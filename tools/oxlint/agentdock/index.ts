import { eslintCompatPlugin } from '@oxlint/plugins';

import { namespaceNodeImportsRule } from './rules/namespace-node-imports.ts';
import { noInlineSchemaCompileRule } from './rules/no-inline-schema-compile.ts';
import { noManualEffectRuntimeInTestsRule } from './rules/no-manual-effect-runtime-in-tests.ts';
import { noWorkspaceServiceConstructorImportsRule } from './rules/no-workspace-service-constructor-imports.ts';

/**
 * Agentdock-specific Oxlint rules. Keep repository policy here rather than in
 * the vendored `tools/oxlint/anti-slop` plugin, so that plugin can be replaced
 * wholesale when upstream changes.
 */
const agentdockPlugin = eslintCompatPlugin({
  meta: { name: 'agentdock' },
  rules: {
    'namespace-node-imports': namespaceNodeImportsRule,
    'no-inline-schema-compile': noInlineSchemaCompileRule,
    'no-manual-effect-runtime-in-tests': noManualEffectRuntimeInTestsRule,
    'no-workspace-service-constructor-imports': noWorkspaceServiceConstructorImportsRule,
  },
});

export default agentdockPlugin;
