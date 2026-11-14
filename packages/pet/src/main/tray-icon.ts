import { type NativeImage, nativeImage } from 'electron';

/**
 * Draws the tray icon in code (a rounded robot face), so the app ships no image
 * files. Raw BGRA pixels at 32x32, scaled down by Windows as needed.
 */
export function trayIcon(muted: boolean): NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const face = muted ? [150, 150, 150] : [255, 210, 63]; // BGR: cyan-blue glow vs grey
  const shell = muted ? [110, 110, 110] : [70, 45, 25];
  const put = (x: number, y: number, rgbBgr: number[], a = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = rgbBgr[0] as number;
    buf[i + 1] = rgbBgr[1] as number;
    buf[i + 2] = rgbBgr[2] as number;
    buf[i + 3] = a;
  };
  const inRounded = (
    x: number,
    y: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    r: number,
  ) => {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (inRounded(px, py, 2, 4, 28, 26, 9)) put(x, y, shell);
      if (inRounded(px, py, 6, 10, 20, 13, 6)) put(x, y, [25, 18, 12]);
      const eye = (ex: number) => (px - ex) ** 2 / 4 + (py - 16.5) ** 2 / 6.25 <= 1;
      if (eye(12) || eye(20)) put(x, y, face);
      if ((px - 16) ** 2 + (py - 2.5) ** 2 <= 4) put(x, y, face);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
