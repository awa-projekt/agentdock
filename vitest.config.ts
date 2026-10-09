import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.bun-cache/**', '**/.references/**', '**/.claude/**'],
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
