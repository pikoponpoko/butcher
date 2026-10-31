// App shell: toolbar, image tool (layers / stage / inspector) and the GIF・動画 tool.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useImageTool } from './image/useImageTool';
import { Inspector, LayersPanel, Stage } from './image/ImagePanels';
import { GifTool, isVideo, type GifToolApi } from './gif/GifTool';
import { Lbl, Seg } from './ui';
import { setLang, tr, useLang } from './i18n';

type Tool = 'img' | 'gif';

export function App() {
  const t = useImageTool();
  const lang = useLang();
  const [tool, setTool] = useState<Tool>('img');
  const [round, setRound] = useState(false);
  const [fold, setFold] = useState(false);
  const gif = useRef<GifToolApi>(null);
  const live = useRef({ t, setTool }); live.current = { t, setTool };

  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tool !== 'img') return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
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
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      const vid = files.find(isVideo);
      if (vid) { live.current.setTool('gif'); gif.current?.open(vid); return; }
      const fs = files.filter(live.current.t.accepts); if (fs.length) live.current.t.openFiles(fs);
    };
    const enter = (e: DragEvent) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); };
    addEventListener('dragenter', enter); addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, []);

  const fileRef = useRef<HTMLInputElement>(null), gFileRef = useRef<HTMLInputElement>(null);
  const pickVideo = () => gFileRef.current!.click();
  const [gifSt, setGifSt] = useState({ open: false, ready: false });
  const plus = <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;

  return (
    <div ref={appRef} className={'app' + (tool === 'gif' ? ' tool-gif' : '') + (fold ? ' folded' : '')}>
      <header className="bar">
        <Seg id="tool" value={tool} options={[['img', tr('画像')], ['gif', tr('GIF・動画')]]} onChange={setTool} />
        <div className="tabs img-only" id="tabs" role="tablist">
          {t.docs.map((d, i) => (
            <div key={i} className={'tab' + (i === t.cur ? ' on' : '')}>
              <button className="tn" role="tab" title={d.name} aria-selected={i === t.cur} onClick={() => t.selectDoc(i)}>{d.name}</button>
              <button className="tx" aria-label={tr('閉じる')} title={tr('閉じる')} onClick={() => t.closeDoc(i)}>
                <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1 1 7" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
              </button>
            </div>
          ))}
        </div>
        <div className="bar-r">
          <button className="link" id="lang" onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}><Lbl other={lang === 'ja' ? '日本語' : 'English'}>{lang === 'ja' ? 'English' : '日本語'}</Lbl></button>
          <button className="link ic img-only" id="add" hidden={!t.docs.length} aria-label={tr('開く')} title={tr('開く')} onClick={() => fileRef.current!.click()}>{plus}</button>
          <button className="link ic gif-only" id="gAdd" hidden={!gifSt.open} aria-label={tr('開く')} title={tr('開く')} onClick={pickVideo}>{plus}</button>
          <button className="btn primary img-only" id="export" disabled={t.busy || !t.doc} onClick={t.doExport}><Lbl>{tr('書き出し')}</Lbl></button>
          <button className="btn primary gif-only" id="gExport" disabled={!gifSt.ready} onClick={() => gif.current?.export()}><Lbl>{tr('書き出し')}</Lbl></button>
          {/* application/mp4 is not video/*, so Android Chrome shows a camera + files chooser instead of the photo picker. */}
          <input ref={gFileRef} id="gFile" className="fi" type="file" accept="video/*,.mp4,.webm,.mov,.m4v,application/mp4" tabIndex={-1} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) gif.current?.open(f); }} />
          <input ref={fileRef} id="file" className="fi" type="file" accept=".psd,.psb,.clip,.png,.jpg,.jpeg,.webp,.gif,.bmp" multiple tabIndex={-1} onChange={async e => { const fs = [...(e.target.files || [])]; e.target.value = ''; await t.openFiles(fs); }} />
        </div>
      </header>
      <LayersPanel t={t} round={round} setRound={setRound} fold={fold} setFold={setFold} />
      <Stage t={t} round={round} onPick={() => fileRef.current!.click()} />
      <Inspector t={t} />
      <GifTool active={tool === 'gif'} ref={gif} onPick={pickVideo} onState={setGifSt} />
    </div>
  );
}
