// App shell: toolbar, image tool (layers / stage / inspector) and the GIF・動画 tool.
import { useEffect, useRef, useState } from 'react';
import { useImageTool } from './image/useImageTool';
import { Inspector, LayersPanel, Stage } from './image/ImagePanels';
import { SAMPLES } from './image/model';
import { GifTool, isVideo, type GifToolApi } from './gif/GifTool';
import { Seg } from './ui';

type Tool = 'img' | 'gif';

export function App() {
  const t = useImageTool();
  const [tool, setTool] = useState<Tool>('img');
  const [sample, setSample] = useState('02_multiple_folders.psd');
  const [round, setRound] = useState(false);
  const gif = useRef<GifToolApi>(null);
  const live = useRef({ t, setTool }); live.current = { t, setTool };

  useEffect(() => { t.openSample(sample); }, []);
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

  return (
    <div className={'app' + (tool === 'gif' ? ' tool-gif' : '')}>
      <header className="bar">
        <Seg id="tool" value={tool} options={[['img', '画像'], ['gif', 'GIF・動画']]} onChange={setTool} />
        <div className="tabs img-only" id="tabs" role="tablist">
          {t.docs.map((d, i) => <button key={i} className="tab" role="tab" title={d.name} aria-selected={i === t.cur} onClick={() => t.selectDoc(i)}>{d.name}</button>)}
        </div>
        <div className="bar-r">
          <select id="sample" className="img-only" aria-label="サンプル" value={sample} onChange={e => { setSample(e.target.value); t.openSample(e.target.value); }}>
            {SAMPLES.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <label className="btn img-only" htmlFor="file">開く</label>
          <label className="btn gif-only" htmlFor="gFile">開く</label>
          <input id="gFile" type="file" accept="video/*,.mp4,.webm,.mov,.m4v" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) gif.current?.open(f); }} />
          <input id="file" type="file" accept=".psd,.psb,.clip,.png,.jpg,.jpeg,.webp,.gif,.bmp" multiple hidden onChange={async e => { const fs = [...(e.target.files || [])]; e.target.value = ''; await t.openFiles(fs); }} />
        </div>
      </header>
      <LayersPanel t={t} round={round} setRound={setRound} />
      <Stage t={t} round={round} />
      <Inspector t={t} />
      <GifTool active={tool === 'gif'} ref={gif} />
    </div>
  );
}
