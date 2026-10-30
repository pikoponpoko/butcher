// SNS export sets: one export writes every checked size, named <name>_<id>.<ext> (e.g. name_x-16x9.png).
export type SnsService = 'x' | 'ig';
export interface SnsSize { id: string; svc: SnsService; ratio: string; w: number; h: number }

export const SNS_SERVICES: [SnsService, string][] = [['x', 'X'], ['ig', 'Instagram']];
// Feed images: X keeps PNG, Instagram re-encodes everything as JPEG.
export const SNS_IMAGE: SnsSize[] = [
  { id: 'x-16x9', svc: 'x', ratio: '16:9', w: 1600, h: 900 },
  { id: 'x-1x1', svc: 'x', ratio: '1:1', w: 1080, h: 1080 },
  { id: 'x-3x4', svc: 'x', ratio: '3:4', w: 1080, h: 1440 },
  { id: 'ig-1x1', svc: 'ig', ratio: '1:1', w: 1080, h: 1080 },
  { id: 'ig-4x5', svc: 'ig', ratio: '4:5', w: 1080, h: 1350 },
  { id: 'ig-3x4', svc: 'ig', ratio: '3:4', w: 1080, h: 1440 },
  { id: 'ig-9x16', svc: 'ig', ratio: '9:16', w: 1080, h: 1920 },
];
export const SNS_VIDEO: SnsSize[] = [
  { id: 'x-16x9', svc: 'x', ratio: '16:9', w: 1920, h: 1080 },
  { id: 'x-1x1', svc: 'x', ratio: '1:1', w: 1080, h: 1080 },
  { id: 'x-9x16', svc: 'x', ratio: '9:16', w: 1080, h: 1920 },
  { id: 'ig-1x1', svc: 'ig', ratio: '1:1', w: 1080, h: 1080 },
  { id: 'ig-4x5', svc: 'ig', ratio: '4:5', w: 1080, h: 1350 },
  { id: 'ig-3x4', svc: 'ig', ratio: '3:4', w: 1080, h: 1440 },
  { id: 'ig-9x16', svc: 'ig', ratio: '9:16', w: 1080, h: 1920 },
];
export const SNS_DEFAULT = ['x-16x9', 'x-1x1', 'ig-1x1', 'ig-4x5', 'ig-9x16'];
export const snsImageExt = (s: SnsSize) => s.svc === 'ig' ? 'jpg' : 'png';
export const snsPicked = (all: SnsSize[], ids: string[]) => all.filter(s => ids.includes(s.id));
export const toggleId = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
