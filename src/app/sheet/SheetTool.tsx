// 四面図 tool: Meshy 4-view sheets (Meshy四面図_<name>.clip) → <name>_Main / _Right / _Back / _Left.png.
// Each file is rendered once when it is added; its four crops are kept as PNG and cut to the shared square on export,
// so the margin and the side names can change without rendering again.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { NotSheet, type Rect, charName, squareOf, viewNames } from '../../core/clipsheet';
import { type Status, writeTo } from '../image/exporter';
import { WARN_JA, makeNamer, safe } from '../image/model';
import { saveBlob, saveFailText, saveFiles, shareMode } from '../save';
import { loadZip } from '../lazy';
import { tr } from '../i18n';
import { AddHint, Lbl, Seg, StatusText, ThemeRow } from '../ui';
import { Aborted, encodeCrop, renderClip, squarePng, stopRender } from './run';

export interface SheetState { open: boolean; busy: boolean; loading: boolean; n: number }
export interface SheetToolApi { open(fs: File[]): void; export(): void; cancel(): void }
export const SHEET_RE = /\.clip$/i;
// files named like the template open here from any tool
export const SHEET_NAME_RE = /^Meshy四面図.*\.clip$/i;

interface View { box: Rect | null; png: Blob | null; url: string }
interface Item {
  id: number; file: File; name: string; st: 'wait' | 'run' | 'ok' | 'empty' | 'notSheet' | 'bad'; step: number;
  views?: View[]; thumb?: string; warn?: { layer: string; type: string }[]; err?: string;
}
interface Settings { margin: string; swap: boolean; out: 'zip' | 'each' | 'dir' }
const INIT: Settings = { margin: '5', swap: false, out: 'zip' };
const KEY = 'sheet:settings';
function load(): Settings {
  const o = { ...INIT };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(INIT) as (keyof Settings)[]) if (v[k] !== undefined && typeof v[k] === typeof INIT[k]) (o as Record<string, unknown>)[k] = v[k];
    if (o.out === 'dir' && !('showDirectoryPicker' in window)) o.out = INIT.out;
  } catch {}
  return o;
}
// 余白 in % of the square's drawing size, on each side
const marginOf = (s: string) => Math.min(50, Math.max(0, Number(s) || 0)) / 100;
const sqOf = (x: Item, o: Settings) => x.st === 'ok' ? squareOf(x.views!.map(v => v.box), marginOf(o.margin)) : null;
const dropUrls = (x: { views?: View[] }) => x.views?.forEach(v => v.url && URL.revokeObjectURL(v.url));
// messages worth showing as they are; anything else reads 読み込めません
const KNOWN = ['CLIP STUDIOのファイルではありません', 'レイヤー情報が見つかりません', '読み込み用ライブラリを取得できません', 'アプリが更新されました。ページを再読み込みしてください'];
let seq = 0;
const X = <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1 1 7" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
const ICON = {
  sort: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M3.5 1.5v10M1.5 9.5l2 2 2-2M7.5 2.5h4M7.5 6.5h3M7.5 10.5h2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
  trash: <svg width="12" height="13" viewBox="0 0 12 13"><path d="M1 3h10M4.5 3V1.5h3V3M2.5 3l.7 8.5h5.6L9.5 3M5 5.5v4M7 5.5v4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
  save: <svg width="12" height="13" viewBox="0 0 12 13"><path d="M6 1v7.5M3 5.5l3 3 3-3M1 9v3h10V9" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
};
const GAP = 8, CAP = 20; // between tiles; caption line under a tile

export function SheetTool({ ref, onPick, onState }: { ref: Ref<SheetToolApi>; onPick: () => void; onState: (s: SheetState) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [cur, setCur] = useState(0);
  const [o, setO] = useState<Settings>(load);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setO(p => ({ ...p, [k]: v }));
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} }, [o]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>([]);
  const [outDir, setOutDir] = useState('showDirectoryPicker' in window);
  const it = items[cur] as Item | undefined;
  const loading = items.some(x => x.st === 'wait' || x.st === 'run'), ready = items.filter(x => x.st === 'ok');
  useEffect(() => { onState({ open: items.length > 0, busy, loading, n: ready.length }); }, [items.length, busy, loading, ready.length]);

  function open(fs: File[]) {
    fs = fs.filter(f => SHEET_RE.test(f.name)); if (!fs.length) return;
    setStatus([]);
    setItems(p => { if (!p.length) setCur(0); return [...p, ...fs.map(file => ({ id: ++seq, file, name: file.name, st: 'wait' as const, step: 0 }))]; });
  }
  // render the files one by one, in list order
  const live = useRef(items); live.current = items;
  const running = useRef(0);
  useEffect(() => {
    if (running.current) return;
    const next = items.find(x => x.st === 'wait'); if (!next) return;
    running.current = next.id;
    const patch = (p: Partial<Item>) => setItems(a => a.map(x => x.id === next.id ? { ...x, ...p } : x));
    patch({ st: 'run', step: 0 });
    (async () => {
      let p: Partial<Item> | null = null;
      try {
        const r = await renderClip(next.file, step => patch({ step }));
        const views: View[] = [];
        let thumb: string | undefined;
        for (const v of r.views) {
          if (!v.box || !v.rgba) { views.push({ box: null, png: null, url: '' }); continue; }
          const e = await encodeCrop(v.rgba, v.box.w, v.box.h, thumb ? 0 : 52);
          thumb ??= e.thumb;
          views.push({ box: v.box, png: e.png, url: URL.createObjectURL(e.png) });
        }
        p = views.some(v => v.box) ? { st: 'ok', views, thumb, warn: r.warnings } : { st: 'empty', warn: r.warnings };
      } catch (e) {
        if (!(e instanceof Aborted)) p = e instanceof NotSheet ? { st: 'notSheet', err: `${e.W}×${e.H}` } : { st: 'bad', err: KNOWN.find(k => k === (e as Error)?.message) };
      }
      running.current = 0;
      // removed while it was rendering
      if (p && !live.current.some(x => x.id === next.id)) { dropUrls(p); p = null; }
      if (p) patch(p); else setItems(a => [...a]);
    })();
  }, [items]);

  function remove(i: number) {
    const x = items[i]; if (!x) return;
    if (x.id === running.current) stopRender();
    dropUrls(x);
    setItems(a => a.filter(y => y.id !== x.id));
    setCur(c => Math.max(0, Math.min(i < c ? c - 1 : c, items.length - 2)));
  }
  function clear() {
    if (running.current) stopRender();
    items.forEach(dropUrls); setItems([]); setCur(0); setStatus([]);
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortByName() { const id = it?.id; const a = [...items].sort((x, y) => coll.compare(x.name, y.name)); setItems(a); setCur(Math.max(0, a.findIndex(x => x.id === id))); }

  // four squares in a row, or two by two when that makes them larger
  const stageRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 1, h: 1 });
  useLayoutEffect(() => {
    const el = stageRef.current!, ro = new ResizeObserver(() => { const cs = getComputedStyle(el); setAvail({ w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const side = (c: number) => { const r = 4 / c; return Math.floor(Math.min((avail.w - GAP * (c - 1)) / c, (avail.h - GAP * (r - 1)) / r - CAP)); };
  const cols = side(4) >= side(2) ? 4 : 2, tile = Math.max(24, side(cols));

  const ac = useRef<AbortController | null>(null);
  async function run(list: Item[]) {
    if (busy || !list.length) return;
    const c = new AbortController(); ac.current = c; setBusy(true);
    try { setStatus(await exportList(o, list, setStatus, () => { setOutDir(false); set('out', 'zip'); }, c.signal)); }
    finally { setBusy(false); ac.current = null; }
  }
  useImperativeHandle(ref, () => ({ open, export: () => run(items.filter(x => x.st === 'ok')), cancel: () => ac.current?.abort() }));

  const vn = viewNames(o.swap), sq = it ? sqOf(it, o) : null;
  const count = ready.reduce((n, x) => n + x.views!.filter(v => v.box).length, 0);
  const sub = (x: Item) => {
    if (x.st === 'wait') return tr('待機中');
    if (x.st === 'run') return `${tr('処理中…')} ${x.step}/4`;
    if (x.st === 'empty') return tr('絵がありません');
    if (x.st === 'notSheet') return tr('四面図ではありません（{s}）', { s: x.err! });
    if (x.st === 'bad') return tr(x.err || '読み込めません');
    const s = sqOf(x, o)!, n = x.views!.filter(v => v.box).length;
    return `${s.size}×${s.size}` + (n < 4 ? ' · ' + tr('{n} 枚', { n }) : '');
  };
  const warnText = (x: Item) => x.warn!.map(w => `${w.layer}${tr('：')}${tr(WARN_JA[w.type] || w.type)}`).join('\n');
  const pct = (n: number) => n / sq!.size * 100 + '%';
  return (
    <section className={'gif sheet' + (items.length ? ' on' : '')} id="sheet">
      <main className="center" style={{ display: 'flex' }}>
        <div className={'stage' + (items.length ? '' : ' pick')} id="sStage" ref={stageRef} onClick={items.length ? undefined : onPick}
          role={items.length ? undefined : 'button'} tabIndex={items.length ? undefined : 0} aria-label={items.length ? undefined : tr('開く')}
          onKeyDown={items.length ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}>
          {it && sq && <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, ${tile}px)` }}>
            {it.views!.map((v, i) => (
              <figure key={i} className="tile">
                <div className={v.box ? undefined : 'empty'} style={{ width: tile, height: tile }}>
                  {v.box && <img alt="" src={v.url} style={{ left: pct(v.box.x - sq.x), top: pct(v.box.y - sq.y), width: pct(v.box.w), height: pct(v.box.h) }} />}
                </div>
                <figcaption>{vn[i]}</figcaption>
              </figure>
            ))}
          </div>}
          {it && !sq && <div className={'smsg' + (it.st === 'wait' || it.st === 'run' ? '' : ' warn')}>{sub(it)}</div>}
          <AddHint hidden={!!items.length} formats="CLIP" />
        </div>
        <div className="status" hidden={!it}>
          <span id="sName">{it?.name}</span>
          <span id="sSize" className="num" style={{ marginLeft: 'auto' }}>{sq ? `${sq.size}×${sq.size}` : ''}</span>
          <span id="sState">{it?.warn?.length ? <span className="warn" title={warnText(it)}>{tr('警告 {n}', { n: it.warn.length })}</span> : null}</span>
          <button className="link ic" id="sSave" disabled={busy || it?.st !== 'ok'} aria-label={tr('選択中を保存')} title={tr('選択中を保存')} onClick={() => it && run([it])}>{ICON.save}</button>
        </div>
      </main>
      <aside className="panel clist" aria-label={tr('ファイル')}>
        <div className="ph"><b><Lbl>{tr('ファイル')}</Lbl></b>
          <span hidden={!items.length}>
            <button className="link ic" id="sSort" disabled={busy} aria-label={tr('名前順に並べ替え')} title={tr('名前順に並べ替え')} onClick={sortByName}>{ICON.sort}</button>
            <button className="link ic" id="sClear" disabled={busy} aria-label={tr('全削除')} title={tr('全削除')} onClick={clear}>{ICON.trash}</button>
          </span>
        </div>
        <div className="flist" role="listbox" aria-label={tr('ファイル')}>
          {items.map((x, i) => (
            <div key={x.id} role="option" aria-selected={i === cur} tabIndex={0} className={'row' + (i === cur ? ' sel' : '')} onClick={() => setCur(i)}
              onKeyDown={e => { if (e.key === 'ArrowDown' && i < items.length - 1) { setCur(i + 1); (e.currentTarget.nextSibling as HTMLElement)?.focus(); e.preventDefault(); } else if (e.key === 'ArrowUp' && i > 0) { setCur(i - 1); (e.currentTarget.previousSibling as HTMLElement)?.focus(); e.preventDefault(); } else if (e.key === 'Delete' && !busy) remove(i); }}>
              <span className={'thumb' + (x.thumb ? ' pic' : '')} style={x.thumb ? { '--pic': `url(${x.thumb})` } as CSSProperties : undefined} />
              <span className="nm"><span className="name" title={x.name}>{charName(x.name)}</span>
                <span className={'sub' + (x.st === 'empty' || x.st === 'notSheet' || x.st === 'bad' ? ' warn' : '')} title={sub(x)}>{sub(x)}{x.warn?.length ? <> · <span className="warn" title={warnText(x)}>{tr('警告 {n}', { n: x.warn.length })}</span></> : null}</span>
              </span>
              <button className="tx" aria-label={tr('閉じる')} title={tr('閉じる')} disabled={busy} onClick={e => { e.stopPropagation(); remove(i); }}>{X}</button>
            </div>
          ))}
        </div>
      </aside>
      <aside className="panel inspector" aria-label={tr('書き出し設定')}>
        <div className="insp">
          <fieldset className="lock" disabled={busy}>
          <div className="sec">
            <label className="prop pair" htmlFor="sMargin"><span><Lbl>{tr('余白')}</Lbl></span><span className="unit"><input id="sMargin" className="n" type="number" min="0" max="50" value={o.margin} onChange={e => set('margin', e.target.value)} />%</span></label>
            <label className="prop pair sw" htmlFor="sSwap"><span><Lbl>{tr('左右入れ替え')}</Lbl></span><input id="sSwap" type="checkbox" checked={o.swap} onChange={e => set('swap', e.target.checked)} /></label>
          </div>
          </fieldset>
          <div className="sec theme-sec">
            <ThemeRow />
          </div>
        </div>
        <div className="foot">
          <div className="sumrow"><span id="sSum" className="num">{tr('{n} ファイル', { n: count })}</span><span id="sStatus" className="muted" role="status" aria-live="polite"><StatusText s={status} /></span></div>
          <fieldset className="lock" disabled={busy}>
          <div className="act">
            <Seg id="sOut" value={o.out} options={[['zip', 'ZIP'], ['each', tr('個別')], ['dir', tr('フォルダに保存')]]} hiddenValues={outDir ? [] : ['dir']} onChange={v => set('out', v)} />
          </div>
          </fieldset>
        </div>
        <div className="insp theme-end"><div className="sec"><ThemeRow /></div></div>
      </aside>
    </section>
  );
}

// Write each file's views (blank panels left out): one ZIP, files one by one (phones: the share sheet), or a folder.
async function exportList(o: Settings, list: Item[], progress: (s: Status) => void, noDir: () => void, signal: AbortSignal): Promise<Status> {
  let dir: FileSystemDirectoryHandle | null = null;
  if (o.out === 'dir') {
    try { dir = await showDirectoryPicker({ id: 'butcher-out', mode: 'readwrite' }); }
    catch (e: any) { if (e.name === 'AbortError') return [{ t: tr('保存を取り消しました') }]; noDir(); return [{ t: tr('この環境ではフォルダに保存できません'), c: 'err' }]; }
  }
  const vn = viewNames(o.swap), names = makeNamer(true), zip = o.out === 'zip' ? new (await loadZip())() : null, share = o.out === 'each' && shareMode(), files: { name: string; data: Blob }[] = [];
  const total = list.reduce((n, x) => n + x.views!.filter(v => v.box).length, 0);
  let written = 0;
  try {
    for (const x of list) {
      const sq = sqOf(x, o); if (!sq) continue;
      // the four names of one file stay together when they clash (ねこ_2_Main.png …)
      const base = names.take(safe(charName(x.name)), vn.map(v => `_${v}.png`));
      for (let i = 0; i < x.views!.length; i++) {
        const v = x.views![i]; if (!v.box || !v.png) continue;
        progress([{ t: `${written + 1}/${total}` }]);
        await new Promise(r => setTimeout(r));
        if (signal.aborted) return [{ t: written && !zip ? tr('{n} ファイルを書き出して中止しました', { n: written }) : tr('中止しました') }];
        const name = `${base}_${vn[i]}.png`, blob = await squarePng(v.png, v.box, sq);
        if (dir) await writeTo(dir, name, blob);
        else if (zip) zip.file(name, blob);
        else if (share) files.push({ name, data: blob });
        else { const r = await saveBlob(name, blob); if (r !== 'ok') return [{ t: saveFailText(r) }]; }
        written++;
      }
    }
    if (!written) return [{ t: tr('書き出せる画像がありません'), c: 'err' }];
    if (zip) {
      const data = await zip.generateAsync({ type: 'blob' });
      if (signal.aborted) return [{ t: tr('中止しました') }];
      const r = await saveBlob(list.length === 1 ? safe(charName(list[0].name)) + '.zip' : 'Meshy.zip', data); if (r !== 'ok') return [{ t: saveFailText(r) }];
    }
    if (share) { const r = await saveFiles(files); if (r !== 'ok') return [{ t: saveFailText(r) }]; }
    return [{ t: tr('{n} ファイルを書き出し', { n: written }), c: 'ok' }];
  } catch (e: any) { return [{ t: tr('エラー: {e}', { e: tr(String(e.message || e)) }), c: 'err' }]; }
}
