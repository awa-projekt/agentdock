import type { ESTree } from '@oxlint/plugins';
import { defineRule } from '@oxlint/plugins';

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/**
 * Workspace package names from the root `workspaces` globs, plus the `@/*`
 * tsconfig alias for `apps/web/src`. Add an entry when a new workspace package
 * is created, otherwise imports through it escape this rule.
 */
const PROJECT_PACKAGES = [
  '@agentdock/cli',
  'agentdock-patterns',
  'agentdock-sdk',
  'agentdock-web',
  'api',
  'db',
  'server',
];

/**
 * True for specifiers that resolve to first-party code but are not relative, so
 * `anti-slop-effect/no-service-constructor-imports` (relative-only) skips them.
 */
function isNonRelativeProjectImport(source: string): boolean {
  if (source.startsWith('@/')) return true;
  return PROJECT_PACKAGES.some((name) => source === name || source.startsWith(`${name}/`));
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  if (specifier.imported.type === 'Identifier') return specifier.imported.name;
  return specifier.imported.value;
}

/**
 * Extends the generic Effect rule across workspace package and path-alias
 * boundaries. The vendored rule only inspects `./` and `../` specifiers, so
 * `import { makeTryDb } from 'db'` would otherwise go unreported.
 */
export const noWorkspaceServiceConstructorImportsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow make<CapabilityName> imports from workspace packages and the @/* alias outside test and spec files.',
    },
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" from "{{source}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    const isTestFile = TEST_FILE.test(context.filename.replaceAll('\\', '/'));

    return {
      ImportDeclaration(node) {
        if (isTestFile || !isNonRelativeProjectImport(node.source.value)) return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;

          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;

          context.report({
            node: specifier,
            messageId: 'serviceConstructorImport',
            data: { name: importedName, source: node.source.value },
          });
        }
      },
    };
  },
});
