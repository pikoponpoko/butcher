// Size presets: one export writes every checked size, named <name>_<id>.<ext> (e.g. name_x-16x9.png, name_iphone-1320x2868.png).
export type Group = 'sns' | 'wp';
export type Fit = 'cover' | 'contain';
export interface Preset { id: string; group: Group; svc: string; label: string; w: number; h: number }

const p = (group: Group, svc: string, label: string, w: number, h: number, id = `${svc}-${w}x${h}`): Preset => ({ id, group, svc, label, w, h });
const sns = (svc: 'x' | 'ig', ratio: string, w: number, h: number) => p('sns', svc, ratio, w, h, `${svc}-${ratio.replace(':', 'x')}`);
const wp = (svc: string, label: string, w: number, h: number) => p('wp', svc, label, w, h);
// Wallpapers: current flagship / most common screens per device family.
const WALLPAPER: Preset[] = [
  wp('iphone', 'Pro Max', 1320, 2868), wp('iphone', 'Pro', 1206, 2622), wp('iphone', '標準', 1179, 2556),
  wp('android', 'FHD+', 1080, 2400), wp('android', 'QHD+', 1440, 3120),
  wp('ipad', '13インチ', 2064, 2752), wp('ipad', '11インチ', 1640, 2360),
  wp('pc', 'FHD', 1920, 1080), wp('pc', 'QHD', 2560, 1440), wp('pc', '4K', 3840, 2160), wp('pc', 'Mac', 3024, 1964),
];
// Feed images: X keeps PNG, Instagram re-encodes everything as JPEG.
export const IMAGE_PRESETS: Preset[] = [
  sns('x', '16:9', 1600, 900), sns('x', '1:1', 1080, 1080), sns('x', '3:4', 1080, 1440),
  sns('ig', '1.91:1', 1080, 566), sns('ig', '1:1', 1080, 1080), sns('ig', '4:5', 1080, 1350), sns('ig', '3:4', 1080, 1440), sns('ig', '9:16', 1080, 1920),
  ...WALLPAPER,
];
export const VIDEO_PRESETS: Preset[] = [
  sns('x', '16:9', 1920, 1080), sns('x', '1:1', 1080, 1080), sns('x', '9:16', 1080, 1920),
  sns('ig', '16:9', 1080, 608), sns('ig', '1:1', 1080, 1080), sns('ig', '4:5', 1080, 1350), sns('ig', '3:4', 1080, 1440), sns('ig', '9:16', 1080, 1920),
  ...WALLPAPER,
];
// X accepts GIF; these sizes keep a 15 MB GIF practical.
export const X_GIF: Record<string, [number, number]> = { 'x-16x9': [1280, 720], 'x-1x1': [720, 720], 'x-9x16': [720, 1280] };

export const SERVICES: Record<Group, [string, string][]> = {
  sns: [['x', 'X'], ['ig', 'Instagram']],
  wp: [['iphone', 'iPhone'], ['android', 'Android'], ['ipad', 'iPad'], ['pc', 'PC']],
};
export const PICKS_DEFAULT = ['x-16x9', 'x-1x1', 'ig-1x1', 'ig-4x5', 'ig-9x16', 'iphone-1320x2868', 'android-1080x2400', 'ipad-2064x2752', 'pc-1920x1080', 'pc-3840x2160'];
export const FITS_DEFAULT: Record<Group, Fit> = { sns: 'contain', wp: 'cover' };
export const picked = (all: Preset[], group: Group, ids: string[]) => all.filter(s => s.group === group && ids.includes(s.id));
export const toggleId = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
