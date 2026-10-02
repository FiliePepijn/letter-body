/// <reference lib="webworker" />
/* Video scene frames → small brightness maps, off the main thread (the readback
   stalls on the GPU; here it only stalls this worker). */
import { LUM_W } from './config';
import { toLum } from './lum';

declare const self: DedicatedWorkerGlobalScope;
let c: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = (e: MessageEvent) => {
  const { id, frame } = e.data as { id: number; frame: VideoFrame };
  try {
    const lw = LUM_W, lh = Math.max(1, Math.round(LUM_W * frame.displayHeight / frame.displayWidth));
    if (!c || c.width !== lw || c.height !== lh) { c = new OffscreenCanvas(lw, lh); g = c.getContext('2d', { willReadFrequently: true }); }
    g!.drawImage(frame, 0, 0, lw, lh);
    const lum = toLum(g!.getImageData(0, 0, lw, lh).data);
    self.postMessage({ id, lum: lum.buffer, lw, lh, w: frame.displayWidth, h: frame.displayHeight }, [lum.buffer]);
  } catch {
    self.postMessage({ id, lum: null });
  } finally {
    frame.close();
  }
};
