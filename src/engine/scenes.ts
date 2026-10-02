/* Per-slide scenes, rendered in letters behind the body. Each one produces a
   brightness map (SceneFrame) that the engine samples per grid cell, like the
   camera picture. Nothing here reads pixels back on the main thread. */
import type { Scene } from './config';
import { parsePCD } from './pcd';

export interface SceneFrame {
  lum: Uint8Array;           // 0..255
  lw: number; lh: number;    // map size
  w: number; h: number;      // picture aspect for the cover fit
}
export interface Grid { W: number; H: number; cols: number; rows: number }

export interface SceneLayer {
  mix: number;                                   // 0..1 crossfade, driven by the engine
  idx: Int32Array | null;                        // engine's cell → map lookup cache
  idxKey: string;
  setActive(on: boolean): void;
  frame(now: number, dt: number, grid: Grid, fps: number): SceneFrame | null;
  destroy(): void;
}

export function createScene(scene: Scene): SceneLayer {
  return scene.kind === 'cloud' ? new CloudScene(scene.src) : new VideoScene(scene.src);
}

// ---------- video ----------
// one worker turns VideoFrames from every video scene into brightness maps
let worker: Worker | null = null;
const waiting = new Map<number, (f: SceneFrame | null) => void>();
let nextId = 1;
function sceneWorker() {
  if (!worker) {
    worker = new Worker(new URL('./sceneWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, lum, lw, lh, w, h } = e.data;
      waiting.get(id)?.(lum ? { lum: new Uint8Array(lum), lw, lh, w, h } : null);
      waiting.delete(id);
    };
  }
  return worker;
}
export function stopSceneWorker() { worker?.terminate(); worker = null; waiting.clear(); }

class VideoScene implements SceneLayer {
  mix = 0;
  idx: Int32Array | null = null;
  idxKey = '';
  private video = document.createElement('video');
  private active = false;
  private failed = false;
  private pending = false;
  private lastSent = 0;
  private last: SceneFrame | null = null;

  constructor(src: string) {
    const v = this.video;
    Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', src });
    v.onerror = () => { this.failed = true; };
  }

  setActive(on: boolean) {
    if (on === this.active || this.failed) return;
    this.active = on;
    if (on) this.video.play().catch(() => {});
    else this.video.pause();
  }

  frame(now: number, _dt: number, _grid: Grid, fps: number) {
    const v = this.video;
    if (this.failed || typeof VideoFrame === 'undefined') return null;
    if (this.active && !this.pending && v.readyState >= 2 && now - this.lastSent >= 1000 / fps - 2) {
      this.lastSent = now;
      try {
        const frame = new VideoFrame(v);
        const id = nextId++;
        this.pending = true;
        waiting.set(id, f => { this.pending = false; if (f) this.last = f; });
        sceneWorker().postMessage({ id, frame }, [frame]);
      } catch { this.pending = false; }
    }
    return this.last;
  }

  destroy() { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
}

// ---------- point cloud ----------
/* The .pcd projected straight onto the grid each frame, swaying left↔right.
   Nearer points are brighter; the brightest point in a cell wins. */
class CloudScene implements SceneLayer {
  mix = 0;
  idx: Int32Array | null = null;
  idxKey = '';
  private pts: Float32Array | null = null;
  private cx = 0; private cy = 0; private cz = 0; private span = 1; private depth = 1;
  private buf = new Uint8Array(0);
  private t = 0;

  constructor(src: string) {
    fetch(src)
      .then(r => { if (!r.ok) throw new Error(`${src}: ${r.status}`); return r.arrayBuffer(); })
      .then(buf => this.load(parsePCD(buf)))
      .catch(err => console.warn('point cloud scene:', err));
  }

  private load(pts: Float32Array) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      if (!Number.isFinite(x + y + z)) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2; this.cz = (z0 + z1) / 2;
    this.span = Math.max(y1 - y0, 1e-6);
    this.depth = Math.max(x1 - x0, z1 - z0, 1e-6) / 2;
    this.pts = pts;
  }

  setActive() {}

  frame(_now: number, dt: number, { W, H, cols, rows }: Grid) {
    const pts = this.pts;
    if (!pts) return null;
    this.t += dt;
    if (this.buf.length !== cols * rows) this.buf = new Uint8Array(cols * rows);
    const buf = this.buf;
    buf.fill(0);
    // placement: left of centre under the corner caption (centred on narrow screens), 80% of the height
    const px0 = W < 900 ? W * 0.5 : W * 0.32, py0 = H * 0.56, s = H * 0.8 / this.span;
    const a = Math.sin(this.t * 0.45) * 0.8, ca = Math.cos(a), sa = Math.sin(a);
    const { cx, cy, cz, depth } = this;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i] - cx, y = pts[i + 1] - cy, z = pts[i + 2] - cz;
      const xr = x * ca + z * sa, zr = -x * sa + z * ca;      // turn around the vertical axis
      const c = Math.floor((px0 + xr * s) / W * cols), r = Math.floor((py0 - y * s) / H * rows);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const shade = 70 + 185 * Math.max(0, Math.min(1, (zr / depth + 1) / 2));   // nearer = brighter
      const k = r * cols + c;
      if (shade > buf[k]) buf[k] = shade;
    }
    return { lum: buf, lw: cols, lh: rows, w: W, h: H };
  }

  destroy() { this.pts = null; }
}
