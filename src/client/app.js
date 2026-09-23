/**
 * @file The command-center shell.
 *
 * Owns the chrome (top bar, navigation, map, timeline, inspector), routes the
 * active page to a panel, and wires map selection to the store. Panels are
 * swapped on navigation but the map is created once and kept, because
 * rebuilding a Cesium viewer on every tab change would discard the operator's
 * camera position.
 *
 * @module client/app
 */

import { api } from './api.js';
import { createMap } from './map.js';
import { createStore } from './store.js';
import { h, badge, chip, clear, empty } from './dom.js';
import {
  NAV_GLYPHS,
  NAV_ITEMS,
  NAV_LABELS,
  formatClock,
  healthToken,
  modeToken,
} from './theme.js';
import {
  analyticsPanel,
  cctvPanel,
  dataSourcesPanel,
  emergencyPanel,
  eventTimeline,
  incidentsPanel,
  inspector,
  intersectionsPanel,
  loginPanel,
  overviewPanel,
  settingsPanel,
  signalsPanel,
  simulationPanel,
  trafficPanel,
  violationsPanel,
} from './panels.js';

/** @const {Object<string,Function>} Page id → panel renderer. */
const PANELS = Object.freeze({
  overview: overviewPanel,
  traffic: trafficPanel,
  intersections: intersectionsPanel,
  cctv: cctvPanel,
  emergency: emergencyPanel,
  incidents: incidentsPanel,
  violations: violationsPanel,
  signals: signalsPanel,
  analytics: analyticsPanel,
  simulation: simulationPanel,
  'data-sources': dataSourcesPanel,
  settings: settingsPanel,
});

/** @const {string[]} Layers the operator may toggle. */
const LAYER_TOGGLES = Object.freeze([
  ['roads', 'Roads'],
  ['intersections', 'Intersections'],
  ['signals', 'Signals'],
  ['cameras', 'Cameras'],
  ['emergency', 'Emergency'],
  ['corridors', 'Corridors'],
  ['incidents', 'Incidents'],
  ['violations', 'Violations'],
]);

/**
 * Mount the command center.
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {string} [options.cesiumIonToken]
 * @returns {Promise<object>}
 */
export async function mountCommandCenter({ root, cesiumIonToken = '' }) {
  const store = createStore();
  const state = store.state;

  /** @type {Set<string>} */
  const visibleLayers = new Set(LAYER_TOGGLES.map(([id]) => id));

  const s = (selector) => root.querySelector(selector);

  // ── Map ─────────────────────────────────────────────────────────────────
  let map = null;
  const mapContext = {
    addFrame: null,
  };
  try {
    map = createMap({
      container: s('#map-canvas'),
      cesiumIonToken,
    });
    map.setSelectionHandler(
      (selection) => {
        if (!selection) {
          store.select(null);
          return;
        }
        void selectFromMap(selection);
      },
      null,
    );
  } catch (error) {
    // A map failure must not take the command center down: every readout on
    // every page still works, so the console reports the map as unavailable
    // and keeps operating.
    s('#map-canvas').appendChild(
      empty(`3D map unavailable: ${error?.message || error}. All readouts remain live.`, 'warn'),
    );
    console.error('[signal-hub] map initialisation failed', error);
  }

  /**
   * Resolve a map pick into a full detail record from the API.
   * @param {object} selection
   */
  async function selectFromMap(selection) {
    const base = { kind: selection.kind, id: selection.id, ...selection };
    store.select(base);
    try {
      if (selection.kind === 'intersection') {
        const detail = await api.intersection(selection.id);
        store.select({ ...base, detail });
      } else if (selection.kind === 'camera') {
        const detail = await api.camera(selection.id);
        store.select({ ...base, detail });
      } else if (selection.kind === 'violation') {
        const detail = await api.violation(selection.id);
        store.select({ ...base, detail });
      }
    } catch (error) {
      store.select({ ...base, detail: null, error: error?.message });
    }
  }

  /**
   * The render context handed to panels. Keeps the API surface a panel can
   * reach explicit and small.
   * @const {object}
   */
  const ctx = {
    select(selection) {
      if (selection?.id && selection.kind) void selectFromMap(selection);
      else store.select(selection);
    },
    act: (fn) => store.act(fn),
    can: (capability) => store.can(capability),
    role: () => state.session?.role || 'anonymous',
    signIn: (operator, password) => store.signIn(operator, password),
    signOut: () => store.signOut(),
    showDemoReport: (report) => showDemoReport(report),
    setFrame(frame) {
      if (state.selection) store.select({ ...state.selection, frame });
    },
  };

  // ── Chrome ──────────────────────────────────────────────────────────────

  const navList = s('#nav-list');
  const pageHost = s('#page-host');
  const timelineHost = s('#timeline-host');
  const inspectorHost = s('#inspector-host');
  const topStatus = s('#top-status');
  const layerRow = s('#layer-row');
  const alertHost = s('#alert-host');

  for (const id of NAV_ITEMS) {
    navList.appendChild(
      h('button', {
        class: 'nav-item',
        type: 'button',
        dataset: { mode: id },
        onclick: () => {
          store.setMode(id);
          map?.render({ selectedId: null });
        },
      }, [
        h('span', { class: 'nav-glyph', text: NAV_GLYPHS[id] }),
        NAV_LABELS[id],
      ]),
    );
  }

  for (const [id, label] of LAYER_TOGGLES) {
    const box = h('input', {
      type: 'checkbox',
      checked: true,
      onchange: (event) => {
        if (event.target.checked) visibleLayers.add(id);
        else visibleLayers.delete(id);
        map?.render({ visibleLayers });
      },
    });
    layerRow.appendChild(h('label', { class: 'layer-toggle' }, [box, label]));
  }

  for (const id of ['overview', 'traffic', 'cctv', 'emergency', 'violations', 'simulation', 'settings']) {
    const control = h('button', {
      class: 'nav-item nav-item-sub',
      type: 'button',
      dataset: { mode: id },
      onclick: () => store.setMode(id),
    }, NAV_LABELS[id]);
    navList.appendChild(control);
  }

  /** The demo report modal host. */
  function showDemoReport(report) {
    const host = s('#modal-host');
    clear(host);
    if (!report) return;
    host.appendChild(h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h3', { text: 'Full City Demo — stage report' }),
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => clear(host) }),
      ]),
      badge(modeToken(report.mode || 'simulated', 'simulator')),
      h('ol', { class: 'demo-stages' }, (report.stages || []).map((stage) =>
        h('li', { class: stage.ok ? 'ok' : 'failed' }, [
          h('strong', { text: stage.stage }),
          h('span', { text: stage.label }),
          h('span', { class: 'demo-detail', text: describeStage(stage) }),
        ]))),
      h('p', { class: 'hint', text: 'Every stage above ran against the traffic-control engine. Nothing here touched real infrastructure.' }),
    ]));
  }

  /** @param {object} stage @returns {string} */
  function describeStage(stage) {
    const parts = [];
    if (stage.intersections?.length) parts.push(`${stage.intersections.length} intersections`);
    if (stage.applied !== undefined) parts.push(`${stage.applied} timing changes applied`);
    if (stage.recommendations !== undefined) parts.push(`${stage.recommendations} recommendations`);
    if (stage.vehicleId) parts.push(`vehicle ${stage.vehicleId}`);
    if (stage.corridorId) parts.push(`corridor ${stage.corridorId}`);
    if (stage.advances !== undefined) parts.push(`${stage.advances} advances`);
    if (stage.preemptions !== undefined) parts.push(`${stage.preemptions} preemptions`);
    if (stage.released !== undefined) parts.push(`${stage.released} released`);
    if (stage.violationId) parts.push(`violation ${stage.violationId}`);
    if (stage.pending !== undefined) parts.push(`${stage.pending} pending review`);
    return parts.join(' · ');
  }

  // ── Render loop ─────────────────────────────────────────────────────────

  let lastMode = null;
  let lastSelectionId = null;

  /** Push the latest state into the map and the panels. */
  function paint() {
    const mode = state.mode;

    // Top bar
    clear(topStatus);
    const operational = state.health?.overall || 'unknown';
    topStatus.appendChild(chip(healthToken({ status: operational })));
    const signalFaults = state.status?.health.signals.fault ?? 0;
    const cameraIssues = (state.status?.health.cameras.degraded ?? 0) + (state.status?.health.cameras.unconfigured ?? 0);
    topStatus.appendChild(chip(
      signalFaults
        ? { label: `${signalFaults} SIGNAL FAULT`, color: '#ef4444', glyph: '✖' }
        : { label: 'SIGNALS OK', color: '#22c55e', glyph: '●' },
    ));
    topStatus.appendChild(chip(
      cameraIssues
        ? { label: `${cameraIssues} CAMERA NOTES`, color: '#eab308', glyph: '▲' }
        : { label: 'CAMERAS OK', color: '#22c55e', glyph: '●' },
    ));
    topStatus.appendChild(chip(
      state.emergency.length || state.corridors.some((corridor) => corridor.status !== 'released')
        ? { label: 'EMERGENCY ACTIVE', color: '#3b82f6', glyph: '✚' }
        : { label: 'NO EMERGENCY', color: '#6b7280', glyph: '○' },
    ));
    s('#clock').textContent = formatClock(Date.now());
    s('#mode-label').textContent = state.config?.operatingMode
      ? `MODE ${String(state.config.operatingMode).replace(/-/g, ' ').toUpperCase()}`
      : 'MODE —';

    // Connectivity banner
    clear(alertHost);
    if (state.error) {
      alertHost.appendChild(
        h('div', { class: 'alert error' }, [
          h('strong', { text: 'COMMAND API UNREACHABLE' }),
          h('span', { text: state.error }),
        ]),
      );
    } else if (state.degraded.length) {
      alertHost.appendChild(
        h('div', { class: 'alert warn' }, [
          h('strong', { text: 'DEGRADED PROVIDERS' }),
          h('span', { text: state.degraded.map((item) => `${item.label} (${item.message})`).join(' · ') }),
        ]),
      );
    }

    // Navigation
    for (const button of navList.querySelectorAll('.nav-item')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }

    // Page
    if (mode !== lastMode) {
      clear(pageHost);
      const panel = PANELS[mode] || overviewPanel;
      pageHost.appendChild(h('div', { class: 'page' }, panel(state, ctx)));
      lastMode = mode;
    } else {
      const existing = pageHost.firstElementChild;
      const fresh = h('div', { class: 'page' }, (PANELS[mode] || overviewPanel)(state, ctx));
      if (existing) pageHost.replaceChild(fresh, existing);
      else pageHost.appendChild(fresh);
    }

    // Timeline and inspector
    clear(timelineHost);
    timelineHost.appendChild(eventTimeline(state));
    clear(inspectorHost);
    inspectorHost.appendChild(inspector(state, ctx));

    // Map
    if (map) {
      const selection = state.selection;
      map.render({
        roads: state.roads,
        intersections: state.intersections,
        signals: state.signals,
        cameras: state.cameras,
        emergency: state.emergency,
        corridors: state.corridors,
        incidents: state.incidents,
        violations: state.violations.map((violation) => ({
          ...violation,
          lon: violation.lon ?? violation.observation?.lon,
          lat: violation.lat ?? violation.observation?.lat,
        })),
        selectedId: selection?.id || null,
        visibleLayers,
      });
      if (selection?.id !== lastSelectionId) {
        lastSelectionId = selection?.id || null;
      }
    }
  }

  store.subscribe(paint);
  setInterval(() => {
    s('#clock').textContent = formatClock(Date.now());
  }, 1000);

  // ── Startup ─────────────────────────────────────────────────────────────

  s('#sign-in').addEventListener('click', () => {
    const host = s('#modal-host');
    clear(host);
    host.appendChild(h('div', { class: 'modal' }, [
      loginPanel(state, {
        signIn: async (operator, password) => {
          const result = await store.signIn(operator, password);
          if (!result.ok) {
            alert(`Sign-in failed: ${result.error}`);
            return;
          }
          clear(host);
        },
      }),
    ]));
  });
  s('#sign-out').addEventListener('click', () => void store.signOut());

  await store.start();

  // Frame the city once the network has arrived.
  if (map && state.status) {
    const roads = state.roads;
    if (roads.length) {
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const road of roads) {
        for (const [lon, lat] of road.coordinates || []) {
          west = Math.min(west, lon);
          south = Math.min(south, lat);
          east = Math.max(east, lon);
          north = Math.max(north, lat);
        }
      }
      if (Number.isFinite(west)) {
        map.frameCity({ west, south, east, north });
        state.mapInfo = { ...(state.mapInfo || {}), imagery: map.imageryLabel() };
      }
    }
  }
  await store.refresh();
  await store.loadSession();
  state.config = await api.config().catch(() => null);
  paint();

  return { store, map };
}
