// Save a blob: the Claude artifact downloads API when present, otherwise a regular download link.
const $ = id => document.getElementById(id);
let dlApi;
export async function saveBlob(name, data) {
  if (dlApi === undefined) dlApi = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
  if (!dlApi) { const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); await new Promise(r => setTimeout(r, 250)); return true; }
  for (let i = 0; ; i++) {
    try { await dlApi.save({ filename: name, data }); return true; }
    catch (e) { if (e && e.code === 'rate_limited' && i < 8) { await new Promise(r => setTimeout(r, 1500)); continue; } $('status').textContent = e && e.code === 'declined' ? '保存を取り消しました' : '保存できませんでした'; return false; }
  }
}
