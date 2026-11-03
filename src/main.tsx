import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(<App />);

// desktop: files opened with the app arrive like a drop on the window (App handles drops)
type Opened = { name: string; data: Uint8Array };
const desktop = (window as any).butcherDesktop as { onFiles?(cb: (fs: Opened[]) => void): void } | undefined;
if (desktop?.onFiles) requestAnimationFrame(() => setTimeout(() => desktop.onFiles!(fs => {
  const dt = new DataTransfer();
  for (const f of fs) dt.items.add(new File([f.data as BlobPart], f.name));
  dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
})));

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
