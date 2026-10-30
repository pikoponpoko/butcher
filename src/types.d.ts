declare module 'gifenc' {
  export function GIFEncoder(): { writeFrame(index: Uint8Array, w: number, h: number, o?: Record<string, unknown>): void; finish(): void; bytes(): Uint8Array };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, o?: Record<string, unknown>): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
