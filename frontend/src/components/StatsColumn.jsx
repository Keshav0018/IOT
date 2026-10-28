import React from 'react';
import { MODE_COPY, TIERS, postureOf, tierOf } from '../postures';

function statusFor(score) {
  if (score == null) return { ...TIERS.idle, label: null };
  if (score >= 75) return { ...TIERS.good, label: 'Good posture' };
  if (score >= 50) return { ...TIERS.warning, label: 'Drifting — adjust a little' };
  if (score >= 35) return { ...TIERS.serious, label: 'Poor posture' };
  return { ...TIERS.critical, label: 'Correct your posture' };
}

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Bar that grows left or right from a centre tick — the natural form for a
 *  signed balance reading, where zero is the target rather than the floor. */
function DivergingBar({ value, limit = 40, negative, positive }) {
  const clamped = Math.max(-limit, Math.min(limit, value || 0));
  const pct = (Math.abs(clamped) / limit) * 50;
  const over = Math.abs(value || 0) > 15;

  return (
    <div className="diverge">
      <div className="diverge-ends">
        <span>{negative}</span>
        <span>{positive}</span>
      </div>
      <div className="diverge-track">
        <span className="diverge-centre" />
        <span
          className="diverge-fill"
          style={{
            width: `${pct}%`,
            [clamped < 0 ? 'right' : 'left']: '50%',
            background: over ? '#D03B3B' : 'var(--accent)',
          }}
        />
      </div>
      <div className="diverge-read">
        {Math.abs(value || 0) < 1.5
          ? 'centred'
          : `${Math.abs(value).toFixed(0)}% ${value < 0 ? negative.toLowerCase() : positive.toLowerCase()}`}
      </div>
    </div>
  );
}

export default function StatsColumn({ data, mode, onReset }) {
  const live = data?.mode === mode ? data : null;
  const copy = MODE_COPY[mode];
  const score = live?.score ?? null;
  const status = statusFor(score);
  const posture = live?.posture;

  const sitSeconds = live?.session?.sitSeconds ?? 0;
  const goodSeconds = live?.session?.goodSeconds ?? 0;
  const goodPct = sitSeconds > 0 ? Math.round((goodSeconds / sitSeconds) * 100) : 0;
  const byPosture = Object.entries(live?.session?.byPosture ?? {})
    .filter(([, s]) => s >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="stats-column">
      {/* ── Posture score: the number the dashboard leads with ── */}
      <div className="card stat-card">
        <div className="card-title">Posture score</div>
        <div className="hero-figure">
          {score ?? '—'}<span className="hero-unit">/100</span>
        </div>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${score ?? 0}%`, background: status.color }} />
        </div>
        <div className="status-pill">
          <span className="status-icon" style={{ color: status.color }}>{status.icon}</span>
          {status.label ?? (posture ? postureOf(posture).name : copy.emptyText)}
        </div>
        <div className="score-note">Expected quality over the model’s class probabilities</div>
      </div>

      {/* ── Balance ── */}
      <div className="card stat-card">
        <div className="card-title">Weight balance</div>
        <div className="card-subtitle">Share of load either side of the mat’s centre</div>
        <DivergingBar value={live?.balanceLR ?? 0} negative="Left" positive="Right" />
        <DivergingBar value={live?.balanceFB ?? 0} negative={copy.vert.neg} positive={copy.vert.pos} />
      </div>

      {/* ── Load ── */}
      <div className="card stat-card">
        <div className="card-title">Load &amp; contact</div>
        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-value">{live ? Math.round(live.total) : 0}</div>
            <div className="kpi-label">Total counts</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{live?.contact ?? 0}<span className="kpi-unit">/100</span></div>
            <div className="kpi-label">Cells in contact</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{live?.peak?.value ? Math.round(live.peak.value) : 0}</div>
            <div className="kpi-label">
              Peak {live?.peak ? `· R${live.peak.row + 1}C${live.peak.col + 1}` : ''}
            </div>
          </div>
        </div>
      </div>

      {/* ── Session ── */}
      <div className="card stat-card">
        <div className="card-head">
          <div className="card-title">This session</div>
          <button className="ghost-btn sm" onClick={onReset}>Reset</button>
        </div>
        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-value">{duration(sitSeconds)}</div>
            <div className="kpi-label">{copy.occupied}</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{goodPct}<span className="kpi-unit">%</span></div>
            <div className="kpi-label">Upright</div>
          </div>
        </div>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${goodPct}%`, background: TIERS.good.color }} />
        </div>
        {byPosture.length > 0 && (
          <ul className="session-list">
            {byPosture.map(([k, s]) => (
              <li key={k}>
                <span className="band-key-dot" style={{ background: tierOf(k).color }} />
                <span className="session-name">{postureOf(k).name}</span>
                <span className="session-time">{duration(s)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
