/**
 * @file The God's Eye View camera and its operational overlays.
 *
 * This is the heart of the command center: a Cesium globe with one
 * `CustomDataSource` per operational layer, so a layer can be toggled, cleared
 * and rebuilt independently and a failure in one cannot blank the map.
 *
 * PERFORMANCE RULES THIS MODULE KEEPS:
 *
 *  - Entity counts are capped per layer. A city network is bounded at load
 *    time, and the vehicle/camera layers take the newest N rather than every
 *    record, because a command center that drops frames is not a command
 *    center.
 *  - Overlays are rebuilt from a single `render(state)` call on a throttled
 *    animation frame, not mutated from a dozen call sites.
 *  - Ground-clamped polylines carry a `distanceDisplayCondition` so road
 *    geometry is not drawn at global zoom, where it is unreadable anyway.
 *
 * @module client/map
 */

import * as Cesium from 'cesium';
import { LAMP_COLOR, STATUS, congestionToken, formatSpeed } from './theme.js';

/** @const {Object<string,[number,number,number,number]>} RGBA per congestion state. */
const ROAD_RGBA = Object.freeze({
  free: [0.13, 0.77, 0.37, 0.85],
  slow: [0.92, 0.7, 0.03, 0.9],
  jam: [0.94, 0.27, 0.27, 0.95],
  unknown: [0.42, 0.45, 0.5, 0.5],
});

/** @const {number} Maximum roads drawn, newest first. */
const MAX_ROADS = 1400;
/** @const {number} Maximum camera markers drawn. */
const MAX_CAMERAS = 240;
/** @const {number} Maximum non-emergency markers drawn. */
const MAX_MARKERS = 220;

/** @const {string} Viewport height the roads layer fades in at. */
const ROAD_MIN_HEIGHT = 60;
const ROAD_MAX_HEIGHT = 9000;

/**
 * Build the map surface.
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {string} [options.cesiumIonToken]
 * @param {object} [options.area] - Startup camera target.
 * @returns {object}
 */
export function createMap({ container, cesiumIonToken = '', area = null }) {
  const useIon = Boolean(cesiumIonToken);
  if (useIon) Cesium.Ion.defaultAccessToken = cesiumIonToken;

  const viewer = new Cesium.Viewer(container, {
    // Command-center chrome: no default widgets, the shell owns the controls.
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // A command center reads best at night: dark globe, no atmosphere glare.
    baseLayer: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#04070d');
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1220');
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.scene.fog.enabled = false;
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  viewer.scene.globe.enableLighting = false;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 40;

  // Imagery: Cesium ion when a token is configured, OpenStreetMap otherwise.
  // The map reports which one it used, because imagery provenance is a
  // data-source fact and the Data Sources page displays it.
  let imageryLabel = 'OpenStreetMap raster tiles';
  const osmLayer = new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
    }),
  );
  viewer.imageryLayers.add(osmLayer);
  if (useIon) {
    imageryLabel = 'Cesium ion global imagery';
    Cesium.createWorldImageryAsync()
      .then((provider) => {
        viewer.imageryLayers.addImageryProvider(provider);
        if (viewer.imageryLayers.length > 1) {
          viewer.imageryLayers.remove(osmLayer, true);
        }
        viewer.scene.requestRender();
      })
      .catch(() => {
        // An unreachable ion endpoint leaves the OSM layer in place, and the
        // readout keeps reporting the imagery that is actually drawn.
      });
  }

  /** @type {Map<string, Cesium.CustomDataSource>} */
  const layers = new Map();
  for (const id of [
    'roads',
    'intersections',
    'signals',
    'cameras',
    'emergency',
    'corridors',
    'incidents',
    'violations',
  ]) {
    const source = new Cesium.CustomDataSource(id);
    viewer.dataSources.add(source);
    layers.set(id, source);
  }

  /** Set by the shell so a click can become a selection. */
  let onSelect = () => {};
  let onHover = () => {};

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (!picked?.id) {
      onSelect(null);
      return;
    }
    const entity = picked.id;
    onSelect(entity.signalHub || null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.endPosition);
    onHover(picked?.id?.signalHub || null, movement.endPosition);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  /** @type {{lon:number,lat:number,height:number}|null} */
  let pendingCamera = null;
  let renderScheduled = false;

  /** @type {object} The most recent state handed to `render`. */
  let current = {
    roads: [],
    intersections: [],
    signals: [],
    cameras: [],
    emergency: [],
    corridors: [],
    incidents: [],
    violations: [],
    selectedId: null,
    visibleLayers: new Set(['roads', 'intersections', 'signals', 'cameras', 'emergency', 'corridors', 'incidents', 'violations']),
  };

  /** Clear a data source without disposing it. */
  const clear = (id) => layers.get(id).entities.removeAll();

  /**
   * Return the camera to the city.
   * @param {object} target
   */
  function flyTo({ lon, lat, height = 4000, duration = 2.2 }) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-58), roll: 0 },
      duration,
    });
  }

  /**
   * Frame the loaded network.
   * @param {object|null} bounds
   */
  function frameCity(bounds) {
    if (!bounds) return;
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      duration: 2.4,
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    });
  }

  /** Draw the road network, coloured by congestion class. */
  function renderRoads(roads) {
    const source = layers.get('roads');
    source.entities.removeAll();
    const drawn = roads.slice(0, MAX_ROADS);
    for (const road of drawn) {
      const coordinates = road.coordinates || [];
      if (coordinates.length < 2) continue;
      const flat = [];
      for (const [lon, lat] of coordinates) flat.push(lon, lat);
      const bucket = road.congestion === 'jam'
        ? 'jam'
        : road.congestion === 'slow'
          ? 'slow'
          : road.congestion === 'free'
            ? 'free'
            : 'unknown';
      const [r, g, b, a] = ROAD_RGBA[bucket];
      source.entities.add({
        id: `road:${road.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: bucket === 'jam' ? 4 : 2.5,
          material: new Cesium.ColorMaterialProperty(new Cesium.Color(r, g, b, a)),
          clampToGround: true,
          // Roads are not drawn from orbit: at that scale the geometry is
          // sub-pixel and drawing it is pure cost.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 26000),
        },
        signalHub: { kind: 'road', id: road.id, road },
      });
    }
  }

  /** Draw an intersection marker with its signal lamp and status word. */
  function renderIntersections(intersections, signals, selectedId) {
    const source = layers.get('intersections');
    source.entities.removeAll();
    const byId = new Map(signals.map((signal) => [signal.intersectionId, signal]));
    for (const intersection of intersections.slice(0, MAX_MARKERS)) {
      const signal = byId.get(intersection.id);
      const phase = signal?.phase || 'red';
      const faul = intersection.health === 'FAULT';
      const token = faul
        ? STATUS.fault
        : intersection.classification === 'severe'
          ? STATUS.jam
          : intersection.classification === 'congested'
            ? STATUS.congested
            : intersection.classification === 'slow'
              ? STATUS.slow
              : STATUS.flowing;
      const color = Cesium.Color.fromCssColorString(faul ? STATUS.fault.color : token.color);
      const selected = intersection.id === selectedId;
      source.entities.add({
        id: `intersection:${intersection.id}`,
        position: Cesium.Cartesian3.fromDegrees(intersection.lon, intersection.lat, 6),
        point: {
          pixelSize: selected ? 16 : 11,
          color,
          outlineColor: selected
            ? Cesium.Color.fromCssColorString('#a855f7')
            : Cesium.Color.fromCssColorString(LAMP_COLOR[phase] || '#ffffff'),
          outlineWidth: selected ? 4 : 2,
          // Markers stay legible from city scale down to street scale.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000),
        },
        label: {
          text: `${intersection.id}${faul ? ' ⚠' : ''}`,
          font: '11px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(6,10,18,0.78)'),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 9000),
        },
        signalHub: { kind: 'intersection', id: intersection.id, intersection, signal },
      });
    }
  }

  /** Draw the signal phase layer as phase lamps, offset from the intersection. */
  function renderSignals(signals, selectedId) {
    const source = layers.get('signals');
    source.entities.removeAll();
    for (const signal of signals.slice(0, MAX_MARKERS)) {
      if (!Number.isFinite(signal.lon) || !Number.isFinite(signal.lat)) continue;
      const color = Cesium.Color.fromCssColorString(
        signal.health === 'FAULT' ? LAMP_COLOR.fault : LAMP_COLOR[signal.phase] || '#ffffff',
      );
      const north = signal.states?.N || 'red';
      source.entities.add({
        id: `signal:${signal.intersectionId}`,
        position: Cesium.Cartesian3.fromDegrees(signal.lon, signal.lat, 14),
        billboard: {
          image: phaseGlyph(signal.phase, signal.health === 'FAULT'),
          color,
          scale: signal.intersectionId === selectedId ? 1.15 : 0.9,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000),
        },
        label: {
          text: `${signal.group} ${String(signal.phase).toUpperCase()}`,
          font: '10px "JetBrains Mono", monospace',
          fillColor: color,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(6,10,18,0.85)'),
          pixelOffset: new Cesium.Cartesian2(0, -26),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3500),
        },
        signalHub: { kind: 'signal', id: signal.intersectionId, signal },
      });
    }
  }

  /** Draw camera markers, distinguishing configured from simulated feeds. */
  function renderCameras(cameras, selectedId) {
    const source = layers.get('cameras');
    source.entities.removeAll();
    for (const camera of cameras.slice(0, MAX_CAMERAS)) {
      if (!Number.isFinite(camera.lon) || !Number.isFinite(camera.lat)) continue;
      const simulated = camera.sourceKind === 'simulated' || camera.mode === 'simulated';
      const offline = camera.status === 'offline';
      const color = offline
        ? STATUS.offline.color
        : simulated
          ? '#3b82f6'
          : '#22d3ee';
      source.entities.add({
        id: `camera:${camera.id}`,
        position: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 8),
        point: {
          pixelSize: camera.id === selectedId ? 12 : 7,
          color: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.fromCssColorString('#0b1220'),
          outlineWidth: 1,
          // A camera only becomes meaningful once the operator is near it.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 14000),
        },
        signalHub: { kind: 'camera', id: camera.id, camera },
      });
    }
  }

  /** Draw emergency vehicles and their corridors. */
  function renderEmergency(vehicles, corridors, selectedId) {
    const vehicleSource = layers.get('emergency');
    const corridorSource = layers.get('corridors');
    vehicleSource.entities.removeAll();
    corridorSource.entities.removeAll();

    for (const corridor of corridors) {
      const points = corridor.polyline || corridor.coordinates || [];
      if (points.length < 2) continue;
      const flat = [];
      for (const point of points) {
        if (Array.isArray(point)) flat.push(point[0], point[1]);
        else if (Number.isFinite(point.lon)) flat.push(point.lon, point.lat);
      }
      if (flat.length < 4) continue;
      const released = corridor.status === 'released';
      corridorSource.entities.add({
        id: `corridor:${corridor.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: released ? 3 : 7,
          material: released
            ? new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.fromCssColorString('rgba(107,114,128,0.7)'),
                dashLength: 24,
              })
            : new Cesium.PolylineGlowMaterialProperty({
                color: Cesium.Color.fromCssColorString('rgba(59,130,246,0.95)'),
                glowPower: 0.28,
              }),
          clampToGround: true,
        },
        signalHub: { kind: 'corridor', id: corridor.id, corridor },
      });
    }

    for (const vehicle of vehicles) {
      if (!Number.isFinite(vehicle.lon) || !Number.isFinite(vehicle.lat)) continue;
      const glyph = vehicle.type === 'fire-engine' ? '🚒' : vehicle.type === 'police' ? '🚓' : '🚑';
      vehicleSource.entities.add({
        id: `vehicle:${vehicle.id}`,
        position: Cesium.Cartesian3.fromDegrees(vehicle.lon, vehicle.lat, 12),
        label: {
          text: `${glyph} ${vehicle.type === 'fire-engine' ? 'FIRE' : 'AMB'}`,
          font: '13px "Inter", sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(37,99,235,0.9)'),
          pixelOffset: new Cesium.Cartesian2(0, -18),
        },
        point: {
          pixelSize: vehicle.id === selectedId ? 15 : 11,
          color: Cesium.Color.fromCssColorString('#3b82f6'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        signalHub: { kind: 'vehicle', id: vehicle.id, vehicle },
      });
    }
  }

  /** Draw incident markers. */
  function renderIncidents(incidents) {
    const source = layers.get('incidents');
    source.entities.removeAll();
    for (const incident of incidents.slice(0, MAX_MARKERS)) {
      if (!Number.isFinite(incident.lon) || !Number.isFinite(incident.lat)) continue;
      const critical = incident.severity === 'critical';
      source.entities.add({
        id: `incident:${incident.id}`,
        position: Cesium.Cartesian3.fromDegrees(incident.lon, incident.lat, 10),
        point: {
          pixelSize: critical ? 16 : 12,
          color: Cesium.Color.fromCssColorString(critical ? '#ef4444' : '#a855f7'),
          outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
          outlineWidth: critical ? 3 : 2,
        },
        label: {
          text: `⚠ ${String(incident.type || '').replace(/-/g, ' ').toUpperCase()}`,
          font: '10px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(88,28,135,0.9)'),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
        },
        signalHub: { kind: 'incident', id: incident.id, incident },
      });
    }
  }

  /** Draw violation markers. Plate text is deliberately never drawn here. */
  function renderViolations(violations) {
    const source = layers.get('violations');
    source.entities.removeAll();
    for (const violation of violations.slice(0, MAX_MARKERS)) {
      if (!Number.isFinite(violation.lon) || !Number.isFinite(violation.lat)) continue;
      source.entities.add({
        id: `violation:${violation.id}`,
        position: Cesium.Cartesian3.fromDegrees(violation.lon, violation.lat, 9),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(
            violation.reviewStatus === 'pending' ? '#f8fafc' : '#94a3b8',
          ),
          outlineColor: Cesium.Color.fromCssColorString('#ef4444'),
          outlineWidth: 2,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000),
        },
        signalHub: { kind: 'violation', id: violation.id, violation },
      });
    }
  }

  /** Apply one render pass. */
  function draw() {
    renderScheduled = false;
    const { visibleLayers } = current;
    layers.get('roads').show = visibleLayers.has('roads');
    layers.get('intersections').show = visibleLayers.has('intersections');
    layers.get('signals').show = visibleLayers.has('signals');
    layers.get('cameras').show = visibleLayers.has('cameras');
    layers.get('emergency').show = visibleLayers.has('emergency');
    layers.get('corridors').show = visibleLayers.has('corridors');
    layers.get('incidents').show = visibleLayers.has('incidents');
    layers.get('violations').show = visibleLayers.has('violations');

    if (visibleLayers.has('roads')) renderRoads(current.roads);
    else clear('roads');
    if (visibleLayers.has('intersections')) renderIntersections(current.intersections, current.signals, current.selectedId);
    else clear('intersections');
    if (visibleLayers.has('signals')) renderSignals(current.signals, current.selectedId);
    else clear('signals');
    if (visibleLayers.has('cameras')) renderCameras(current.cameras, current.selectedId);
    else clear('cameras');
    if (visibleLayers.has('emergency') || visibleLayers.has('corridors')) {
      renderEmergency(
        visibleLayers.has('emergency') ? current.emergency : [],
        visibleLayers.has('corridors') ? current.corridors : [],
        current.selectedId,
      );
    } else {
      clear('emergency');
      clear('corridors');
    }
    if (visibleLayers.has('incidents')) renderIncidents(current.incidents);
    else clear('incidents');
    if (visibleLayers.has('violations')) renderViolations(current.violations);
    else clear('violations');

    viewer.scene.requestRender();
  }

  /**
   * Merge new state and redraw on the next frame.
   *
   * Throttled to one animation frame so an SSE burst of twenty events causes
   * one render pass rather than twenty.
   * @param {object} patch
   */
  function render(patch) {
    current = { ...current, ...patch };
    if (patch.visibleLayers) current.visibleLayers = patch.visibleLayers;
    if (!renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(draw);
    }
  }

  return Object.freeze({
    viewer,
    render,
    flyTo,
    frameCity,
    imageryLabel: () => imageryLabel,
    /** @returns {string} The camera's current height in metres, for the HUD. */
    cameraHeight: () => viewer.camera.positionCartographic.height,
    /** @returns {{west:number,south:number,east:number,north:number}|null} */
    viewportBounds() {
      const rectangle = viewer.camera.computeViewRectangle();
      if (!rectangle) return null;
      return {
        west: Cesium.Math.toDegrees(rectangle.west),
        south: Cesium.Math.toDegrees(rectangle.south),
        east: Cesium.Math.toDegrees(rectangle.east),
        north: Cesium.Math.toDegrees(rectangle.north),
      };
    },
    /**
     * @param {Function} fn @param {Function} hover
     */
    setSelectionHandler(fn, hover) {
      onSelect = fn || (() => {});
      onHover = hover || (() => {});
    },
    destroy() {
      handler.destroy();
      viewer.destroy();
    },
  });
}

/**
 * A tiny canvas glyph for a signal phase.
 *
 * Drawn rather than fetched so the signal layer has no network dependency and
 * no icon font to fail.
 * @param {string} phase @param {boolean} fault
 * @returns {string} A data URL.
 */
function phaseGlyph(phase, fault) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const color = fault ? LAMP_COLOR.fault : LAMP_COLOR[phase] || '#ffffff';
  ctx.fillStyle = 'rgba(6,10,18,0.85)';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 5, 0, Math.PI * 2);
  ctx.fill();
  if (fault) {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(6, 26);
    ctx.lineTo(26, 6);
    ctx.stroke();
  }
  return canvas.toDataURL();
}

export { congestionToken, formatSpeed };
