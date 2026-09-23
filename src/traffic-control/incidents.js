/**
 * @file Incident detection and the incident catalogue.
 *
 * An incident is a condition on the network that warrants a response. This
 * module classifies incidents, records them with an affected-footprint, and
 * proposes a response; it does not dispatch anything. Incidents in the
 * prototype are raised by the simulator or by an operator, never claimed to be
 * an upstream feed.
 *
 * @module traffic-control/incidents
 */

import { DATA_MODES } from './policy.js';
import { clamp, haversineM, isFiniteNumber } from './geometry.js';
import { SEVERITY, sequenceGenerator } from './events.js';

/**
 * Incident types the platform recognizes.
 *
 * `severity` is the DEFAULT for the type; a specific incident may override it,
 * because a fire in a bin and a fire in a tunnel are not the same thing.
 * @const {object[]}
 */
export const INCIDENT_TYPES = Object.freeze([
  Object.freeze({ type: 'ACCIDENT', label: 'Accident', severity: 'critical', affectsLanes: true }),
  Object.freeze({ type: 'BROKEN_DOWN_VEHICLE', label: 'Broken-down vehicle', severity: 'warning', affectsLanes: true }),
  Object.freeze({ type: 'ROAD_BLOCK', label: 'Road block', severity: 'critical', affectsLanes: true }),
  Object.freeze({ type: 'FIRE', label: 'Fire', severity: 'critical', affectsLanes: true }),
  Object.freeze({ type: 'FLOODING', label: 'Flooding', severity: 'critical', affectsLanes: true }),
  Object.freeze({ type: 'UNUSUAL_CONGESTION', label: 'Unusual congestion', severity: 'warning', affectsLanes: false }),
  Object.freeze({ type: 'EMERGENCY_VEHICLE', label: 'Emergency vehicle', severity: 'notice', affectsLanes: false }),
  Object.freeze({ type: 'TRAFFIC_SIGNAL_FAILURE', label: 'Traffic signal failure', severity: 'critical', affectsLanes: false }),
  Object.freeze({ type: 'CAMERA_FAILURE', label: 'Camera failure', severity: 'warning', affectsLanes: false }),
  Object.freeze({ type: 'ROAD_CLOSURE', label: 'Road closure', severity: 'critical', affectsLanes: true }),
]);

const TYPE_BY_NAME = new Map(INCIDENT_TYPES.map((entry) => [entry.type, entry]));

/** @const {Object<string,string>} Suggested operator response per incident type. */
export const RECOMMENDED_RESPONSES = Object.freeze({
  ACCIDENT: 'Dispatch traffic police; consider closing the affected lanes and rerouting.',
  BROKEN_DOWN_VEHICLE: 'Dispatch recovery; monitor queue growth on the approach.',
  ROAD_BLOCK: 'Divert traffic at the previous intersection; notify adjacent corridors.',
  FIRE: 'Notify fire service; close the affected road segment.',
  FLOODING: 'Close the affected segment; check drainage and adjacent low points.',
  UNUSUAL_CONGESTION: 'Inspect the corridor; check for a downstream incident or signal fault.',
  EMERGENCY_VEHICLE: 'Prepare the corridor; hold conflicting approaches.',
  TRAFFIC_SIGNAL_FAILURE: 'Treat the intersection as all-way stop; dispatch a controller technician.',
  CAMERA_FAILURE: 'Check the camera and its upstream feed; a blind approach reduces detection coverage.',
  ROAD_CLOSURE: 'Update routing; verify detour signage.',
});

/**
 * Update an incident catalogue entry, validating it like the rule set does.
 * @param {object} entry
 * @returns {boolean}
 */
export function validateIncidentType(entry) {
  if (!entry || typeof entry.type !== 'string' || !entry.type)
    throw new TypeError('An incident type requires a type name');
  if (!INCIDENT_TYPES.some((known) => known.type === entry.type))
    throw new TypeError(`Unknown incident type: ${entry.type}`);
  return true;
}

/**
 * Create the incident log.
 * @param {object} options
 * @param {() => number} [options.clock]
 * @param {(event:object) => void} [options.emit]
 * @param {object} [options.audit]
 * @returns {object}
 */
export function createIncidentEngine({ clock = () => Date.now(), emit = null, audit = null } = {}) {
  /** @type {Map<string, object>} */
  const incidents = new Map();
  let nextId = sequenceGenerator('INC', 4);

  const publish = (event) => {
    try {
      emit?.(event);
    } catch (error) {
      console.error('Incident event sink failed', error);
    }
  };

  const engine = {
    /**
     * Raise an incident.
     * @param {object} input
     * @param {string} input.type
     * @param {number} input.lon @param {number} input.lat
     * @param {string} [input.severity]
     * @param {string} [input.source] - Who or what reported it.
     * @param {number} [input.confidence]
     * @param {string[]} [input.affectedRoadIds]
     * @param {string[]} [input.affectedIntersectionIds]
     * @param {string} [input.detail]
     * @param {string} [input.mode]
     * @returns {object|null}
     */
    raise(input = {}) {
      const known = TYPE_BY_NAME.get(input.type);
      if (!known) return null;
      if (!isFiniteNumber(input.lon) || !isFiniteNumber(input.lat)) return null;
      const id = `INC-${nextId().slice(4)}`;
      const incident = Object.freeze({
        id,
        type: known.type,
        label: known.label,
        severity: input.severity || known.severity,
        lon: input.lon,
        lat: input.lat,
        source: input.source || 'operator',
        confidence: isFiniteNumber(input.confidence) ? clamp(input.confidence, 0, 1) : 1,
        affectedRoadIds: Object.freeze([...(input.affectedRoadIds || [])]),
        affectedIntersectionIds: Object.freeze([...(input.affectedIntersectionIds || [])]),
        recommendedResponse: RECOMMENDED_RESPONSES[known.type] || 'Inspect the location.',
        detail: input.detail || null,
        status: 'open',
        mode: input.mode || DATA_MODES.simulated,
        raisedAt: clock(),
        clearedAt: null,
        affectsLanes: known.affectsLanes,
      });
      incidents.set(id, incident);
      publish({
        category: 'incident',
        type: 'incident-raised',
        severity: severityForEvent(incident.severity),
        message: `${known.label.toUpperCase()} — ${input.detail || 'location reported'}`,
        mode: incident.mode,
        detail: {
          incidentId: id,
          incidentType: known.type,
          severity: incident.severity,
          lon: incident.lon,
          lat: incident.lat,
          recommendedResponse: incident.recommendedResponse,
        },
      });
      return incident;
    },

    /** @param {string} id @returns {object|null} */
    get(id) {
      return incidents.get(id) || null;
    },

    /**
     * List incidents.
     * @param {object} [options]
     * @param {string} [options.status='open']
     * @param {string} [options.type]
     * @param {number} [options.limit=100]
     * @returns {object[]}
     */
    list({ status = 'open', type = null, limit = 100 } = {}) {
      let out = [...incidents.values()];
      if (status) out = out.filter((incident) => incident.status === status);
      if (type) out = out.filter((incident) => incident.type === type);
      const bounded = Math.max(0, Math.floor(limit));
      return Object.freeze(out.slice(Math.max(0, out.length - bounded)));
    },

    /**
     * Incidents near a point, with distance, for the map and the alert list.
     * @param {number} lon @param {number} lat @param {number} radiusM
     * @returns {object[]}
     */
    near(lon, lat, radiusM) {
      return Object.freeze(
        [...incidents.values()]
          .filter((incident) => incident.status === 'open')
          .map((incident) =>
            Object.freeze({
              ...incident,
              distanceM: Math.round(haversineM(lon, lat, incident.lon, incident.lat)),
            }),
          )
          .filter((incident) => incident.distanceM <= radiusM),
      );
    },

    /**
     * Clear an incident.
     * @param {object} options
     * @param {string} options.id
     * @param {string} [options.role]
     * @returns {{ok:boolean, reason:string|null, incident:object|null}}
     */
    clear({ id, role = null } = {}) {
      const incident = incidents.get(id);
      if (!incident) return { ok: false, reason: 'unknown incident', incident: null };
      if (incident.status === 'cleared')
        return { ok: false, reason: 'already cleared', incident };
      const updated = Object.freeze({
        ...incident,
        status: 'cleared',
        clearedAt: clock(),
      });
      incidents.set(id, updated);
      audit?.record({
        action: 'incidents.clear',
        role,
        intersectionId: incident.affectedIntersectionIds[0] || null,
        outcome: 'applied',
        mode: incident.mode,
        reason: `cleared ${incident.type}`,
      });
      publish({
        category: 'incident',
        type: 'incident-cleared',
        severity: SEVERITY.notice,
        message: `${incident.label.toUpperCase()} CLEARED`,
        mode: incident.mode,
        detail: { incidentId: id },
      });
      return { ok: true, reason: null, incident: updated };
    },

    /** @returns {object} */
    summary() {
      const open = [...incidents.values()].filter((i) => i.status === 'open');
      const byType = {};
      for (const incident of open) byType[incident.type] = (byType[incident.type] || 0) + 1;
      return {
        total: incidents.size,
        open: open.length,
        byType,
        critical: open.filter((i) => i.severity === 'critical').length,
        mode: open.length
          ? open[0].mode
          : DATA_MODES.unavailable,
      };
    },

    clear() {
      incidents.clear();
    },
  };
  return Object.freeze(engine);
}

function severityForEvent(severity) {
  if (severity === 'critical') return SEVERITY.critical;
  if (severity === 'warning') return SEVERITY.warning;
  return SEVERITY.notice;
}

/**
 * Classify a traffic observation into an incident, or null.
 *
 * This is the "unusual congestion" detector: a road that is jammed while its
 * neighbours are not is a different thing from a network-wide peak, and only
 * the former is worth an operator's attention as an incident.
 * @param {object} input
 * @param {object} input.road
 * @param {number} [input.neighbourMeanLevel]
 * @param {number} [input.sustainedMs]
 * @param {number} [input.minSustainedMs=120000]
 * @returns {object|null}
 */
export function detectUnusualCongestion({
  road,
  neighbourMeanLevel = null,
  sustainedMs = 0,
  minSustainedMs = 120000,
} = {}) {
  if (!road) return null;
  if (road.congestion !== 'jam') return null;
  if (sustainedMs < minSustainedMs) return null;
  const contrast = isFiniteNumber(neighbourMeanLevel)
    ? 1 - clamp(neighbourMeanLevel, 0, 1)
    : 0.5;
  if (contrast < 0.3) return null;
  return {
    type: 'UNUSUAL_CONGESTION',
    confidence: clamp(0.5 + contrast * 0.5, 0, 1),
    detail: `${road.name || road.id} jammed while surrounding roads flow`,
  };
}

/**
 * Detect a signal controller fault from its health report.
 * @param {object} health
 * @param {string} intersectionId
 * @returns {object|null}
 */
export function detectSignalFailure(health, intersectionId) {
  if (!health) return null;
  if (health.status !== 'FAULT' && health.status !== 'DEGRADED') return null;
  return {
    type: 'TRAFFIC_SIGNAL_FAILURE',
    intersectionId,
    confidence: 1,
    detail:
      health.status === 'FAULT'
        ? `signal controller fault — ${health.fault || 'unknown cause'}`
        : `controller heartbeat ${Math.round((health.msSinceHeartbeat || 0) / 1000)}s ago`,
  };
}

/**
 * Detect a camera fault from its reported status.
 * @param {object} camera
 * @returns {object|null}
 */
export function detectCameraFailure(camera) {
  if (!camera) return null;
  if (camera.status === 'ok' || camera.status === 'unknown') return null;
  return {
    type: 'CAMERA_FAILURE',
    cameraId: camera.id,
    confidence: 1,
    detail: `${camera.id} (${camera.sourceKind || 'source'}) — ${camera.message || camera.status}`,
  };
}
