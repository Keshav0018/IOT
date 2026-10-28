import { useState, useEffect, useRef, useCallback } from 'react';

// In dev the dashboard runs on Vite (5173) and talks to FastAPI on 3000; when
// FastAPI serves the built dashboard itself, it's the same origin.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL
  || (import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin);
const WS_URL = `${BACKEND_URL.replace(/^http/, 'ws')}/ws`;

const CELLS         = 100;
const GRID_ALPHA    = 0.45;  // per-cell smoothing; lower = calmer, laggier
const SCALAR_ALPHA  = 0.25;  // smoothing for balance/CoP readouts
const UI_INTERVAL   = 100;   // ms between React re-renders of the numbers
const HISTORY_STEP  = 250;   // ms between timeline samples
const MAX_HISTORY   = 120;   // 120 × 250ms = 30s of trend
const MAX_TRAIL     = 45;    // CoP trail length

const ema = (prev, next, a) => (prev == null ? next : prev + a * (next - prev));

/**
 * Frames arrive up to 25×/second. The raw frame lives in a ref that the
 * canvas reads inside its own animation loop, and React state updates at a
 * calm 10 Hz for text and charts. Same data, two clocks.
 */
export function usePostureSocket() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState(null);
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const frameRef    = useRef(null);
  const trailRef    = useRef([]);
  const gridRef     = useRef(null);
  const scalarRef   = useRef({});
  const wsRef       = useRef(null);
  const modeRef     = useRef(null);
  const lastUiRef   = useRef(0);
  const lastHistRef = useRef(0);
  const fpsRef      = useRef({ count: 0, at: 0, value: 0 });

  const resetTracking = useCallback(() => {
    gridRef.current = null;
    scalarRef.current = {};
    trailRef.current = [];
    setHistory([]);
  }, []);

  const onFrame = useCallback((incoming) => {
    const now = performance.now();

    // The mat moved to the other surface: old trends no longer mean anything.
    if (modeRef.current && modeRef.current !== incoming.mode) resetTracking();
    modeRef.current = incoming.mode;

    if (!gridRef.current || gridRef.current.length !== CELLS) {
      gridRef.current = Float32Array.from(incoming.grid);
    } else {
      const g = gridRef.current;
      for (let i = 0; i < CELLS; i++) g[i] += GRID_ALPHA * (incoming.grid[i] - g[i]);
    }

    const s = scalarRef.current;
    s.copX      = ema(s.copX,      incoming.cop.x,     SCALAR_ALPHA);
    s.copY      = ema(s.copY,      incoming.cop.y,     SCALAR_ALPHA);
    s.balanceLR = ema(s.balanceLR, incoming.balanceLR, SCALAR_ALPHA);
    s.balanceFB = ema(s.balanceFB, incoming.balanceFB, SCALAR_ALPHA);

    const f = fpsRef.current;
    f.count++;
    if (now - f.at >= 1000) {
      f.value = Math.round((f.count * 1000) / (now - f.at));
      f.count = 0;
      f.at = now;
    }

    const frame = {
      ...incoming,
      grid: gridRef.current,
      cop: { x: s.copX, y: s.copY },
      balanceLR: s.balanceLR,
      balanceFB: s.balanceFB,
      fps: f.value,
    };
    frameRef.current = frame;

    if (incoming.sitting) {
      const trail = trailRef.current;
      trail.push({ x: s.copX, y: s.copY });
      if (trail.length > MAX_TRAIL) trail.shift();
    } else {
      trailRef.current = [];
    }

    if (now - lastUiRef.current >= UI_INTERVAL) {
      lastUiRef.current = now;
      setData(frame);
    }

    if (now - lastHistRef.current >= HISTORY_STEP) {
      lastHistRef.current = now;
      const point = {
        t: Date.now(),
        time: new Date().toLocaleTimeString('en-US', {
          hour12: false, minute: '2-digit', second: '2-digit',
        }),
        balanceLR: +s.balanceLR.toFixed(1),
        balanceFB: +s.balanceFB.toFixed(1),
        score: incoming.score,
        confidence: incoming.model.confidence,
        posture: incoming.posture,
        truth: incoming.label,
        sitting: incoming.sitting,
      };
      setHistory((prev) => {
        const next = prev.length >= MAX_HISTORY ? prev.slice(1) : prev.slice();
        next.push(point);
        return next;
      });
    }
  }, [resetTracking]);

  useEffect(() => {
    let ws;
    let retry = 500;
    let timer;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => { setConnected(true); setError(null); retry = 500; };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'frame') onFrame(msg);
        else if (msg.type === 'status') setStatus(msg);
        else if (msg.type === 'hello') {
          setModels(msg.models);
          setStatus(msg.status);
          if (msg.latest) onFrame(msg.latest);
        } else if (msg.type === 'error') setError(msg.message);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, retry);          // back off, don't hammer
        retry = Math.min(retry * 2, 5000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [onFrame]);

  const send = useCallback((type, payload = {}) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  }, []);

  const actions = {
    setMode:        useCallback((mode) => send('setMode', { mode }), [send]),
    setSource:      useCallback((source) => send('setSource', { source }), [send]),
    tare:           useCallback(() => send('tare'), [send]),
    flip:           useCallback((axes) => send('setOrientation', axes), [send]),
    setCalibration: useCallback((c) => send('setCalibration', c), [send]),
    resetSession:   useCallback(() => { send('resetSession'); resetTracking(); }, [send, resetTracking]),
  };

  return { connected, status, models, data, history, error, frameRef, trailRef, ...actions };
}
