/**
 * @file Presentation vocabulary shared by every command-center surface.
 *
 * Two rules are encoded here rather than left to each panel:
 *
 *  1. **A status is never colour alone.** Every token carries a word, a glyph
 *     and a colour, so the lamp, the legend and the text readout agree and the
 *     interface survives a colour-blind operator or a monochrome screenshot.
 *  2. **A data mode is always visible.** `modeToken()` maps the engine's
 *     provenance (`live`, `simulated`, `estimated`, `unavailable`) onto a badge
 *     label, so simulated traffic can never be mistaken for measured traffic.
 *
 * @module client/theme
 */

/**
 * Congestion/operational tokens, keyed by the vocabulary the engine emits.
 * @const {Object<string,{label:string,glyph:string,color:string,pattern:string}>}
 */
export const STATUS = Object.freeze({
  flowing: Object.freeze({ label: 'Flowing', glyph: '●', color: '#22c55e', pattern: 'solid' }),
  slow: Object.freeze({ label: 'Slowing', glyph: '▲', color: '#eab308', pattern: 'dashed' }),
  congested: Object.freeze({ label: 'Congested', glyph: '◆', color: '#f97316', pattern: 'dotted' }),
  jam: Object.freeze({ label: 'Severe', glyph: '■', color: '#ef4444', pattern: 'dense' }),
  severe: Object.freeze({ label: 'Severe', glyph: '■', color: '#ef4444', pattern: 'dense' }),
  emergency: Object.freeze({ label: 'Emergency', glyph: '✚', color: '#3b82f6', pattern: 'dashed' }),
  incident: Object.freeze({ label: 'Incident', glyph: '⚠', color: '#a855f7', pattern: 'dotted' }),
  fault: Object.freeze({ label: 'Fault', glyph: '✖', color: '#ef4444', pattern: 'dense' }),
  offline: Object.freeze({ label: 'Unavailable', glyph: '○', color: '#6b7280', pattern: 'dotted' }),
  unknown: Object.freeze({ label: 'Unknown', glyph: '?', color: '#6b7280', pattern: 'dotted' }),
  normal: Object.freeze({ label: 'Normal', glyph: '●', color: '#e5e7eb', pattern: 'solid' }),
});

/** @const {Object<string,string>} Signal lamp hue by phase. */
export const LAMP_COLOR = Object.freeze({
  green: '#22c55e',
  amber: '#f59e0b',
  'all-red': '#ef4444',
  red: '#ef4444',
  fault: '#6b7280',
});

/** @const {Object<string,string>} Badge copy per data mode. */
const MODE_LABEL = Object.freeze({
  live: 'LIVE',
  simulated: 'SIMULATED',
  estimated: 'ESTIMATED',
  unavailable: 'UNAVAILABLE',
  unconfigured: 'UNCONFIGURED',
  unknown: 'UNKNOWN',
});

/**
 * Describe a data mode for display.
 * @param {string} mode
 * @param {string} [source]
 * @returns {{key:string, label:string, source:string, color:string}}
 */
export function modeToken(mode, source = '') {
  const key = String(mode || 'unknown').toLowerCase();
  const color =
    key === 'live'
      ? '#22c55e'
      : key === 'simulated'
        ? '#3b82f6'
        : key === 'estimated'
          ? '#eab308'
          : '#6b7280';
  return {
    key,
    label: MODE_LABEL[key] || key.toUpperCase(),
    source,
    color,
  };
}

/**
 * Map a congestion name or numeric level onto a status token.
 * @param {string|number|null} value
 * @returns {object}
 */
export function congestionToken(value) {
  if (typeof value === 'number') {
    if (value >= 0.85) return STATUS.flowing;
    if (value >= 0.55) return STATUS.slow;
    if (value >= 0.3) return STATUS.congested;
    return STATUS.jam;
  }
  return STATUS[String(value || 'unknown').toLowerCase()] || STATUS.unknown;
}

/**
 * Describe signal health for display, with the reason attached.
 * @param {object} health
 * @returns {{label:string, color:string, glyph:string}}
 */
export function healthToken(health) {
  const status = String(health?.status || 'unknown').toUpperCase();
  if (status === 'FAULT') return { label: 'FAULT', color: '#ef4444', glyph: '✖' };
  if (status === 'DEGRADED') return { label: 'DEGRADED', color: '#eab308', glyph: '▲' };
  if (status === 'PREEMPTED') return { label: 'PREEMPTED', color: '#3b82f6', glyph: '✚' };
  if (status === 'OK' || status === 'HEALTHY') return { label: 'OK', color: '#22c55e', glyph: '●' };
  if (status === 'UNAVAILABLE') return { label: 'UNAVAILABLE', color: '#6b7280', glyph: '○' };
  return { label: status, color: '#6b7280', glyph: '?' };
}

/**
 * Readable speed from metres per second.
 * @param {number|null} mps
 * @returns {string}
 */
export function formatSpeed(mps) {
  if (!Number.isFinite(mps)) return '—';
  return `${Math.round(mps * 3.6)} km/h`;
}

/**
 * Readable distance.
 * @param {number|null} metres
 * @returns {string}
 */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

/**
 * `HH:MM:SS` in local time, for the event stream.
 * @param {number|null} at
 * @returns {string}
 */
export function formatClock(at) {
  if (!Number.isFinite(at)) return '--:--:--';
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

/**
 * Full timestamp for an evidence record.
 * @param {number|null} at
 * @returns {string}
 */
export function formatStamp(at) {
  if (!Number.isFinite(at)) return '—';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** @const {string[]} The command-center navigation, in the documented order. */
export const NAV_ITEMS = Object.freeze([
  'overview',
  'traffic',
  'intersections',
  'cctv',
  'emergency',
  'incidents',
  'violations',
  'signals',
  'analytics',
  'simulation',
  'data-sources',
  'settings',
]);

/** @const {Object<string,string>} */
export const NAV_LABELS = Object.freeze({
  overview: 'Overview',
  traffic: 'Live Traffic',
  intersections: 'Intersections',
  cctv: 'CCTV',
  emergency: 'Emergency',
  incidents: 'Incidents',
  violations: 'Violations',
  signals: 'Signal Health',
  analytics: 'Analytics',
  simulation: 'Simulation',
  'data-sources': 'Data Sources',
  settings: 'System Settings',
});

/** @const {Object<string,string>} */
export const NAV_GLYPHS = Object.freeze({
  overview: '◎',
  traffic: '⇄',
  intersections: '╬',
  cctv: '▣',
  emergency: '✚',
  incidents: '⚠',
  violations: '✖',
  signals: '◉',
  analytics: '◔',
  simulation: '▷',
  'data-sources': '≡',
  settings: '⚙',
});
