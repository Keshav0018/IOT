import React from 'react';
import { FEATURES, formatFeature } from '../postures';

const Z_LIMIT = 3;

/** Signed z-score as a bar growing either way from the training mean. */
function ZBar({ z }) {
  const c = Math.max(-Z_LIMIT, Math.min(Z_LIMIT, z));
  const w = (Math.abs(c) / Z_LIMIT) * 50;
  const out = Math.abs(z) > Z_LIMIT;
  return (
    <span className="zbar" title={`${z >= 0 ? '+' : ''}${z.toFixed(2)} σ from the training mean`}>
      <span className="zbar-centre" />
      <span className={`zbar-fill ${out ? 'out' : ''}`}
        style={{ width: `${w}%`, [c < 0 ? 'right' : 'left']: '50%' }} />
    </span>
  );
}

export default function FeaturePanel({ data, meta, mode }) {
  const live = data?.mode === mode ? data : null;
  const feats = live?.features ?? {};
  const stats = meta?.featureStats;
  const names = meta?.engineeredFeatures ?? Object.keys(feats);
  const outliers = stats
    ? names.filter((k) => stats[k] && Math.abs((feats[k] - stats[k][0]) / stats[k][1]) > Z_LIMIT)
    : [];

  return (
    <div className="card feat-card">
      <div className="card-title">Model features</div>
      <div className="card-subtitle">
        {stats
          ? 'Engineered inputs the SVM receives with the 100 taxels each frame. z = standardised value it actually sees.'
          : 'Computed each frame for insight. The CNN itself reads the pressure map directly.'}
      </div>

      <table className="feat-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th className="num">Value</th>
            {stats && <th className="zcol">vs training</th>}
          </tr>
        </thead>
        <tbody>
          {names.map((k) => {
            const f = FEATURES[k] ?? { name: k };
            const v = feats[k];
            const z = stats?.[k] && v != null ? (v - stats[k][0]) / stats[k][1] : null;
            return (
              <tr key={k} title={f.hint}>
                <td className="feat-name">{f.name}</td>
                <td className="num">
                  {formatFeature(k, v)}
                  {f.unit && v != null && <span className="feat-unit"> {f.unit}</span>}
                </td>
                {stats && <td className="zcol">{z != null ? <ZBar z={z} /> : null}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>

      {outliers.length > 0 && live?.sitting && (
        <div className="feat-warn">
          <span className="tier-icon" style={{ color: 'var(--warning)' }}>▲</span>{' '}
          {outliers.map((k) => FEATURES[k]?.name ?? k).join(', ')}{' '}
          {outliers.length === 1 ? 'is' : 'are'} more than {Z_LIMIT}σ from the training data — check the
          gain and body weight, or the mat’s orientation.
        </div>
      )}
    </div>
  );
}
