// Libraries loaded on first use, so the first screen doesn't wait for them.
import { tr } from './i18n';

const stale = (): never => { throw new Error(tr('アプリが更新されました。ページを再読み込みしてください')); };
function once<T>(load: () => Promise<T>) {
  let p: Promise<T> | undefined;
  return () => p ||= load().catch(() => { p = undefined; return stale(); });
}
export const loadZip = once(() => import('jszip').then(m => m.default));
export const loadPsd = once(() => import('ag-psd'));
