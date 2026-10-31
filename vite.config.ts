import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Writes the list of built files into dist/sw.js so the service worker can cache them all at install.
function swAssets(): Plugin {
  let files: string[] = [], outDir = 'dist';
  return {
    name: 'sw-assets', apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    generateBundle(_, bundle) { files = Object.keys(bundle).filter(f => f.startsWith('assets/')).sort(); },
    closeBundle() {
      const p = resolve(outDir, 'sw.js'), src = readFileSync(p, 'utf8');
      const out = src.replace('const ASSETS = [];', `const ASSETS = ${JSON.stringify(files)};`);
      if (out === src) throw new Error('sw.js: ASSETS placeholder not found');
      writeFileSync(p, out);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), swAssets()],
  assetsInclude: ['**/*.psd'],
  build: { chunkSizeWarningLimit: 1000 },
  test: { environment: 'node' },
});
