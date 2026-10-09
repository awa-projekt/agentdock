import type { ESTree } from '@oxlint/plugins';
import { defineRule } from '@oxlint/plugins';

import { memberCallee, unwrapExpression } from '../ast.ts';

const COMPILER_METHODS = new Set([
  'is',
  'asserts',
  'decodeEffect',
  'decodeExit',
  'decodeOption',
  'decodePromise',
  'decodeResult',
  'decodeSync',
  'decodeUnknownExit',
  'decodeUnknownEffect',
  'decodeUnknownOption',
  'decodeUnknownPromise',
  'decodeUnknownResult',
  'decodeUnknownSync',
  'encodeExit',
  'encodeEffect',
  'encodeOption',
  'encodePromise',
  'encodeResult',
  'encodeSync',
  'encodeUnknownExit',
  'encodeUnknownEffect',
  'encodeUnknownOption',
  'encodeUnknownPromise',
  'encodeUnknownResult',
  'encodeUnknownSync',
]);

/** A module-level schema: an uppercase identifier or a namespace member such as `Schemas.User`. */
const isStaticSchemaReference = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);
  if (expression.type === 'Identifier') {
    const first = expression.name.charAt(0);
    return first !== '' && first === first.toUpperCase();
  }
  return expression.type === 'MemberExpression';
};

/** A schema built inline from static parts, e.g. `Schema.Struct({...})` or `Schema.fromJsonString(User)`. */
const isInlineStaticSchema = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);
  if (expression.type !== 'CallExpression') return false;
  const callee = memberCallee(expression.callee);
  if (callee === undefined || callee.object !== 'Schema') return false;
  if (callee.method !== 'fromJsonString') return true;
  const inner = expression.arguments[0];
  return inner !== undefined && (isStaticSchemaReference(inner) || isInlineStaticSchema(inner));
};

/**
 * `Schema.decodeUnknownSync(User)(input)` inside a function compiles a fresh
 * decoder on every call. Only immediately-invoked compilers of static schemas
 * are reported: a factory that returns a compiled decoder, or a compiler over a
 * schema parameter, cannot be hoisted.
 */
export const noInlineSchemaCompileRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Schema decoder/encoder compiler calls inside function bodies; hoist them to module scope.',
    },
    messages: {
      inlineLiteral:
        'Hoist Schema.{{method}}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.',
      inlineCompile:
        'Hoist Schema.{{method}}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.',
    },
  },
  createOnce(context) {
    let functionDepth = 0;
    const enterFunction = () => {
      functionDepth += 1;
    };
    const exitFunction = () => {
      functionDepth -= 1;
    };

    return {
      before: () => {
        functionDepth = 0;
      },
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      CallExpression(node) {
        if (functionDepth === 0) return;

        const compiled = unwrapExpression(node.callee);
        if (compiled.type !== 'CallExpression') return;
        const callee = memberCallee(compiled.callee);
        if (callee === undefined || callee.object !== 'Schema' || !COMPILER_METHODS.has(callee.method)) return;

        const schema = compiled.arguments[0];
        if (schema === undefined) return;
        const inlineLiteral = isInlineStaticSchema(schema);
        if (!inlineLiteral && !isStaticSchemaReference(schema)) return;

        context.report({
          node: compiled.callee,
          messageId: inlineLiteral ? 'inlineLiteral' : 'inlineCompile',
          data: { method: callee.method },
        });
      },
    };
  },
});
