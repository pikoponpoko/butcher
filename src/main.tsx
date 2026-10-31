import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
