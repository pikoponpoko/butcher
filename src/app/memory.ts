// Rough memory budget for one export or one open file. Browsers don't expose free memory; Chrome reports the
// device's RAM (navigator.deviceMemory, capped at 8 GB), other browsers report nothing. A tab gets a share of it.
export const MB = 1048576;
export function memBudget() {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const ram = dm || (matchMedia('(pointer: coarse)').matches ? 4 : 8);
  return Math.min(1.2e9, ram * 1024 * MB * 0.2);
}
export const fmtMem = (b: number) => b >= 1024 * MB ? (b / 1024 / MB).toFixed(1) + ' GB' : Math.ceil(b / MB) + ' MB';
// Compositing keeps several canvas-sized Float32 RGBA buffers (16 bytes per pixel each): the result, the backdrop
// copy and the isolated layer for clipping, one more per nested folder level, plus the 8-bit result.
export const compositeBytes = (W: number, H: number, depth: number) => W * H * (16 * (3 + depth) + 4);
