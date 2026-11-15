// 変換 tool: a list of images converted one by one on export (format, quality, size, rotation, flip, naming).
// Files stay as File objects until they are converted, so long lists don't hold decoded pixels.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { type ConvSettings, CONV_INIT, CONV_RE, NoEncoder, convertFile, extFor, outSize, ruleName, stemOf } from './convert';
import { type Status, writeTo } from '../image/exporter';
import { makeNamer, safe } from '../image/model';
import { saveBlob, saveFailText, saveFiles, shareMode } from '../save';
import { getSign, signReady, useSign } from '../sign';
import { loadZip } from '../lazy';
import { tr, trAlt } from '../i18n';
import { AddHint, Lbl, NameRows, altOptions, Seg, SignRows, StatusText, ThemeRow, Toggles } from '../ui';

export interface ConvState { open: boolean; busy: boolean; n: number }
export interface ConvToolApi { open(fs: File[]): void; export(): void; cancel(): void }
interface Item { id: number; file: File; name: string; thumb?: string; W?: number; H?: number; bad?: boolean }

const KEY = 'conv:settings';
function load(): ConvSettings {
  const o = { ...CONV_INIT };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(CONV_INIT) as (keyof ConvSettings)[]) if (v[k] !== undefined && typeof v[k] === typeof CONV_INIT[k]) (o as Record<string, unknown>)[k] = v[k];
    if (o.out === 'dir' && !('showDirectoryPicker' in window)) o.out = CONV_INIT.out;
  } catch {}
  return o;
}
let seq = 0;
const kb = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const X = <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1 1 7" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
const ICON = {
  sort: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M3.5 1.5v10M1.5 9.5l2 2 2-2M7.5 2.5h4M7.5 6.5h3M7.5 10.5h2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
  trash: <svg width="12" height="13" viewBox="0 0 12 13"><path d="M1 3h10M4.5 3V1.5h3V3M2.5 3l.7 8.5h5.6L9.5 3M5 5.5v4M7 5.5v4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
  save: <svg width="12" height="13" viewBox="0 0 12 13"><path d="M6 1v7.5M3 5.5l3 3 3-3M1 9v3h10V9" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
};
const CHK = 'conic-gradient(var(--chk-b) 25%, transparent 0 50%, var(--chk-b) 0 75%, transparent 0)';

export function ConvTool({ ref, onPick, onState }: { ref: Ref<ConvToolApi>; onPick: () => void; onState: (s: ConvState) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [cur, setCur] = useState(0);
  const [o, setO] = useState<ConvSettings>(load);
  type Side = Exclude<ConvSettings['size'], 'orig'>;
  const side = useRef<Side>(o.size === 'orig' ? 'long' : o.size);
  const set = <K extends keyof ConvSettings>(k: K, v: ConvSettings[K]) => setO(p => ({ ...p, [k]: v }));
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} }, [o]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>([]);
  const [view, setView] = useState<'src' | 'out'>('out');
  const [outDir, setOutDir] = useState('showDirectoryPicker' in window);
  const sign = useSign();
  const it = items[cur] as Item | undefined;
  useEffect(() => { onState({ open: items.length > 0, busy, n: items.length }); }, [items.length, busy]);

  function open(fs: File[]) {
    const add = fs.filter(f => CONV_RE.test(f.name)).map(file => ({ id: ++seq, file, name: file.name }));
    if (!add.length) return;
    setItems(p => { if (!p.length) setCur(0); return [...p, ...add]; });
    setStatus([]);
  }
  // thumbnails and source sizes, one file at a time
  const thumbing = useRef(false);
  useEffect(() => {
    if (thumbing.current) return;
    const next = items.find(x => !x.thumb && !x.bad); if (!next) return;
    thumbing.current = true;
    (async () => {
      const p: Partial<Item> = {};
      try {
        const b = await createImageBitmap(next.file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
        const k = Math.min(1, 78 / Math.max(b.width, b.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(b.width * k)); c.height = Math.max(1, Math.round(b.height * k));
        const ctx = c.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(b, 0, 0, c.width, c.height);
        p.W = b.width; p.H = b.height; p.thumb = c.toDataURL(); b.close(); c.width = c.height = 0;
      } catch { p.bad = true; }
      thumbing.current = false;
      setItems(a => a.map(x => x.id === next.id ? { ...x, ...p } : x));
    })();
  }, [items]);

  function remove(i: number) {
    setItems(a => a.filter((_, j) => j !== i));
    setCur(c => Math.max(0, Math.min(i < c ? c - 1 : c, items.length - 2)));
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortByName() { const id = it?.id; const a = [...items].sort((x, y) => coll.compare(x.name, y.name)); setItems(a); setCur(Math.max(0, a.findIndex(x => x.id === id))); }

  // output names, as export writes them (same-name clashes get _2, _3 …)
  const outNames = (() => {
    const n = makeNamer(true);
    return items.map((x, i) => { const ext = '.' + extFor(o.fmt, x.name); return n.take(safe(ruleName(o, stemOf(x.name), i)), [ext]) + ext; });
  })();

  // preview: the selected file as it will be written
  const [pv, setPv] = useState<{ url: string; w: number; h: number; size: number } | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (!it) { setSrcUrl(''); return; } const u = URL.createObjectURL(it.file); setSrcUrl(u); return () => URL.revokeObjectURL(u); }, [it?.id]);
  const pvKey = JSON.stringify([it?.id, o.fmt, o.quality, o.size, o.px, o.pct, o.noUp, o.rot, o.flipH, o.flipV, sign]);
  useEffect(() => {
    if (!it || it.bad) { setPv(null); return; }
    let stop = false, url = '';
    const id = setTimeout(async () => {
      try {
        await signReady(sign);
        const r = await convertFile(o, it.file, it.name, sign); if (stop) return;
        url = URL.createObjectURL(r.blob); setPv({ url, w: r.w, h: r.h, size: r.blob.size }); setErr('');
      } catch (e) { if (!stop) { setPv(null); setErr(e instanceof NoEncoder ? tr('このブラウザは{f}書き出しに対応していません', { f: 'WebP' }) : tr('読み込めません')); } }
    }, 150);
    return () => { stop = true; clearTimeout(id); if (url) URL.revokeObjectURL(url); };
  }, [pvKey]);

  // fit the preview into the stage
  const stageRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 1, h: 1 });
  useLayoutEffect(() => {
    const el = stageRef.current!, ro = new ResizeObserver(() => { const cs = getComputedStyle(el); setAvail({ w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const showOut = view === 'out';
  const dims = showOut ? (pv ? { w: pv.w, h: pv.h } : null) : it?.W ? { w: it.W, h: it.H! } : null;
  const q = dims ? Math.min(avail.w / dims.w, avail.h / dims.h, 8) : 1;
  const box: CSSProperties | undefined = dims ? { width: Math.max(1, Math.floor(dims.w * q)) + 'px', height: Math.max(1, Math.floor(dims.h * q)) + 'px' } : undefined;

  const ac = useRef<AbortController | null>(null);
  async function run(list: Item[], all: boolean) {
    if (busy || !list.length) return;
    const c = new AbortController(); ac.current = c; setBusy(true);
    try { setStatus(await exportList(o, list, all ? 0 : items.indexOf(list[0]), all ? o.out : 'each', setStatus, () => { setOutDir(false); set('out', 'zip'); }, c.signal)); }
    finally { setBusy(false); ac.current = null; }
  }
  useImperativeHandle(ref, () => ({ open, export: () => run(items.filter(x => !x.bad), true), cancel: () => ac.current?.abort() }));

  const ok = items.filter(x => !x.bad).length;
  const sizeLine = it ? showOut ? pv ? `${pv.w}×${pv.h}` : '' : it.W ? `${it.W}×${it.H}` : '' : '';
  const est = it?.W ? outSize(o, it.W, it.H!) : null;
  return (
    <section className={'gif conv' + (items.length ? ' on' : '')} id="conv">
      <main className="center" style={{ display: 'flex' }}>
        <div className={'stage' + (items.length ? '' : ' pick')} id="cStage" ref={stageRef} onClick={items.length ? undefined : onPick}
          role={items.length ? undefined : 'button'} tabIndex={items.length ? undefined : 0} aria-label={items.length ? undefined : tr('開く')}
          onKeyDown={items.length ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
          style={dims ? { '--sw': dims.w, '--sh': dims.h } as CSSProperties : est ? { '--sw': est.w, '--sh': est.h } as CSSProperties : undefined}>
          {it && (showOut ? pv && <img className="out" alt="" src={pv.url} style={box} /> : srcUrl && <img className="out" alt="" src={srcUrl} style={box} />)}
          {it && (it.bad || (showOut && err)) && <div className="warnbox">{it.bad ? tr('読み込めません') : err}</div>}
          <AddHint hidden={!!items.length} formats="JPEG · PNG · WebP · GIF · BMP · AVIF" />
        </div>
        <div className="status" hidden={!it}>
          <span id="cName">{it ? showOut ? outNames[cur] : it.name : ''}</span>
          <span id="cSize" className="num" style={{ marginLeft: 'auto' }}>{sizeLine}</span>
          <span id="cState" className="num">{it ? showOut ? pv ? `${kb(it.file.size)} → ${kb(pv.size)}` : '' : kb(it.file.size) : ''}</span>
          <Seg id="cView" value={view} options={[['src', tr('元')], ['out', tr('出力')]]} onChange={setView} />
          <button className="link ic" id="cSave" disabled={busy || !it || it.bad} aria-label={tr('選択中を保存')} title={tr('選択中を保存')} onClick={() => it && run([it], false)}>{ICON.save}</button>
        </div>
      </main>
      <aside className="panel clist" aria-label={tr('ファイル')}>
        <div className="ph"><b><Lbl>{tr('ファイル')}</Lbl></b>
          <span hidden={!items.length}>
            <button className="link ic" id="cSort" disabled={busy} aria-label={tr('名前順に並べ替え')} title={tr('名前順に並べ替え')} onClick={sortByName}>{ICON.sort}</button>
            <button className="link ic" id="cClear" disabled={busy} aria-label={tr('全削除')} title={tr('全削除')} onClick={() => { setItems([]); setCur(0); setStatus([]); }}>{ICON.trash}</button>
          </span>
        </div>
        <div className="flist" role="listbox" aria-label={tr('ファイル')}>
          {items.map((x, i) => (
            <div key={x.id} role="option" aria-selected={i === cur} tabIndex={0} className={'row' + (i === cur ? ' sel' : '')} onClick={() => setCur(i)}
              onKeyDown={e => { if (e.key === 'ArrowDown' && i < items.length - 1) { setCur(i + 1); (e.currentTarget.nextSibling as HTMLElement)?.focus(); e.preventDefault(); } else if (e.key === 'ArrowUp' && i > 0) { setCur(i - 1); (e.currentTarget.previousSibling as HTMLElement)?.focus(); e.preventDefault(); } else if (e.key === 'Delete' && !busy) remove(i); }}>
              <span className="thumb" style={x.thumb ? { backgroundImage: `url(${x.thumb}), ${CHK}`, backgroundSize: 'contain, 6px 6px', backgroundRepeat: 'no-repeat, repeat', backgroundPosition: 'center, 0 0' } : undefined} />
              <span className="nm"><span className="name" title={x.name}>{x.name}</span>{x.bad ? <span className="sub warn">{tr('読み込めません')}</span> : <span className="sub" title={outNames[i]}>{outNames[i]}</span>}</span>
              <button className="tx" aria-label={tr('閉じる')} title={tr('閉じる')} disabled={busy} onClick={e => { e.stopPropagation(); remove(i); }}>{X}</button>
            </div>
          ))}
        </div>
      </aside>
      <aside className="panel inspector" aria-label={tr('書き出し設定')}>
        <div className="insp">
          <fieldset className="lock" disabled={busy}>
          <div className="sec">
            <div className="prop"><span><Lbl>{tr('形式')}</Lbl></span><Seg id="cFmt" value={o.fmt} options={[['orig', tr('元')], ['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']]} onChange={v => set('fmt', v)} /></div>
            <label className="prop" htmlFor="cQuality" hidden={o.fmt === 'png'}><span><Lbl>{tr('画質')}</Lbl></span><span className="unit"><input id="cQuality" className="n" type="number" min="1" max="100" value={o.quality} onChange={e => set('quality', e.target.value)} /></span></label>
          </div>
          <div className="sec">
            <div className="prop"><span><Lbl>{tr('サイズ')}</Lbl></span><Seg id="cSizeMode" value={o.size === 'orig' ? 'orig' : 'set'} options={[['orig', tr('原寸')], ['set', <Lbl other={trAlt('指定')}>{tr('指定')}</Lbl>]]} onChange={v => set('size', v === 'orig' ? 'orig' : side.current)} /></div>
            <div className="prop" id="cSizeRow" hidden={o.size === 'orig'}>
              <select id="cSide" aria-label={tr('基準の辺')} value={o.size} onChange={e => { side.current = e.target.value as Side; set('size', side.current); }}>
                <option value="long">{tr('長辺')}</option><option value="w">{tr('幅')}</option><option value="h">{tr('高さ')}</option><option value="pct">%</option>{altOptions([['長辺'], ['幅'], ['高さ']])}
              </select>
              <span className="unit" style={{ gridColumn: '2 / -1' }}>
                {o.size === 'pct' ? <><input id="cPct" className="n" type="number" min="1" max="1000" value={o.pct} aria-label={tr('倍率')} onChange={e => set('pct', e.target.value)} />%</>
                  : <><input id="cPx" className="n" type="number" min="1" max="20000" value={o.px} aria-label={tr('ピクセル')} onChange={e => set('px', e.target.value)} />px</>}
              </span>
            </div>
            <label className="prop sw" htmlFor="cNoUp" hidden={o.size === 'orig'}><span><Lbl>{tr('拡大しない')}</Lbl></span><input id="cNoUp" type="checkbox" checked={o.noUp} onChange={e => set('noUp', e.target.checked)} /></label>
          </div>
          <div className="sec">
            <div className="prop"><span><Lbl>{tr('回転')}</Lbl></span><Seg id="cRot" value={o.rot} tips={{ '90': tr('右に90°'), '270': tr('左に90°') }} options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]} onChange={v => set('rot', v)} /></div>
            <div className="prop"><span><Lbl>{tr('反転')}</Lbl></span><Toggles id="cFlip" values={[...(o.flipH ? ['h'] : []), ...(o.flipV ? ['v'] : [])] as ('h' | 'v')[]} options={[['h', tr('左右')], ['v', tr('上下')]]} onToggle={v => v === 'h' ? set('flipH', !o.flipH) : set('flipV', !o.flipV)} /></div>
          </div>
          <div className="sec">
            <NameRows p="c" o={o} set={set as never} />
          </div>
          <div className="sec">
            <SignRows />
          </div>
          </fieldset>
          <div className="sec theme-sec">
            <ThemeRow />
          </div>
        </div>
        <div className="foot">
          <div className="sumrow"><span id="cSum" className="num">{tr('{n} ファイル', { n: ok })}</span><span id="cStatus" className="muted" role="status" aria-live="polite"><StatusText s={status} /></span></div>
          <fieldset className="lock" disabled={busy}>
          <div className="act">
            <Seg id="cOut" value={o.out} options={[['zip', 'ZIP'], ['each', tr('個別')], ['dir', tr('フォルダに保存')]]} hiddenValues={outDir ? [] : ['dir']} onChange={v => set('out', v)} />
          </div>
          </fieldset>
        </div>
        <div className="insp theme-end"><div className="sec"><ThemeRow /></div></div>
      </aside>
    </section>
  );
}

declare global { function showDirectoryPicker(o?: { id?: string; mode?: string }): Promise<FileSystemDirectoryHandle> }
// Convert and save `list` (numbered from `first`): one ZIP, files one by one (phones: the share sheet), or a folder.
async function exportList(o: ConvSettings, list: Item[], first: number, out: ConvSettings['out'], progress: (s: Status) => void, noDir: () => void, signal: AbortSignal): Promise<Status> {
  const sign = getSign();
  let dir: FileSystemDirectoryHandle | null = null;
  if (out === 'dir') {
    try { dir = await showDirectoryPicker({ id: 'butcher-out', mode: 'readwrite' }); }
    catch (e: any) { if (e.name === 'AbortError') return [{ t: tr('保存を取り消しました') }]; noDir(); return [{ t: tr('この環境ではフォルダに保存できません'), c: 'err' }]; }
  }
  await signReady(sign);
  const names = makeNamer(true), zip = out === 'zip' ? new (await loadZip())() : null, share = out === 'each' && shareMode(), files: { name: string; data: Blob }[] = [];
  let written = 0, failed = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      progress([{ t: `${i + 1}/${list.length}` }]);
      await new Promise(r => setTimeout(r));
      if (signal.aborted) return [{ t: written && out !== 'zip' ? tr('{n} ファイルを書き出して中止しました', { n: written }) : tr('中止しました') }];
      let blob: Blob;
      try { blob = (await convertFile(o, x.file, x.name, sign)).blob; }
      catch (e) { if (e instanceof NoEncoder) return [{ t: tr('このブラウザは{f}書き出しに対応していません', { f: 'WebP' }), c: 'err' }]; failed++; continue; }
      const ext = '.' + extFor(o.fmt, x.name), name = names.take(safe(ruleName(o, stemOf(x.name), first + i)), [ext]) + ext;
      if (dir) await writeTo(dir, name, blob);
      else if (zip) zip.file(name, blob);
      else if (share) files.push({ name, data: blob });
      else { const r = await saveBlob(name, blob); if (r !== 'ok') return [{ t: saveFailText(r) }]; }
      written++;
    }
    if (!written) return [{ t: tr('書き出せる画像がありません'), c: 'err' }];
    if (zip) {
      const data = await zip.generateAsync({ type: 'blob' });
      if (signal.aborted) return [{ t: tr('中止しました') }];
      const r = await saveBlob('images.zip', data); if (r !== 'ok') return [{ t: saveFailText(r) }];
    }
    if (share) { const r = await saveFiles(files); if (r !== 'ok') return [{ t: saveFailText(r) }]; }
    return [{ t: tr('{n} ファイルを書き出し', { n: written }), c: 'ok' }, ...(failed ? [{ t: ' · ' }, { t: tr('{n} 件を省略', { n: failed }), c: 'warn' as const }] : [])];
  } catch (e: any) { return [{ t: tr('エラー: {e}', { e: tr(String(e.message || e)) }), c: 'err' }]; }
}
