// ---------- slides ----------
/* One slide per scroll step. Scrolling to a new step explodes the previous caption
   and crossfades the scene behind the body. Scenes are rendered in letters too:
   'cloud' = a .pcd point cloud, 'video' = any video file (mp4/webm). Drop files in
   public/scenes/ — a missing file just leaves the room visible behind the body. */
export type Scene = { kind: 'cloud'; src: string } | { kind: 'video'; src: string };
export interface Slide {
  text: string;
  layout: 'hero' | 'corner';   // hero: big and centred, no box · corner: top-right in a box
  scene?: Scene;
}
export const SLIDES: Slide[] = [
  { text: 'Hello',                layout: 'hero' },
  { text: 'I am\nPepijn',         layout: 'corner', scene: { kind: 'cloud', src: '/scenes/pepijn.pcd' } },
  { text: 'I build\nthings',      layout: 'corner', scene: { kind: 'video', src: '/scenes/builders.mp4' } },
  { text: 'i like\nnature',       layout: 'corner', scene: { kind: 'video', src: '/scenes/nature.mp4' } },
  { text: 'and\nI like\npeople',  layout: 'corner', scene: { kind: 'video', src: '/scenes/people.mp4' } },
];
export const SCENE_ALPHA = 0.45;   // brightest a scene letter gets; the body stays brighter
// the live letter body: 'camera' = webcam + MediaPipe pose, 'demo' = the stick figure, 'off' = no body
// ('off' never asks for the camera or downloads the pose model)
export const BODY: 'camera' | 'demo' | 'off' = 'off';
export const DEMO_LOOP = 16;      // the demo figure waves at the start of each loop

// ---------- tunables ----------
export const BG          = '#1a1a1a';
export const FONT        = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
export const CELL        = 15;      // grid row height in px; columns are 0.6× that
export const TRAIL       = 0.86;    // per-frame (at 60fps) fade of cells the body just left
export const SHED_P      = 0.4;     // chance a vacated cell drops a falling glyph
export const FAST_JOINT  = 900;     // px/s: wrists/ankles faster than this glitch nearby cells
export const GLITCH_R    = 90;
export const GRAVITY     = 1500;    // px/s² for falling glyphs
export const BLAST_SPEED = 1700;    // px/s: how fast the shockwave travels out from the click
export const REFORM      = 1.8;     // per second: how fast a swiped-away cell grows back
export const MIN_LOAD    = 1.8;     // s: the loader always plays at least this long
export const TEXT_LH     = 0.92;    // caption line height, in em
export const ZONE_PAD    = [3, 2] as const;   // cols, rows of space between the caption and its box
export const TXT_SS      = 3;       // supersampling per cell when measuring text coverage
export const TXT_WEIGHT  = 400;     // caption weight, same as the grid glyphs

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GLITCH_CHARS = UPPER;
// every glyph we might draw, so the atlas can pre-render them
export const ALL_CHARS = [...new Set([...LOWER, ...UPPER])];
export const CHAR_ID: Record<string, number> = Object.fromEntries(ALL_CHARS.map((c, i) => [c, i]));
export const TINTS = ['#ffffff', '#bff6ff', '#ffc4f4'];   // white, pale cyan, pale magenta

// ---------- quality tiers ----------
/* The engine starts at the last tier that held up on this device and steps down
   when frames run over budget (low power mode, hot laptop, big screen), back up
   when there is room again. */
export interface Tier {
  name: string;
  dprCap: number;         // canvas pixel ratio cap: fewer pixels per glyph blit
  fps: number;            // render cap; also stops 120Hz screens doubling the work
  poseFps: number;        // how often a camera frame goes to the pose model
  model: 'full' | 'lite';
  numPoses: number;
  maxParts: number;       // flying glyphs alive at once
  burstPer: number;       // glyphs per caption cell when it explodes
  spin: boolean;          // rotated glyphs cost a transform each
  backdropEvery: number;  // redraw the faint room letters / scene every n frames
  sceneFps: number;       // video scene frames per second sent for brightness
}
export const TIERS: Tier[] = [
  { name: 'high',   dprCap: 2,   fps: 60, poseFps: 30, model: 'full', numPoses: 2, maxParts: 9000, burstPer: 3, spin: true,  backdropEvery: 1, sceneFps: 24 },
  { name: 'medium', dprCap: 1.5, fps: 60, poseFps: 24, model: 'full', numPoses: 1, maxParts: 4000, burstPer: 2, spin: true,  backdropEvery: 2, sceneFps: 20 },
  { name: 'low',    dprCap: 1,   fps: 30, poseFps: 15, model: 'lite', numPoses: 1, maxParts: 1500, burstPer: 1, spin: false, backdropEvery: 3, sceneFps: 12 },
];

export const MODEL_URL = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};
export const LUM_W = 256;   // brightness map width; plenty for the letter grid
export const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
