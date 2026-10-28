import React from 'react';
import { usePostureSocket } from './hooks/usePostureSocket';
import Heatmap from './components/Heatmap';
import PostureModel from './components/PostureModel';
import StatsColumn from './components/StatsColumn';
import LineGraph from './components/LineGraph';
import ModelPanel from './components/ModelPanel';
import FeaturePanel from './components/FeaturePanel';
import { MODE_COPY, postureOf } from './postures';

const SOURCE_LABEL = { mqtt: 'MQTT', direct: 'Direct Wi-Fi', sim: 'Simulator', replay: 'Replay' };
const LINK_NAME = { mqtt: 'Broker', direct: 'ESP Wi-Fi', sim: 'Simulator', replay: 'Capture' };

export default function App() {
  const {
    connected, status, models, data, history, error, frameRef, trailRef,
    setMode, setSource, tare, flip, setCalibration, resetSession,
  } = usePostureSocket();

  const mode = status?.mode ?? data?.mode ?? 'seat';
  const source = status?.source ?? 'mqtt';
  const linkUp = connected && !!status?.link?.up;
  const deviceUp = linkUp && !!status?.device?.up;
  const posture = data?.mode === mode ? data?.posture : null;
  const p = postureOf(posture);
  const idle = !posture || p.tier === 'idle';
  const hardware = source === 'mqtt' || source === 'direct';

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="brand">
          <h1>Posture<span>Guard</span></h1>
          <span className="brand-sub">10 × 10 pressure matrix · ML posture detection</span>
        </div>

        <div className="header-right">
          <div className="control-group" role="group" aria-label="Mat placement">
            <span className="control-label">Mat on</span>
            <div className="seg lg">
              {['seat', 'backrest'].map((m) => (
                <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {MODE_COPY[m].label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group" role="group" aria-label="Data source">
            <span className="control-label">Source</span>
            <div className="seg">
              {(status?.availableSources ?? ['mqtt', 'direct', 'sim']).map((s) => (
                <button key={s} className={source === s ? 'on' : ''} onClick={() => setSource(s)}>
                  {SOURCE_LABEL[s] ?? s}
                </button>
              ))}
            </div>
          </div>

          {/* Three hops, shown as a chain — you can see *where* the stream broke */}
          <div className="link-chain" title={status?.link?.label ?? ''}>
            <span className={`link-node ${connected ? 'up' : ''}`}>
              <span className="link-dot" /> Server
            </span>
            <span className={`link-wire ${linkUp ? 'up' : ''}`} />
            <span className={`link-node ${linkUp ? 'up' : ''}`}>
              <span className="link-dot" /> {LINK_NAME[source] ?? 'Link'}
            </span>
            <span className={`link-wire ${deviceUp ? 'up' : ''}`} />
            <span className={`link-node ${deviceUp ? 'up' : ''}`}>
              <span className="link-dot" /> {hardware ? 'ESP32' : 'Frames'}
            </span>
          </div>

          <div className="rate-chip" title="Frames per second reaching this browser">
            {data?.fps ?? 0} <span>fps</span>
          </div>

          <div className={`posture-label ${idle ? 'idle' : ''}`}>
            <span className="posture-icon">{p.icon}</span>
            {posture ? p.name : 'Waiting…'}
          </div>
        </div>
      </header>

      <ConnectionNotice connected={connected} status={status} error={error} source={source} />

      <div className="dashboard-grid">
        <Heatmap frameRef={frameRef} trailRef={trailRef} data={data} mat={mode} onTare={tare} onFlip={flip} />
        <PostureModel posture={posture} mode={mode} frameRef={frameRef} />
        <StatsColumn data={data} mode={mode} onReset={resetSession} />
        <ModelPanel data={data} meta={models?.[mode]} mode={mode} status={status} onCalibrate={setCalibration} />
        <FeaturePanel data={data} meta={models?.[mode]} mode={mode} />
        <LineGraph history={history} data={data} mode={mode} />
      </div>
    </div>
  );
}

/** One line under the header saying what's wrong with the link, if anything. */
function ConnectionNotice({ connected, status, error, source }) {
  let msg = null;
  if (!connected) {
    msg = 'Can’t reach the backend — start it with `python -m app` in backend/.';
  } else if (error) {
    msg = error;
  } else if (status?.taring) {
    msg = 'Zeroing the mat — keep it unloaded for a couple of seconds.';
  } else if (status?.tareNote) {
    msg = status.tareNote;
  } else if (source === 'mqtt' && status && !status.link?.up) {
    msg = `Connecting to ${status.link?.label}…`;
  } else if (source === 'mqtt' && status?.link?.up && !status.device?.up) {
    msg = `Broker connected. Waiting for the ESP32 to publish on ${status.device?.topic}.`;
  } else if (source === 'direct' && status && !status.link?.up) {
    msg = status.device?.error
      ?? `Connecting to the ESP32 at ${status.link?.label} — join its Wi-Fi “PostureGuard-Mat” first.`;
  } else if (source === 'direct' && status?.link?.up && !status.device?.up) {
    msg = 'Connected to the ESP32, waiting for frames…';
  }
  if (!msg) return null;
  return <div className="notice" role="status">{msg}</div>;
}
