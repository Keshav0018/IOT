import React, { useRef, useEffect, useState, useCallback } from 'react';
import { MODE_COPY } from '../postures';

/* Sequential ramp — one hue, light → dark, monotonic in lightness.
   Magnitude is the only thing encoded here, so a single hue is correct;
   a rainbow would invent categories the data doesn't have. */
const RAMP = [
  [250, 246, 241], [246, 231, 218], [240, 211, 190], [230, 183, 154],
  [216, 154, 120], [196, 119,  91], [172,  93,  66], [143,  70,  46],
  [112,  50,  30], [ 78,  32,  19],
];

export const RAMP_CSS = RAMP.map(([r, g, b]) => `rgb(${r},${g},${b})`);

const ROWS = 10, COLS = 10;
const FIELD = 72;        // bicubic render resolution before the browser upscales
const PAD_L = 24;        // gutter holding the front/back profile
const PAD_B = 24;        // gutter holding the left/right profile
// Colour-scale floor in 8-bit counts, so an empty mat doesn't amplify noise.
const SCALE_FLOOR = 24;

export function rampColor(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2);
  const f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

const catmullRom = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (-p0 + p2) * t +
         (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
         (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

const at = (g, r, c) =>
  g[Math.max(0, Math.min(ROWS - 1, r)) * COLS + Math.max(0, Math.min(COLS - 1, c))];

/** Bicubic sample of the 10×10 field at fractional grid coords. */
function sample(g, gx, gy) {
  const cx = Math.floor(gx), cy = Math.floor(gy);
  const tx = gx - cx, ty = gy - cy;
  let col = [0, 0, 0, 0];
  for (let m = -1; m <= 2; m++) {
    col[m + 1] = catmullRom(
      at(g, cy + m, cx - 1), at(g, cy + m, cx),
      at(g, cy + m, cx + 1), at(g, cy + m, cx + 2), tx);
  }
  return catmullRom(col[0], col[1], col[2], col[3], ty);
}

export default function Heatmap({ frameRef, trailRef, data, mat = 'seat', onTare, onFlip }) {
  const canvasRef = useRef(null);
  const fieldRef = useRef(null);
  const scaleRef = useRef(SCALE_FLOOR);
  const hoverRef = useRef(null);
  const geomRef = useRef({ x: PAD_L, y: 0, size: 0 });   // where the field landed
  const [mode, setMode] = useState('smooth');   // 'smooth' | 'cells' | 'values'
  const [hover, setHover] = useState(null);
  const [peakScale, setPeakScale] = useState(SCALE_FLOOR);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const matRef = useRef(mat);
  matRef.current = mat;
  const copy = MODE_COPY[mat];

  /* Offscreen buffer the bicubic field is written into, then upscaled. */
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = FIELD;
    c.height = FIELD;
    fieldRef.current = c;
  }, []);

  const handleMove = useCallback((e) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    // The canvas draws in CSS pixels (the ctx is DPR-scaled), so the field
    // geometry the draw loop recorded is already in pointer units.
    const { x: gx, y: gy, size } = geomRef.current;
    if (!size) return;

    const x = e.clientX - rect.left - gx;
    const y = e.clientY - rect.top - gy;
    if (x < 0 || y < 0 || x > size || y > size) {
      hoverRef.current = null; setHover(null); return;
    }

    const col = Math.min(COLS - 1, Math.floor((x / size) * COLS));
    const row = Math.min(ROWS - 1, Math.floor((y / size) * ROWS));
    const grid = frameRef.current?.grid;
    hoverRef.current = { row, col };
    setHover({
      row, col,
      value: grid ? Math.round(grid[row * COLS + col]) : 0,
      px: x + gx, py: y + gy,
    });
  }, [frameRef]);

  const handleLeave = useCallback(() => { hoverRef.current = null; setHover(null); }, []);

  /* One animation loop, reading the ref the socket writes into. React never
     re-renders for a frame — the canvas just redraws. */
  useEffect(() => {
    let raf;
    let lastScalePush = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      const frame = frameRef.current;
      if (!cv || !frame) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = cv.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (cv.width !== Math.round(rect.width * dpr)) {
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
      }

      const ctx = cv.getContext('2d');
      const W = rect.width, H = rect.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const g = frame.grid;

      // A 10×10 mat is square, so draw it square and centre it in whatever
      // space the card gives us. Stretching it would misreport where the load is.
      const availW = W - PAD_L, availH = H - PAD_B;
      const size = Math.max(0, Math.min(availW, availH));
      const ox = PAD_L + (availW - size) / 2;
      const oy = (availH - size) / 2;
      geomRef.current = { x: ox, y: oy, size };
      const fw = size, fh = size;

      /* Auto-scale to the live peak, released slowly so the map doesn't
         breathe on every frame. Floor keeps an empty mat from amplifying noise. */
      let peak = 0;
      for (let i = 0; i < ROWS * COLS; i++) if (g[i] > peak) peak = g[i];
      scaleRef.current = Math.max(peak, scaleRef.current * 0.985, SCALE_FLOOR);
      const scale = scaleRef.current;

      const now = performance.now();
      if (now - lastScalePush > 500) {
        lastScalePush = now;
        setPeakScale(Math.round(scale));
      }

      if (modeRef.current === 'smooth') {
        // Bicubic into a small buffer, then let the browser do the final
        // bilinear upscale — smooth output for a fraction of the pixel work.
        const fc = fieldRef.current;
        const fctx = fc.getContext('2d');
        const img = fctx.createImageData(FIELD, FIELD);
        const d = img.data;
        for (let y = 0; y < FIELD; y++) {
          const gy = (y / (FIELD - 1)) * (ROWS - 1);
          for (let x = 0; x < FIELD; x++) {
            const gx = (x / (FIELD - 1)) * (COLS - 1);
            const v = Math.max(0, sample(g, gx, gy)) / scale;
            const [r, gg, b] = rampColor(v);
            const o = (y * FIELD + x) * 4;
            d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
          }
        }
        fctx.putImageData(img, 0, 0);

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(ox, oy, fw, fh, 10);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(fc, ox, oy, fw, fh);
        ctx.restore();
      } else {
        const cw = fw / COLS, ch = fh / ROWS;
        const showValues = modeRef.current === 'values';
        const fontPx = Math.max(7, Math.min(12, cw * 0.30));

        if (showValues) {
          ctx.font = `600 ${fontPx}px "DM Sans", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
        }

        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const raw = g[r * COLS + c];
            const t = raw / scale;
            const [rr, gg, bb] = rampColor(t);
            ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`;
            // 2px of surface between cells does the separating — no strokes.
            ctx.fillRect(ox + c * cw + 1, oy + r * ch + 1, cw - 2, ch - 2);

            if (showValues) {
              // Text sitting inside a colored fill picks ink or white by the
              // fill's darkness, so it always clears contrast.
              ctx.fillStyle = t > 0.55 ? '#FFFFFF' : '#3D2E24';
              ctx.fillText(String(Math.round(raw)),
                           ox + c * cw + cw / 2, oy + r * ch + ch / 2);
            }
          }
        }
      }

      /* ── Marginal profiles: how the load spreads front-to-back (left gutter)
            and side-to-side (bottom gutter). Both grow off a hairline baseline. */
      const rowMax = Math.max(...frame.rowProfile, 1);
      const colMax = Math.max(...frame.colProfile, 1);
      const gut = PAD_L - 9;
      const baseX = ox - 6, baseY = oy + fh + 6;

      ctx.strokeStyle = 'rgba(61,46,36,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(baseX + 0.5, oy); ctx.lineTo(baseX + 0.5, oy + fh);
      ctx.moveTo(ox, baseY + 0.5); ctx.lineTo(ox + fw, baseY + 0.5);
      ctx.stroke();

      ctx.fillStyle = 'rgba(196,119,91,0.5)';
      const bh = fh / ROWS, bw = fw / COLS;
      for (let r = 0; r < ROWS; r++) {
        const len = (frame.rowProfile[r] / rowMax) * gut;
        ctx.fillRect(baseX - len, oy + r * bh + 1, len, bh - 2);
      }
      for (let c = 0; c < COLS; c++) {
        const len = (frame.colProfile[c] / colMax) * gut;
        ctx.fillRect(ox + c * bw + 1, baseY, bw - 2, len);
      }

      /* ── Backrest zones the SVM reads: shoulder blades (rows 1–4) and lumbar (rows 8–10) ── */
      if (matRef.current === 'backrest') drawZones(ctx, ox, oy, fw, fh);

      /* ── Seat outline ── */
      ctx.strokeStyle = 'rgba(61,46,36,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(ox + 0.5, oy + 0.5, fw - 1, fh - 1, 10);
      ctx.stroke();

      if (!frame.sitting) { drawEmpty(ctx, ox, oy, fw, fh); return; }

      /* ── Centre-of-pressure trail, oldest faintest ── */
      const toPx = (p) => ({
        x: ox + ((p.x + 1) / 2) * fw,
        y: oy + ((1 - p.y) / 2) * fh,
      });
      const trail = trailRef.current || [];
      if (trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const a = toPx(trail[i - 1]), b = toPx(trail[i]);
          ctx.strokeStyle = `rgba(30,134,201,${(i / trail.length) * 0.5})`;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      /* ── Centre of pressure + the seat centre it should sit near ── */
      const centre = toPx({ x: 0, y: 0 });
      ctx.strokeStyle = 'rgba(61,46,36,0.25)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(ox, centre.y);  ctx.lineTo(ox + fw, centre.y);
      ctx.moveTo(centre.x, oy);  ctx.lineTo(centre.x, oy + fh);
      ctx.stroke();
      ctx.setLineDash([]);

      const cop = toPx(frame.cop);
      ctx.beginPath();
      ctx.moveTo(centre.x, centre.y);
      ctx.lineTo(cop.x, cop.y);
      ctx.strokeStyle = 'rgba(30,134,201,0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 2px surface ring keeps the marker readable over any ramp step
      ctx.beginPath();
      ctx.arc(cop.x, cop.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cop.x, cop.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#1E86C9';
      ctx.fill();

      /* ── Hovered cell ── */
      const h = hoverRef.current;
      if (h) {
        ctx.strokeStyle = 'rgba(61,46,36,0.75)';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox + h.col * bw, oy + h.row * bh, bw, bh);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frameRef, trailRef]);

  const sitting = data?.sitting;

  return (
    <div className="card map-card">
      <div className="card-head">
        <div>
          <div className="card-title">{copy.mapTitle}</div>
          <div className="card-subtitle">{copy.mapSubtitle}</div>
        </div>
        <div className="seg">
          <button className={mode === 'smooth' ? 'on' : ''} onClick={() => setMode('smooth')}>Smooth</button>
          <button className={mode === 'cells' ? 'on' : ''} onClick={() => setMode('cells')}>Cells</button>
          <button className={mode === 'values' ? 'on' : ''} onClick={() => setMode('values')}>Values</button>
        </div>
      </div>

      <div className="map-frame">
        <div className="map-canvas-wrap">
          <span className="map-axis top">{copy.axes.top}</span>
          <span className="map-axis bottom">{copy.axes.bottom}</span>
          <span className="map-axis left">{copy.axes.left}</span>
          <span className="map-axis right">{copy.axes.right}</span>

          <canvas
            ref={canvasRef}
            className="map-canvas"
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
          />
          {hover && (
            <div
              className="map-tooltip"
              style={{
                left: `${hover.px}px`,
                top: `${hover.py}px`,
                transform: `translate(${hover.px > 200 ? '-108%' : '8%'}, -50%)`,
              }}
            >
              <div className="map-tooltip-head">R{hover.row + 1} · C{hover.col + 1}</div>
              <div className="map-tooltip-value">{hover.value}</div>
              <div className="map-tooltip-sub">
                {Math.round((hover.value / Math.max(peakScale, 1)) * 100)}% of peak
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="map-footer">
        <div className="scale">
          <span className="scale-label">0</span>
          <div className="scale-bar" style={{ background: `linear-gradient(90deg, ${RAMP_CSS.join(',')})` }} />
          <span className="scale-label">{peakScale}</span>
        </div>
        <div className="map-legend">
          <span className="key cop" /> Centre of pressure
          <span className="key sep" />
          <span className={`live-chip ${sitting ? 'on' : ''}`}>
            {sitting ? `${data?.contact ?? 0}/100 cells in contact` : copy.emptyText}
          </span>
        </div>
        <div className="flip-group" title="Correct the mat's mounted orientation">
          <button
            className={`ghost-btn sm ${data?.orientation?.flipRows ? 'active' : ''}`}
            onClick={() => onFlip?.({ flipRows: !data?.orientation?.flipRows })}
          >
            ⇅ Front/back
          </button>
          <button
            className={`ghost-btn sm ${data?.orientation?.flipCols ? 'active' : ''}`}
            onClick={() => onFlip?.({ flipCols: !data?.orientation?.flipCols })}
          >
            ⇄ Left/right
          </button>
          <button
            className={`ghost-btn sm ${data?.orientation?.transpose ? 'active' : ''}`}
            onClick={() => onFlip?.({ transpose: !data?.orientation?.transpose })}
            title="Swap rows and columns"
          >
            ⤡ Swap axes
          </button>
        </div>

        <button className="ghost-btn" onClick={onTare} title="Re-zero the mat while nobody is sitting on it">
          Zero mat
        </button>
      </div>
    </div>
  );
}

function drawZones(ctx, ox, oy, fw, fh) {
  const rh = fh / ROWS;
  const zones = [
    { from: 0, to: 4, label: 'Shoulder blades' },
    { from: 7, to: 10, label: 'Lumbar' },
  ];
  ctx.save();
  ctx.strokeStyle = 'rgba(61,46,36,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  for (const z of zones) {
    const y0 = oy + z.from * rh, y1 = oy + z.to * rh;
    ctx.beginPath();
    if (z.from > 0) { ctx.moveTo(ox, y0 + 0.5); ctx.lineTo(ox + fw, y0 + 0.5); }
    if (z.to < ROWS) { ctx.moveTo(ox, y1 + 0.5); ctx.lineTo(ox + fw, y1 + 0.5); }
    ctx.stroke();
    // label on a surface chip so it reads over any ramp step
    const tw = ctx.measureText(z.label).width;
    const lx = ox + fw - 6, ly = y0 + 5;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(lx - tw - 5, ly - 2, tw + 10, 15);
    ctx.fillStyle = '#6B5647';
    ctx.fillText(z.label, lx, ly);
  }
  ctx.restore();
}

function drawEmpty(ctx, ox, oy, fw, fh) {
  ctx.fillStyle = 'rgba(139,121,104,0.75)';
  ctx.font = '500 12px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No load detected', ox + fw / 2, oy + fh / 2);
}
