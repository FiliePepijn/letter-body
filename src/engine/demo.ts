/* Without a camera, a waving, dancing stick figure drawn off-screen stands in:
   a lit "video" frame for brightness plus a matching mask. */
import { DEMO_LOOP } from './config';
import { toLum } from './lum';
import type { Landmark, Source } from './types';

// small CPU-backed canvases: reading them back never waits on the GPU
const DV_W = 256, DV_H = 144, DM_W = 160, DM_H = 90;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const P = (x: number, y: number): Landmark => ({ x, y, visibility: 1 });
const lerpP = (a: Landmark, b: Landmark, t: number) => P(lerp(a.x, b.x, t), lerp(a.y, b.y, t));

// joint positions in normalised [0,1] frame coords
function demoPose(t: number) {
  const lt = t % DEMO_LOOP;
  const wave = clamp(Math.min(lt - 0.3, 3.4 - lt) / 0.4, 0, 1);   // hello-wave at the top of each loop
  const sway = Math.sin(t * 1.1) * 0.06 * (1 - wave), bounce = Math.abs(Math.sin(t * 2.2)) * 0.02 * (1 - wave);
  const hip = P(0.5 + sway, 0.6 - bounce);
  const neck = P(hip.x + Math.sin(t * 1.1 + 0.6) * 0.02, hip.y - 0.26);
  const head = P(neck.x, neck.y - 0.09);
  const sh = 0.07, hp = 0.045;
  const lS = P(neck.x - sh, neck.y + 0.01), rS = P(neck.x + sh, neck.y + 0.01);
  const lH = P(hip.x - hp, hip.y), rH = P(hip.x + hp, hip.y);
  // arms: a ~7s cycle that ends in a clap overhead
  const cyc = (t % 7) / 7;
  const clap = cyc > 0.82 ? Math.sin((cyc - 0.82) / 0.18 * Math.PI) : 0;
  const armA = (base: number, side: number) => base + Math.sin(t * 2.6 + side) * 0.9;
  const limb = (o: Landmark, a: number, len: number) => P(o.x + Math.cos(a) * len * 0.5625, o.y + Math.sin(a) * len);
  // swipe: right arm sweeps straight across the chest from outside right to past the left shoulder
  const sw = cyc > 0.14 && cyc < 0.34 ? Math.sin((cyc - 0.14) / 0.2 * Math.PI) : 0;
  const swA = lerp(-0.15, Math.PI + 0.25, clamp((cyc - 0.17) / 0.14, 0, 1));
  const aL = lerp(lerp(armA(Math.PI * 0.85, 0), Math.PI * 0.75, sw), -Math.PI * 0.42, clap);
  const aR = lerp(lerp(armA(Math.PI * 0.15, Math.PI), swA, sw), -Math.PI * 0.58, clap);
  let lE = limb(lS, aL, 0.14), rE = limb(rS, aR, 0.14);
  let lW = limb(lE, aL + lerp(lerp(Math.sin(t * 3) * 0.6, 0, sw), 0.5, clap), 0.13);
  let rW = limb(rE, aR - lerp(lerp(Math.sin(t * 3 + 1) * 0.6, 0, sw), 0.5, clap), 0.13);
  // wave: upper arm out to the side, forearm up and wagging; left arm relaxes down
  const wE = limb(rS, -0.35, 0.14), wW = limb(wE, -Math.PI / 2 + Math.sin(t * 10) * 0.45, 0.13);
  const dE = limb(lS, Math.PI * 0.58, 0.14), dW = limb(dE, Math.PI * 0.53, 0.13);
  rE = lerpP(rE, wE, wave); rW = lerpP(rW, wW, wave);
  lE = lerpP(lE, dE, wave); lW = lerpP(lW, dW, wave);
  const ext = (e: Landmark, w: Landmark) => P(w.x + (w.x - e.x) * 0.3, w.y + (w.y - e.y) * 0.3);   // hand ≈ past the wrist
  const lI = ext(lE, lW), rI = ext(rE, rW);
  const step = Math.sin(t * 2.2) * (1 - wave);
  const lK = limb(lH, Math.PI / 2 + 0.15 + step * 0.25, 0.16), rK = limb(rH, Math.PI / 2 - 0.15 - step * 0.25, 0.16);
  const lA = limb(lK, Math.PI / 2 + step * 0.1, 0.16), rA = limb(rK, Math.PI / 2 - step * 0.1, 0.16);
  const pose: (Landmark | null)[] = new Array(33).fill(null);
  Object.assign(pose, { 0: head, 11: lS, 12: rS, 13: lE, 14: rE, 15: lW, 16: rW, 19: lI, 20: rI,
                        23: lH, 24: rH, 25: lK, 26: rK, 27: lA, 28: rA, 31: lA, 32: rA });
  return { pose, neck, head };
}

function drawFigure(g: CanvasRenderingContext2D, t: number, w: number, h: number, fill: string | CanvasGradient) {
  const { pose: p, neck, head } = demoPose(t);
  const X = (q: Landmark) => q.x * w, Y = (q: Landmark) => q.y * h, s = h / 360;
  const at = (i: number) => p[i]!;
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = fill; g.fillStyle = fill;
  const seg = (a: Landmark, b: Landmark, lw: number) => {
    g.lineWidth = lw * s; g.beginPath(); g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); g.stroke();
  };
  // torso as a filled quad
  g.beginPath();
  g.moveTo(X(at(11)), Y(at(11))); g.lineTo(X(at(12)), Y(at(12)));
  g.lineTo(X(at(24)), Y(at(24))); g.lineTo(X(at(23)), Y(at(23))); g.closePath(); g.fill();
  g.lineWidth = 26 * s; g.stroke();
  seg(neck, head, 14);
  g.beginPath(); g.arc(X(head), Y(head) - 6 * s, 22 * s, 0, Math.PI * 2); g.fill();
  for (const [a, b, lw] of [[11, 13, 22], [13, 15, 18], [12, 14, 22], [14, 16, 18], [23, 25, 28], [25, 27, 22], [24, 26, 28], [26, 28, 22]])
    seg(at(a), at(b), lw);
  return p;
}

export class Demo {
  t = 0;
  private vid = Object.assign(document.createElement('canvas'), { width: DV_W, height: DV_H });
  private maskC = Object.assign(document.createElement('canvas'), { width: DM_W, height: DM_H });
  private dv = this.vid.getContext('2d', { willReadFrequently: true })!;
  private lum = new Uint8Array(DV_W * DV_H);
  private dm = this.maskC.getContext('2d', { willReadFrequently: true })!;
  private mask = new Float32Array(DM_W * DM_H);

  step(dt: number): { src: Source; pose: (Landmark | null)[] } {
    this.t += dt;
    const { dv, dm } = this;
    // "video": lit figure on a dim room
    const bg = dv.createLinearGradient(0, 0, 0, DV_H);
    bg.addColorStop(0, '#202020'); bg.addColorStop(1, '#3a3a3a');
    dv.fillStyle = bg; dv.fillRect(0, 0, DV_W, DV_H);
    const light = dv.createRadialGradient(DV_W * 0.35, DV_H * 0.15, 10, DV_W * 0.5, DV_H * 0.5, DV_W * 0.45);
    light.addColorStop(0, '#f2f2f2'); light.addColorStop(1, '#4a4a4a');
    const pose = drawFigure(dv, this.t, DV_W, DV_H, light);
    toLum(dv.getImageData(0, 0, DV_W, DV_H).data, this.lum);
    // mask
    dm.fillStyle = '#000'; dm.fillRect(0, 0, DM_W, DM_H);
    drawFigure(dm, this.t, DM_W, DM_H, '#fff');
    const d = dm.getImageData(0, 0, DM_W, DM_H).data;
    for (let k = 0; k < this.mask.length; k++) this.mask[k] = d[k * 4] / 255;
    return { src: { w: DV_W, h: DV_H, mirror: false, mask: this.mask, mw: DM_W, mh: DM_H, lum: this.lum, lw: DV_W, lh: DV_H }, pose };
  }
}
