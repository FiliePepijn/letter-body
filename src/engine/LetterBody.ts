/* =====================================================================
   LETTER BODY — PoseLandmarker segmentation mask → monospace letter grid.
   Every grid cell inside the person gets a letter chosen by brightness.
   Scrolling steps through slides: a caption (real type snapped to the
   grid; letters step around its strokes; it explodes when the next one
   comes) and a scene behind the body — a point cloud or a video, also
   rendered in letters.
   ===================================================================== */
import {
  ALL_CHARS, BG, BODY, BLAST_SPEED, CELL, CHAR_ID, FAST_JOINT, FONT, GLITCH_CHARS, GLITCH_R, GRAVITY,
  LOWER, MIN_LOAD, REFORM, SCENE_ALPHA, SHED_P, SLIDES, TEXT_LH, TIERS, TINTS, TRAIL, TXT_SS, TXT_WEIGHT, UPPER, ZONE_PAD,
  type Tier,
} from './config';
import { Camera } from './camera';
import { Demo } from './demo';
import { createScene, stopSceneWorker, type SceneFrame, type SceneLayer } from './scenes';
import type { CameraInfo, Landmark, Phase, ScreenPoint, Source, Stats } from './types';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rnd = (n: number) => (Math.random() * n) | 0;
const TIER_KEY = 'letterbody.tier';
const CAM_KEY = 'letterbody.camera';
const JOINT_IDS = [15, 16, 19, 20, 27, 28];   // wrists, hands, ankles

interface Box { x: number; y: number; w: number; h: number; align: 'left' | 'center' | 'right'; middle?: boolean }
interface TextLayout { lines: string[]; n: number; size: number; chW: number; cA: number; cB: number; r0: number; lineRows: number; align: Box['align'] }
interface Zone { c0: number; c1: number; r0: number; r1: number }
interface Block {
  box: () => Box;
  mode: 'type' | 'cells';   // 'type': real type on the grid; 'cells': the text rasterised into grid letters
  text: string;
  layout: TextLayout | null;
  cells: Int32Array;        // grid cells the text covers
  seed: Float32Array[];     // per character (type) — when it appears, 0..1
  cellSeed: Float32Array;   // per cell (cells)
  letters: string;          // the caption's own letters, for the explosion
  t: number;
  gate: number | null;      // loader: progress instead of time decides what has settled
  zone: Zone | null;        // the box around the text, in cells
}
interface Particle { x: number; y: number; vx: number; vy: number; id: number; t: number; life: number; age: number; g: number; rot: number; vr: number }
interface Joint { x: number; y: number; vx: number; vy: number }

export interface EngineEvents {
  onPhase?(phase: Phase): void;
  onCameras?(list: CameraInfo[], current: string): void;
  onStats?(stats: Stats): void;
}

// order letters by how much ink they put down, so the ramp shades correctly
function sortByInk(chars: string) {
  const S = 48, c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = `400 ${S * 0.8}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const ink = (ch: string) => {
    g.clearRect(0, 0, S, S); g.fillStyle = '#fff'; g.fillText(ch, S / 2, S / 2);
    const d = g.getImageData(0, 0, S, S).data;
    let sum = 0; for (let k = 3; k < d.length; k += 4) sum += d[k];
    return sum;
  };
  const score: Record<string, number> = Object.fromEntries([...chars].map(ch => [ch, ink(ch)]));
  return [...chars].sort((a, b) => score[a] - score[b]).join('');
}

export class LetterBody {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private events: EngineEvents;
  private camera: Camera;
  private demo = new Demo();

  // ---------- state ----------
  private phase: Phase = 'loading';
  private mode: 'idle' | 'camera' | 'demo' = 'idle';
  private running = false;
  private raf = 0;
  private ramp = LOWER;
  private bgRamp = LOWER;

  // ---------- grid ----------
  private W = 0; private H = 0; private DPR = 1;
  private cw = 0; private chh = 0; private cols = 0; private rows = 0; private gx0 = 0; private gy0 = 0; private N = 0;
  private maskS = new Float32Array(0);
  private alpha = new Float32Array(0);
  private lumN = new Float32Array(0);
  private cellFade = new Float32Array(0);
  private glyph = new Uint16Array(0);
  private tint = new Uint8Array(0);
  private inside = new Uint8Array(0);
  private knock = new Uint8Array(0);   // cells under the caption's strokes: the grid leaves them empty for the type
  private idxMap = new Int32Array(0);    // cell → mask pixel
  private lumIdx = new Int32Array(0);    // cell → brightness pixel
  private idxKey = '';
  private atlas: HTMLCanvasElement[][] = [];   // atlas[tint][charId]
  private bgLayer = document.createElement('canvas');   // cached faint room letters
  private bgCtx = this.bgLayer.getContext('2d')!;
  private sceneLayer = document.createElement('canvas');   // cached scene letters
  private sceneCtx = this.sceneLayer.getContext('2d')!;
  private scenes: (SceneLayer | null)[] = SLIDES.map(() => null);
  private sceneFrames: (SceneFrame | null)[] = SLIDES.map(() => null);
  private sceneMix = 0;                                    // strongest scene on screen: the room fades by this much
  private levels = { lo: 0, hi: 1 };

  // ---------- text ----------
  private txtC = document.createElement('canvas');
  private txtG = this.txtC.getContext('2d', { willReadFrequently: true })!;
  private caption: Block;
  private loader: { block: Block; t: number; p: number };
  private cue = -1;
  private wantCue = 0;
  private slideLayout: 'hero' | 'corner' = 'hero';
  private showT = 0;

  // ---------- effects ----------
  private parts: Particle[] = [];
  private joints: Record<number, Joint | null> = Object.fromEntries(JOINT_IDS.map(k => [k, null]));
  private blastState: { x: number; y: number; r: number; prevR: number; maxR: number } | null = null;
  private burstCooldown = 0;
  private bodyFade = 1;
  private bodyFadeIn = 0;
  private zoneHits = 0;
  private zoneHeat = 0;

  // ---------- camera ----------
  private camReady: boolean | null = null;
  private camStage = 0;
  private camStatus = 'LOADING';

  // ---------- performance ----------
  private tierIdx = 0;
  private tierFloor = 0;                  // best tier still allowed after repeated failures
  private drops = [0, 0, 0];
  private perf = { work: 8, interval: 16, bad: 0, good: 0 };
  private last = 0;
  private lastFrame = 0;
  private frameNo = 0;
  private statsAcc = { frames: 0, work: 0, since: 0 };

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, events: EngineEvents = {}) {
    this.canvas = canvas;
    // no `desynchronized`: low-latency canvases tear and flicker when macOS throttles the GPU
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.events = events;
    this.camera = new Camera(video);
    this.caption = this.makeBlock(() => {
      const { W, H } = this, narrow = W < 900;
      if (this.slideLayout === 'hero')
        return narrow ? { x: 16, y: H * 0.3, w: W - 32, h: H * 0.3, align: 'center', middle: true }
                      : { x: W * 0.08, y: H * 0.22, w: W * 0.84, h: H * 0.5, align: 'center', middle: true };
      return narrow ? { x: 24, y: 64, w: W - 48, h: H * 0.22, align: 'right' }
                    : { x: W * 0.5, y: 90, w: W * 0.5 - 50, h: H * 0.36, align: 'right' };
    });
    this.loader = {
      block: this.makeBlock(() => this.W < 900
        ? { x: 16, y: this.H * 0.36, w: this.W - 32, h: this.H * 0.2, align: 'center', middle: true }
        : { x: this.W * 0.06, y: this.H * 0.28, w: this.W * 0.88, h: this.H * 0.36, align: 'center', middle: true }, 'cells'),
      t: 0, p: 0,
    };
    try { this.tierIdx = clamp(Number(localStorage.getItem(TIER_KEY)) || 0, 0, TIERS.length - 1); } catch { /* private mode */ }
  }

  private get tier(): Tier { return TIERS[this.tierIdx]; }

  // ---------- public API ----------
  async start() {
    this.running = true;
    window.addEventListener('resize', this.onResize);
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    if (BODY === 'camera') this.startCamera().then(ok => { this.camReady = ok; });
    else this.camReady = false;   // no camera: the loader only waits for the fonts and its minimum time

    await Promise.race([
      Promise.all([400, 500, 700].map(w => document.fonts.load(`${w} 16px ${FONT}`, LOWER + UPPER))),
      new Promise(r => setTimeout(r, 1500)),
    ]).catch(() => {});
    if (!this.running) return;
    this.ramp = sortByInk(LOWER);
    this.bgRamp = ' ' + this.ramp.slice(0, 12);   // lightest lowercase for the backdrop
    this.layout();
    this.setText(this.loader.block, 'LOADING');
    this.last = this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.camera.destroy();
    this.scenes.forEach(s => s?.destroy());
    stopSceneWorker();
  }

  /** Scroll step → caption. Applied once the loader has blown away. */
  setCue(k: number) { this.wantCue = clamp(k, 0, SLIDES.length - 1); }

  blast(x: number, y: number) {
    if (this.phase !== 'show' || this.blastState || this.burstCooldown > 0) return;
    const { W, H } = this;
    const maxR = Math.max(Math.hypot(x, y), Math.hypot(W - x, y), Math.hypot(x, H - y), Math.hypot(W - x, H - y));
    this.blastState = { x, y, r: 0, prevR: 0, maxR };
    this.burstCooldown = 1.2;
  }

  async selectCamera(id: string) {
    try {
      await this.camera.open(id);
      try { localStorage.setItem(CAM_KEY, id); } catch { /* private mode */ }
    } catch (err) {
      console.error(err);
    }
    this.emitCameras();
  }

  // ---------- camera ----------
  private onDeviceChange = () => { if (this.camera.currentId()) this.emitCameras(); };

  private async emitCameras() {
    try { this.events.onCameras?.(await this.camera.list(), this.camera.currentId()); } catch { /* no devices API */ }
  }

  private async startCamera() {
    try {
      this.camStatus = 'REQUESTING CAMERA'; this.camStage = 0.1;
      let saved: string | null = null;
      try { saved = localStorage.getItem(CAM_KEY); } catch { /* private mode */ }
      try { await this.camera.open(saved); }
      catch (err) { if (!saved) throw err; await this.camera.open(null); }   // remembered camera gone: use the default
      this.emitCameras();
      this.camStatus = 'LOADING POSE MODEL'; this.camStage = 0.4;
      this.camera.poseFps = this.tier.poseFps;
      await this.camera.start(this.tier.model, this.tier.numPoses);
      this.camStatus = 'READY';
      return true;
    } catch (err) {
      console.error(err);
      this.camStatus = 'NO CAMERA — DEMO';
      return false;
    }
  }

  // ---------- canvas + grid ----------
  private onResize = () => this.layout();

  private layout() {
    const DPR = this.DPR = Math.min(window.devicePixelRatio || 1, this.tier.dprCap);
    const W = this.W = window.innerWidth, H = this.H = window.innerHeight;
    this.canvas.width = this.bgLayer.width = this.sceneLayer.width = Math.round(W * DPR);
    this.canvas.height = this.bgLayer.height = this.sceneLayer.height = Math.round(H * DPR);
    this.ctx.imageSmoothingEnabled = false;
    const cw = this.cw = Math.max(5, Math.round(CELL * 0.6)), chh = this.chh = CELL;
    const cols = this.cols = Math.floor(W / cw), rows = this.rows = Math.floor(H / chh);
    this.gx0 = Math.floor((W - cols * cw) / 2); this.gy0 = Math.floor((H - rows * chh) / 2);
    const N = this.N = cols * rows;
    this.maskS = new Float32Array(N); this.alpha = new Float32Array(N); this.lumN = new Float32Array(N);
    this.cellFade = new Float32Array(N).fill(1);
    this.glyph = new Uint16Array(N); this.tint = new Uint8Array(N); this.inside = new Uint8Array(N);
    this.knock = new Uint8Array(N);
    this.idxKey = '';
    this.buildAtlas();
    // captions live on the grid, so re-rasterise them (without re-animating)
    for (const b of [this.caption, this.loader.block]) if (b.text) this.setText(b, b.text, true);
  }

  private buildAtlas() {
    const { cw, chh, DPR } = this;
    this.atlas = TINTS.map(color => ALL_CHARS.map(c => {
      const a = Object.assign(document.createElement('canvas'), { width: Math.ceil(cw * DPR), height: Math.ceil(chh * DPR) });
      const g = a.getContext('2d')!;
      g.scale(DPR, DPR);
      g.font = `400 ${CELL * 0.92}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = color;
      g.fillText(c, cw / 2, chh / 2 + CELL * 0.04);
      return a;
    }));
  }

  // source → screen mapping (cover fit, optional mirror)
  private coverRect(sw: number, sh: number) {
    const s = Math.max(this.W / sw, this.H / sh), dw = sw * s, dh = sh * s;
    return { dx: (this.W - dw) / 2, dy: (this.H - dh) / 2, dw, dh };
  }
  private toScreen(lm: Landmark, src: { w: number; h: number; mirror: boolean }) {
    const r = this.coverRect(src.w, src.h);
    return { x: r.dx + (src.mirror ? 1 - lm.x : lm.x) * r.dw, y: r.dy + lm.y * r.dh };
  }
  private screenPose(pose: (Landmark | null)[] | null, src: { w: number; h: number; mirror: boolean }): (ScreenPoint | null)[] | null {
    return pose?.map(lm => {
      if (!lm) return null;
      const s = this.toScreen(lm, src);
      return { sx: s.x, sy: s.y, visibility: lm.visibility };
    }) ?? null;
  }

  // cell index → pixel index of a mw×mh map covering a w×h picture (−1 = off the picture)
  private coverIdx(w: number, h: number, mw: number, mh: number, mirror: boolean) {
    const { cols, rows, cw, chh, gx0, gy0 } = this;
    const idx = new Int32Array(this.N), r = this.coverRect(w, h);
    for (let rr = 0; rr < rows; rr++) for (let c = 0; c < cols; c++) {
      let u = (gx0 + (c + 0.5) * cw - r.dx) / r.dw;
      const v = (gy0 + (rr + 0.5) * chh - r.dy) / r.dh;
      if (mirror) u = 1 - u;
      idx[rr * cols + c] = u < 0 || u >= 1 || v < 0 || v >= 1 ? -1 : Math.floor(v * mh) * mw + Math.floor(u * mw);
    }
    return idx;
  }

  // mask / brightness lookups for the body source, rebuilt only when geometry changes
  private ensureIdxMap(src: Source) {
    const key = `${this.cols}x${this.rows}|${src.w}x${src.h}|${src.mw}x${src.mh}|${src.lw}x${src.lh}|${src.mirror}`;
    if (key === this.idxKey) return;
    this.idxKey = key;
    this.idxMap = this.coverIdx(src.w, src.h, src.mw, src.mh, src.mirror);
    this.lumIdx = this.coverIdx(src.w, src.h, src.lw, src.lh, src.mirror);
  }

  // ---------- particles ----------
  // g scales gravity (below 1 = floatier); vr is spin in rad/s
  private spawn(x: number, y: number, vx: number, vy: number, id: number, t = 0, life = 1.2, g = 1, vr = (Math.random() - 0.5) * 8) {
    if (this.parts.length >= this.tier.maxParts) return;   // at the cap: drop new ones instead of shifting the array
    this.parts.push({ x, y, vx, vy, id, t, life, age: 0, g, rot: 0, vr });
  }

  private updateParts(dt: number) {
    const parts = this.parts, floor = this.H - this.chh, drag = Math.pow(0.99, dt * 60);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age > p.life) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }   // swap-remove: O(1)
      p.vy += GRAVITY * p.g * dt; p.vx *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > floor) { p.y = floor; p.vy *= -0.25; p.vx *= 0.7; p.vr *= 0.5; }   // settle on the floor
    }
  }

  // ---------- big text (loader + captions) ----------
  /* Two looks, one engine. 'type' (captions): real type snapped to the letter grid —
     the font size is a whole number of cells and every character sits on a grid
     column/row — each character scrambling through random capitals before settling.
     'cells' (loader): the text rasterised onto the grid, every covered cell a letter.
     Either way the grid cells the text covers size the box and become the falling
     letters when the next cue explodes it. */
  private makeBlock(box: () => Box, mode: Block['mode'] = 'type'): Block {
    return { box, mode, text: '', layout: null, cells: new Int32Array(0), seed: [], cellSeed: new Float32Array(0),
             letters: UPPER, t: 0, gate: null, zone: null };
  }

  // fit the string into box b on the grid: each character is n×n cells (Plex Mono is 0.6em wide, like a cell)
  private textLayout(str: string, b: Box): TextLayout {
    const { cw, chh, gx0, gy0 } = this;
    const lines = str.split('\n');
    const len = Math.max(...lines.map(l => l.length));
    const n = Math.max(1, Math.floor(Math.min(b.w / (len * cw), b.h / (lines.length * TEXT_LH * chh))));
    const lineRows = Math.round(n * TEXT_LH);
    const cA = Math.floor((b.x - gx0) / cw), cB = Math.floor((b.x + b.w - gx0) / cw);
    const top = b.middle ? b.y + (b.h - lines.length * lineRows * chh) / 2 : b.y;
    return { lines, n, size: n * chh, chW: n * cw, cA, cB, r0: Math.round((top - gy0) / chh), lineRows, align: b.align };
  }
  private lineX(L: TextLayout, line: string) {
    const col = L.align === 'right' ? L.cB - line.length * L.n
      : L.align === 'center' ? Math.round((L.cA + L.cB - line.length * L.n) / 2) : L.cA;
    return this.gx0 + this.cw * col;
  }
  private lineY(L: TextLayout, li: number) { return this.gy0 + (L.r0 + li * L.lineRows) * this.chh; }

  private textCells(L: TextLayout, weight: number, cover: number) {
    const { cols, rows, cw, chh, gx0, gy0, txtC, txtG } = this;
    txtC.width = cols * TXT_SS; txtC.height = rows * TXT_SS;     // also clears
    txtG.setTransform(TXT_SS / cw, 0, 0, TXT_SS / chh, -gx0 * TXT_SS / cw, -gy0 * TXT_SS / chh);
    txtG.font = `${weight} ${L.size}px ${FONT}`;
    txtG.textAlign = 'left'; txtG.textBaseline = 'top'; txtG.fillStyle = txtG.strokeStyle = '#fff';
    txtG.lineWidth = L.size * 0.05; txtG.lineJoin = 'round';     // fatten strokes so they survive the grid
    L.lines.forEach((l, k) => {
      const x = this.lineX(L, l), y = this.lineY(L, k);
      for (let j = 0; j < l.length; j++) {
        txtG.fillText(l[j], x + j * L.chW, y); txtG.strokeText(l[j], x + j * L.chW, y);
      }
    });
    const d = txtG.getImageData(0, 0, txtC.width, txtC.height).data, tw = txtC.width;
    const out: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let y = 0; y < TXT_SS; y++) for (let x = 0; x < TXT_SS; x++)
        s += d[((r * TXT_SS + y) * tw + c * TXT_SS + x) * 4 + 3];
      if (s > TXT_SS * TXT_SS * 255 * cover) out.push(r * cols + c);
    }
    return Int32Array.from(out);
  }

  private textGlyph(b: Block, i: number) {
    return CHAR_ID[b.letters[(i % this.cols + ((i / this.cols) | 0) * 3) % b.letters.length]];
  }
  // 0 = hidden, 1 = scrambling, 2 = settled
  private charState(b: Block, s: number) {
    if (b.gate != null) return s < b.gate ? 2 : 1;
    const a = b.t - (0.25 + s * 0.6);
    return a < 0 ? 0 : a < 0.35 ? 1 : 2;
  }

  private setText(b: Block, str: string, instant = false) {
    if (!instant) this.explodeText(b);
    const { cols, rows } = this;
    b.text = str; b.t = 0;
    b.layout = str ? this.textLayout(str, b.box()) : null;
    b.cells = b.layout ? (b.mode === 'cells' ? this.textCells(b.layout, 700, 0.35) : this.textCells(b.layout, TXT_WEIGHT, 0.06))
                       : new Int32Array(0);
    b.letters = str.toUpperCase().replace(/[^A-Z]/g, '') || UPPER;
    b.seed = b.layout ? b.layout.lines.map(l => Float32Array.from(l, (_, k) =>
      instant ? -1 : k / Math.max(1, l.length - 1) * 0.6 + Math.random() * 0.4)) : [];
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const i of b.cells) {
      const c = i % cols, r = (i / cols) | 0;
      c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
    }
    b.cellSeed = Float32Array.from(b.cells, i =>
      instant ? -1 : ((i % cols) - c0) / Math.max(1, c1 - c0) * 0.6 + Math.random() * 0.4);
    // box: the text's cell bounds plus padding, in grid cells (inclusive)
    b.zone = b.cells.length ? { c0: Math.max(0, c0 - ZONE_PAD[0]), c1: Math.min(cols - 1, c1 + ZONE_PAD[0]),
                                r0: Math.max(0, r0 - ZONE_PAD[1]), r1: Math.min(rows - 1, r1 + ZONE_PAD[1]) } : null;
  }

  // the type shatters into letters on the grid
  private explodeText(b: Block) {
    const n = b.cells.length, { cols, cw, chh, gx0, gy0 } = this;
    if (n && (b.gate != null || b.t > 0.25)) {
      let cx = 0, cy = 0;
      for (const i of b.cells) { cx += i % cols; cy += (i / cols) | 0; }
      cx = gx0 + cx / n * cw; cy = gy0 + cy / n * chh;
      const per = this.tier.burstPer;
      for (const i of b.cells) for (let k = 0; k < per; k++) {
        const x = gx0 + (i % cols) * cw + (Math.random() - 0.5) * cw, y = gy0 + ((i / cols) | 0) * chh + (Math.random() - 0.5) * chh;
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1, s = 500 + Math.random() * 1400;
        this.spawn(x, y, dx / d * s + (Math.random() - 0.5) * 500, dy / d * s - 500 - Math.random() * 700,
                   CHAR_ID[b.letters[rnd(b.letters.length)]], Math.random() < 0.4 ? 0 : 1 + rnd(2),
                   1.8 + Math.random() * 1.6, 0.45 + Math.random() * 0.35, (Math.random() - 0.5) * 18);
      }
    }
    b.cells = new Int32Array(0); b.text = ''; b.layout = null; b.seed = []; b.zone = null;
  }

  private drawText(b: Block) {
    const L = b.layout, { ctx, cols, cw, chh, gx0, gy0, atlas } = this;
    if (!L) return;
    if (b.mode === 'cells') {
      for (let k = 0; k < b.cells.length; k++) {
        const st = this.charState(b, b.cellSeed[k]);
        if (!st) continue;
        const i = b.cells[k], x = gx0 + (i % cols) * cw, y = gy0 + ((i / cols) | 0) * chh;
        let img;
        if (st === 1) { ctx.globalAlpha = 0.5; img = atlas[1 + rnd(2)][CHAR_ID[GLITCH_CHARS[rnd(GLITCH_CHARS.length)]]]; }
        else          { ctx.globalAlpha = 1;   img = atlas[0][this.textGlyph(b, i)]; }
        ctx.drawImage(img, x, y, cw, chh);
      }
      ctx.globalAlpha = 1;
      return;
    }
    ctx.font = `${TXT_WEIGHT} ${L.size}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    L.lines.forEach((line, li) => {
      const x0 = this.lineX(L, line), y = this.lineY(L, li);
      for (let k = 0; k < line.length; k++) {
        if (line[k] === ' ') continue;
        const st = this.charState(b, b.seed[li][k]);
        if (!st) continue;
        if (st === 1) { ctx.globalAlpha = 0.6; ctx.fillStyle = TINTS[1 + rnd(2)]; }
        else          { ctx.globalAlpha = 1;   ctx.fillStyle = '#fff'; }
        ctx.fillText(st === 1 ? GLITCH_CHARS[rnd(GLITCH_CHARS.length)] : line[k], x0 + k * L.chW, y);
      }
    });
    ctx.globalAlpha = 1;
  }

  // the box around the caption; it flickers while the body is inside
  private drawZone() {
    const z = this.caption.zone, { ctx, cw, chh, gx0, gy0, zoneHeat } = this;
    if (!z || this.slideLayout === 'hero') return;
    const grow = clamp((this.caption.t - 0.1) / 0.35, 0, 1);
    if (!grow) return;
    const k = 1 - Math.pow(1 - grow, 3);                    // ease out from the centre
    const x0 = gx0 + z.c0 * cw, x1 = gx0 + (z.c1 + 1) * cw, y0 = gy0 + z.r0 * chh, y1 = gy0 + (z.r1 + 1) * chh;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = (x1 - x0) * k, h = (y1 - y0) * k;
    const j = zoneHeat * 3;
    const ox = (Math.random() - 0.5) * j, oy = (Math.random() - 0.5) * j;
    ctx.globalAlpha = 0.3 + 0.6 * zoneHeat;
    ctx.strokeStyle = zoneHeat > 0.3 && Math.random() < zoneHeat ? TINTS[1 + rnd(2)] : '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(cx - w / 2 + ox) + 0.5, Math.round(cy - h / 2 + oy) + 0.5, Math.round(w), Math.round(h));
    ctx.globalAlpha = 1;
  }

  // ---------- pose-driven effects ----------
  private trackJoints(pose: ArrayLike<ScreenPoint | null | undefined> | null, dt: number) {
    for (const k of JOINT_IDS) {
      const lm = pose?.[k];
      if (!lm || (lm.visibility ?? 1) < 0.5) { this.joints[k] = null; continue; }
      const j = this.joints[k];
      if (!j) { this.joints[k] = { x: lm.sx, y: lm.sy, vx: 0, vy: 0 }; continue; }
      const f = 1 - Math.exp(-20 * dt);      // velocity smoothing at 20/s
      j.vx += ((lm.sx - j.x) / dt - j.vx) * f;
      j.vy += ((lm.sy - j.y) / dt - j.vy) * f;
      j.x = lm.sx; j.y = lm.sy;
    }
  }

  // ---------- per-frame grid update ----------
  private processFrame(src: Source, dt: number) {
    this.ensureIdxMap(src);
    const { cols, rows, cw, chh, gx0, gy0, N, maskS, lumN, alpha, glyph, tint, inside, cellFade, idxMap, lumIdx, levels } = this;

    // 1. mask + brightness per cell, plus a histogram for auto-levels
    const hist = new Uint32Array(32);
    const keep = Math.pow(0.35, dt * 60);                  // temporal smoothing kills flicker
    let count = 0;
    for (let i = 0; i < N; i++) {
      const mi = idxMap[i];
      const m = mi < 0 ? 0 : src.mask[mi];
      maskS[i] = maskS[i] * keep + m * (1 - keep);
      const li = lumIdx[i];
      const l = li < 0 ? 0 : src.lum[li] / 255;
      lumN[i] = l;
      if (maskS[i] > 0.5) { hist[Math.min(31, (l * 32) | 0)]++; count++; }
    }
    // 5th / 95th percentile of brightness inside the body
    let lo = 0, hi = 1;
    if (count > 20) {
      let acc = 0, a = -1, b = -1;
      for (let k = 0; k < 32; k++) {
        acc += hist[k];
        if (a < 0 && acc >= count * 0.05) a = k;
        if (b < 0 && acc >= count * 0.95) b = k;
      }
      lo = a / 32; hi = Math.max(lo + 0.08, (b + 1) / 32);
    }
    levels.lo += (lo - levels.lo) * 0.1;
    levels.hi += (hi - levels.hi) * 0.1;

    // 2. choose glyphs
    const rc = this.ramp, trail = Math.pow(TRAIL, dt * 60), blast = this.blastState;
    this.bodyFade = Math.min(1, this.bodyFade + dt * 1.6);
    if (blast) { blast.prevR = blast.r; blast.r += BLAST_SPEED * dt; }
    for (let rr = 0; rr < rows; rr++) for (let c = 0; c < cols; c++) {
      const i = rr * cols + c;
      if (maskS[i] > 0.5) {
        const t = clamp((lumN[i] - levels.lo) / (levels.hi - levels.lo), 0, 1);
        const id = CHAR_ID[rc[Math.min(rc.length - 1, (t * rc.length) | 0)]];
        cellFade[i] = Math.min(1, cellFade[i] + dt * REFORM);
        glyph[i] = id; tint[i] = 0; alpha[i] = (0.5 + 0.5 * t) * this.bodyFade * Math.max(0, cellFade[i]); inside[i] = 1;
        if (blast) {
          const x = gx0 + c * cw, y = gy0 + rr * chh;
          const dx = x - blast.x, dy = y - blast.y, d = Math.hypot(dx, dy) || 1;
          if (d < blast.r) {
            if (d >= blast.prevR && Math.random() < 0.7) {
              // the wave just reached this cell: fling it, harder near the click
              const s = (700 + Math.random() * 900) * (1.4 - 0.8 * Math.min(1, d / 700));
              this.spawn(x, y, dx / d * s, dy / d * s - 250, id, rnd(3), 1.4 + Math.random() * 0.8);
            }
            alpha[i] = 0;
          }
        }
      } else {
        if (inside[i] && Math.random() < SHED_P && this.bodyFade > 0.9) {
          // the body moved off this cell: drop the glyph
          this.spawn(gx0 + c * cw, gy0 + rr * chh, (Math.random() - 0.5) * 60, -Math.random() * 80, glyph[i], 0, 1.1);
        }
        inside[i] = 0;
        cellFade[i] = Math.min(1, cellFade[i] + dt * REFORM);
        alpha[i] *= trail;
      }
    }
    if (blast && blast.r > blast.maxR) { this.blastState = null; this.bodyFade = 0; }   // wave gone: re-form

    // 3. fast wrists / ankles glitch the cells around them
    for (const j of Object.values(this.joints)) {
      if (!j || Math.hypot(j.vx, j.vy) < FAST_JOINT) continue;
      const c0 = Math.floor((j.x - gx0 - GLITCH_R) / cw), c1 = Math.ceil((j.x - gx0 + GLITCH_R) / cw);
      const r0 = Math.floor((j.y - gy0 - GLITCH_R) / chh), r1 = Math.ceil((j.y - gy0 + GLITCH_R) / chh);
      for (let rr = Math.max(0, r0); rr < Math.min(rows, r1); rr++)
        for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
          const i = rr * cols + c;
          const dx = gx0 + c * cw - j.x, dy = gy0 + rr * chh - j.y;
          if (dx * dx + dy * dy > GLITCH_R * GLITCH_R || alpha[i] < 0.05) continue;
          glyph[i] = CHAR_ID[GLITCH_CHARS[rnd(GLITCH_CHARS.length)]];
          tint[i] = 1 + rnd(2);
          if (Math.random() < 0.12)   // flick a few off along the motion
            this.spawn(gx0 + c * cw, gy0 + rr * chh, j.vx * 0.3, j.vy * 0.3, glyph[i], tint[i], 0.9);
        }
    }
  }

  // ---------- loader ----------
  private updateLoader(dt: number) {
    const L = this.loader;
    L.t += dt;
    // real progress = camera / model stages; creep a little so it never looks stuck
    const real = this.camReady !== null ? 1 : this.camStage + 0.3 * (1 - Math.exp(-L.t / 4));
    const target = Math.min(real, L.t / MIN_LOAD);
    L.p += (target - L.p) * (1 - Math.exp(-6 * dt));
    L.block.gate = L.p * 1.02;
    if (this.camReady !== null && L.p > 0.985) this.startShow();
  }

  private drawLoaderLabel() {
    const L = this.loader.block.layout, by = L ? this.lineY(L, L.lines.length) : this.H * 0.6, ctx = this.ctx;
    ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fillText(`${this.camStatus} ${String(Math.round(this.loader.p * 100)).padStart(3, '0')}%`, this.W / 2, by + 28);
  }

  private startShow() {
    this.phase = 'show';
    const lb = this.loader.block;
    lb.gate = null; lb.t = 9;          // every loader cell counts as settled, so all of it explodes
    this.explodeText(lb);
    this.bodyFade = 0; this.showT = 0;
    if (this.camReady) this.mode = 'camera';
    else if (BODY !== 'off') { this.mode = 'demo'; this.demo.t = 0; }
    this.events.onPhase?.('show');
  }

  // ---------- rendering ----------
  private renderBackdrop() {
    const { bgCtx: g, N, cols, cw, chh, gx0, gy0, alpha, knock, lumN, atlas, bgRamp, DPR } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.bgLayer.width, this.bgLayer.height);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    for (let i = 0; i < N; i++) {
      if (alpha[i] > 0.05 || knock[i]) continue;
      const k = (lumN[i] * bgRamp.length) | 0;
      if (k <= 0) continue;
      g.drawImage(atlas[0][CHAR_ID[bgRamp[Math.min(k, bgRamp.length - 1)]]], gx0 + (i % cols) * cw, gy0 + ((i / cols) | 0) * chh, cw, chh);
    }
  }

  // the active slide's scene(s) in letters; crossfading scenes overlap
  private renderScenes() {
    const { sceneCtx: g, N, cols, cw, chh, gx0, gy0, alpha, knock, atlas, ramp, DPR, W, H, rows } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.sceneLayer.width, this.sceneLayer.height);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    this.scenes.forEach((layer, k) => {
      const f = this.sceneFrames[k];
      if (!layer || !f) return;
      const key = `${f.lw}x${f.lh}|${f.w}x${f.h}|${cols}x${rows}|${W}x${H}`;
      if (layer.idxKey !== key) { layer.idx = this.coverIdx(f.w, f.h, f.lw, f.lh, false); layer.idxKey = key; }
      const idx = layer.idx!, a0 = layer.mix * SCENE_ALPHA, top = ramp.length - 1;
      for (let i = 0; i < N; i++) {
        if (alpha[i] > 0.05 || knock[i]) continue;
        const li = idx[i];
        if (li < 0) continue;
        const v = f.lum[li] / 255;
        if (v < 0.06) continue;
        g.globalAlpha = a0 * (0.15 + 0.85 * v);
        g.drawImage(atlas[0][CHAR_ID[ramp[Math.min(top, (v * ramp.length) | 0)]]], gx0 + (i % cols) * cw, gy0 + ((i / cols) | 0) * chh, cw, chh);
      }
    });
  }

  private updateScenes(now: number, dt: number) {
    const grid = { W: this.W, H: this.H, cols: this.cols, rows: this.rows }, show = this.phase === 'show';
    let top = 0;
    SLIDES.forEach((slide, k) => {
      if (!slide.scene) return;
      let layer = this.scenes[k];
      // create a scene when its slide is on screen or next to it, so it has loaded by the time you scroll there
      if (!layer && show && Math.abs(k - this.cue) <= 1) layer = this.scenes[k] = createScene(slide.scene);
      if (!layer) return;
      const on = show && k === this.cue;
      layer.setActive(on);
      layer.mix += ((on ? 1 : 0) - layer.mix) * (1 - Math.exp(-4 * dt));
      const f = this.sceneFrames[k] = layer.mix > 0.01 ? layer.frame(now, dt, grid, this.tier.sceneFps) : null;
      if (f) top = Math.max(top, layer.mix);
    });
    this.sceneMix = top;
  }

  private render() {
    const { ctx, DPR, W, H, N, cols, cw, chh, gx0, gy0, alpha, knock, tint, glyph, atlas, caption } = this;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

    // cells under the caption's strokes stay empty so the type sits in the grid
    const showType = caption.layout && caption.t > 0.25;
    if (showType) for (const i of caption.cells) knock[i] = 1;

    // behind the body: the faint room, fading out under the slide's scene. Both are cached
    // layers, refreshed every few frames on lower tiers.
    if (this.phase === 'show') {
      const redraw = this.frameNo % this.tier.backdropEvery === 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.mode !== 'idle' && this.sceneMix < 0.99) {
        if (redraw) this.renderBackdrop();
        ctx.globalAlpha = 0.08 * this.bodyFadeIn * (1 - this.sceneMix);
        ctx.drawImage(this.bgLayer, 0, 0);
      }
      if (this.sceneMix > 0) {
        if (redraw) this.renderScenes();
        ctx.globalAlpha = 1;
        ctx.drawImage(this.sceneLayer, 0, 0);
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    // the body — it steps around the caption's strokes too
    const z = caption.t > 0.25 && this.slideLayout === 'corner' ? caption.zone : null;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const a = alpha[i];
      if (a < 0.02 || knock[i]) continue;
      const c = i % cols, r = (i / cols) | 0;
      if (z && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) hits++;
      ctx.globalAlpha = a;
      ctx.drawImage(atlas[tint[i]][glyph[i]], gx0 + c * cw, gy0 + r * chh, cw, chh);
    }
    this.zoneHits = hits;

    // shockwave ring
    const blast = this.blastState;
    if (blast) {
      ctx.globalAlpha = 0.35 * (1 - blast.r / blast.maxR);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(blast.x, blast.y, blast.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (showType) for (const i of caption.cells) knock[i] = 0;

    if (this.phase === 'loading') { this.drawText(this.loader.block); this.drawLoaderLabel(); }
    this.drawZone();
    this.drawText(caption);

    // falling glyphs
    if (this.tier.spin) {
      for (const p of this.parts) {
        ctx.globalAlpha = clamp(1 - p.age / p.life, 0, 1) * 0.9;
        const c = Math.cos(p.rot) * DPR, s = Math.sin(p.rot) * DPR;
        ctx.setTransform(c, s, -s, c, (p.x + cw / 2) * DPR, (p.y + chh / 2) * DPR);
        ctx.drawImage(atlas[p.t][p.id], -cw / 2, -chh / 2, cw, chh);
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    } else {
      for (const p of this.parts) {
        ctx.globalAlpha = clamp(1 - p.age / p.life, 0, 1) * 0.9;
        ctx.drawImage(atlas[p.t][p.id], p.x, p.y, cw, chh);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- quality ----------
  /* Two signals: how long our own work takes, and how often frames actually arrive.
     Over budget for 1.5s → step down a tier. Lots of headroom for 10s → step back up,
     unless that tier already failed twice (stops it see-sawing on a laptop in low power mode). */
  private watchPerf(work: number, interval: number, dt: number) {
    const p = this.perf, budget = 1000 / this.tier.fps;
    p.work += (work - p.work) * 0.1;
    if (interval < 250) p.interval += (interval - p.interval) * 0.1;   // ignore gaps from a hidden tab
    const struggling = p.work > budget * 0.75 || p.interval > budget * 1.5;
    const relaxed = p.work < budget * 0.3 && p.interval < budget * 1.15;
    p.bad = struggling ? p.bad + dt : Math.max(0, p.bad - dt * 0.5);
    p.good = relaxed ? p.good + dt : 0;
    if (p.bad > 1.5 && this.tierIdx < TIERS.length - 1) {
      if (++this.drops[this.tierIdx] >= 2) this.tierFloor = Math.max(this.tierFloor, this.tierIdx + 1);
      this.setTier(this.tierIdx + 1);
    } else if (p.good > 10 && this.tierIdx > this.tierFloor) {
      this.setTier(this.tierIdx - 1);
    }
  }

  private setTier(k: number) {
    const prev = this.tier;
    this.tierIdx = k;
    const next = this.tier;
    this.perf.bad = this.perf.good = 0;
    try { localStorage.setItem(TIER_KEY, String(k)); } catch { /* private mode */ }
    if (next.dprCap !== prev.dprCap) this.layout();
    if (this.parts.length > next.maxParts) this.parts.length = next.maxParts;
    this.camera.poseFps = next.poseFps;
    if ((next.model !== prev.model || next.numPoses !== prev.numPoses) && this.camReady)
      this.camera.setModel(next.model, next.numPoses).catch(console.error);
  }

  // ---------- main loop ----------
  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    // cap the frame rate: a 120Hz display would otherwise double all the work
    if (now - this.lastFrame < 1000 / this.tier.fps - 1.5) return;
    const interval = now - this.lastFrame;
    this.lastFrame = now;
    const t0 = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frameNo++;
    this.burstCooldown -= dt;

    if (this.phase === 'loading') this.updateLoader(dt);

    let src: Source | null = null;
    if (this.mode === 'camera') {
      src = this.camera.frame(now);
      const pose = this.camera.takePose();
      if (pose && src) this.trackJoints(this.screenPose(pose.landmarks, src), pose.dt);
    } else if (this.mode === 'demo') {
      const d = this.demo.step(dt);
      src = d.src;
      this.trackJoints(this.screenPose(d.pose, d.src), dt);
    }
    if (src) { this.processFrame(src, dt); this.bodyFadeIn = Math.min(1, this.bodyFadeIn + dt); }

    const hit = this.zoneHits > 0 ? 1 : 0;
    this.zoneHeat += (hit - this.zoneHeat) * (1 - Math.exp(-(hit ? 18 : 4) * dt));
    if (this.phase === 'show') {
      this.showT += dt;
      // let the loader blow away first
      if (this.showT > 0.6 && this.wantCue !== this.cue) {
        this.cue = this.wantCue;
        this.explodeText(this.caption);              // explode in the old layout before the box moves
        this.slideLayout = SLIDES[this.cue].layout;
        this.setText(this.caption, SLIDES[this.cue].text);
      }
    }
    this.updateScenes(now, dt);
    this.caption.t += dt;
    this.updateParts(dt);
    this.render();

    const work = performance.now() - t0;
    this.watchPerf(work, interval, dt);
    this.reportStats(now, work);
  };

  private reportStats(now: number, work: number) {
    if (!this.events.onStats) return;
    const s = this.statsAcc;
    s.frames++; s.work += work;
    if (!s.since) s.since = now;
    if (now - s.since < 1000) return;
    this.events.onStats({ fps: Math.round(s.frames * 1000 / (now - s.since)), workMs: +(s.work / s.frames).toFixed(1), tier: this.tier.name });
    s.frames = 0; s.work = 0; s.since = now;
  }
}
