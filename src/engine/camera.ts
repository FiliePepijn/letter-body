/* Webcam + PoseLandmarker. Prefers a worker (VideoFrames are transferred, the
   model never blocks rendering); falls back to running on the main thread.
   Frames are sent at most poseFps times a second, one in flight at a time. */
import { LUM_W, MODEL_URL, MP_BASE } from './config';
import { toLum } from './lum';
import type { CameraInfo, Landmark, PoseResult, Source } from './types';

type Model = keyof typeof MODEL_URL;

export class Camera {
  readonly video: HTMLVideoElement;
  poseFps = 30;

  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private landmarker: any = null;
  private pending = false;
  private lastVideoTime = -1;
  private lastSent = 0;

  private mask: Float32Array | null = null;
  private mw = 0;
  private mh = 0;
  private lum: Uint8Array | null = null;
  private lw = 0;
  private lh = 0;
  private pose: Landmark[] | null = null;
  private poseFresh = false;
  private poseAt = 0;
  private prevPoseAt = 0;

  constructor(video: HTMLVideoElement) { this.video = video; }

  async open(deviceId: string | null) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
               width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    this.lastVideoTime = -1;
  }

  currentId() { return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''; }

  async list(): Promise<CameraInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput')
                  .map((d, k) => ({ id: d.deviceId, label: d.label || `Camera ${k + 1}` }));
  }

  /** Load the pose model; resolves false if neither the worker nor the main thread can run it. */
  async start(model: Model, numPoses: number) {
    if (await this.startWorker(model, numPoses)) return true;
    this.landmarker = await createLandmarker(model, numPoses);
    return true;
  }

  /** Swap models (full ↔ lite) without dropping the stream; the old one keeps running until the new one is ready. */
  async setModel(model: Model, numPoses: number) {
    if (this.worker) { this.worker.postMessage({ type: 'init', model, numPoses }); return; }
    if (!this.landmarker) return;
    const next = await createLandmarker(model, numPoses);
    this.landmarker.close();
    this.landmarker = next;
  }

  /** Feed the model if a frame is due; return the latest picture + mask for the grid. */
  frame(now: number): Source | null {
    const v = this.video;
    if ((!this.landmarker && !this.worker) || v.readyState < 2) return null;
    const due = now - this.lastSent >= 1000 / this.poseFps - 2;
    if (due && !this.pending && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      this.lastSent = now;
      if (this.worker) {
        try {
          const frame = new VideoFrame(v);
          this.pending = true;
          this.worker.postMessage({ type: 'frame', frame, timestamp: now }, [frame]);
        } catch {
          this.worker.terminate(); this.worker = null; this.pending = false;
        }
      } else {
        this.applyResult(detectOnMain(this.landmarker, v, now));
      }
    }
    if (!this.mask || !this.lum) return null;
    return { w: v.videoWidth, h: v.videoHeight, mirror: true, mask: this.mask, mw: this.mw, mh: this.mh,
             lum: this.lum, lw: this.lw, lh: this.lh };
  }

  /** The newest pose since the last call, with the time between the two model results. */
  takePose(): { landmarks: Landmark[] | null; dt: number } | null {
    if (!this.poseFresh) return null;
    this.poseFresh = false;
    return { landmarks: this.pose, dt: Math.min(0.1, Math.max(1 / 120, (this.poseAt - this.prevPoseAt) / 1000)) };
  }

  destroy() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.worker?.terminate(); this.worker = null;
    this.landmarker?.close?.(); this.landmarker = null;
  }

  private applyResult(r: PoseResult) {
    if (r.mask) { this.mask = new Float32Array(r.mask); this.mw = r.maskWidth; this.mh = r.maskHeight; }
    else if (this.mask) this.mask.fill(0);
    else { this.mask = new Float32Array(1); this.mw = this.mh = 1; }   // nobody in view: the room still shows
    this.lum = new Uint8Array(r.lum); this.lw = r.lumWidth; this.lh = r.lumHeight;
    this.pose = r.landmarks[0] ?? null;
    this.prevPoseAt = this.poseAt || performance.now() - 33;
    this.poseAt = performance.now();
    this.poseFresh = true;
  }

  private startWorker(model: Model, numPoses: number) {
    if (typeof VideoFrame === 'undefined' || !window.Worker) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      try {
        const w = new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module' });
        const fail = () => {
          w.terminate();
          if (this.worker === w) this.worker = null;
          this.pending = false;
          resolve(false);
        };
        w.onmessage = (e: MessageEvent) => {
          const { type, ...rest } = e.data;
          if (type === 'ready') { this.worker = w; resolve(true); }
          else if (type === 'result') { this.pending = false; this.applyResult(rest as PoseResult); }
          else if (type === 'skip') this.pending = false;
          else if (type === 'error') fail();
        };
        w.onerror = fail;
        w.postMessage({ type: 'init', model, numPoses });
      } catch {
        resolve(false);
      }
    });
  }
}

async function createLandmarker(model: Model, numPoses: number) {
  const { FilesetResolver, PoseLandmarker } = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_URL[model], delegate },
    runningMode: 'VIDEO', numPoses, outputSegmentationMasks: true,
  });
  try { return await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
}

// main-thread fallback only: this readback does stall the page, which is why the worker is preferred
let mainLumG: CanvasRenderingContext2D | null = null;
function mainBrightness(video: HTMLVideoElement) {
  const lw = LUM_W, lh = Math.max(1, Math.round(LUM_W * video.videoHeight / video.videoWidth));
  if (!mainLumG || mainLumG.canvas.width !== lw || mainLumG.canvas.height !== lh)
    mainLumG = Object.assign(document.createElement('canvas'), { width: lw, height: lh }).getContext('2d', { willReadFrequently: true })!;
  mainLumG.drawImage(video, 0, 0, lw, lh);
  return { lum: toLum(mainLumG.getImageData(0, 0, lw, lh).data).buffer as ArrayBuffer, lumWidth: lw, lumHeight: lh };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectOnMain(landmarker: any, video: HTMLVideoElement, now: number): PoseResult {
  const result = landmarker.detectForVideo(video, now);
  const masks = result.segmentationMasks || [];
  let mask: Float32Array | null = null, maskWidth = 0, maskHeight = 0;
  if (masks.length) {
    maskWidth = masks[0].width; maskHeight = masks[0].height;
    mask = new Float32Array(maskWidth * maskHeight);
    for (const m of masks) {
      const values = m.getAsFloat32Array();
      for (let i = 0; i < values.length; i++) if (values[i] > mask[i]) mask[i] = values[i];
      m.close();
    }
  }
  return { landmarks: result.landmarks || [], mask: mask?.buffer as ArrayBuffer ?? null, maskWidth, maskHeight, ...mainBrightness(video) };
}
