import React, { useEffect, useState } from 'react';
import { POSTURES, postureOf, tierOf } from '../postures';

/* Fixed order, so bars never jump around as the ranking changes. */
const ORDER = ['upright', 'lean_left', 'lean_right', 'lean_forward', 'slouch_back',
  'perch_edge', 'cross_leg_left', 'cross_leg_right', 'empty', 'no_contact'];

const METRICS = [
  ['accuracy', 'Accuracy'],
  ['macro_f1', 'Macro F1'],
  ['balanced_acc', 'Balanced acc.'],
  ['hold_acc', 'Hold-out acc.'],
  ['acc_nc_merged', 'Acc. · no-contact merged'],
];

const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);

export default function ModelPanel({ data, meta, mode, status, onCalibrate }) {
  const live = data?.mode === mode ? data : null;
  const m = live?.model;
  const stable = live?.posture;
  const p = postureOf(stable);
  const tier = tierOf(stable);
  const isSvm = meta?.scoreKind === 'votes';

  const classes = ORDER.filter((c) =>
    meta?.classes?.includes(c) || (c === 'no_contact' && mode === 'backrest'));

  const truth = live?.label;
  const truthShown = truth && (mode === 'backrest' && ['empty', 'lean_forward', 'perch_edge'].includes(truth)
    ? 'no_contact' : truth);

  return (
    <div className="card ml-card">
      <div className="card-head">
        <div>
          <div className="card-title">Model output</div>
          <div className="card-subtitle">
            {meta ? `${meta.name} trained on the ${meta.mat} mat · ${meta.inputs}` : 'Loading model…'}
          </div>
        </div>
        {meta && <span className="file-chip" title="Model bundle">{meta.file}</span>}
      </div>

      <div className="ml-body">
        <section className="ml-verdict">
          <div className="verdict">
            <span className="verdict-icon" style={{ background: tier.color, color: p.tier === 'idle' ? 'var(--text-mid)' : '#fff' }}>
              {p.icon}
            </span>
            <div className="verdict-text">
              <div className="verdict-name">{stable ? p.name : 'Waiting for frames…'}</div>
              <div className="verdict-desc">{stable ? p[mode] : 'Nothing has arrived from the mat yet.'}</div>
            </div>
          </div>

          <div className="kpi-row tight">
            <div className="kpi">
              <div className="kpi-value">{m ? pct(m.confidence) : '—'}</div>
              <div className="kpi-label">Confidence · smoothed</div>
            </div>
            <div className="kpi">
              <div className="kpi-value sm">{m ? postureOf(m.shown).name : '—'}</div>
              <div className="kpi-label">This frame</div>
            </div>
            <div className="kpi">
              <div className="kpi-value sm">
                <span className="tier-icon" style={{ color: tier.color }}>{tier.icon}</span> {stable ? tier.label : '—'}
              </div>
              <div className="kpi-label">Posture quality</div>
            </div>
          </div>

          {truth && (
            <div className={`truth-row ${truthShown === stable ? 'match' : ''}`}>
              <span className="truth-tag">{status?.source === 'replay' ? 'Capture label' : 'Simulator is showing'}</span>
              {postureOf(truth).name}
              <span className="truth-verdict">{truthShown === stable ? '✓ model agrees' : '✗ model differs'}</span>
            </div>
          )}

          {m?.gated && (
            <div className="gate-note">
              <strong>Below the contact gate.</strong> Total load {m.totalLoad} &lt; {m.gate} counts, so the
              model sees an empty mat.{' '}
              {mode === 'backrest' && <>On the backrest, <em>empty</em>, <em>leaning forward</em> and{' '}
                <em>perched on the edge</em> all look identical, so they’re reported together as “No back contact”.</>}
            </div>
          )}

          <div className="mini-title">
            Class scores
            <span className="mini-sub">
              {isSvm
                ? 'Softmax of the SVM’s one-vs-one votes (it has no calibrated probabilities)'
                : 'Softmax probability'}
              {' · bar = smoothed, tick = this frame'}
            </span>
          </div>
          <div className="prob-list">
            {classes.map((c) => {
              const sm = m?.smoothed?.[c] ?? 0;
              const raw = c === 'no_contact' ? (m?.gated ? 1 : 0) : (m?.probs?.[c] ?? 0);
              const on = c === stable;
              const votes = m?.scores?.[c];
              return (
                <div
                  key={c}
                  className={`prob-row ${on ? 'on' : ''}`}
                  title={`${POSTURES[c]?.name ?? c}: smoothed ${pct(sm, 1)}, this frame ${pct(raw, 1)}`
                    + (votes != null ? ` · ${votes.toFixed(2)} votes of 8` : '')}
                >
                  <span className="prob-name">{POSTURES[c]?.name ?? c}</span>
                  <span className="prob-track">
                    <span className="prob-fill" style={{ width: `${sm * 100}%` }} />
                    {raw >= 0.005 && <span className="prob-tick" style={{ left: `calc(${raw * 100}% - 1px)` }} />}
                  </span>
                  <span className="prob-val">{pct(sm)}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="ml-details">
          <div className="mini-title">Test-set performance</div>
          <div className="metric-grid">
            {METRICS.filter(([k]) => meta?.testMetrics?.[k] != null).map(([k, label]) => (
              <div key={k} className="metric">
                <div className="metric-value">{pct(meta.testMetrics[k], 1)}</div>
                <div className="metric-label">{label}</div>
              </div>
            ))}
          </div>

          <div className="mini-title">Live inference</div>
          <dl className="facts">
            <dt>Latency</dt><dd>{m ? `${m.latencyMs.toFixed(2)} ms` : '—'}</dd>
            <dt>Frames in</dt><dd>{live ? `${live.inputFps} /s` : '—'}</dd>
            <dt>Total load</dt>
            <dd>{m ? <>{Math.round(m.totalLoad)} <span className="muted">/ gate {m.gate}</span></> : '—'}</dd>
            <dt>Noise floor</dt><dd>{meta ? `< ${meta.noiseThreshold} counts ignored` : '—'}</dd>
          </dl>

          <Calibration status={status} onCalibrate={onCalibrate} mode={mode} />

          {meta?.params && (
            <details className="params">
              <summary>Hyper-parameters</summary>
              <dl className="facts">
                {Object.entries(meta.params).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{typeof v === 'number' ? +v.toPrecision(3) : String(v)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}

/** Body weight feeds load_per_kg (an SVM input); gain rescales the mat to
 *  the units the models were trained on. Commit on Enter or blur. */
function Calibration({ status, onCalibrate, mode }) {
  const [weight, setWeight] = useState('');
  const [gain, setGain] = useState('');

  useEffect(() => { if (status?.weightKg != null) setWeight(String(status.weightKg)); }, [status?.weightKg]);
  useEffect(() => { if (status?.gain != null) setGain(String(status.gain)); }, [status?.gain]);

  const commit = (key, raw) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0) onCalibrate({ [key]: v });
  };
  const onKey = (key) => (e) => { if (e.key === 'Enter') e.currentTarget.blur(); };

  return (
    <>
      <div className="mini-title">Calibration</div>
      <div className="calib">
        <label>
          <span>Body weight</span>
          <span className="input-unit">
            <input type="number" min="20" max="250" step="1" value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onBlur={(e) => commit('weightKg', e.target.value)} onKeyDown={onKey('weightKg')} />
            kg
          </span>
        </label>
        <label>
          <span>Input gain</span>
          <span className="input-unit">
            <input type="number" min="0.1" max="20" step="0.1" value={gain}
              onChange={(e) => setGain(e.target.value)}
              onBlur={(e) => commit('gain', e.target.value)} onKeyDown={onKey('gain')} />
            ×
          </span>
        </label>
      </div>
      <div className="calib-hint">
        {mode === 'backrest'
          ? 'The SVM uses load ÷ body weight as an input. Raise the gain if total load sits far below the training range in the feature table.'
          : 'The CNN reads load as a percentage of the total, so gain only shifts the contact gate.'}
      </div>
    </>
  );
}
