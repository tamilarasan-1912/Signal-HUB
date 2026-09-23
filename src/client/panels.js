/**
 * @file Every command-center page.
 *
 * Each panel is a pure `(state, ctx) => Element` function. They read the store
 * and call the API, but they never hold their own copy of city state — that is
 * what keeps the overview count and the intersection list from drifting apart.
 *
 * Two conventions that apply to all of them:
 *
 *  - Anything the engine labels `simulated` is shown with a SIMULATED badge.
 *    There is no panel that renders simulated traffic as if it were measured.
 *  - An empty result says *why* it is empty. "No incidents — nothing detected"
 *    and "Incidents unavailable — provider failed" are different sentences.
 *
 * @module client/panels
 */

import { h, badge, chip, row, section, empty, value } from './dom.js';
import { api } from './api.js';
import {
  STATUS,
  congestionToken,
  formatClock,
  formatDistance,
  formatSpeed,
  formatStamp,
  healthToken,
  modeToken,
} from './theme.js';

/**
 * A metric tile.
 * @param {string} label @param {string|number} figure
 * @param {object|null} [mode] @param {string} [note]
 * @returns {HTMLElement}
 */
function metric(label, figure, mode = null, note = '') {
  return h('div', { class: 'metric' }, [
    h('span', { class: 'metric-label', text: label }),
    h('div', { class: 'metric-row' }, [
      h('strong', { class: 'metric-value', text: String(figure) }),
      mode ? badge(mode) : null,
    ]),
    note ? h('span', { class: 'metric-note', text: note }) : null,
  ]);
}

/** @param {string} text @returns {HTMLElement} */
function heading(text) {
  return h('h2', { class: 'page-title', text });
}

/**
 * A capability-gated control. A control the current role may not use is shown
 * disabled with the reason attached, rather than hidden — an operator needs to
 * know the control exists and why it is unavailable to them.
 * @param {string} label @param {string} capability @param {object} ctx
 * @param {Function} onAct @param {object} [options]
 * @returns {HTMLElement}
 */
function action(label, capability, ctx, onAct, { title = '', tone = '' } = {}) {
  const permitted = ctx.can(capability);
  return h('button', {
    class: `btn ${tone}`,
    type: 'button',
    disabled: !permitted,
    title: permitted ? title : `Requires the "${capability}" capability — your role is "${ctx.role()}"`,
    onclick: permitted ? onAct : undefined,
  }, label);
}

// ─── Overview ───────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function overviewPanel(state, ctx) {
  const status = state.status;
  if (!status) return empty('Waiting for the command API…');
  const congestionMode = state.traffic?.mode || status.modes.traffic;
  const cameraMode = status.modes.cameras;
  const signalMode = status.modes.signals;
  const emergencyMode = status.modes.emergency;
  const operational = state.health?.overall || 'unknown';

  return h('div', { class: 'panel-content' }, [
    heading('City Overview'),
    h('div', { class: 'metric-grid' }, [
      metric('Intersections', status.city.intersections, modeToken(congestionMode, 'network')),
      metric('Signalized', status.city.signalized, modeToken(signalMode, 'simulator')),
      metric('Roads monitored', status.city.roads, modeToken(congestionMode, 'network')),
      metric(
        'Congested roads',
        status.congestion.congestedRoads,
        modeToken(congestionMode, 'congestion model'),
        `${status.congestion.slowRoads} slowing`,
      ),
      metric(
        'Mean speed',
        Number.isFinite(status.congestion.meanSpeedMps) ? formatSpeed(status.congestion.meanSpeedMps) : '—',
        modeToken('estimated', 'derived from flow'),
      ),
      metric('Total queue', formatDistance(status.congestion.totalQueueM), modeToken('estimated', 'queue model')),
      metric('Emergency vehicles', status.emergency.vehicles, modeToken(emergencyMode, 'simulator')),
      metric('Active corridors', status.emergency.corridors, modeToken('simulated', 'corridor engine')),
      metric('Open incidents', status.incidents.open, modeToken('simulated', 'incident detectors'), `${status.incidents.critical} critical`),
      metric('Pending violations', status.violations.pending, modeToken('simulated', 'violation engine'), `${status.violations.total} total`),
      metric('Cameras', status.city.cameras, modeToken(cameraMode, 'camera catalog')),
      metric('Signal faults', status.health.signals.fault, modeToken(signalMode, 'controller health'), `${status.health.signals.degraded} degraded`),
    ]),
    section('Platform health', [
      h('div', { class: 'health-list' }, (state.health?.components || []).map((component) => {
        const token = healthToken({ status: component.status });
        return h('div', { class: 'health-row' }, [
          h('span', { class: 'health-label', text: component.label }),
          chip(token),
          h('span', { class: 'health-detail', text: component.detail }),
        ]);
      })),
    ], chip(healthToken({ status: operational }))),
    state.degraded.length
      ? section('Degraded providers', state.degraded.map((item) => empty(`${item.label}: ${item.message}`, 'warn')))
      : null,
    section('Operational mode', [
      h('div', { class: 'mode-grid' }, (state.config?.operatingModes || []).map((mode) =>
        h('div', { class: `mode-card ${mode.selected ? 'selected' : ''} ${mode.selectable ? '' : 'refused'}` }, [
          h('strong', { text: mode.label }),
          h('p', { text: mode.detail }),
          h('span', {
            class: 'mode-state',
            text: mode.selected ? 'ACTIVE' : mode.selectable ? 'available' : `unavailable — ${mode.reason || 'not configured'}`,
          }),
        ]))),
    ]),
  ]);
}

// ─── Live traffic ───────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function trafficPanel(state, ctx) {
  const traffic = state.traffic;
  if (!traffic) return empty('Traffic readout unavailable — the traffic provider did not respond.', 'warn');
  const summary = traffic.summary;
  return h('div', { class: 'panel-content' }, [
    heading('Live Traffic'),
    h('div', { class: 'notice' }, [
      badge(modeToken(summary.mode, 'traffic flow')),
      h('span', {
        text: summary.mode === 'live'
          ? 'Measurements come from the configured flow provider.'
          : 'No live flow provider is configured. These figures come from the traffic simulator and are labelled as such.',
      }),
    ]),
    h('div', { class: 'metric-grid' }, [
      metric('Roads', summary.roads, modeToken(summary.mode)),
      metric('Free flowing', summary.freeRoads, null, `${STATUS.flowing.label}`),
      metric('Slowing', summary.slowRoads, null, `${STATUS.slow.label}`),
      metric('Severe', summary.congestedRoads, null, `${STATUS.jam.label}`),
      metric('Unknown', summary.unknownRoads, modeToken('unavailable')),
      metric('Mean speed', Number.isFinite(summary.meanSpeedMps) ? formatSpeed(summary.meanSpeedMps) : '—', modeToken('estimated')),
      metric('Total queue', formatDistance(summary.totalQueueM), modeToken('estimated')),
      metric('Worst pressure', summary.worstPressure?.toFixed?.(2) ?? value(summary.worstPressure), modeToken('estimated')),
    ]),
    section('Most congested roads', [
      traffic.congestedRoads.length
        ? h('table', { class: 'data-table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', { text: 'Road' }),
                h('th', { text: 'Class' }),
                h('th', { text: 'Queue' }),
                h('th', { text: 'Speed' }),
                h('th', { text: 'State' }),
              ]),
            ]),
            h('tbody', {}, traffic.congestedRoads.map((road) => h('tr', { class: 'clickable', onclick: () => ctx.select({ kind: 'road', id: road.id, road }) }, [
              h('td', { text: road.name || road.id }),
              h('td', { text: road.roadClass || road.type || '—' }),
              h('td', { text: formatDistance(road.queueM) }),
              h('td', { text: formatSpeed(road.speedMps) }),
              h('td', {}, [chip(congestionToken(road.congestion))]),
            ]))),
          ])
        : empty('No severely congested roads right now.'),
    ], badge(modeToken(summary.mode))),
    section('Intersection pressure ranking', [
      traffic.pressureRanking.length
        ? h('table', { class: 'data-table' }, [
            h('thead', {}, [h('tr', {}, [h('th', { text: 'Intersection' }), h('th', { text: 'Pressure' }), h('th', { text: 'Why' })])]),
            h('tbody', {}, traffic.pressureRanking.map((ranked) => h('tr', {
              class: 'clickable',
              onclick: () => ctx.select({ kind: 'intersection', id: ranked.intersectionId }),
            }, [
              h('td', { text: ranked.name || ranked.intersectionId }),
              h('td', { text: ranked.pressure.toFixed(2) }),
              h('td', { text: (ranked.reasons || []).join('; ') || '—' }),
            ]))),
          ])
        : empty('No pressure to rank yet — start the simulation to accumulate demand.'),
    ], badge(modeToken('estimated', 'pressure model'))),
  ]);
}

// ─── Intersections ──────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function intersectionsPanel(state, ctx) {
  const list = state.intersections;
  return h('div', { class: 'panel-content' }, [
    heading('Intersections'),
    h('div', { class: 'panel-actions' }, [
      action('Optimize city timing', 'signals:control', ctx, async () => {
        await ctx.act(() => api.optimize({ apply: true }));
      }, { title: 'Ask the optimizer to revise every intersection and apply it in simulation mode', tone: 'primary' }),
      h('span', { class: 'hint', text: 'Recommendations come from the congestion engine, not the UI.' }),
    ]),
    list.length
      ? h('table', { class: 'data-table' }, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', { text: 'ID' }),
              h('th', { text: 'Name' }),
              h('th', { text: 'Signal' }),
              h('th', { text: 'Classification' }),
              h('th', { text: 'Pressure' }),
              h('th', { text: 'Health' }),
            ]),
          ]),
          h('tbody', {}, list.map((intersection) => h('tr', {
            class: `clickable ${state.selection?.id === intersection.id ? 'selected' : ''}`,
            onclick: () => ctx.select({ kind: 'intersection', id: intersection.id }),
          }, [
            h('td', { text: intersection.id }),
            h('td', { text: intersection.name || '—' }),
            h('td', { text: `${intersection.signal?.group || '—'} ${intersection.signal?.phase || ''}` }),
            h('td', {}, [chip(statusForClassification(intersection.classification))]),
            h('td', { text: Number.isFinite(intersection.pressure) ? intersection.pressure.toFixed(2) : '—' }),
            h('td', {}, [chip(healthToken({ status: intersection.health }))]),
          ]))),
        ])
      : empty('No intersections loaded. Check the road network on the Data Sources page.'),
    section('Approach detail', [
      state.selection?.kind === 'intersection' && state.selection.detail
        ? approachDetail(state.selection.detail, state, ctx)
        : empty('Select an intersection to see its approaches, signal state and optimizer recommendation.'),
    ]),
  ]);
}

/** @param {string} classification @returns {object} */
function statusForClassification(classification) {
  if (classification === 'severe') return STATUS.jam;
  if (classification === 'congested') return STATUS.congested;
  if (classification === 'slow') return STATUS.slow;
  if (!classification) return STATUS.unknown;
  return STATUS.flowing;
}

/**
 * The four-approach block plus the adaptive recommendation.
 * @param {object} detail @param {object} state @param {object} ctx
 * @returns {HTMLElement}
 */
export function approachDetail(detail, state, ctx) {
  const signal = detail.signal || {};
  const recommendation = detail.recommendation;
  return h('div', { class: 'detail-stack' }, [
    h('div', { class: 'kv-grid' }, [
      row('Intersection', detail.name || detail.id),
      row('Coordinates', `${detail.lat?.toFixed?.(5)}, ${detail.lon?.toFixed?.(5)}`),
      row('Controller', detail.controller?.label || '—'),
      row('Mode', detail.controller?.operatingMode || '—'),
    ]),
    h('table', { class: 'data-table' }, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { text: 'Approach' }),
          h('th', { text: 'Lamp' }),
          h('th', { text: 'Vehicles' }),
          h('th', { text: 'Queue' }),
          h('th', { text: 'Speed' }),
          h('th', { text: 'Congestion' }),
          h('th', { text: 'Delay' }),
          h('th', { text: 'LOS' }),
        ]),
      ]),
      h('tbody', {}, (detail.approaches || []).map((approach) => h('tr', {}, [
        h('td', { text: `${approach.direction} (${approach.axis})` }),
        h('td', {}, [lamp(approach.signalState)]),
        h('td', { text: value(Math.round(approach.vehicleCount ?? NaN)) }),
        h('td', { text: `${value(Math.round(approach.queueVehicles ?? NaN))} · ${formatDistance(approach.queueM)}` }),
        h('td', { text: formatSpeed(approach.speedMps) }),
        h('td', {}, [chip(congestionToken(1 - (approach.congestion ?? 1)))]),
        h('td', { text: Number.isFinite(approach.delayS) ? `${Math.round(approach.delayS)} s` : '—' }),
        h('td', { text: approach.levelOfService || '—' }),
      ]))),
    ]),
    recommendation
      ? h('div', { class: 'recommendation' }, [
          h('header', {}, [
            h('strong', { text: 'Adaptive signal recommendation' }),
            badge(modeToken('estimated', 'optimizer')),
          ]),
          h('p', { class: 'reason', text: recommendation.reason }),
          h('div', { class: 'kv-grid' }, [
            row('Current green', `${Math.round((recommendation.current?.greenMs ?? 0) / 1000)} s`),
            row('Recommended green', `${Math.round((recommendation.recommended?.NS ?? 0) / 1000)} s`),
            row('Holding', recommendation.current?.holding || '—'),
            row('Applicable', recommendation.applicable ? 'yes (simulation mode)' : 'no (recommendation-only mode)'),
          ]),
          h('div', { class: 'panel-actions' }, [
            action('Apply in simulator', 'signals:control', ctx, async () => {
              await ctx.act(() => api.optimize({ intersectionId: detail.id, apply: true }));
            }, { title: 'Apply the recommended timing to the simulated controller', tone: 'primary' }),
            action('Recommendation only', 'traffic:view', ctx, async () => {
              await ctx.act(() => api.signalRecommendation(detail.id));
            }, { title: 'Recompute the recommendation without applying it' }),
          ]),
        ])
      : empty('No recommendation — demand is balanced, so the current timing is already appropriate.'),
  ]);
}

/**
 * A signal lamp that is never colour-only: it carries a word and a glyph too.
 * @param {string} state @returns {HTMLElement}
 */
export function lamp(state) {
  const key = String(state);
  const color = key === 'green' ? '#22c55e' : key === 'amber' ? '#f59e0b' : key === 'red' ? '#ef4444' : '#6b7280';
  const glyph = key === 'green' ? '●' : key === 'amber' ? '▲' : key === 'red' ? '■' : '?';
  return h('span', { class: 'lamp', style: { color }, title: key.toUpperCase() }, [
    h('span', { class: 'lamp-glyph', text: glyph }),
    key.toUpperCase(),
  ]);
}

// ─── CCTV ───────────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function cctvPanel(state, ctx) {
  const cameras = state.cameras;
  const health = state.status?.health.cameras;
  return h('div', { class: 'panel-content' }, [
    heading('CCTV'),
    h('div', { class: 'notice' }, [
      badge(modeToken(health?.mode || 'unconfigured', 'camera catalog')),
      h('span', {
        text: 'Cameras are simulated unless a feed is explicitly configured. A simulated feed is generated by the vision adapter and is never a real optical view.',
      }),
    ]),
    h('div', { class: 'metric-grid' }, [
      metric('Cameras', health?.total ?? cameras.length, modeToken(health?.mode || 'unconfigured')),
      metric('Healthy', health?.ok ?? 0, null),
      metric('Degraded', health?.degraded ?? 0, null),
      metric('Unconfigured', health?.unconfigured ?? health?.unknown ?? 0, modeToken('unconfigured')),
    ]),
    cameras.length
      ? h('table', { class: 'data-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Camera' }),
            h('th', { text: 'Intersection' }),
            h('th', { text: 'Feed' }),
            h('th', { text: 'Status' }),
            h('th', { text: 'Source' }),
          ])]),
          h('tbody', {}, cameras.slice(0, 120).map((camera) => h('tr', {
            class: `clickable ${state.selection?.id === camera.id ? 'selected' : ''}`,
            onclick: () => ctx.select({ kind: 'camera', id: camera.id }),
          }, [
            h('td', { text: camera.id }),
            h('td', { text: camera.intersectionId || '—' }),
            h('td', { text: camera.feedType || 'snapshot' }),
            h('td', {}, [chip(healthToken({ status: camera.status === 'ok' ? 'OK' : camera.status === 'degraded' ? 'DEGRADED' : camera.status === 'offline' ? 'UNAVAILABLE' : 'UNKNOWN' }))]),
            h('td', {}, [badge(modeToken(camera.mode, camera.sourceKind))]),
          ]))),
        ])
      : empty('No cameras are registered for this city.'),
    section('Camera inspector', [
      state.selection?.kind === 'camera'
        ? cameraInspector(state, ctx)
        : empty('Select a camera to open its inspector, frame analysis and coverage details.'),
    ]),
  ]);
}

/**
 * The camera panel: feed (or an explicit fallback), coverage, and the vision
 * pipeline's output for the most recent frame the operator requested.
 * @param {object} state @param {object} ctx @returns {HTMLElement}
 */
function cameraInspector(state, ctx) {
  const detail = state.selection.detail;
  if (!detail) return empty('Loading camera…');
  const frame = state.selection.frame;
  return h('div', { class: 'detail-stack' }, [
    h('div', { class: 'kv-grid' }, [
      row('Camera', detail.id),
      row('Name', detail.name || '—'),
      row('Intersection', detail.intersectionId || '—'),
      row('Approach', detail.approach || '—'),
      row('Feed type', detail.feedType || 'snapshot'),
      row('Status', detail.status || 'unknown'),
      row('Source', detail.sourceKind || '—'),
      row('Mode', badge ? null : null),
    ]),
    h('div', { class: 'feed-preview' }, [
      h('div', { class: 'feed-frame' }, [
        h('span', { class: 'feed-glyph', text: detail.status === 'offline' ? '⊘' : '▣' }),
        h('p', {
          text: detail.status === 'offline'
            ? 'FEED UNAVAILABLE — this camera is offline. No image is shown, because there is none.'
            : detail.sourceKind === 'simulated'
              ? 'SIMULATED FEED — no optical sensor is attached. Frame analysis below is generated by the vision adapter.'
              : 'Configured feed — playback requires the camera provider integration described in docs/DATA-SOURCES.md.',
        }),
      ]),
      badge(modeToken(detail.mode, detail.sourceKind)),
    ]),
    h('div', { class: 'panel-actions' }, [
      action('Run frame analysis', 'city:view', ctx, async () => {
        const result = await ctx.act(() => api.processFrame(detail.id));
        if (result.ok) ctx.setFrame(result.result);
      }, { title: 'Run one frame through the detector → tracker → census pipeline', tone: 'primary' }),
      action('Simulate camera failure', 'signals:control', ctx, async () => {
        await ctx.act(() => api.runScenario('camera-failure', { cameraId: detail.id }));
      }, { title: 'Take this camera down and record the coverage loss' }),
    ]),
    frame
      ? h('div', { class: 'detail-stack' }, [
          h('h4', { text: 'Frame analysis' }),
          h('div', { class: 'kv-grid' }, [
            row('Detections', value(frame.detections?.length ?? 0)),
            row('Census', frame.census ? Object.entries(frame.census).filter(([k]) => k !== 'meanConfidence').map(([k, v]) => `${k}:${v}`).join(' ') : '—'),
            row('Mean confidence', frame.census?.meanConfidence ? `${Math.round(frame.census.meanConfidence * 100)}%` : '—'),
            row('Mode', frame.mode || '—'),
          ]),
          h('p', { class: 'hint', text: 'Vehicle classes only. This platform implements no face or person detection.' }),
        ])
      : null,
  ]);
}

// ─── Emergency ──────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function emergencyPanel(state, ctx) {
  const vehicles = state.emergency;
  const corridors = state.corridors;
  return h('div', { class: 'panel-content' }, [
    heading('Emergency'),
    h('div', { class: 'notice' }, [
      badge(modeToken('simulated', 'emergency simulator')),
      h('span', { text: 'No dispatch integration is connected. Every vehicle and corridor here is simulated.' }),
    ]),
    h('div', { class: 'panel-actions' }, [
      action('Simulate ambulance', 'simulation:run', ctx, async () => {
        await ctx.act(() => api.simulateEmergency({ type: 'ambulance' }));
      }, { title: 'Spawn an ambulance, plan its corridor and preempt signals in simulation', tone: 'primary' }),
      action('Simulate fire engine', 'simulation:run', ctx, async () => {
        await ctx.act(() => api.simulateEmergency({ type: 'fire-engine' }));
      }, { title: 'Same corridor machinery with a fire appliance as the subject', tone: 'primary' }),
      state.selection?.kind === 'corridor'
        ? action('Release corridor', 'signals:preempt', ctx, async () => {
            await ctx.act(() => api.releaseCorridor(state.selection.id));
          }, { title: 'Release the corridor and hand control back to adaptive timing' })
        : null,
    ]),
    section('Emergency vehicles', [
      vehicles.length
        ? h('table', { class: 'data-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Vehicle' }),
              h('th', { text: 'Type' }),
              h('th', { text: 'Status' }),
              h('th', { text: 'Confidence' }),
              h('th', { text: 'Speed' }),
              h('th', { text: 'Corridor' }),
            ])]),
            h('tbody', {}, vehicles.map((vehicle) => h('tr', {
              class: 'clickable',
              onclick: () => ctx.select({ kind: 'vehicle', id: vehicle.id }),
            }, [
              h('td', { text: vehicle.id }),
              h('td', { text: vehicle.type }),
              h('td', { text: vehicle.status }),
              h('td', { text: vehicle.detection?.band?.toUpperCase?.() || '—' }),
              h('td', { text: formatSpeed(vehicle.speedMps) }),
              h('td', { text: vehicle.corridor?.id || '—' }),
            ]))),
          ])
        : empty('No emergency vehicles. Use a simulation control above to spawn one.'),
    ]),
    section('Corridors', [
      corridors.length
        ? h('div', { class: 'corridor-list' }, corridors.map((corridor) => h('div', {
            class: `corridor-card ${corridor.status === 'released' ? 'released' : 'active'}`,
            onclick: () => ctx.select({ kind: 'corridor', id: corridor.id, corridor }),
          }, [
            h('header', {}, [
              h('strong', { text: corridor.id }),
              chip(corridor.status === 'released'
                ? { label: 'RELEASED', color: '#6b7280', glyph: '○' }
                : { label: 'ACTIVE', color: '#3b82f6', glyph: '✚' }),
            ]),
            h('p', { text: `${(corridor.intersectionIds || []).length} intersections · ${formatDistance(corridorLength(corridor))}` }),
            h('ol', { class: 'route-list' }, (corridor.intersectionIds || []).map((id) => h('li', {
              text: id,
              onclick: (event) => {
                event.stopPropagation();
                ctx.select({ kind: 'intersection', id });
              },
            }))),
            h('footer', {}, [
              badge(modeToken('simulated', 'corridor engine')),
              h('span', {
                class: 'hint',
                text: corridor.preemptions?.length
                  ? `${corridor.preemptions.length} preemption(s) applied`
                  : 'no preemption applied yet',
              }),
            ]),
          ])))
        : empty('No corridors planned. Simulate an emergency vehicle to plan one.'),
    ]),
    section('Preemption log', [
      (state.corridors || []).some((corridor) => corridor.preemptions?.length)
        ? h('table', { class: 'data-table' }, [
            h('thead', {}, [h('tr', {}, [h('th', { text: 'Corridor' }), h('th', { text: 'Intersection' }), h('th', { text: 'Axis' }), h('th', { text: 'Reason' }), h('th', { text: 'At' })])]),
            h('tbody', {}, (state.corridors || []).flatMap((corridor) =>
              (corridor.preemptions || []).map((preemption) => h('tr', {}, [
                h('td', { text: corridor.id }),
                h('td', { text: preemption.intersectionId || '—' }),
                h('td', { text: preemption.axis || '—' }),
                h('td', { text: preemption.reason || '—' }),
                h('td', { text: formatClock(preemption.at) }),
              ])))),
          ])
        : empty('No preemptions recorded. Preemption runs through amber → all-red → green, never straight to green.'),
    ]),
  ]);
}

/** @param {object} corridor @returns {number} */
function corridorLength(corridor) {
  if (Number.isFinite(corridor.lengthM)) return corridor.lengthM;
  const points = corridor.polyline || [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [lonA, latA] = points[i - 1];
    const [lonB, latB] = points[i];
    const dLat = (latB - latA) * 111_320;
    const dLon = (lonB - lonA) * 111_320 * Math.cos((latA * Math.PI) / 180);
    total += Math.hypot(dLat, dLon);
  }
  return total;
}

// ─── Incidents ──────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function incidentsPanel(state, ctx) {
  const incidents = state.incidents;
  const types = ['accident', 'broken-down-vehicle', 'road-block', 'fire', 'flooding', 'unusual-congestion', 'signal-failure', 'camera-failure', 'road-closure'];
  return h('div', { class: 'panel-content' }, [
    heading('Incidents'),
    h('div', { class: 'panel-actions' }, [
      action('Simulate accident', 'simulation:run', ctx, async () => {
        await ctx.act(() => api.runScenario('accident'));
      }, { title: 'Raise a collision incident with a recommended response', tone: 'primary' }),
      action('Simulate signal failure', 'simulation:run', ctx, async () => {
        await ctx.act(() => api.runScenario('signal-failure'));
      }, { title: 'Drop one controller into fault and alert the operator' }),
      action('Scan for incidents', 'signals:control', ctx, async () => {
        await ctx.act(() => api.raiseIncident({ type: 'unusual-congestion', auto: true }).catch(() => null));
      }, { title: 'Run the congestion-based incident detectors against current state' }),
    ]),
    incidents.length
      ? h('div', { class: 'incident-list' }, incidents.map((incident) => h('div', {
          class: `incident-card ${incident.severity}`,
          onclick: () => ctx.select({ kind: 'incident', id: incident.id, incident }),
        }, [
          h('header', {}, [
            h('strong', { text: incident.id }),
            h('span', { class: 'incident-type', text: String(incident.type || '').replace(/-/g, ' ').toUpperCase() }),
            chip(incident.severity === 'critical'
              ? { label: 'CRITICAL', color: '#ef4444', glyph: '⚠' }
              : { label: String(incident.severity || '').toUpperCase(), color: '#eab308', glyph: '▲' }),
          ]),
          h('p', { text: incident.message || incident.description || '—' }),
          h('div', { class: 'kv-grid' }, [
            row('Location', incident.intersectionId || `${incident.lat?.toFixed?.(4)}, ${incident.lon?.toFixed?.(4)}`),
            row('Source', incident.source || 'detector'),
            row('Confidence', incident.confidence ? `${Math.round(incident.confidence * 100)}%` : '—'),
            row('Raised', formatStamp(incident.at)),
          ]),
          incident.recommendedResponse
            ? h('div', { class: 'recommended' }, [
                h('strong', { text: 'Recommended response' }),
                h('ul', {}, (Array.isArray(incident.recommendedResponse) ? incident.recommendedResponse : [incident.recommendedResponse]).map((step) => h('li', { text: typeof step === 'string' ? step : step.label || JSON.stringify(step) }))),
              ])
            : null,
          h('div', { class: 'panel-actions' }, [
            action('Clear incident', 'signals:control', ctx, async () => {
              await ctx.act(() => api.clearIncident(incident.id));
            }, { title: 'Mark this incident resolved' }),
          ]),
        ])))
      : empty('No open incidents. Detectors run on every simulation step.'),
    section('Raise a manual incident', [
      h('div', { class: 'panel-actions wrap' }, types.map((type) =>
        action(type.replace(/-/g, ' '), 'signals:control', ctx, async () => {
          await ctx.act(() => api.raiseIncident({ type }));
        }, { title: `Raise a ${type} incident at a sampled location` }))),
    ]),
  ]);
}

// ─── Violations ─────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function violationsPanel(state, ctx) {
  const violations = state.violations;
  const summary = state.violationSummary;
  return h('div', { class: 'panel-content' }, [
    heading('Violations'),
    h('div', { class: 'notice warn' }, [
      badge(modeToken('simulated', 'violation engine')),
      h('span', {
        text: 'Automated enforcement is disabled by design. A detected violation is a CANDIDATE that enters review; this platform does not issue a fine.',
      }),
    ]),
    h('div', { class: 'metric-grid' }, [
      metric('Pending review', summary?.pending ?? 0, modeToken('simulated')),
      metric('Approved', summary?.approved ?? 0, null),
      metric('Rejected', summary?.rejected ?? 0, null),
      metric('Escalated', summary?.escalated ?? 0, null),
      metric('Total', summary?.total ?? 0, null),
      metric('Automated enforcement', summary?.automatedEnforcement ? 'ENABLED' : 'DISABLED', modeToken('simulated')),
    ]),
    h('div', { class: 'panel-actions' }, [
      action('Simulate red-light violation', 'simulation:run', ctx, async () => {
        await ctx.act(() => api.runScenario('red-light-violation'));
      }, { title: 'A tracked vehicle crosses a stop line on red and is logged for review', tone: 'primary' }),
    ]),
    violations.length
      ? h('table', { class: 'data-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Violation' }),
            h('th', { text: 'Rule' }),
            h('th', { text: 'Intersection' }),
            h('th', { text: 'Camera' }),
            h('th', { text: 'Signal' }),
            h('th', { text: 'Confidence' }),
            h('th', { text: 'Review' }),
          ])]),
          h('tbody', {}, violations.map((violation) => h('tr', {
            class: `clickable ${state.selection?.id === violation.id ? 'selected' : ''}`,
            onclick: () => ctx.select({ kind: 'violation', id: violation.id }),
          }, [
            h('td', { text: violation.id }),
            h('td', { text: String(violation.ruleId || '').replace(/_/g, ' ') }),
            h('td', { text: violation.intersectionId || '—' }),
            h('td', { text: violation.cameraId || '—' }),
            h('td', {}, [lamp(violation.observation?.signalState || violation.signalState || 'unknown')]),
            h('td', { text: violation.detection?.confidence ? `${Math.round(violation.detection.confidence * 100)}%` : '—' }),
            h('td', {}, [reviewChip(violation.reviewStatus)]),
          ]))),
        ])
      : empty('No violations recorded. Use the control above to simulate one.'),
    section('Violation review', [
      state.selection?.kind === 'violation'
        ? violationReview(state, ctx)
        : empty('Select a violation to open the review workflow.'),
    ]),
    section('Penalty configuration', [
      h('p', { class: 'hint', text: 'Configured penalty — verify against current jurisdiction rules. This platform computes a configured figure; it does not impose a fine.' }),
      state.selection?.kind === 'violation' && state.selection.detail?.penalty
        ? h('div', { class: 'kv-grid' }, [
            row('Rule', state.selection.detail.penalty.ruleId || '—'),
            row('Jurisdiction', state.selection.detail.penalty.jurisdiction || '—'),
            row('Configured amount', state.selection.detail.penalty.amountDisplay || '—'),
            row('Review required', state.selection.detail.penalty.reviewRequired ? 'yes' : 'no'),
          ])
        : empty('Select a violation to see its configured penalty.'),
    ]),
  ]);
}

/** @param {string} status @returns {HTMLElement} */
function reviewChip(status) {
  if (status === 'pending') return chip({ label: 'PENDING', color: '#f8fafc', glyph: '○' });
  if (status === 'approved') return chip({ label: 'APPROVED', color: '#22c55e', glyph: '✔' });
  if (status === 'rejected') return chip({ label: 'REJECTED', color: '#ef4444', glyph: '✖' });
  if (status === 'escalated') return chip({ label: 'ESCALATED', color: '#a855f7', glyph: '↑' });
  return chip({ label: String(status || 'unknown').toUpperCase(), color: '#6b7280', glyph: '?' });
}

/**
 * The enforcement review block, including the plate workflow's own confidence
 * verdict so an unreadable plate is visibly rejected rather than guessed.
 * @param {object} state @param {object} ctx @returns {HTMLElement}
 */
function violationReview(state, ctx) {
  const detail = state.selection.detail;
  if (!detail) return empty('Loading violation…');
  const plate = detail.plate;
  const plateConfidence = plate?.confidence ?? detail.plateConfidence ?? null;
  const readable = Boolean(plate?.text) && !plate?.unreadable;
  return h('div', { class: 'detail-stack' }, [
    h('div', { class: 'kv-grid' }, [
      row('Violation ID', detail.id),
      row('Rule', String(detail.ruleId || '').replace(/_/g, ' ')),
      row('Intersection', detail.intersectionId || '—'),
      row('Camera', detail.cameraId || '—'),
      row('Timestamp', formatStamp(detail.at)),
      row('Signal at crossing', detail.observation?.signalState || detail.signalState || '—'),
      row('Vehicle', detail.vehicleClass || detail.detection?.vehicleClass || '—'),
      row('Detection confidence', detail.detection?.confidence ? `${Math.round(detail.detection.confidence * 100)}%` : '—'),
    ]),
    h('div', { class: 'plate-block' }, [
      h('span', { class: 'plate-label', text: 'PLATE' }),
      h('strong', {
        class: `plate-value ${readable ? '' : 'unreadable'}`,
        text: readable
          ? plate.text
          : state.session?.capabilities?.includes('violations:plate')
            ? 'PLATE UNREADABLE'
            : 'RESTRICTED — enforcement reviewer capability required',
      }),
      plateConfidence !== null
        ? h('span', { class: 'plate-confidence', text: `confidence ${Math.round(plateConfidence * 100)}%` })
        : null,
      h('p', {
        class: 'hint',
        text: readable
          ? 'Plate characters are only ever reported above the configured confidence floor; low-confidence reads are rejected rather than guessed.'
          : 'Below the confidence floor, so no characters are reported. The system does not invent plate characters.',
      }),
    ]),
    h('div', { class: 'evidence-block' }, [
      h('strong', { text: 'Evidence' }),
      detail.evidence
        ? h('div', { class: 'kv-grid' }, [
            row('Frame reference', detail.evidence.frameRef || '—'),
            row('Retain until', formatStamp(detail.evidence.retainUntil)),
            row('Captured', formatStamp(detail.evidence.capturedAt)),
          ])
        : empty('No evidence frame is attached to this record.'),
      h('p', { class: 'hint', text: 'Evidence is metadata plus a frame reference. Access is restricted to reviewers and administrators and every access is audited.' }),
    ]),
    h('div', { class: 'panel-actions' }, [
      action('Approve', 'violations:review', ctx, async () => {
        await ctx.act(() => api.reviewViolation(detail.id, { decision: 'approved' }));
      }, { title: 'Approve this violation as valid', tone: 'primary' }),
      action('Reject', 'violations:review', ctx, async () => {
        await ctx.act(() => api.reviewViolation(detail.id, { decision: 'rejected' }));
      }, { title: 'Reject this violation as not valid' }),
      action('Escalate', 'violations:review', ctx, async () => {
        await ctx.act(() => api.reviewViolation(detail.id, { decision: 'escalated' }));
      }, { title: 'Escalate for a second reviewer' }),
    ]),
    detail.reviewStatus !== 'pending'
      ? h('p', { class: 'hint', text: `Reviewed: ${detail.reviewStatus} by ${detail.reviewedBy || 'unknown'} at ${formatStamp(detail.reviewedAt)}` })
      : h('p', { class: 'hint', text: 'Awaiting human review. No automated path leaves this state.' }),
  ]);
}

// ─── Signal health ──────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function signalsPanel(state, ctx) {
  const signals = state.signals;
  const health = state.status?.health.signals;
  return h('div', { class: 'panel-content' }, [
    heading('Signal Health'),
    h('div', { class: 'metric-grid' }, [
      metric('Controllers', health?.total ?? signals.length, modeToken('simulated', 'simulator')),
      metric('OK', health?.ok ?? 0, null),
      metric('Degraded', health?.degraded ?? 0, null),
      metric('Fault', health?.fault ?? 0, null),
    ]),
    section('Simulated signal control', [
      h('div', { class: 'panel-actions' }, [
        action('Start simulation', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.startSimulation());
        }, { title: 'Begin stepping the simulated city every 2 s', tone: 'primary' }),
        action('Pause', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.pauseSimulation());
        }, { title: 'Stop stepping the simulation' }),
        action('Step once', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.stepSimulation());
        }, { title: 'Advance one control step' }),
        action('Reset', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.resetSimulation());
        }, { title: 'Clear vehicles, incidents, violations and preemptions; keep the network' }),
      ]),
      h('p', { class: 'hint', text: 'Every command here drives the built-in simulator. Phase changes always run green → amber → all-red → green; conflicting greens are impossible by construction.' }),
    ]),
    signals.length
      ? h('table', { class: 'data-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Intersection' }),
            h('th', { text: 'Holding' }),
            h('th', { text: 'Phase' }),
            h('th', { text: 'N' }),
            h('th', { text: 'S' }),
            h('th', { text: 'E' }),
            h('th', { text: 'W' }),
            h('th', { text: 'Green' }),
            h('th', { text: 'Health' }),
            h('th', { text: 'Actions' }),
          ])]),
          h('tbody', {}, signals.map((signal) => h('tr', {
            class: `clickable ${state.selection?.id === signal.intersectionId ? 'selected' : ''}`,
            onclick: () => ctx.select({ kind: 'intersection', id: signal.intersectionId }),
          }, [
            h('td', { text: signal.intersectionId }),
            h('td', { text: signal.group }),
            h('td', { text: signal.phase }),
            h('td', {}, [lamp(signal.states?.N)]),
            h('td', {}, [lamp(signal.states?.S)]),
            h('td', {}, [lamp(signal.states?.E)]),
            h('td', {}, [lamp(signal.states?.W)]),
            h('td', { text: `${Math.round((signal.greenMs || 0) / 1000)} s` }),
            h('td', {}, [chip(healthToken({ status: signal.health }))]),
            h('td', {}, [
              h('div', { class: 'row-actions' }, [
                action('+10s', 'signals:control', ctx, async () => {
                  await ctx.act(() => api.setGreen(signal.intersectionId, 10000));
                }, { title: 'Extend this phase green by 10 seconds' }),
                action(signal.health === 'FAULT' ? 'Clear fault' : 'Fault', 'signals:control', ctx, async () => {
                  if (signal.health === 'FAULT') await ctx.act(() => api.setSignalFault(signal.intersectionId, false));
                  else await ctx.act(() => api.setSignalFault(signal.intersectionId, true, 'simulated controller fault'));
                }, { title: signal.health === 'FAULT' ? 'Return this controller to ordinary control' : 'Put this controller into a fault' }),
              ]),
            ]),
          ]))),
        ])
      : empty('No controllers. Load a road network first.'),
  ]);
}

// ─── Analytics ──────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function analyticsPanel(state, ctx) {
  const analytics = state.analytics;
  if (!analytics) return empty('Analytics unavailable — the command API did not return a series.', 'warn');
  const samples = analytics.samples || [];
  return h('div', { class: 'panel-content' }, [
    heading('Analytics'),
    h('div', { class: 'notice' }, [
      badge(modeToken(analytics.mode, 'engine samples')),
      h('span', { text: analytics.note }),
    ]),
    h('div', { class: 'metric-grid' }, [
      metric('Samples', samples.length, modeToken(analytics.mode)),
      metric('Simulation steps', analytics.totals.simulationSteps, modeToken('simulated')),
      metric('Violations', analytics.totals.violations, modeToken('simulated')),
      metric('Incidents', analytics.totals.incidents, modeToken('simulated')),
      metric('Corridors', analytics.totals.corridors, modeToken('simulated')),
      metric('Corridors released', analytics.totals.corridorsReleased, modeToken('simulated')),
    ]),
    section('Congested roads over time', [
      samples.length ? sparkline(samples.map((sample) => sample.congestedRoads), '#ef4444', 'roads') : empty('No samples yet — start the simulation to accumulate history.'),
    ]),
    section('Total queue length over time', [
      samples.length ? sparkline(samples.map((sample) => sample.totalQueueM), '#eab308', 'm') : empty('No samples yet.'),
    ]),
    section('Mean speed over time', [
      samples.length ? sparkline(samples.map((sample) => (sample.meanSpeedMps ?? 0) * 3.6), '#22c55e', 'km/h') : empty('No samples yet.'),
    ]),
    section('Worst intersection pressure over time', [
      samples.length ? sparkline(samples.map((sample) => sample.worstPressure ?? 0), '#a855f7', '') : empty('No samples yet.'),
    ]),
    h('p', { class: 'hint', text: 'Every series is sampled from engine state at each control step. No curve here is synthesised for display.' }),
  ]);
}

/**
 * An inline SVG sparkline. Drawn from real samples, with the axis range printed
 * so the reader knows what the shape means.
 * @param {number[]} values @param {string} color @param {string} unit
 * @returns {HTMLElement}
 */
export function sparkline(values, color, unit) {
  const width = 640;
  const height = 120;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((item, index) => {
    const x = index * step;
    const y = height - ((item - min) / span) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Series over ${values.length} samples, minimum ${min.toFixed(1)}, maximum ${max.toFixed(1)} ${unit}`);
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '2');
  svg.appendChild(polyline);
  return h('div', { class: 'chart' }, [
    svg,
    h('div', { class: 'chart-axis' }, [
      h('span', { text: `min ${min.toFixed(1)} ${unit}` }),
      h('span', { text: `max ${max.toFixed(1)} ${unit}` }),
      h('span', { text: `${values.length} samples` }),
    ]),
  ]);
}

// ─── Simulation ─────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function simulationPanel(state, ctx) {
  const simulation = state.simulation;
  const scenarios = state.scenarios;
  return h('div', { class: 'panel-content' }, [
    heading('Simulation Control'),
    h('div', { class: 'notice' }, [
      badge(modeToken('simulated', 'simulator')),
      h('span', { text: 'This page drives a full city simulation. Nothing here reaches real infrastructure.' }),
    ]),
    h('div', { class: 'metric-grid' }, [
      metric('State', simulation?.running ? 'RUNNING' : 'PAUSED', modeToken('simulated')),
      metric('Simulated time', `${((simulation?.steps ?? 0) * (simulation?.stepSeconds ?? 2))} s`, modeToken('simulated')),
      metric('Steps', simulation?.steps ?? 0, null),
      metric('Active vehicles', simulation?.vehicles ?? 0, modeToken('simulated')),
      metric('Corridors', simulation?.corridors ?? 0, modeToken('simulated')),
      metric('Incidents', simulation?.incidents ?? 0, modeToken('simulated')),
      metric('Pending violations', simulation?.violations ?? 0, modeToken('simulated')),
      metric('Seed', simulation?.seed ?? '—', null, 'deterministic'),
    ]),
    section('Transport controls', [
      h('div', { class: 'panel-actions' }, [
        action('Start', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.startSimulation());
        }, { title: 'Step the city every two simulated seconds', tone: 'primary' }),
        action('Pause', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.pauseSimulation());
        }, { title: 'Hold the current state' }),
        action('Step', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.stepSimulation());
        }, { title: 'Advance exactly one control step' }),
        action('Reset', 'simulation:run', ctx, async () => {
          await ctx.act(() => api.resetSimulation());
        }, { title: 'Clear all simulated state and reseed demand' }),
      ]),
    ]),
    section('Run full city demo', [
      h('p', { class: 'hint', text: 'Executes the documented end-to-end sequence: congestion → adaptive timing → ambulance → corridor → preemption → release → violation → review queue. Repeatable, deterministic for a given seed.' }),
      h('div', { class: 'panel-actions' }, [
        action('RUN FULL CITY DEMO', 'simulation:run', ctx, async () => {
          const result = await ctx.act(() => api.runDemo());
          if (result.ok) ctx.showDemoReport(result.result);
        }, { title: 'Run every stage and report what each one did', tone: 'primary large' }),
      ]),
    ]),
    section('Scenarios', [
      h('div', { class: 'scenario-grid' }, (scenarios || []).map((scenario) =>
        h('button', {
          class: 'scenario-card',
          type: 'button',
          disabled: !ctx.can('simulation:run'),
          title: ctx.can('simulation:run') ? scenario.description : `Requires the "simulation:run" capability — your role is "${ctx.role()}"`,
          onclick: ctx.can('simulation:run')
            ? async () => {
                await ctx.act(() => api.runScenario(scenario.id));
              }
            : undefined,
        }, [
          h('span', { class: 'scenario-glyph', text: scenario.glyph || '▷' }),
          h('strong', { text: scenario.label }),
          h('p', { text: scenario.description }),
        ]))),
    ]),
    section('Simulation state', [
      simulation
        ? h('div', { class: 'kv-grid' }, [
            row('Running', simulation.running ? 'yes' : 'no'),
            row('Last step', simulation.lastStepAt ? formatClock(simulation.lastStepAt) : '—'),
            row('Last scenario', simulation.scenario || '—'),
            row('Operating mode', simulation.operatingMode || '—'),
            row('Congested roads', simulation.congestion?.congestedRoads ?? 0),
            row('Mean speed', Number.isFinite(simulation.congestion?.meanSpeedMps) ? formatSpeed(simulation.congestion.meanSpeedMps) : '—'),
          ])
        : empty('Simulation state unavailable.'),
    ]),
  ]);
}

// ─── Data sources ───────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function dataSourcesPanel(state) {
  const sources = state.dataSources;
  if (!sources) return empty('Data-source inventory unavailable.', 'warn');
  const road = sources.roadSource;
  return h('div', { class: 'panel-content' }, [
    heading('Data Sources'),
    h('p', { class: 'hint', text: 'Every value in this command center carries one of these modes. This page is the authority on which is which.' }),
    h('table', { class: 'data-table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Source' }),
        h('th', { text: 'Provider' }),
        h('th', { text: 'Mode' }),
        h('th', { text: 'Key required' }),
        h('th', { text: 'Detail' }),
      ])]),
      h('tbody', {}, (sources.sources || []).map((source) => h('tr', {}, [
        h('td', { text: source.label }),
        h('td', { text: source.source }),
        h('td', {}, [badge(modeToken(source.mode, source.source))]),
        h('td', { text: source.keyRequired ? 'yes' : 'no' }),
        h('td', { text: source.detail }),
      ]))),
    ]),
    road
      ? section('Road network provenance', [
          h('div', { class: 'kv-grid' }, [
            row('Area', road.area?.label || '—'),
            row('Source', road.source),
            row('Mode', road.mode),
            row('Detail', road.detail),
            row('Fallback reason', road.fallbackReason || 'none — live geometry in use'),
            row('Durability', road.store ? `${road.store.driver} (${road.store.note})` : 'memory'),
            row('Received', formatStamp(road.receivedAt)),
          ]),
        ], badge(modeToken(road.mode, road.source)))
      : null,
    section('Map imagery', [
      h('div', { class: 'kv-grid' }, [
        row('Imagery', state.mapInfo?.imagery || 'OpenStreetMap raster tiles'),
        row('Cesium ion token', state.config?.map?.cesiumIonToken ? 'configured' : 'not configured'),
        row('Live traffic provider', state.config?.map?.liveTrafficProvider ? 'configured' : 'not configured'),
      ]),
    ]),
  ]);
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** @param {object} state @param {object} ctx @returns {HTMLElement} */
export function settingsPanel(state, ctx) {
  const session = state.session;
  return h('div', { class: 'panel-content' }, [
    heading('System Settings'),
    section('Session', [
      h('div', { class: 'kv-grid' }, [
        row('Operator', session?.operator || 'anonymous'),
        row('Role', session?.role || '—'),
        row('Authenticated', session?.authenticated ? 'yes' : 'no'),
      ]),
      h('div', { class: 'capability-list' }, (session?.capabilities || []).map((capability) =>
        h('span', { class: 'capability', text: capability }))),
    ]),
    section('Roles and capabilities', [
      h('table', { class: 'data-table' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: 'Role' }), h('th', { text: 'Capabilities' })])]),
        h('tbody', {}, (session?.roles || []).map((entry) => h('tr', {}, [
          h('td', { text: entry.role }),
          h('td', { text: (entry.capabilities || []).join(', ') }),
        ]))),
      ]),
    ]),
    section('Safety invariants', [
      h('ul', { class: 'invariant-list' }, [
        h('li', { text: 'Green → amber → all-red → green. A conflicting green cannot be produced by the simulator.' }),
        h('li', { text: 'Automated enforcement is disabled: every violation enters PENDING REVIEW.' }),
        h('li', { text: 'A plate below the confidence floor is reported as PLATE UNREADABLE, never guessed.' }),
        h('li', { text: 'No face, person or biometric detection exists in this platform.' }),
        h('li', { text: 'Authorized control mode is refused unless a real controller integration is configured.' }),
        h('li', { text: 'Every consequential action is written to the audit log with the operator and role.' }),
      ]),
    ]),
    section('Audit log', [
      ctx.can('audit:read')
        ? (state.audit || []).length
          ? h('table', { class: 'data-table audit-table' }, [
              h('thead', {}, [h('tr', {}, [
                h('th', { text: 'At' }),
                h('th', { text: 'Operator' }),
                h('th', { text: 'Role' }),
                h('th', { text: 'Action' }),
                h('th', { text: 'Intersection' }),
                h('th', { text: 'Outcome' }),
                h('th', { text: 'Reason' }),
              ])]),
              h('tbody', {}, state.audit.slice(0, 80).map((entry) => h('tr', {}, [
                h('td', { text: formatClock(entry.at) }),
                h('td', { text: entry.operator || entry.role || '—' }),
                h('td', { text: entry.role || '—' }),
                h('td', { text: entry.action }),
                h('td', { text: entry.intersectionId || '—' }),
                h('td', { text: entry.outcome || '—' }),
                h('td', { text: entry.reason || '—' }),
              ]))),
            ])
          : empty('No audit entries yet. Consequential actions appear here as they happen.')
        : empty('Your role does not include the "audit:read" capability.', 'warn'),
    ]),
  ]);
}

// ─── Event timeline (shared by the shell) ───────────────────────────────────

/**
 * The live event stream strip.
 * @param {object} state @returns {HTMLElement}
 */
export function eventTimeline(state) {
  const events = state.events || [];
  return h('div', { class: 'timeline' }, [
    h('header', { class: 'timeline-head' }, [
      h('h3', { text: 'Live Event Stream' }),
      h('span', {
        class: `stream-state ${state.stream}`,
        text: state.stream === 'open' ? 'STREAM CONNECTED' : `STREAM ${String(state.stream).toUpperCase()}`,
      }),
    ]),
    events.length
      ? h('div', { class: 'timeline-items' }, events.slice(0, 40).map((event) => h('div', {
          class: `timeline-item severity-${event.severity || 'notice'}`,
        }, [
          h('span', { class: 'timeline-time', text: formatClock(event.at) }),
          h('span', { class: 'timeline-category', text: (event.category || 'system').toUpperCase() }),
          h('span', { class: 'timeline-message', text: event.message || event.type || '' }),
          event.mode ? badge(modeToken(event.mode, event.source)) : null,
        ])))
      : empty('No events yet. Start the simulation or run a scenario to populate the stream.'),
  ]);
}

/**
 * The right-hand inspector for whatever is selected.
 * @param {object} state @param {object} ctx @returns {HTMLElement}
 */
export function inspector(state, ctx) {
  const selection = state.selection;
  return h('div', { class: 'inspector' }, [
    h('header', { class: 'inspector-head' }, [
      h('h3', { text: 'Selected Object' }),
      selection
        ? h('span', { class: 'inspector-kind', text: selection.kind.toUpperCase() })
        : null,
    ]),
    selection
      ? selectionBody(state, ctx)
      : empty('Nothing selected. Click the map or a table row to inspect an object.'),
  ]);
}

/**
 * Render the inspector body for the current selection.
 * @param {object} state @param {object} ctx @returns {HTMLElement}
 */
function selectionBody(state, ctx) {
  const selection = state.selection;
  switch (selection.kind) {
    case 'intersection': {
      const detail = selection.detail;
      if (!detail) return empty('Loading intersection…');
      return approachDetail(detail, state, ctx);
    }
    case 'camera':
      return cameraInspector(state, ctx);
    case 'violation':
      return violationReview(state, ctx);
    case 'vehicle': {
      const vehicle = selection.detail || selection.vehicle;
      if (!vehicle) return empty('Loading vehicle…');
      const corridor = vehicle.corridor;
      return h('div', { class: 'detail-stack' }, [
        h('div', { class: 'kv-grid' }, [
          row('Vehicle', vehicle.id),
          row('Type', vehicle.type),
          row('Status', vehicle.status),
          row('Confidence', vehicle.detection?.band || '—'),
          row('Speed', formatSpeed(vehicle.speedMps)),
          row('Position', `${vehicle.lat?.toFixed?.(5)}, ${vehicle.lon?.toFixed?.(5)}`),
          row('ETA', Number.isFinite(vehicle.etaS) ? `${Math.round(vehicle.etaS)} s` : '—'),
        ]),
        corridor
          ? h('div', { class: 'route-block' }, [
              h('strong', { text: 'Emergency corridor' }),
              h('ol', { class: 'route-list' }, (corridor.intersectionIds || []).map((id) => h('li', { text: id }))),
              h('div', { class: 'kv-grid' }, [
                row('Corridor', corridor.id),
                row('Status', corridor.status),
                row('Preemptions', (corridor.preemptions || []).length),
              ]),
            ])
          : empty('No corridor planned for this vehicle.'),
        h('div', { class: 'panel-actions' }, [
          action('Release corridor', 'signals:preempt', ctx, async () => {
            await ctx.act(() => api.releaseCorridor(corridor?.id || vehicle.corridor?.id));
          }, { title: 'Release the corridor and restore adaptive control' }),
        ]),
      ]);
    }
    case 'incident': {
      const incident = selection.detail || selection.incident;
      return h('div', { class: 'detail-stack' }, [
        h('div', { class: 'kv-grid' }, [
          row('Incident', incident.id),
          row('Type', String(incident.type || '').replace(/-/g, ' ')),
          row('Severity', incident.severity || '—'),
          row('Source', incident.source || 'detector'),
          row('Raised', formatStamp(incident.at)),
          row('Affected roads', (incident.affectedRoadIds || []).join(', ') || '—'),
          row('Affected intersections', (incident.affectedIntersectionIds || []).join(', ') || '—'),
        ]),
        h('p', { text: incident.message || '' }),
        action('Clear incident', 'signals:control', ctx, async () => {
          await ctx.act(() => api.clearIncident(incident.id));
        }, { title: 'Mark this incident resolved' }),
      ]);
    }
    case 'road': {
      const road = selection.detail || selection.road;
      return h('div', { class: 'kv-grid' }, [
        row('Road', road.name || road.id),
        row('Class', road.roadClass || road.type || '—'),
        row('Lanes', road.lanes ?? '—'),
        row('Length', formatDistance(road.lengthM)),
        row('Vehicles', value(Math.round(road.vehicleCount ?? NaN))),
        row('Queue', formatDistance(road.queueM)),
        row('Speed', formatSpeed(road.speedMps)),
        row('Free flow', formatSpeed(road.freeFlowMps)),
        row('Congestion', road.congestion || 'unknown'),
        row('Intersections', (road.intersectionIds || []).join(', ') || '—'),
      ]);
    }
    case 'corridor': {
      const corridor = selection.detail || selection.corridor;
      return h('div', { class: 'detail-stack' }, [
        h('div', { class: 'kv-grid' }, [
          row('Corridor', corridor.id),
          row('Status', corridor.status),
          row('Length', formatDistance(corridorLength(corridor))),
          row('Intersections', (corridor.intersectionIds || []).length),
          row('Preemptions', (corridor.preemptions || []).length),
        ]),
        h('ol', { class: 'route-list' }, (corridor.intersectionIds || []).map((id) => h('li', { text: id }))),
        action('Release corridor', 'signals:preempt', ctx, async () => {
          await ctx.act(() => api.releaseCorridor(corridor.id));
        }, { title: 'Release and restore adaptive control' }),
      ]);
    }
    default:
      return empty(`No inspector for "${selection.kind}".`);
  }
}

// ─── Login ──────────────────────────────────────────────────────────────────

/**
 * The prototype sign-in form. The demo credentials are listed deliberately:
 * this is a local demonstration build, and the server refuses to run with them
 * in production.
 * @param {object} state @param {object} ctx @returns {HTMLElement}
 */
export function loginPanel(state, ctx) {
  const accounts = [
    ['viewer', 'viewer', 'Read-only city view'],
    ['operator', 'operator', 'Run simulations'],
    ['control', 'control', 'Control signals, preempt corridors'],
    ['enforcement', 'enforcement', 'Review violations, see plates'],
    ['admin', 'admin', 'Everything, including the audit log'],
  ];
  const submit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await ctx.signIn(form.operator.value, form.password.value);
  };
  return h('form', { class: 'login-form', onsubmit: submit }, [
    h('h2', { text: 'Operator sign-in' }),
    h('label', {}, ['Operator', h('input', { name: 'operator', required: true, autocomplete: 'username' })]),
    h('label', {}, ['Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })]),
    h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' }),
    h('table', { class: 'data-table' }, [
      h('thead', {}, [h('tr', {}, [h('th', { text: 'Operator' }), h('th', { text: 'Password' }), h('th', { text: 'Role grants' })])]),
      h('tbody', {}, accounts.map(([operator, password, note]) => h('tr', {}, [
        h('td', { text: operator }),
        h('td', { text: password }),
        h('td', { text: note }),
      ]))),
    ]),
    h('p', { class: 'hint', text: 'Prototype accounts for local demonstration only. The server refuses to start with these defaults when SIGNAL_HUB_ENV=production.' }),
  ]);
}
