declare module 'gifenc' {
  export function GIFEncoder(): { writeFrame(index: Uint8Array, w: number, h: number, o?: Record<string, unknown>): void; finish(): void; bytes(): Uint8Array };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, o?: Record<string, unknown>): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}

declare module 'utif' { const UTIF: any; export default UTIF; }
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' { const factory: (o?: object) => any; export default factory; }
