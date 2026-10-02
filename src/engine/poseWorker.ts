/// <reference lib="webworker" />
/* PoseLandmarker off the main thread: frames come in as VideoFrames, results go
   back as landmarks + one merged segmentation mask (max over all people) + a small
   brightness map. Reading pixels back stalls on the GPU — here it only stalls this
   worker, never the page. */
import { LUM_W, MODEL_URL, MP_BASE } from './config';
import { toLum } from './lum';
import type { PoseResult } from './types';

declare const self: DedicatedWorkerGlobalScope;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let landmarker: any = null;
let lumC: OffscreenCanvas | null = null;
let lumG: OffscreenCanvasRenderingContext2D | null = null;

function brightness(frame: VideoFrame) {
  const lw = LUM_W, lh = Math.max(1, Math.round(LUM_W * frame.displayHeight / frame.displayWidth));
  if (!lumC || lumC.width !== lw || lumC.height !== lh) {
    lumC = new OffscreenCanvas(lw, lh);
    lumG = lumC.getContext('2d', { willReadFrequently: true });
  }
  lumG!.drawImage(frame, 0, 0, lw, lh);
  return { lum: toLum(lumG!.getImageData(0, 0, lw, lh).data), lumWidth: lw, lumHeight: lh };
}

async function create(model: keyof typeof MODEL_URL, numPoses: number) {
  const { FilesetResolver, PoseLandmarker } = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_URL[model], delegate },
    runningMode: 'VIDEO', numPoses, outputSegmentationMasks: true,
  });
  try { return await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
}

self.onmessage = async (event: MessageEvent) => {
  const { type, frame, timestamp, model, numPoses } = event.data;

  if (type === 'init') {
    try {
      const next = await create(model, numPoses);
      landmarker?.close();
      landmarker = next;
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: (error as Error)?.message || String(error) });
    }
    return;
  }

  if (type !== 'frame' || !frame) return;
  if (!landmarker) { frame.close(); self.postMessage({ type: 'skip' }); return; }

  try {
    const result = landmarker.detectForVideo(frame, timestamp);
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
    const b = brightness(frame);
    const out: PoseResult & { type: 'result' } = {
      type: 'result', landmarks: result.landmarks || [], mask: mask?.buffer as ArrayBuffer ?? null, maskWidth, maskHeight,
      lum: b.lum.buffer as ArrayBuffer, lumWidth: b.lumWidth, lumHeight: b.lumHeight,
    };
    self.postMessage(out, mask ? [mask.buffer, b.lum.buffer] : [b.lum.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: (error as Error)?.message || String(error) });
  } finally {
    frame.close();
  }
};
