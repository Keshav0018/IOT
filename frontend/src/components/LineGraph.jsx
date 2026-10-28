import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';

import { MODE_COPY, TIERS, postureOf, tierOf } from '../postures';

/* Two series, one shared unit (% of load either side of centre), one axis.
   Validated pair: CVD ΔE 16.9, normal-vision ΔE 24.1, both ≥3:1 on white. */
const seriesFor = (mode) => [
  { key: 'balanceLR', name: 'Left ↔ right', color: '#1E86C9' },
  { key: 'balanceFB', name: MODE_COPY[mode].vert.name, color: '#C4775B' },
];

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const posture = payload[0]?.payload?.posture;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-head">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="chart-tooltip-row">
          <span className="chart-tooltip-key" style={{ background: entry.color }} />
          <span className="chart-tooltip-name">{entry.name}</span>
          <span className="chart-tooltip-val">{entry.value > 0 ? '+' : ''}{entry.value}%</span>
        </div>
      ))}
      {posture && <div className="chart-tooltip-foot">{postureOf(posture).name}</div>}
    </div>
  );
}

export default function LineGraph({ history, data, mode = 'seat' }) {
  const SERIES = seriesFor(mode);
  const live = {
    balanceLR: data?.balanceLR ?? 0,
    balanceFB: data?.balanceFB ?? 0,
  };

  return (
    <div className="card graph-card">
      <div className="card-head">
        <div>
          <div className="card-title">Balance over time</div>
          <div className="card-subtitle">
            Load either side of the mat’s centre — zero is centred. Last 30 seconds.
          </div>
        </div>
        <div className="graph-legend">
          {SERIES.map((s) => (
            <div key={s.key} className="graph-legend-item">
              <span className="graph-legend-dot" style={{ background: s.color }} />
              {s.name}
              <span className="graph-legend-value">
                {live[s.key] > 0 ? '+' : ''}{Math.round(live[s.key])}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="graph-container">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#EFE7DC" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#8B7968', fontSize: 11 }}
              axisLine={{ stroke: '#E8DFD3' }}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={[-100, 100]}
              ticks={[-100, -50, 0, 50, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fill: '#8B7968', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <ReferenceLine y={0} stroke="#C3BAAC" strokeWidth={1} />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#C3BAAC', strokeWidth: 1 }} />
            {SERIES.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, fill: s.color, stroke: '#fff', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <PostureBand history={history} />
    </div>
  );
}

/* The band encodes how good each moment's predicted posture was, on the
   reserved status scale. The exact class is in each segment's tooltip. */
function PostureBand({ history }) {
  return (
    <div className="band">
      <div className="band-label">Model prediction</div>
      <div className="band-track">
        {history.length === 0 && <div className="band-empty">Waiting for data…</div>}
        {history.map((p, i) => (
          <span
            key={p.t ?? i}
            className="band-seg"
            style={{ background: tierOf(p.posture).color }}
            title={`${p.time} — ${postureOf(p.posture).name}`
              + (p.confidence != null ? ` (${Math.round(p.confidence * 100)}%)` : '')}
          />
        ))}
      </div>
      <div className="band-key">
        {[
          ['good', 'Upright'],
          ['warning', 'Leaning · legs crossed'],
          ['serious', 'Forward · perched'],
          ['critical', 'Slouching'],
          ['idle', 'Away · no contact'],
        ].map(([tier, label]) => (
          <span key={tier} className="band-key-item">
            <span className="band-key-dot" style={{ background: TIERS[tier].color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
