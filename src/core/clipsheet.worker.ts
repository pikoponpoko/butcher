// Renders Meshy 4-view sheets (clipsheet.ts) off the main thread: a .clip in, each panel's drawing out as RGBA.
// The page sends the sql.js wasm bytes once; a blob worker has no base URL to fetch it from.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { NotSheet, renderSheet } from './clipsheet';

let SQL: Promise<SqlJsStatic> | null = null;
const post = (m: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { wasm?: ArrayBuffer; id?: number; buf?: ArrayBuffer };
  if (m.wasm) SQL = initSqlJs({ wasmBinary: m.wasm });
  if (m.id == null || !m.buf) return;
  const id = m.id;
  try {
    const r = await renderSheet(m.buf, await SQL!, step => post({ id, step }));
    post({ id, views: r.views, warnings: r.warnings }, r.views.flatMap(v => v.rgba ? [v.rgba.buffer] : []));
  } catch (err) {
    post({ id, error: err instanceof NotSheet ? { W: err.W, H: err.H } : String((err as Error)?.message || err) });
  }
};
