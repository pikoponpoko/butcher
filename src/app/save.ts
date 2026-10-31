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
