// File pickers that start in the folder used last time (Chrome / Edge on PC: File System Access API,
// the browser remembers the folder per id). Elsewhere — Android, Safari, Firefox, the artifact iframe —
// the hidden <input type=file> is used.
type Accept = Record<string, string[]>;
type OpenPicker = (o: { id?: string; multiple?: boolean; types?: { accept: Accept }[]; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;

export const canRemember = () => typeof (window as any).showOpenFilePicker === 'function' && window.self === window.top;

export async function pickFiles(id: string, accept: Accept, multiple: boolean, input: HTMLInputElement | null, onFiles: (fs: File[]) => void) {
  if (!canRemember()) { input?.click(); return; }
  try {
    const hs = await ((window as any).showOpenFilePicker as OpenPicker)({ id, multiple, types: [{ accept }] });
    onFiles(await Promise.all(hs.map(h => h.getFile())));
  } catch (e: any) { if (e?.name !== 'AbortError') input?.click(); }
}

export const IMG_ACCEPT: Accept = { 'image/*': ['.psd', '.psb', '.clip', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] };
export const VIDEO_ACCEPT: Accept = { 'video/*': ['.mp4', '.webm', '.mov', '.m4v'] };

// Files shared to the installed app (Android: ギャラリー → 共有 → Butcher). The service worker keeps them in a cache.
export const SHARE_CACHE = 'butcher-share';
export async function takeShared(): Promise<File[]> {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return [];
  history.replaceState(null, '', location.pathname);
  const c = await caches.open(SHARE_CACHE), out: File[] = [];
  for (const req of await c.keys()) {
    const res = await c.match(req); if (!res) continue;
    const blob = await res.blob(), type = res.headers.get('content-type') || blob.type;
    let name = decodeURIComponent(res.headers.get('x-name') || 'shared');
    if (!/\.[a-z0-9]+$/i.test(name)) { const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov'); if (ext) name += '.' + ext; }
    out.push(new File([blob], name, { type }));
  }
  await caches.delete(SHARE_CACHE);
  return out;
}
