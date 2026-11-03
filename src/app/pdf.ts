// PDF → one PNG per page, so a scan (ScanSnap etc.) opens like an image. pdf.js is loaded only when a PDF arrives.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

const DPI = 300, MAX_DPI = 600;

export async function pdfToImages(f: File): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), wasmUrl: new URL('./assets/pdfjs/', location.href).href });
  const doc = await task.promise;
  const stem = f.name.replace(/\.pdf$/i, '') || 'scan', out: File[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i), base = page.getViewport({ scale: 1 });
      // a scanned page is one image covering the page: render at that image's own resolution
      const ops = await page.getOperatorList();
      let px = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k], a = ops.argsArray[k];
        if (fn === pdfjs.OPS.paintImageXObject) px = Math.max(px, Number(a[1]) || 0, Number(a[2]) || 0);
        else if (fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) px = Math.max(px, Number(a[0]?.width) || 0, Number(a[0]?.height) || 0);
      }
      const dpi = px ? Math.min(MAX_DPI, Math.max(72, px / Math.max(base.width, base.height) * 72)) : DPI;
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
      c.width = c.height = 0; page.cleanup();
      if (!blob) throw new Error('render failed');
      out.push(new File([blob], doc.numPages > 1 ? `${stem}_${i}.png` : `${stem}.png`, { type: 'image/png' }));
    }
  } finally { await task.destroy(); }
  return out;
}
