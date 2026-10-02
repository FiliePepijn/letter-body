/** RGBA pixels → one byte of perceived brightness per pixel. */
export function toLum(rgba: Uint8ClampedArray, out = new Uint8Array(rgba.length / 4)) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++)
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return out;
}
