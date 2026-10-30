import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  assetsInclude: ['**/*.psd'],
  build: { chunkSizeWarningLimit: 1000 },
  test: { environment: 'node' },
});
