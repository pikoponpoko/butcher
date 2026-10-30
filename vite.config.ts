import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.psd'],
  build: { chunkSizeWarningLimit: 1000 },
  test: { environment: 'node' },
});
