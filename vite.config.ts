import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Writes the list of built files into dist/sw.js: ASSETS are cached at install, LAZY (PDF and CLIP STUDIO readers) on first use.
function swAssets(): Plugin {
  let files: string[] = [], outDir = 'dist';
  return {
    name: 'sw-assets', apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    generateBundle(_, bundle) { files = Object.keys(bundle).filter(f => f.startsWith('assets/')).sort(); },
    closeBundle() {
      const p = resolve(outDir, 'sw.js'), src = readFileSync(p, 'utf8');
      const lazy = (f: string) => /^assets\/(pdfjs\/|pdf[.-]|sql-wasm)/.test(f);
      const out = src.replace('const ASSETS = [];', `const ASSETS = ${JSON.stringify(files.filter(f => !lazy(f)))};`)
        .replace('const LAZY = [];', `const LAZY = ${JSON.stringify(files.filter(lazy))};`);
      if (out === src) throw new Error('sw.js: ASSETS placeholder not found');
      writeFileSync(p, out);
    },
  };
}

// pdf.js decoders for scanned PDFs (JBIG2 black-and-white, JPEG 2000, ICC color), served from assets/pdfjs/ (see src/app/pdf.ts)
const PDFJS_WASM = ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'], pdfjsDir = resolve('node_modules/pdfjs-dist/wasm');
function pdfjsWasm(): Plugin {
  return {
    name: 'pdfjs-wasm',
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const m = /\/assets\/pdfjs\/([\w.]+)$/.exec(req.url || '');
        if (!m || !PDFJS_WASM.includes(m[1])) return next();
        res.setHeader('content-type', 'application/wasm'); res.end(readFileSync(resolve(pdfjsDir, m[1])));
      });
    },
    generateBundle() { for (const f of PDFJS_WASM) this.emitFile({ type: 'asset', fileName: 'assets/pdfjs/' + f, source: readFileSync(resolve(pdfjsDir, f)) }); },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), pdfjsWasm(), swAssets()],
  assetsInclude: ['**/*.psd'],
  build: { chunkSizeWarningLimit: 1000 },
  test: { environment: 'node' },
});
