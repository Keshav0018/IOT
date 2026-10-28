import React, { useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF, RoundedBox, ContactShadows, Line } from '@react-three/drei';
import * as THREE from 'three';

import { postureOf, tierOf } from '../postures';
import { rampColor } from './Heatmap';

/* Pose per model class (radians / metres):
     hinge  whole upper body pivots at the hips: + forward, − recline
     flex   spine rounds forward, spread over lower / mid / upper back
     bend   side bend, + towards the sitter's left
     head   extra nod: + down, − up (keeps the gaze level when hinged)
     slide  pelvis slides forward on the seat
     thigh  thighs tilt down (+) or up (−) from horizontal
     knee   extra knee bend: + tucks the feet back, − pushes them forward
     cross  +1 left leg over right, −1 right over left
     view   camera angle that shows this posture best (0 = front, π/2 = side)
     lookY  height the camera aims at (higher when standing) */
const POSES = {
  upright:         { hinge: -0.04, view: 0.62 },
  lean_left:       { hinge: 0.02, flex: 0.04, bend: 0.42, view: 0.32 },
  lean_right:      { hinge: 0.02, flex: 0.04, bend: -0.42, view: 0.32 },
  lean_forward:    { hinge: 0.5, flex: 0.18, head: -0.42, view: 1.32 },
  slouch_back:     { hinge: -0.36, flex: 0.55, head: 0.05, slide: 0.13, thigh: -0.12, knee: -0.35, view: 1.32 },
  perch_edge:      { hinge: 0.1, head: -0.08, slide: 0.2, thigh: 0.3, knee: 0.3, view: 1.2 },
  cross_leg_left:  { bend: 0.04, cross: 1, view: 0.5 },
  cross_leg_right: { bend: -0.04, cross: -1, view: 0.5 },
  no_contact:      { hinge: 0.42, flex: 0.12, head: -0.34, slide: 0.04, view: 1.25 },   // off the backrest
  empty:           { standing: true, view: 0.5, lookY: 0.86 },
};
const KEYS = ['hinge', 'flex', 'bend', 'head', 'slide', 'thigh', 'knee', 'cross'];
const poseOf = (posture) => POSES[posture] ?? POSES.empty;

// Where the figure stands when the seat is empty: beside the chair, not in it.
const ASIDE = { x: -0.58, z: 0.26 };

const lerp = THREE.MathUtils.lerp;

/** Eases every pose value toward the class target; returns the live values. */
function usePose(posture) {
  const cur = useRef({ ...Object.fromEntries(KEYS.map((k) => [k, 0])), sit: 1 });
  return (delta) => {
    const t = poseOf(posture);
    const s = Math.min(3.5 * delta, 1);
    const c = cur.current;
    for (const k of KEYS) c[k] = lerp(c[k], t[k] ?? 0, s);
    c.sit = lerp(c.sit, t.standing ? 0 : 1, s);
    return c;
  };
}

/* ─────────────────────────── Avatar from GLB ────────────────────────────
   Used when frontend/public/DrexCharacter.glb exists. */

function Character({ posture }) {
  const { scene } = useGLTF('/DrexCharacter.glb');
  const rootRef = useRef();
  const bonesRef = useRef({});
  const ready = useRef(false);
  const origHipY = useRef(null);
  const origHipZ = useRef(0);
  const step = usePose(posture);

  useEffect(() => {
    if (!scene) return;
    const boneMap = {};
    scene.traverse((child) => {
      if (child.isBone) boneMap[child.name] = child;
      if (child.isMesh || child.isSkinnedMesh) child.frustumCulled = false;
    });
    const get = (name) => boneMap[name] || null;
    const B = {
      hips: get('Hips'),
      spine: get('Spine'), spine1: get('Spine1'), spine2: get('Spine2'),
      neck: get('Neck'), head: get('Head'),
      lThigh: get('LeftUpLeg'), rThigh: get('RightUpLeg'),
      lShin: get('LeftLeg'), rShin: get('RightLeg'),
      lFoot: get('LeftFoot'), rFoot: get('RightFoot'),
      lArm: get('LeftArm'), rArm: get('RightArm'),
      lForeArm: get('LeftForeArm'), rForeArm: get('RightForeArm'),
    };
    bonesRef.current = B;
    if (B.hips && origHipY.current === null) {
      origHipY.current = B.hips.position.y;
      origHipZ.current = B.hips.position.z;
    }
    // Arms down from the T-pose, elbows bent
    B.lArm?.rotation.set(0.2, 0.2, 1.2);
    B.rArm?.rotation.set(0.2, -0.2, -1.2);
    B.lForeArm?.rotation.set(-0.5, 0.3, 0);
    B.rForeArm?.rotation.set(-0.5, -0.3, 0);
    ready.current = true;
  }, [scene]);

  useFrame((_, delta) => {
    if (!ready.current) return;
    const B = bonesRef.current;
    const c = step(delta);
    const sw = c.sit;
    rootRef.current.position.set(lerp(ASIDE.x, 0, sw), 0, 0.15 + lerp(ASIDE.z, 0, sw));

    const crossL = Math.max(c.cross, 0), crossR = Math.max(-c.cross, 0);
    if (B.lThigh) {
      B.lThigh.rotation.x = lerp(0, -1.4 + c.thigh, sw) - 0.3 * crossL * sw;
      B.lThigh.rotation.z = -0.38 * crossL * sw;
    }
    if (B.rThigh) {
      B.rThigh.rotation.x = lerp(0, -1.4 + c.thigh, sw) - 0.3 * crossR * sw;
      B.rThigh.rotation.z = 0.38 * crossR * sw;
    }
    if (B.lShin) B.lShin.rotation.x = lerp(0, -1.6 - c.knee, sw) + 0.35 * crossL * sw;
    if (B.rShin) B.rShin.rotation.x = lerp(0, -1.6 - c.knee, sw) + 0.35 * crossR * sw;
    if (B.lFoot) B.lFoot.rotation.x = lerp(0, 0.5, sw);
    if (B.rFoot) B.rFoot.rotation.x = lerp(0, 0.5, sw);
    if (B.hips) {
      B.hips.position.y = lerp(origHipY.current || 0.9, 0.6, sw);
      B.hips.position.z = origHipZ.current + c.slide * sw;
    }
    const fwd = c.hinge + c.flex;
    [B.spine, B.spine1, B.spine2].filter(Boolean).forEach((bone, i) => {
      const w = [0.4, 0.35, 0.25][i];
      bone.rotation.x = fwd * w * sw;
      bone.rotation.z = c.bend * w * sw;
    });
    if (B.head) B.head.rotation.x = c.head * sw;
  });

  return <group ref={rootRef}><primitive object={scene} /></group>;
}

/* ─────────────────────────── Built-in figure ────────────────────────────
   A plain art-mannequin, built from primitives in a joint hierarchy so each
   pose value maps onto known rotations. Faces +z; its left side is +x. */

// Slate blue-grey: neutral, and clearly apart from the cream chair and the terracotta mat.
const BODY = '#7F8D9C';
const THIGH = 0.44, SHIN = 0.47, UPPER_ARM = 0.27, FOREARM = 0.24;

function Skin(props) {
  return <meshStandardMaterial color={BODY} roughness={0.88} metalness={0} {...props} />;
}

/** Smooth body part made by spinning a side profile [radius, y] around y. */
function Lathe({ profile, scale, position }) {
  const geo = useMemo(
    () => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 40),
    [profile],
  );
  return <mesh geometry={geo} scale={scale} position={position}><Skin /></mesh>;
}

/** Tapered limb hanging down from its joint, rounded at both ends. */
function Segment({ length, top, bottom = top, seg = 20 }) {
  return (
    <>
      <mesh position={[0, -length / 2, 0]}>
        <cylinderGeometry args={[top, bottom, length, seg]} />
        <Skin />
      </mesh>
      <mesh><sphereGeometry args={[top, seg, 14]} /><Skin /></mesh>
      <mesh position={[0, -length, 0]}><sphereGeometry args={[bottom, seg, 14]} /><Skin /></mesh>
    </>
  );
}

const HIPS    = [[0, -0.09], [0.09, -0.085], [0.125, -0.05], [0.132, 0], [0.125, 0.05], [0.112, 0.085], [0, 0.09]];
const ABDOMEN = [[0, -0.03], [0.108, -0.03], [0.116, 0], [0.118, 0.07], [0.117, 0.14], [0.122, 0.2], [0, 0.21]];
const CHEST   = [[0, -0.02], [0.12, -0.02], [0.13, 0.04], [0.135, 0.1], [0.13, 0.16], [0.11, 0.2], [0.07, 0.225], [0, 0.232]];

const FINGERS = [[-0.027, 0.044], [-0.009, 0.054], [0.009, 0.051], [0.027, 0.042]];

/** Palm, four fingers and a thumb. Fingers point down the arm (−y); the palm
 *  faces −z, which is the thigh when seated. */
function Hand({ side }) {
  return (
    <group>
      <RoundedBox args={[0.072, 0.082, 0.026]} radius={0.011} smoothness={3} position={[0, -0.042, 0]}>
        <Skin />
      </RoundedBox>
      {FINGERS.map(([x, len]) => (
        <group key={x} position={[x * side, -0.08, -0.002]} rotation={[0.32, 0, 0]}>
          <Segment length={len} top={0.0088} bottom={0.0078} seg={12} />
        </group>
      ))}
      <group position={[-side * 0.031, -0.024, -0.006]} rotation={[0.35, 0, -side * 0.6]}>
        <Segment length={0.046} top={0.011} bottom={0.0092} seg={12} />
      </group>
    </group>
  );
}

function Foot() {
  return (
    <mesh position={[0, -0.028, 0.05]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.62]}>
      <capsuleGeometry args={[0.044, 0.13, 8, 16]} />
      <Skin />
    </mesh>
  );
}

function Leg({ side, refs }) {
  return (
    <group ref={refs.yaw} position={[side * 0.085, -0.03, 0]}>
      <group ref={refs.pitch}>
        <Segment length={THIGH} top={0.078} bottom={0.058} />
        <group ref={refs.knee} position={[0, -THIGH, 0]}>
          <Segment length={SHIN} top={0.056} bottom={0.04} />
          <group position={[0, -SHIN, 0]}>
            <Foot />
          </group>
        </group>
      </group>
    </group>
  );
}

function Arm({ side, refs }) {
  return (
    <group ref={refs.shoulder} position={[side * 0.168, 0.02, 0]}>
      <Segment length={UPPER_ARM} top={0.05} bottom={0.042} />
      <group ref={refs.elbow} position={[0, -UPPER_ARM, 0]}>
        <Segment length={FOREARM} top={0.04} bottom={0.031} />
        <group ref={refs.wrist} position={[0, -FOREARM - 0.006, 0]}>
          <Hand side={side} />
        </group>
      </group>
    </group>
  );
}

/** Smooth, featureless oval head. */
function Head() {
  return (
    <mesh position={[0, 0.1, 0.006]} rotation={[0.12, 0, 0]} scale={[0.86, 1.12, 0.98]}>
      <sphereGeometry args={[0.096, 40, 30]} />
      <Skin />
    </mesh>
  );
}

function Figure({ posture }) {
  const root = useRef(), pelvis = useRef(), spine = useRef(), chest = useRef(), upper = useRef(), neck = useRef();
  const L = { yaw: useRef(), pitch: useRef(), knee: useRef() };
  const R = { yaw: useRef(), pitch: useRef(), knee: useRef() };
  const LA = { shoulder: useRef(), elbow: useRef(), wrist: useRef() };
  const RA = { shoulder: useRef(), elbow: useRef(), wrist: useRef() };
  const step = usePose(posture);

  useFrame((_, delta) => {
    const c = step(delta);
    const sit = c.sit;

    root.current.position.set(lerp(ASIDE.x, 0, sit), 0, -0.04 + lerp(ASIDE.z, 0, sit));
    pelvis.current.position.set(0, lerp(1.0, 0.575 - 0.05 * Math.max(-c.hinge, 0), sit), c.slide * sit);

    // Upper body: hip hinge at the base, rounding and side bend spread up the
    // spine, and the neck partly undoes both so the head stays near level.
    spine.current.rotation.set((c.hinge + c.flex * 0.3) * sit, 0, -c.bend * 0.42 * sit);
    chest.current.rotation.set(c.flex * 0.4 * sit, 0, -c.bend * 0.35 * sit);
    upper.current.rotation.set(c.flex * 0.3 * sit, 0, -c.bend * 0.23 * sit);
    neck.current.rotation.set(c.head * sit, 0, c.bend * 0.4 * sit);

    // Legs: thighs pitch forward, knees fold down. A crossed leg lifts and
    // swings over the other knee, its shin hanging straighter.
    for (const [refs, side] of [[L, 1], [R, -1]]) {
      const over = Math.max(c.cross * side, 0) * sit;
      refs.yaw.current.rotation.y = -side * 0.46 * over;
      refs.yaw.current.position.y = -0.03 + 0.09 * over;
      refs.pitch.current.rotation.x = (-1.52 + c.thigh) * sit - 0.14 * over;
      refs.knee.current.rotation.x = (1.52 + c.knee) * sit - 0.42 * over;
    }

    // Arms: hanging when standing; seated, hands rest on the thighs, reaching
    // further forward as the body hinges so they stay on the legs.
    const fwd = c.hinge + c.flex;
    for (const [refs, side] of [[LA, 1], [RA, -1]]) {
      refs.shoulder.current.rotation.set(lerp(0.04, -0.3 - 1.05 * fwd, sit), 0, side * lerp(0.1, 0.07, sit));
      refs.elbow.current.rotation.x = lerp(-0.1, -0.95 + 0.45 * fwd, sit);
      refs.wrist.current.rotation.set(lerp(0, 0.25, sit), side * (Math.PI / 2) * (1 - sit), 0);
    }
  });

  return (
    <group ref={root}>
      <group ref={pelvis}>
        <Lathe profile={HIPS} scale={[1.22, 1, 0.9]} />
        <Leg side={1} refs={L} />
        <Leg side={-1} refs={R} />

        <group ref={spine} position={[0, 0.06, 0]}>
          <Lathe profile={ABDOMEN} scale={[1.18, 1, 0.82]} />
          <group ref={chest} position={[0, 0.18, 0]}>
            <Lathe profile={CHEST} scale={[1.32, 1, 0.8]} />
            <group ref={upper} position={[0, 0.15, 0]}>
              {[1, -1].map((s) => (
                <mesh key={s} position={[s * 0.165, 0.025, 0]}>
                  <sphereGeometry args={[0.06, 24, 16]} />
                  <Skin />
                </mesh>
              ))}
              <Arm side={1} refs={LA} />
              <Arm side={-1} refs={RA} />
              <group ref={neck} position={[0, 0.06, 0]}>
                <mesh position={[0, 0.03, 0]}>
                  <cylinderGeometry args={[0.043, 0.05, 0.075, 20]} />
                  <Skin />
                </mesh>
                <group position={[0, 0.055, 0]}>
                  <Head />
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/** Falls back to the built-in figure if the GLB can't be loaded. */
class ModelBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    console.info('DrexCharacter.glb unavailable — using the built-in figure. '
      + 'Put the file in frontend/public/ to use it.');
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/* ────────────────────────────── Sensor mat ────────────────────────────── */

const MAT_EDGE = '#C4775B';
const HEAT_FLOOR = 24;   // colour-scale floor in 8-bit counts, as on the 2D map

/** Live pressure as a 10×10 texture, upscaled smoothly by the GPU.
 *  `cellToTexel` says where each mat cell lands for this surface. */
function useHeatTexture(frameRef, mode, cellToTexel) {
  const tex = useMemo(() => {
    const t = new THREE.DataTexture(new Uint8Array(100 * 4).fill(255), 10, 10, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, []);
  const scale = useRef(HEAT_FLOOR);

  useFrame(() => {
    const f = frameRef?.current;
    const g = f && f.mode === mode ? f.grid : null;
    let peak = 0;
    if (g) for (let i = 0; i < 100; i++) if (g[i] > peak) peak = g[i];
    scale.current = Math.max(peak, scale.current * 0.985, HEAT_FLOOR);

    const d = tex.image.data;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const [cr, cg, cb] = rampColor(g ? g[r * 10 + c] / scale.current : 0);
        const o = cellToTexel(r, c) * 4;
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 255;
      }
    }
    tex.needsUpdate = true;
  });
  return tex;
}

// Seat mat lies flat: texel row 0 is the front edge; +x is the sitter's left.
const seatTexel = (r, c) => r * 10 + (9 - c);
// Backrest mat stands upright: texel row 0 is the bottom; +x is the sitter's left.
const backTexel = (r, c) => (9 - r) * 10 + (9 - c);

/** The 10×10 sensor lines, drawn once. */
function useGridTexture() {
  return useMemo(() => {
    const n = 256, cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = 'rgba(61,46,36,0.28)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i < 10; i++) {
      const p = Math.round((i / 10) * n) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, n); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(n, p); ctx.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

/**
 * The mat as a real pad: accent-edged slab, live heatmap on top, the 10×10
 * sensor grid over it, and an outline that stays visible through the body —
 * solid where you can see the mat, dashed where the sitter covers it.
 * Built in its local XY plane, facing +z.
 */
function SensorMat({ frameRef, mode, size, ...placement }) {
  const heat = useHeatTexture(frameRef, mode, mode === 'seat' ? seatTexel : backTexel);
  const grid = useGridTexture();
  const [w, h] = size;
  const rim = 0.012;
  const outline = useMemo(() => {
    const x = w / 2 + rim, y = h / 2 + rim, z = 0.0025;
    return [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [-x, -y, z]];
  }, [w, h]);

  return (
    <group {...placement}>
      <mesh position={[0, 0, -0.005]}>
        <boxGeometry args={[w + 2 * rim, h + 2 * rim, 0.01]} />
        <meshStandardMaterial color={MAT_EDGE} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0, 0.0006]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={heat} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.0012]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={grid} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <Line points={outline} color={MAT_EDGE} lineWidth={2.5} />
      <Line points={outline} color={MAT_EDGE} lineWidth={1.6} dashed dashSize={0.02} gapSize={0.014}
        depthTest={false} transparent opacity={0.85} renderOrder={10} />
    </group>
  );
}

/* ─────────────────────────────── Chair ──────────────────────────────── */

const CUSHION = '#EAE0D3';
const FRAME = '#8B7968';

function Chair({ mode, frameRef }) {
  const legs = [[-0.235, 0.32], [0.235, 0.32], [-0.235, -0.12], [0.235, -0.12]];
  return (
    <group position={[0, 0, -0.05]}>
      <RoundedBox args={[0.56, 0.07, 0.52]} radius={0.028} smoothness={4} position={[0, 0.445, 0.1]}>
        <meshStandardMaterial color={CUSHION} roughness={0.8} />
      </RoundedBox>
      <mesh position={[0, 0.39, 0.1]}>
        <boxGeometry args={[0.5, 0.045, 0.46]} />
        <meshStandardMaterial color={FRAME} roughness={0.7} />
      </mesh>

      <group position={[0, 0.9, -0.14]} rotation={[-0.1, 0, 0]}>
        <RoundedBox args={[0.52, 0.6, 0.05]} radius={0.022} smoothness={4}>
          <meshStandardMaterial color={CUSHION} roughness={0.8} />
        </RoundedBox>
        {mode === 'backrest' && (
          <SensorMat frameRef={frameRef} mode="backrest" size={[0.42, 0.5]} position={[0, 0, 0.035]} />
        )}
      </group>
      {[-0.23, 0.23].map((x) => (
        <mesh key={x} position={[x, 0.53, -0.13]} rotation={[-0.1, 0, 0]}>
          <cylinderGeometry args={[0.015, 0.017, 0.2, 14]} />
          <meshStandardMaterial color={FRAME} roughness={0.7} />
        </mesh>
      ))}
      {legs.map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.19, z]}>
          <cylinderGeometry args={[0.021, 0.016, 0.38, 14]} />
          <meshStandardMaterial color={FRAME} roughness={0.7} />
        </mesh>
      ))}

      {mode === 'seat' && (
        <SensorMat frameRef={frameRef} mode="seat" size={[0.44, 0.42]}
          position={[0, 0.49, 0.1]} rotation={[-Math.PI / 2, 0, 0]} />
      )}
    </group>
  );
}

/* ─────────────────────────────── Scene ──────────────────────────────── */

const CAM_DIST = 3.05, CAM_Y = 1.32, LOOK_Y = 0.6, LOOK_Z = 0.2;

/** Swings the camera to the angle that shows the current posture best.
 *  Dragging the view hands control to you; it resumes 8 s after you let go. */
function CameraRig({ posture, controls }) {
  const { camera } = useThree();
  const userUntil = useRef(0);
  const goal = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(0, LOOK_Y, LOOK_Z), []);
  const lookGoal = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const c = controls.current;
    if (!c) return undefined;
    c.target.copy(look);
    const hold = () => { userUntil.current = Infinity; };
    const release = () => { userUntil.current = performance.now() + 8000; };
    c.addEventListener('start', hold);
    c.addEventListener('end', release);
    return () => { c.removeEventListener('start', hold); c.removeEventListener('end', release); };
  }, [controls, look]);

  useFrame((_, delta) => {
    if (performance.now() < userUntil.current) return;
    const pose = poseOf(posture);
    const k = Math.min(delta * 1.6, 1);
    lookGoal.set(0, pose.lookY ?? LOOK_Y, LOOK_Z);
    look.lerp(lookGoal, k);
    goal.set(Math.sin(pose.view) * CAM_DIST, CAM_Y + (look.y - LOOK_Y), LOOK_Z + Math.cos(pose.view) * CAM_DIST);
    camera.position.lerp(goal, k);
    controls.current?.target.copy(look);
    camera.lookAt(look);
    controls.current?.update();
  });
  return null;
}

function SceneLighting() {
  return (
    <>
      <ambientLight intensity={0.7} color="#FAF6F1" />
      <directionalLight position={[3, 8, 5]} intensity={1.5} color="#FFF5EB" />
      <directionalLight position={[-3, 5, -3]} intensity={0.55} color="#E8DED1" />
      <directionalLight position={[-2, 2, 4]} intensity={0.4} color="#FFFFFF" />
      <hemisphereLight skyColor="#FAF6F1" groundColor="#8B7968" intensity={0.5} />
    </>
  );
}

function Spinner() {
  const ref = useRef();
  useFrame((_, d) => { if (ref.current) ref.current.rotation.y += d * 2; });
  return (
    <mesh ref={ref} position={[0, 0.8, 0]}>
      <torusGeometry args={[0.25, 0.05, 8, 24]} />
      <meshStandardMaterial color="#C4775B" />
    </mesh>
  );
}

export default function PostureModel({ posture, mode = 'seat', frameRef }) {
  const p = postureOf(posture);
  const tier = tierOf(posture);
  const pose = posture ?? 'empty';
  const controls = useRef();

  return (
    <div className="card model-card">
      <div className="card-title">Posture visualisation</div>
      <div className="card-subtitle">
        Pose follows the model’s prediction · the {mode === 'seat' ? 'seat' : 'backrest'} mat shows live pressure
      </div>

      <div className="model-container">
        <Canvas
          camera={{ fov: 40, near: 0.01, far: 100, position: [1.75, CAM_Y, 2.6] }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.1;
            gl.outputColorSpace = THREE.SRGBColorSpace;
          }}
        >
          <SceneLighting />
          <Suspense fallback={<Spinner />}>
            <Chair mode={mode} frameRef={frameRef} />
            <ModelBoundary fallback={<Figure posture={pose} />}>
              <Character posture={pose} />
            </ModelBoundary>
          </Suspense>
          <ContactShadows position={[0, 0.001, 0]} opacity={0.42} scale={3} blur={2.4}
            far={1.4} resolution={512} color="#3D2E24" />
          <OrbitControls
            ref={controls}
            enablePan={false}
            minDistance={1.2}
            maxDistance={6}
            maxPolarAngle={Math.PI / 2 - 0.05}
          />
          <CameraRig posture={pose} controls={controls} />
        </Canvas>

        <div className="model-posture-tag">
          <span className="dot" style={{ background: tier.color }} />
          {posture ? p.name : 'Waiting…'}
        </div>
      </div>
    </div>
  );
}
