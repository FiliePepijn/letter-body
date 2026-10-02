/* Minimal .pcd reader: ascii or binary, x/y/z (other fields are skipped). */
export function parsePCD(buf: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buf);
  // header is ascii up to and including the DATA line
  let end = 0, header = '';
  for (let line = ''; end < bytes.length; end++) {
    const ch = String.fromCharCode(bytes[end]);
    if (ch !== '\n') { line += ch; continue; }
    header += line + '\n';
    if (line.startsWith('DATA')) { end++; break; }
    line = '';
  }
  const field = (k: string) => header.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1].trim().split(/\s+/) ?? [];
  const fields = field('FIELDS'), size = field('SIZE').map(Number), type = field('TYPE');
  const count = field('COUNT').map(Number), n = Number(field('POINTS')[0]), data = field('DATA')[0];
  const ix = fields.indexOf('x'), iy = fields.indexOf('y'), iz = fields.indexOf('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('pcd: no x/y/z');
  const out = new Float32Array(n * 3);

  if (data === 'ascii') {
    const rows = new TextDecoder().decode(bytes.subarray(end)).trim().split('\n');
    const col = (f: number) => fields.slice(0, f).reduce((s, _, k) => s + (count[k] || 1), 0);
    const cx = col(ix), cy = col(iy), cz = col(iz);
    for (let p = 0; p < n && p < rows.length; p++) {
      const v = rows[p].trim().split(/\s+/);
      out[p * 3] = +v[cx]; out[p * 3 + 1] = +v[cy]; out[p * 3 + 2] = +v[cz];
    }
    return out;
  }
  if (data !== 'binary') throw new Error(`pcd: DATA ${data} not supported (save as ascii or binary)`);
  if ([ix, iy, iz].some(f => type[f] !== 'F' || size[f] !== 4)) throw new Error('pcd: x/y/z must be float32');
  const offset = (f: number) => fields.slice(0, f).reduce((s, _, k) => s + size[k] * (count[k] || 1), 0);
  const stride = offset(fields.length), ox = offset(ix), oy = offset(iy), oz = offset(iz);
  const view = new DataView(buf, end);
  for (let p = 0; p < n; p++) {
    const b = p * stride;
    out[p * 3] = view.getFloat32(b + ox, true);
    out[p * 3 + 1] = view.getFloat32(b + oy, true);
    out[p * 3 + 2] = view.getFloat32(b + oz, true);
  }
  return out;
}
