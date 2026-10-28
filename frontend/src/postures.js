/* Everything the dashboard says about a posture class, in one place.

   `tier` maps each class onto the reserved status scale (good → critical),
   matching the backend's QUALITY weights, so a class is never told apart
   by an invented hue — the name and icon always travel with the colour. */

export const TIERS = {
  good:     { color: '#0CA30C', icon: '●', label: 'Good' },
  warning:  { color: '#FAB219', icon: '▲', label: 'Fair' },
  serious:  { color: '#EC835A', icon: '◆', label: 'Poor' },
  critical: { color: '#D03B3B', icon: '■', label: 'Bad' },
  idle:     { color: '#E8DED1', icon: '○', label: 'Away' },
};

export const POSTURES = {
  upright: {
    name: 'Upright', icon: '✓', tier: 'good',
    seat: 'Weight shared evenly across both sit bones and the thighs.',
    backrest: 'Back supported evenly from shoulder blades to lumbar.',
  },
  lean_left: {
    name: 'Leaning left', icon: '←', tier: 'warning',
    seat: 'More load on the left sit bone than the right.',
    backrest: 'The left side of your back is carrying the load.',
  },
  lean_right: {
    name: 'Leaning right', icon: '→', tier: 'warning',
    seat: 'More load on the right sit bone than the left.',
    backrest: 'The right side of your back is carrying the load.',
  },
  cross_leg_left: {
    name: 'Legs crossed · left', icon: '⤩', tier: 'warning',
    seat: 'Left leg crossed — the pelvis tilts and the thighs load unevenly.',
    backrest: 'A crossed left leg twists the pelvis, which shows up as a twist across your back.',
  },
  cross_leg_right: {
    name: 'Legs crossed · right', icon: '⤪', tier: 'warning',
    seat: 'Right leg crossed — the pelvis tilts and the thighs load unevenly.',
    backrest: 'A crossed right leg twists the pelvis, which shows up as a twist across your back.',
  },
  lean_forward: {
    name: 'Leaning forward', icon: '↑', tier: 'serious',
    seat: 'Weight has moved forward onto the thighs.',
    backrest: 'Leaning away from the backrest.',
  },
  perch_edge: {
    name: 'Perched on the edge', icon: '⤒', tier: 'serious',
    seat: 'Only the front of the seat is loaded — no thigh or back support.',
    backrest: 'Sitting forward on the seat edge, back unsupported.',
  },
  slouch_back: {
    name: 'Slouching', icon: '↘', tier: 'critical',
    seat: 'Hips slid forward and weight rolled back onto the tailbone.',
    backrest: 'Upper back pressed in, lumbar off the backrest — a rounded spine.',
  },
  empty: {
    name: 'Empty', icon: '○', tier: 'idle',
    seat: 'Nobody on the seat.',
    backrest: 'Nobody against the backrest.',
  },
  no_contact: {
    name: 'No back contact', icon: '○', tier: 'idle',
    seat: '',
    backrest: 'Nothing is touching the backrest. Leaning forward, perching and an empty chair all look like this, so the model can’t tell them apart.',
  },
};

export const postureOf = (key) =>
  POSTURES[key] ?? { name: key ?? 'Waiting…', icon: '○', tier: 'idle', seat: '', backrest: '' };

export const tierOf = (key) => TIERS[postureOf(key).tier];

/* Copy that changes with where the mat is mounted. */
export const MODE_COPY = {
  seat: {
    label: 'Seat',
    mapTitle: 'Seat pressure map',
    mapSubtitle: '10 × 10 sensor matrix under you, viewed from above',
    axes: { top: 'Front of seat', bottom: 'Back of seat', left: 'Left', right: 'Right' },
    vert: { name: 'Front ↔ back', neg: 'Back', pos: 'Front' },
    occupied: 'Seated',
    emptyText: 'No one on the seat',
  },
  backrest: {
    label: 'Backrest',
    mapTitle: 'Backrest pressure map',
    mapSubtitle: '10 × 10 sensor matrix behind you, viewed from behind the chair',
    axes: { top: 'Shoulders', bottom: 'Lower back', left: 'Left', right: 'Right' },
    vert: { name: 'Upper ↔ lower', neg: 'Lower', pos: 'Upper' },
    occupied: 'Back supported',
    emptyText: 'Nothing against the backrest',
  },
};

/* The engineered features each model computes, in plain words. */
export const FEATURES = {
  total_load:     { name: 'Total load', unit: 'counts', hint: 'Sum of all cells above the noise threshold' },
  contact:        { name: 'Contact', fmt: 'flag', hint: 'Load cleared the model’s contact gate' },
  contact_area:   { name: 'Contact area', unit: '/100', fmt: 'int', hint: 'Cells carrying load' },
  peak:           { name: 'Peak cell', unit: 'counts', hint: 'Highest single reading' },
  cop_x:          { name: 'Centre of pressure · x', unit: 'col', hint: 'Load-weighted column, 0 = left edge, 9 = right' },
  cop_y:          { name: 'Centre of pressure · y', unit: 'row', hint: 'Load-weighted row, 0 = front/top, 9 = back/bottom' },
  spread_x:       { name: 'Spread · x', unit: 'cells', hint: 'How widely load is spread side to side' },
  spread_y:       { name: 'Spread · y', unit: 'cells', hint: 'How widely load is spread front to back / top to bottom' },
  lr_imbalance:   { name: 'Left ↔ right', fmt: 'signed%', hint: '(right − left) ÷ total. + means right' },
  fb_imbalance:   { name: 'Front ↔ back', fmt: 'signed%', hint: '(front − back) ÷ total. + means front' },
  top_bottom:     { name: 'Upper ↔ lower', fmt: 'signed%', hint: '(upper − lower half) ÷ total. + means upper' },
  front_lr:       { name: 'Front half · L↔R', fmt: 'signed%', hint: 'Side-to-side balance of the front half alone' },
  back_lr:        { name: 'Back half · L↔R', fmt: 'signed%', hint: 'Side-to-side balance of the back half alone' },
  upper_lr:       { name: 'Upper half · L↔R', fmt: 'signed%', hint: 'Side-to-side balance of the upper back' },
  lower_lr:       { name: 'Lower half · L↔R', fmt: 'signed%', hint: 'Side-to-side balance of the lower back' },
  leg_cross_cue:  { name: 'Leg-cross cue', fmt: 'signed%', hint: 'Front-half L↔R minus back-half L↔R' },
  twist_cue:      { name: 'Twist cue', fmt: 'signed%', hint: 'Upper-back L↔R minus lower-back L↔R' },
  scapula_share:  { name: 'Shoulder-blade share', fmt: '%', hint: 'Share of load on the top four rows' },
  lumbar_share:   { name: 'Lumbar share', fmt: '%', hint: 'Share of load on the bottom three rows' },
  entropy:        { name: 'Load entropy', hint: '0 = one cell, 1 = perfectly even spread' },
  load_per_kg:    { name: 'Load per kg', unit: '/kg', hint: 'Total load ÷ the body weight you entered' },
};

export function formatFeature(key, v) {
  if (v == null || Number.isNaN(v)) return '—';
  const f = FEATURES[key]?.fmt;
  if (f === 'flag') return v >= 0.5 ? 'yes' : 'no';
  if (f === 'int') return String(Math.round(v));
  if (f === '%') return `${(v * 100).toFixed(0)}%`;
  if (f === 'signed%') {
    const p = v * 100;
    return `${p > 0.5 ? '+' : p < -0.5 ? '−' : ''}${Math.abs(p).toFixed(0)}%`;
  }
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
