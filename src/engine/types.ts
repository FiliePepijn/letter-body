export interface Landmark { x: number; y: number; visibility?: number }
export interface ScreenPoint { sx: number; sy: number; visibility?: number }

/** One frame of input for the letter grid: a small brightness map plus a body mask.
    Both arrive as plain arrays, so the main thread never reads pixels back from the GPU. */
export interface Source {
  w: number; h: number;      // picture size (aspect for the cover fit)
  mirror: boolean;
  mask: Float32Array;        // 0..1 per mask pixel
  mw: number; mh: number;    // mask size
  lum: Uint8Array;           // 0..255 per brightness pixel
  lw: number; lh: number;    // brightness map size
}

export interface PoseResult {
  landmarks: Landmark[][];
  mask: ArrayBuffer | null;
  maskWidth: number;
  maskHeight: number;
  lum: ArrayBuffer;
  lumWidth: number;
  lumHeight: number;
}

export interface CameraInfo { id: string; label: string }

export interface Stats { fps: number; workMs: number; tier: string }

export type Phase = 'loading' | 'show';
