// App shell: toolbar, image tool (layers / stage / inspector) and the GIF・動画 tool.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useImageTool } from './image/useImageTool';
import { Inspector, LayersPanel, Stage } from './image/ImagePanels';
import { GifTool, isVideo, type GifState, type GifToolApi } from './gif/GifTool';
import { Lbl, Seg, Swap } from './ui';
import { setLang, tr, useLang } from './i18n';
import { IMG_ACCEPT, VIDEO_ACCEPT, pickFiles, takeShared } from './pick';

type Tool = 'img' | 'gif';

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
  const lang = useLang();
  const [tool, setTool] = useState<Tool>('img');
  const [round, setRound] = useState(false);
  const [fold, setFold] = useState(false);
  const gif = useRef<GifToolApi>(null);
  const live = useRef({ t, setTool, gifBusy: false }); live.current = { t, setTool, gifBusy: false };

  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tool !== 'img') return;
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || live.current.t.busy || (el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable))) return;
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

  const fileRef = useRef<HTMLInputElement>(null), gFileRef = useRef<HTMLInputElement>(null);
  const pickVideo = () => pickFiles('butcher-video', VIDEO_ACCEPT, false, gFileRef.current, fs => { if (fs[0]) gif.current?.open(fs[0]); });
  const pickImages = () => pickFiles('butcher-image', IMG_ACCEPT, true, fileRef.current, fs => t.openFiles(fs));
  const [gifSt, setGifSt] = useState<GifState>({ open: false, ready: false, busy: false });
  live.current.gifBusy = gifSt.busy;

  return (
    <div ref={appRef} className={'app' + (tool === 'gif' ? ' tool-gif' : '') + (fold ? ' folded' : '') + (typing ? ' typing' : '')}>
      <header className="bar">
        <Seg id="tool" value={tool} options={[['img', tr('画像')], ['gif', tr('GIF・動画')]]} onChange={setTool} />
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
          <button className="link" id="lang" onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}><Lbl other={lang === 'ja' ? '日本語' : 'English'}>{lang === 'ja' ? 'English' : '日本語'}</Lbl></button>
          <button className="btn img-only" id="add" onClick={pickImages}><Swap labels={['開く', '追加']} at={t.docs.length ? 1 : 0} /></button>
          <button className="btn gif-only" id="gAdd" disabled={gifSt.busy} onClick={pickVideo}><Swap labels={['開く', '追加']} at={gifSt.open ? 1 : 0} /></button>
          {/* while an export runs the same button cancels it */}
          <button className="btn primary img-only" id="export" disabled={!t.busy && !t.doc} onClick={t.busy ? t.cancel : t.doExport}><Swap labels={['一括書き出し', '中止']} at={t.busy ? 1 : 0} /></button>
          <button className="btn primary gif-only" id="gExport" disabled={!gifSt.ready && !gifSt.busy} onClick={() => gifSt.busy ? gif.current?.cancel() : gif.current?.export()}><Swap labels={['書き出し', '中止']} at={gifSt.busy ? 1 : 0} /></button>
          {/* application/mp4 is not video/*, so Android Chrome shows a camera + files chooser instead of the photo picker. */}
          <input ref={gFileRef} id="gFile" className="fi" type="file" accept="video/*,.mp4,.webm,.mov,.m4v,application/mp4" tabIndex={-1} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) gif.current?.open(f); }} />
          <input ref={fileRef} id="file" className="fi" type="file" accept=".psd,.psb,.clip,.png,.jpg,.jpeg,.webp,.gif,.bmp" multiple tabIndex={-1} onChange={async e => { const fs = [...(e.target.files || [])]; e.target.value = ''; await t.openFiles(fs); }} />
        </div>
      </header>
      <LayersPanel t={t} round={round} setRound={setRound} fold={fold} setFold={setFold} />
      <Stage t={t} round={round} onPick={pickImages} active={tool === 'img'} />
      <Inspector t={t} />
      <GifTool active={tool === 'gif'} ref={gif} onPick={pickVideo} onState={setGifSt} />
    </div>
  );
}
