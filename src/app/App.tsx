// App shell: toolbar, image tool (layers / stage / inspector) and the GIF・動画 tool.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useImageTool } from './image/useImageTool';
import { Inspector, LayersPanel, Stage } from './image/ImagePanels';
import { GifTool, isVideo, type GifState, type GifToolApi } from './gif/GifTool';
import { LINE_RE, LineTool, type LineState, type LineToolApi } from './line/LineTool';
import { Lbl, Seg, Swap } from './ui';
import { setLang, tr, useLang } from './i18n';
const ic = (d: string) => <svg width="16" height="16" viewBox="0 0 16 16"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>;
// tool switch icons for phones, where the names don't fit next to the document tabs
const TOOL_ICON = {
  img: ic('M2 3h12v10H2ZM2 11l3.5-3.5 3 3 2-2L14 12M10.5 6.2h.01'),
  gif: ic('M2 3h12v10H2ZM6.5 5.8v4.4L10.2 8Z'),
  line: ic('M10.5 2.5l3 3-7.5 7.5H3v-3ZM9 4l3 3'),
};
import { IMG_ACCEPT, LINE_ACCEPT, VIDEO_ACCEPT, pickFiles, takeShared } from './pick';

type Tool = 'img' | 'gif' | 'line';

declare global { interface Window { butcherDesktop?: { version: string; checkUpdate(): Promise<'latest' | 'opened'> } } }

// Desktop app only: opens the latest release page when a newer version exists.
function UpdateLink() {
  const [st, setSt] = useState<'idle' | 'busy' | 'latest'>('idle');
  const run = async () => {
    setSt('busy');
    const r = await window.butcherDesktop!.checkUpdate().catch(() => 'opened' as const);
    setSt(r === 'latest' ? 'latest' : 'idle');
    if (r === 'latest') setTimeout(() => setSt('idle'), 3000);
  };
  return <button className="link" id="update" disabled={st === 'busy'} onClick={run}><Lbl>{tr(st === 'latest' ? '最新版です' : 'アップデートを確認')}</Lbl></button>;
}

export function App() {
  const t = useImageTool();
  // keep the current document's tab in view when the tab row scrolls (phones)
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.tab.on'), row = el?.parentElement; if (!el || !row) return;
    if (el.offsetLeft < row.scrollLeft) row.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = el.offsetLeft + el.offsetWidth - row.clientWidth;
  }, [t.cur, t.docs.length]);
  const lang = useLang();
  const [tool, setTool] = useState<Tool>('img');
  const [round, setRound] = useState(false);
  const [fold, setFold] = useState(false);
  const gif = useRef<GifToolApi>(null), line = useRef<LineToolApi>(null);
  const live = useRef({ t, tool, setTool, gifBusy: false }); live.current = { t, tool, setTool, gifBusy: false };

  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tool !== 'img') return;
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || live.current.t.busy || (el && ((/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !['checkbox', 'radio', 'range', 'color'].includes((el as HTMLInputElement).type)) || el.isContentEditable))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) live.current.t.undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') live.current.t.redo();
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [tool]);
  useLayoutEffect(() => {
    // folded layers: the stage fills the screen below the (wrapping) toolbar
    const app = appRef.current!, bar = app.querySelector('.bar')!;
    const ro = new ResizeObserver(() => app.style.setProperty('--bar-h', bar.getBoundingClientRect().height + 'px'));
    ro.observe(bar); return () => ro.disconnect();
  }, []);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    // phones: hide the bottom export bar while the keyboard is up
    const text = (e: Event) => { const el = e.target as HTMLElement; return el.tagName === 'INPUT' && !['checkbox', 'file', 'radio'].includes((el as HTMLInputElement).type); };
    const on = (e: FocusEvent) => { if (text(e)) setTyping(true); }, off = (e: FocusEvent) => { if (text(e)) setTyping(false); };
    addEventListener('focusin', on); addEventListener('focusout', off);
    return () => { removeEventListener('focusin', on); removeEventListener('focusout', off); };
  }, []);
  const openAny = (files: File[]) => {
    const vid = files.find(isVideo);
    if (vid && live.current.gifBusy) return;
    if (vid) { live.current.setTool('gif'); gif.current?.open(vid); return; }
    // the 線画 tool takes one plain image
    const ln = live.current.tool === 'line' && files.find(f => LINE_RE.test(f.name));
    if (ln) { line.current?.open(ln); return; }
    const fs = files.filter(live.current.t.accepts); if (fs.length) { live.current.setTool('img'); live.current.t.openFiles(fs); }
  };
  useEffect(() => { takeShared().then(fs => { if (fs.length) openAny(fs); }, () => {}); }, []);
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      openAny([...(e.dataTransfer?.files || [])]);
    };
    const enter = (e: DragEvent) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); };
    addEventListener('dragenter', enter); addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, []);

  const fileRef = useRef<HTMLInputElement>(null), gFileRef = useRef<HTMLInputElement>(null), lFileRef = useRef<HTMLInputElement>(null);
  const pickLine = () => pickFiles('butcher-line', LINE_ACCEPT, false, lFileRef.current, fs => { if (fs[0]) line.current?.open(fs[0]); });
  const [lineSt, setLineSt] = useState<LineState>({ open: false, busy: false });
  const pickVideo = () => pickFiles('butcher-video', VIDEO_ACCEPT, false, gFileRef.current, fs => { if (fs[0]) gif.current?.open(fs[0]); });
  const pickImages = () => pickFiles('butcher-image', IMG_ACCEPT, true, fileRef.current, fs => t.openFiles(fs));
  const [gifSt, setGifSt] = useState<GifState>({ open: false, ready: false, busy: false });
  live.current.gifBusy = gifSt.busy;
  // ask before leaving (reload, back, closing the tab) while files are open
  const working = t.docs.length > 0 || gifSt.open || lineSt.open;
  useEffect(() => {
    if (!working) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', ask); return () => removeEventListener('beforeunload', ask);
  }, [working]);

  return (
    <div ref={appRef} className={'app' + (tool === 'gif' ? ' tool-gif' : tool === 'line' ? ' tool-line' : '') + (fold ? ' folded' : '') + (typing ? ' typing' : '')}>
      <header className="bar">
        <Seg id="tool" value={tool} tips={{ img: tr('画像'), gif: tr('GIF・動画'), line: tr('線画') }} options={([['img', '画像', TOOL_ICON.img], ['gif', 'GIF・動画', TOOL_ICON.gif], ['line', '線画', TOOL_ICON.line]] as const).map(([v, ja, ic]) => [v, <><span className="long"><Lbl>{tr(ja)}</Lbl></span><span className="short" aria-hidden="true">{ic}</span></>] as [typeof v, ReactNode])} onChange={v => { if (v === 'img' && tool === 'line') line.current?.send(); setTool(v); }} />
        <div className="tabs img-only" id="tabs" role="tablist">
          {t.docs.map((d, i) => (
            <div key={i} className={'tab' + (i === t.cur ? ' on' : '')}>
              <button className="tn" role="tab" title={d.name} aria-selected={i === t.cur} onClick={() => t.selectDoc(i)}>{d.name}</button>
              <button className="tx" aria-label={tr('閉じる')} title={tr('閉じる')} disabled={t.busy} onClick={() => t.closeDoc(i)}>
                <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1 1 7" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
              </button>
            </div>
          ))}
        </div>
        <div className="bar-r">
          {window.butcherDesktop && <UpdateLink />}
          <button className="link" id="lang" title={lang === 'ja' ? 'English' : '日本語'} onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}><span className="long"><Lbl other={lang === 'ja' ? '日本語' : 'English'}>{lang === 'ja' ? 'English' : '日本語'}</Lbl></span><span className="short">{lang === 'ja' ? 'EN' : 'JA'}</span></button>
          <button className="btn img-only" id="add" onClick={pickImages}><Swap labels={['開く', '追加']} at={t.docs.length ? 1 : 0} /></button>
          <button className="btn line-only" id="lAdd" disabled={lineSt.busy} onClick={pickLine}><Swap labels={['開く', '追加']} at={0} /></button>
          <button className="btn gif-only" id="gAdd" disabled={gifSt.busy} onClick={pickVideo}><Swap labels={['開く', '追加']} at={gifSt.open ? 1 : 0} /></button>
          {/* while an export runs the same button cancels it */}
          <button className="btn primary img-only" id="export" disabled={!t.busy && (!t.doc || !t.summary.n)} onClick={t.busy ? t.cancel : t.doExport}><Swap labels={['一括書き出し', '中止']} at={t.busy ? 1 : 0} /></button>
          <button className="btn primary gif-only" id="gExport" disabled={!gifSt.ready && !gifSt.busy} onClick={() => gifSt.busy ? gif.current?.cancel() : gif.current?.export()}><Swap labels={['書き出し', '中止']} at={gifSt.busy ? 1 : 0} /></button>
          <button className="btn primary line-only" id="lExport" disabled={!lineSt.open || lineSt.busy} onClick={() => line.current?.export()}><Swap labels={['書き出し', '中止']} at={0} /></button>
          {/* application/mp4 is not video/*, so Android Chrome shows a camera + files chooser instead of the photo picker. */}
          <input ref={gFileRef} id="gFile" className="fi" type="file" accept="video/*,.mp4,.webm,.mov,.m4v,application/mp4" tabIndex={-1} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) gif.current?.open(f); }} />
          <input ref={lFileRef} id="lFile" className="fi" type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,.gif" tabIndex={-1} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) line.current?.open(f); }} />
          <input ref={fileRef} id="file" className="fi" type="file" accept=".psd,.psb,.clip,.png,.jpg,.jpeg,.webp,.gif,.bmp,.pdf,application/pdf" multiple tabIndex={-1} onChange={async e => { const fs = [...(e.target.files || [])]; e.target.value = ''; await t.openFiles(fs); }} />
        </div>
      </header>
      <LayersPanel t={t} round={round} setRound={setRound} fold={fold} setFold={setFold} />
      <Stage t={t} round={round} onPick={pickImages} active={tool === 'img'} />
      <Inspector t={t} />
      <GifTool active={tool === 'gif'} ref={gif} onPick={pickVideo} onState={setGifSt} />
      <LineTool active={tool === 'line'} ref={line} onPick={pickLine} onState={setLineSt} onOpenImage={(name, psd) => { t.addDoc(name, psd); setTool('img'); }} />
    </div>
  );
}
