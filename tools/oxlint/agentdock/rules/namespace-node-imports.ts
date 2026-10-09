import { defineRule } from '@oxlint/plugins';

const MODULE_ALIASES = new Map([
  ['assert/strict', 'Assert'],
  ['fs/promises', 'FSP'],
]);

const SEGMENT_ALIASES = new Map([
  ['fs', 'FS'],
  ['os', 'OS'],
  ['url', 'URL'],
  ['vm', 'VM'],
]);

const toPascalCase = (value: string) =>
  value
    .split(/[_-]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');

export const expectedNamespaceAlias = (source: string): string => {
  const moduleName = source.slice('node:'.length);
  const alias = MODULE_ALIASES.get(moduleName);
  if (alias !== undefined) return `Node${alias}`;
  return `Node${moduleName
    .split('/')
    .map((segment) => SEGMENT_ALIASES.get(segment) ?? toPascalCase(segment))
    .join('')}`;
};

/** One canonical `import * as NodeFS from 'node:fs'` per builtin keeps call sites greppable and the Node surface obvious. */
export const namespaceNodeImportsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Require canonical namespace imports for Node.js built-in modules.',
    },
    messages: {
      namespace: 'Import {{source}} as a namespace named {{alias}}.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (!source.startsWith('node:')) return;

        const alias = expectedNamespaceAlias(source);
        const [specifier] = node.specifiers;
        if (
          node.specifiers.length === 1 &&
          specifier?.type === 'ImportNamespaceSpecifier' &&
          specifier.local.name === alias
        ) {
          return;
        }

        context.report({ node, messageId: 'namespace', data: { source, alias } });
      },
    };
  },
});
