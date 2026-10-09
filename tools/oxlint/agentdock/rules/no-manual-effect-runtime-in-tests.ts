import { defineRule } from '@oxlint/plugins';

import { memberCallee } from '../ast.ts';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const EFFECT_RUNTIME_METHODS = new Set([
  'runCallback',
  'runCallbackWith',
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseExit',
  'runPromiseExitWith',
  'runPromiseWith',
  'runSync',
  'runSyncExit',
  'runSyncExitWith',
  'runSyncWith',
]);

const manualRunner = (callee: { readonly object: string; readonly method: string }): string | undefined => {
  if (callee.object === 'Effect' && EFFECT_RUNTIME_METHODS.has(callee.method)) return `Effect.${callee.method}`;
  if (callee.object === 'ManagedRuntime' && callee.method === 'make') return 'ManagedRuntime.make';
  return undefined;
};

/** Tests build layers and run through `@effect/vitest`; a hand-rolled runtime hides missing dependencies and leaks fibers. */
export const noManualEffectRuntimeInTestsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.',
    },
    messages: {
      manualRuntime: 'Do not use {{runner}} in tests. Use @effect/vitest with it.effect(...) and test layers instead.',
    },
  },
  create(context) {
    if (!TEST_FILE.test(context.filename.replaceAll('\\', '/'))) return {};

    return {
      CallExpression(node) {
        const callee = memberCallee(node.callee);
        if (callee === undefined) return;
        const runner = manualRunner(callee);
        if (runner === undefined) return;

        context.report({ node: node.callee, messageId: 'manualRuntime', data: { runner } });
      },
    };
  },
});
