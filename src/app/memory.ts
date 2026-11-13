// Rough memory budget for one export or one open file. Browsers don't expose free memory; Chrome reports the
// device's RAM (navigator.deviceMemory, capped at 8 GB), other browsers report nothing. A tab gets a share of it:
// typed arrays live outside the JS heap, so a desktop tab can hold a few GB; phones kill background-heavy tabs sooner.
export const MB = 1048576;
export function memBudget() {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory, phone = matchMedia('(pointer: coarse)').matches;
  const ram = dm || (phone ? 4 : 8);
  return phone ? Math.min(1.5 * 1024 * MB, ram * 1024 * MB * 0.25) : Math.min(3 * 1024 * MB, ram * 1024 * MB * 0.4);
}
export const fmtMem = (b: number) => b >= 1024 * MB ? (b / 1024 / MB).toFixed(1) + ' GB' : Math.ceil(b / MB) + ' MB';
// Compositing keeps several canvas-sized Float32 RGBA buffers (16 bytes per pixel each): the result, the backdrop
// copy and the isolated layer for clipping, one more per nested folder level, plus the 8-bit result.
// A flat image (PNG / JPEG …) is never composited in floats: the decoded bitmap, the canvas and its 8-bit pixels while
// opening, then the preview canvas and an export copy — about five 4-byte RGBA copies at the peak.
export const imageBytes = (W: number, H: number) => W * H * 20;
export const compositeBytes = (W: number, H: number, depth: number) => W * H * (16 * (3 + depth) + 4);
