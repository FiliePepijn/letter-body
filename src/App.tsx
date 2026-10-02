import { useEffect, useRef, useState } from 'react';
import { LetterBody } from './engine/LetterBody';
import { SLIDES } from './engine/config';
import type { CameraInfo, Phase, Stats } from './engine/types';

const showStats = new URLSearchParams(location.search).has('debug');

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<LetterBody | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [cue, setCue] = useState(0);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);

  // the canvas engine lives for the lifetime of the component
  useEffect(() => {
    history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    const engine = new LetterBody(canvasRef.current!, videoRef.current!, {
      onPhase: setPhase,
      onCameras: (list, current) => { setCameras(list); setCameraId(current); },
      onStats: showStats ? setStats : undefined,
    });
    engineRef.current = engine;
    engine.start();
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  // no scrolling until the loader is done
  useEffect(() => {
    document.documentElement.classList.toggle('locked', phase === 'loading');
  }, [phase]);

  // one full-screen step per caption: the nearest step picks the caption
  useEffect(() => {
    if (phase !== 'show') return;
    const onScroll = () =>
      setCue(Math.max(0, Math.min(SLIDES.length - 1, Math.round(window.scrollY / window.innerHeight))));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [phase]);

  useEffect(() => { engineRef.current?.setCue(cue); }, [cue]);

  // click anywhere: shockwave
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element).closest('select')) return;
      engineRef.current?.blast(e.clientX, e.clientY);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      <canvas id="stage" ref={canvasRef} />
      <video id="cam" ref={videoRef} playsInline muted autoPlay />

      <div id="steps">
        {SLIDES.map((_, k) => <section key={k} />)}
      </div>

      <div id="labels" className={phase === 'loading' ? 'hidden' : ''}>
        <div className="lab tl">LETTER BODY<br />&gt;&gt; FULL FORM<br />SILHOUETTE<br />&gt;&gt; SIGNAL<br />NOISE</div>
        <div className="lab tc">(FIGURE)</div>
        <div className="lab bc">EXPERIMENTAL COMPOSITION</div>
        <div className="lab bl">
          <span>&gt;&gt;&gt;</span><span>TYPE GESTURAL</span>
          <span>&gt; &gt;&gt;</span><span>BODY CONTROL</span>
          <span>&gt;&gt;&gt;</span><span>CLICK / BLAST</span>
        </div>
        <div className="lab br">
          {stats && <div className="stats">{stats.fps} FPS · {stats.workMs} MS · {stats.tier}</div>}
          <div className={`hint${cue === SLIDES.length - 1 ? ' gone' : ''}`}>SCROLL<br />&darr;</div>
        </div>
        {cameras.length > 1 && (
          <div className="lab tr">
            <select
              id="camSelect"
              aria-label="Camera"
              value={cameraId}
              onChange={e => { setCameraId(e.target.value); engineRef.current?.selectCamera(e.target.value); }}
            >
              {cameras.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        )}
      </div>
    </>
  );
}
