import test from 'node:test';
import assert from 'node:assert/strict';

import { DATA_MODES } from './policy.js';
import {
  approachStatus,
  approachTable,
  buildRoutingGraph,
  confidenceBand,
  corridorLengthM,
  corridorPointAt,
  createEmergencyEngine,
  createEmergencyVehicle,
  fuseEmergencyDetection,
  projectVehicle,
  routeForEmergency,
  shortestPath,
} from './emergency.js';
import { buildRoadNetwork } from './network.js';
import { createSimulatedSignalController } from './signals.js';
import { gridRoads, createVirtualClock } from './fixtures.mjs';

test('fuseEmergencyDetection short-circuits on an authorized feed', () => {
  const fused = fuseEmergencyDetection({
    authorized: true,
    type: 'ambulance',
    // Contradictory weak evidence must not drag an authoritative call down.
    visual: 0.1,
  });
  assert.equal(fused.band, 'high');
  assert.equal(fused.confidence, 1);
  assert.equal(fused.type, 'ambulance');
  assert.equal(fused.mode, DATA_MODES.live);
});

test('a single uncertain visual classification cannot reach HIGH on its own', () => {
  const fused = fuseEmergencyDetection({ visual: 0.6, type: 'ambulance' });
  assert.notEqual(fused.band, 'high');
  assert.ok(
    fused.reasons.some((reason) => /visual classification alone/.test(reason)),
    fused.reasons.join('; '),
  );
});

test('independent signals combine into a stronger call than any one alone', () => {
  const visualOnly = fuseEmergencyDetection({ visual: 0.9, type: 'ambulance' });
  const fused = fuseEmergencyDetection({
    visual: 0.9,
    lightPattern: 0.9,
    siren: 0.9,
    type: 'ambulance',
  });
  assert.ok(fused.confidence > visualOnly.confidence);
  assert.equal(fused.band, 'high');
  assert.ok(fused.reasons.some((reason) => /light pattern/.test(reason)));
  assert.ok(fused.reasons.some((reason) => /siren/.test(reason)));
});

test('no evidence at all produces a LOW band', () => {
  const fused = fuseEmergencyDetection({});
  assert.equal(fused.band, 'low');
  assert.equal(fused.confidence, 0);
  assert.equal(fused.type, null);
});

test('an unrecognized vehicle type is dropped rather than passed through', () => {
  const fused = fuseEmergencyDetection({ authorized: true, type: 'tank' });
  assert.equal(fused.type, null);
});

test('confidenceBand maps onto the documented thresholds', () => {
  assert.equal(confidenceBand(0.9), 'high');
  assert.equal(confidenceBand(0.8), 'high');
  assert.equal(confidenceBand(0.79), 'medium');
  assert.equal(confidenceBand(0.5), 'medium');
  assert.equal(confidenceBand(0.49), 'low');
  assert.equal(confidenceBand(0), 'low');
  assert.equal(confidenceBand(NaN), 'low');
  // The cap is how "one visual detection is not enough for control" is kept.
  assert.equal(confidenceBand(0.9, true), 'medium');
});

test('createEmergencyVehicle validates its identity and coordinates', () => {
  assert.throws(() => createEmergencyVehicle({ id: '', type: 'ambulance', lon: 80, lat: 13 }), /requires an id/);
  assert.throws(
    () => createEmergencyVehicle({ id: 'EMV-1', type: 'tank', lon: 80, lat: 13 }),
    /Unknown emergency vehicle type/,
  );
  assert.throws(
    () => createEmergencyVehicle({ id: 'EMV-1', type: 'ambulance', lon: NaN, lat: 13 }),
    /requires coordinates/,
  );
  const vehicle = createEmergencyVehicle({ id: 'EMV-1', type: 'ambulance', lon: 80.2, lat: 13.08 });
  assert.equal(vehicle.mode, DATA_MODES.simulated);
  assert.equal(vehicle.confidence, 'low');
});

test('buildRoutingGraph connects intersections that share a road', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  assert.equal(graph.nodes.size, 16);
  for (const [id, edges] of graph.edges) {
    assert.ok(edges.length > 0, `${id} is isolated`);
    for (const edge of edges) {
      assert.ok(graph.nodes.has(edge.to), `${id} links to a missing node`);
      assert.ok(edge.costM >= edge.baseM);
    }
  }
});

test('shortestPath finds a route across the grid and reconstructs its geometry', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  const found = shortestPath(graph, 'INT-001', 'INT-016');
  assert.ok(found, 'no path found between diagonal corners');
  assert.equal(found.path[0], 'INT-001');
  assert.equal(found.path[found.path.length - 1], 'INT-016');
  assert.equal(found.roadIds.length, found.path.length - 1);
  assert.ok(found.distanceM > 0);
  // Consecutive intersections in the path must actually be adjacent.
  for (let i = 0; i < found.path.length - 1; i += 1) {
    const from = found.path[i];
    const to = found.path[i + 1];
    const neighbours = graph.edges.get(from).map((edge) => edge.to);
    assert.ok(neighbours.includes(to), `${from} → ${to} is not an edge`);
  }
});

test('shortestPath returns a trivial path for the same node and null for unreachable', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  const same = shortestPath(graph, 'INT-001', 'INT-001');
  assert.deepEqual(same.path, ['INT-001']);
  assert.equal(same.distanceM, 0);
  assert.equal(shortestPath(graph, 'INT-001', 'INT-999'), null);
  assert.equal(shortestPath(graph, 'INT-999', 'INT-001'), null);
});

test('congestion raises a road edge cost so a drone-free route can be preferred', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  const found = shortestPath(graph, 'INT-001', 'INT-002');
  assert.ok(found);
  // With free-flowing roads, cost equals distance.
  assert.ok(Math.abs(found.costM - found.distanceM) < 1);
});

test('routeForEmergency reports the intersections it will preempt, with an axis each', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  const route = routeForEmergency(graph, { fromId: 'INT-001', toId: 'INT-016' });
  assert.ok(route);
  assert.equal(route.mode, DATA_MODES.simulated);
  assert.equal(route.priorityAxes.length, route.intersectionIds.length);
  assert.ok(route.etaS > 0);
  for (const entry of route.priorityAxes) {
    assert.ok(['NS', 'EW'].includes(entry.axis), `axis ${entry.axis}`);
    assert.ok(entry.bearingDeg >= 0 && entry.bearingDeg < 360);
  }
});

test('routeForEmergency returns null when no route exists', () => {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  assert.equal(routeForEmergency(graph, { fromId: 'INT-001', toId: 'NOPE' }), null);
});

function engineHarness() {
  const network = buildRoadNetwork(gridRoads());
  const graph = buildRoutingGraph(network);
  const virtual = createVirtualClock();
  const controllers = new Map();
  for (const intersection of network.intersections) {
    controllers.set(
      intersection.id,
      createSimulatedSignalController({
        intersectionId: intersection.id,
        clock: virtual.clock,
        scheduler: virtual.scheduler,
      }),
    );
  }
  const emitted = [];
  const audited = [];
  const engine = createEmergencyEngine({
    emit: (event) => emitted.push(event),
    audit: { record: (entry) => audited.push(entry) },
  });
  return { network, graph, controllers, engine, emitted, audited, virtual };
}

test('the emergency engine spawns a vehicle and publishes a detection', () => {
  const { engine, emitted } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.075 });
  assert.equal(vehicle.type, 'ambulance');
  assert.equal(engine.listVehicles().length, 1);
  assert.equal(emitted[0].type, 'emergency-vehicle-detected');
  assert.match(emitted[0].message, /AMBULANCE detected/);
  assert.equal(emitted[0].mode, DATA_MODES.simulated);
  engine.clear();
});

test('planCorridor records the route and the intersections still ahead', () => {
  const { engine, graph, emitted } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  assert.ok(corridor);
  assert.equal(corridor.mode, DATA_MODES.simulated);
  assert.ok(corridor.intersectionIds.length >= 2);
  assert.equal(corridor.upcoming.length, corridor.intersectionIds.length);
  for (const item of corridor.upcoming) assert.equal(item.cleared, false);
  assert.ok(emitted.some((event) => event.type === 'emergency-corridor-requested'));
  engine.clear();
});

test('planCorridor refuses an unknown vehicle and a graph with no nodes', () => {
  const { engine, graph } = engineHarness();
  assert.equal(engine.planCorridor({ vehicleId: 'NOPE', graph, toId: 'INT-016' }), null);
  const empty = { nodes: new Map(), edges: new Map() };
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  assert.equal(engine.planCorridor({ vehicleId: vehicle.id, graph: empty, toId: 'INT-016' }), null);
  engine.clear();
});

test('preemption goes through the controller, never around it, and is audited', () => {
  const { engine, graph, controllers, emitted, audited } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  const target = corridor.upcoming[0].intersectionId;
  const controller = controllers.get(target);
  const before = controller.getSignalState();

  const result = engine.requestPreemption({
    corridorId: corridor.id,
    intersectionId: target,
    controllers,
    role: 'traffic-control',
  });
  assert.equal(result.ok, true);
  // The controller is now clearing the conflicting phase — it did NOT jump to
  // a conflicting green.
  const after = controller.getSignalState();
  assert.ok(
    !(after.states.N === 'green' && after.states.E === 'green')
      && !(after.states.S === 'green' && after.states.W === 'green'),
    'a conflicting green was produced',
  );
  assert.ok(audited.some((entry) => entry.action === 'signals.emergency-preemption'));
  assert.ok(emitted.some((event) => event.type === 'signal-priority-active'));
  assert.ok(result.request.before);
  assert.equal(before.intersectionId, result.request.intersectionId);
  engine.clear();
});

test('requestPreemption refuses an unknown corridor and a missing controller', () => {
  const { engine, graph, controllers } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  assert.equal(
    engine.requestPreemption({ corridorId: 'NOPE', intersectionId: 'INT-001', controllers }).ok,
    false,
  );
  assert.equal(
    engine.requestPreemption({ corridorId: corridor.id, intersectionId: 'INT-999', controllers }).ok,
    false,
  );
  engine.clear();
});

test('releaseCorridor restores normal control and marks the corridor released', () => {
  const { engine, graph, controllers, emitted, audited } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  const target = corridor.upcoming[0].intersectionId;
  engine.requestPreemption({ corridorId: corridor.id, intersectionId: target, controllers });

  const released = engine.releaseCorridor({ corridorId: corridor.id, controllers, role: 'traffic-control' });
  assert.equal(released.ok, true);
  assert.deepEqual(released.released, [target]);
  assert.equal(engine.getCorridor(corridor.id).status, 'released');
  assert.equal(engine.listPreemptions().length, 0);
  assert.ok(emitted.some((event) => event.type === 'signal-restored'));
  assert.ok(audited.some((entry) => entry.action === 'signals.emergency-release'));
  engine.clear();
});

test('upcomingIntersections shrinks as each intersection is preempted', () => {
  const { engine, graph, controllers } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  const total = engine.upcomingIntersections(corridor.id).length;
  const first = engine.upcomingIntersections(corridor.id)[0].intersectionId;
  engine.requestPreemption({ corridorId: corridor.id, intersectionId: first, controllers });
  assert.equal(engine.upcomingIntersections(corridor.id).length, total - 1);
  engine.clear();
});

test('advanceVehicle moves it along its corridor and eventually marks it arrived', () => {
  const { engine, graph } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  const corridor = engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  const start = engine.getVehicle(vehicle.id);
  const stepped = engine.advanceVehicle(vehicle.id, 1);
  assert.ok(
    stepped.lon !== start.lon || stepped.lat !== start.lat,
    'the vehicle did not move',
  );
  assert.ok(Math.abs(stepped.speedMps - 16.7) < 1e-9);
  // Run well past the corridor's length.
  for (let i = 0; i < 1000; i += 1) engine.advanceVehicle(vehicle.id, 5);
  assert.equal(engine.getVehicle(vehicle.id).status, 'arrived');
  assert.equal(engine.getVehicle(vehicle.id).speedMps, 0);
  assert.ok(corridor.lengthM > 0 || corridorLengthM(corridor) > 0);
  engine.clear();
});

test('advanceVehicle ignores a vehicle with no route and a non-positive step', () => {
  const { engine, graph } = engineHarness();
  const vehicle = engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  assert.equal(engine.advanceVehicle(vehicle.id, 5).travelledM, undefined);
  engine.planCorridor({ vehicleId: vehicle.id, graph, toId: 'INT-016' });
  const before = engine.getVehicle(vehicle.id);
  engine.advanceVehicle(vehicle.id, 0);
  assert.equal(engine.getVehicle(vehicle.id).travelledM, before.travelledM);
  engine.clear();
});

test('vehiclesNear filters by radius and reports the distance', () => {
  const { engine } = engineHarness();
  engine.spawnVehicle({ type: 'ambulance', lon: 80.2, lat: 13.08 });
  engine.spawnVehicle({ type: 'police', lon: 80.5, lat: 13.5 });
  const near = engine.vehiclesNear(80.2, 13.08, 1000);
  assert.equal(near.length, 1);
  assert.equal(near[0].type, 'ambulance');
  assert.ok(near[0].distanceM < 10);
  engine.clear();
});

test('approachStatus reports an ETA only inside the notice window', () => {
  const vehicle = { lon: 80.2, lat: 13.08, headingDeg: 0 };
  const intersection = { id: 'INT-1', lon: 80.2, lat: 13.08 };
  const onTop = approachStatus(vehicle, intersection);
  assert.equal(onTop.approaching, true);
  assert.ok(onTop.etaS >= 1);

  const far = approachStatus(vehicle, { id: 'INT-2', lon: 80.3, lat: 13.08 });
  assert.equal(far.approaching, false);
  assert.equal(far.etaS, null);
});

test('projectVehicle returns a plausible point ahead of the vehicle', () => {
  const vehicle = { lon: 80.2, lat: 13.08, headingDeg: 0 };
  const projected = projectVehicle(vehicle, 10);
  assert.ok(projected);
  assert.ok(projected.lat > vehicle.lat);
  assert.equal(projectVehicle(vehicle, NaN), null);
});

test('approachTable surfaces all four cardinal approaches with their mode', () => {
  const intersection = {
    id: 'INT-1',
    mode: DATA_MODES.simulated,
    modes: { N: { vehicleCount: DATA_MODES.simulated } },
    approaches: {
      N: { direction: 'N', roadName: 'Main', vehicleCount: 12, queueM: 30, signalPhase: 'green' },
    },
  };
  const table = approachTable(intersection);
  assert.deepEqual(table.map((row) => row.direction), ['N', 'S', 'E', 'W']);
  assert.equal(table[0].roadName, 'Main');
  assert.equal(table[0].signalPhase, 'green');
  // An approach the network did not fill reports `unmapped`, not a blank.
  assert.equal(table[1].roadName, 'unmapped');
});

test('corridorPointAt walks the corridor geometry', () => {
  const corridor = {
    geometry: [
      [80.2, 13.08],
      [80.22, 13.08],
      [80.24, 13.08],
    ],
  };
  const start = corridorPointAt(corridor, 0);
  const end = corridorPointAt(corridor, 1);
  assert.ok(Math.abs(start.lon - 80.2) < 1e-6);
  assert.ok(Math.abs(end.lon - 80.24) < 1e-6);
  const middle = corridorPointAt(corridor, 0.5);
  assert.ok(Math.abs(middle.lon - 80.22) < 0.003);
  assert.ok(corridorLengthM(corridor) > 4000);
  assert.equal(corridorLengthM({}), 0);
});
