import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const testOutputRoot = join(tmpdir(), 'wechat-article-exporter-tests');

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    env: {
      WECHAT2MD_OUTPUT_DIR: testOutputRoot,
    },
    include: ['tests/**/*.test.ts'],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
