// Save a blob: the Claude artifact downloads API when present, otherwise a regular download link.
import { tr } from './i18n';

export type SaveResult = 'ok' | 'declined' | 'failed';
type DownloadsApi = { save(o: { filename: string; data: Blob }): Promise<unknown> };
declare global { interface Window { claude?: { use?(name: string): Promise<DownloadsApi> } } }

let dlApi: DownloadsApi | null | undefined;
export async function saveBlob(name: string, data: Blob): Promise<SaveResult> {
  if (dlApi === undefined) dlApi = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
  if (!dlApi) { const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); await new Promise(r => setTimeout(r, 250)); return 'ok'; }
  for (let i = 0; ; i++) {
    try { await dlApi.save({ filename: name, data }); return 'ok'; }
    catch (e: any) { if (e && e.code === 'rate_limited' && i < 8) { await new Promise(r => setTimeout(r, 1500)); continue; } return e && e.code === 'declined' ? 'declined' : 'failed'; }
  }
}
export const saveFailText = (r: SaveResult) => tr(r === 'declined' ? '保存を取り消しました' : '保存できませんでした');

// Phones: hand the files to the share sheet (Google フォト, X, Instagram …) instead of downloading.
// The share sheet needs a recent tap; when it has expired (a long encode) or sharing isn't possible, the files are downloaded.
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm' };
const asFile = (name: string, data: Blob) => new File([data], name, { type: data.type || MIME[name.split('.').pop()!.toLowerCase()] || '' });
export const shareMode = () => matchMedia('(pointer: coarse)').matches && typeof navigator.canShare === 'function';
export async function saveFiles(list: { name: string; data: Blob }[]): Promise<SaveResult> {
  if (shareMode() && list.length) {
    const files = list.map(f => asFile(f.name, f.data));
    const active = (navigator as any).userActivation?.isActive ?? true;
    if (active && navigator.canShare({ files })) {
      try { await navigator.share({ files }); return 'ok'; }
      catch (e: any) { if (e?.name === 'AbortError') return 'declined'; }
    }
  }
  for (const f of list) { const r = await saveBlob(f.name, f.data); if (r !== 'ok') return r; }
  return 'ok';
}
