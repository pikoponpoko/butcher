// Image tool state. Documents are large mutable objects (parsed PSD trees), so they stay mutable and
// `bump()` re-renders after an in-place change.
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { type Doc, type Node, type Slice, type Snap, SRC_RE, restore, sameSnap, snap, clampSlice, curSlice, nextSliceName, newSliceId, openFile, persistSlices, renderNode, safe, sampleBuf, sliceData, stem, summarize } from './model';
import { type Settings, type Status, exportAll, saveCurrent } from './exporter';
import { saveBlob } from '../save';

export type Pane = 'layer' | 'slice';
const INIT: Settings = {
  mode: 'folder', fmt: 'png', quality: '90', size: 'orig', px: '1080', basis: 'canvas', trim: true,
  prefix: '', suffix: '', hidden: false, tree: true, slFill: true, allFiles: false, incWarn: false, out: 'zip',
};

export function useImageTool() {
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const docs = useRef<Doc[]>([]).current;
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState<Node | null>(null);
  const [pane, setPaneState] = useState<Pane>('layer');
  const [o, setO] = useState<Settings>(INIT);
  const prevMode = useRef<Settings['mode']>('folder');
  const [status, setStatus] = useState<Status>([]);
  const [busy, setBusy] = useState(false);
  const [outDir, setOutDir] = useState('showDirectoryPicker' in window);
  const doc = docs[cur] as Doc | undefined;
  const set = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => setO(p => ({ ...p, [k]: v })), []);

  const preview = useMemo(() => {
    if (!doc) return null;
    const t0 = performance.now();
    const r = renderNode(doc, sel, o.hidden);
    return { ...r, ms: Math.round(performance.now() - t0) };
  }, [doc, sel, o.hidden]);

  const summary = useMemo(() => summarize(o.allFiles ? docs : doc ? [doc] : [], o.mode, o.hidden),
    [doc, o.allFiles, o.mode, o.hidden, ver, docs.length]);

  function setPane(p: Pane) {
    setPaneState(p);
    if (p === 'slice') { if (o.mode !== 'slice') prevMode.current = o.mode; set('mode', 'slice'); setSel(null); }
    else if (o.mode === 'slice') set('mode', prevMode.current || 'folder');
  }
  function sliceChanged() { if (doc) persistSlices(doc); bump(); }

  // undo / redo per document: begin() before an edit, end() after it (drops the entry when nothing changed)
  const hist = useRef(new WeakMap<Doc, { u: Snap[]; r: Snap[] }>()).current;
  const stacks = (d: Doc) => { let h = hist.get(d); if (!h) hist.set(d, h = { u: [], r: [] }); return h; };
  function begin() { if (!doc) return; const h = stacks(doc); h.u.push(snap(doc)); if (h.u.length > 200) h.u.shift(); }
  function end() { if (!doc) return; const h = stacks(doc), top = h.u[h.u.length - 1]; if (!top) return; if (sameSnap(top, snap(doc))) h.u.pop(); else h.r.length = 0; }
  function edit(f: () => void) { begin(); f(); end(); sliceChanged(); }
  function step(back: boolean) {
    if (!doc) return; const h = stacks(doc), [from, to] = back ? [h.u, h.r] : [h.r, h.u], s = from.pop(); if (!s) return;
    to.push(snap(doc)); restore(doc, s); sliceChanged();
  }

  async function openFiles(files: File[]) {
    let last: Doc | undefined;
    for (const f of files) {
      try { setStatus([{ t: f.name }]); last = await openFile(f.name, await f.arrayBuffer()); docs.push(last); setStatus([]); }
      catch (err: any) { setStatus([{ t: `${f.name}: 読み込めません（${String(err.message || err)}）`, c: 'err' }]); }
    }
    if (last) { setCur(docs.length - 1); setSel(null); if (last.isImage && pane !== 'slice') setPane('slice'); }
    bump();
  }
  async function openSample(k: string) {
    const i = docs.findIndex(d => d.name === k);
    if (i >= 0) setCur(i);
    else { docs.push(await openFile(k, await sampleBuf(k))); setCur(docs.length - 1); }
    setSel(null); bump();
  }
  function selectDoc(i: number) { setCur(i); setSel(null); }

  async function doExport() {
    setBusy(true);
    const s = await exportAll(o, o.allFiles ? docs : [doc!], setStatus, () => { setOutDir(false); set('out', 'zip'); });
    setStatus(s); setBusy(false);
  }
  async function saveOne() {
    if (!doc) return;
    setStatus(await saveCurrent(o, doc, sel, pane === 'slice' ? curSlice(doc) : null));
  }

  // slices
  function deleteSlice() {
    if (!doc) return; const i = doc.slices.findIndex(s => s.id === doc.sliceSel); if (i < 0) return;
    edit(() => { doc.slices.splice(i, 1); doc.sliceSel = (doc.slices[i] || doc.slices[i - 1] || {} as Partial<Slice>).id ?? null; });
  }
  function clearSlices() {
    if (!doc || !doc.slices.length) return;
    edit(() => { doc.slices = []; doc.sliceSel = null; });
  }
  async function saveSlices() {
    if (!doc) return;
    if (!doc.slices.length) { setStatus([{ t: 'スライスがありません', c: 'err' }]); return; }
    const data = { type: 'slices', version: 2, width: doc.psd.width, height: doc.psd.height, slices: sliceData(doc).map(({ name, x, y, w, h, on }) => ({ name, cx: x + w / 2, cy: y + h / 2, w, h, on })) };
    if (await saveBlob(safe(stem(doc.name)) + '_slices.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })) === 'ok') setStatus([{ t: 'スライス設定を保存', c: 'ok' }]);
  }
  async function loadSlices(f: File) {
    if (!doc) return;
    try {
      const j = JSON.parse(await f.text()); if (!Array.isArray(j.slices)) throw new Error();
      const W = doc.psd.width, H = doc.psd.height;
      begin();
      doc.slices = j.slices.map((s: any) => { const o: Slice = { id: newSliceId(), name: String(s.name || '') || nextSliceName(doc), x: +s.x || 0, y: +s.y || 0, w: +s.w || 1, h: +s.h || 1, on: s.on !== false };
        if (s.cx != null) { o.x = (+s.cx || 0) - o.w / 2; o.y = (+s.cy || 0) - o.h / 2; } clampSlice(o, W, H); return o; });
      doc.sliceSel = doc.slices[0]?.id ?? null; end(); if (pane !== 'slice') setPane('slice'); sliceChanged();
      setStatus((j.width && (j.width !== W || j.height !== H)) ? [{ t: `キャンバスサイズが異なります（${j.width}×${j.height}）`, c: 'warn' }] : [{ t: `${doc.slices.length} 件のスライスを読込`, c: 'ok' }]);
    } catch { setStatus([{ t: 'スライス設定を読み込めません', c: 'err' }]); }
  }

  return {
    ver, bump, docs, cur, doc, sel, setSel, pane, setPane, o, set, status, setStatus, busy, outDir, preview, summary,
    openFiles, openSample, selectDoc, doExport, saveOne, sliceChanged, deleteSlice, clearSlices, saveSlices, loadSlices,
    begin, end, edit, undo: () => step(true), redo: () => step(false),
    accepts: (f: File) => SRC_RE.test(f.name),
  };
}
export type ImageTool = ReturnType<typeof useImageTool>;
