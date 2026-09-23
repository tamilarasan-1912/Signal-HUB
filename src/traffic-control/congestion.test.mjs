import test from 'node:test';
import assert from 'node:assert/strict';

import { DATA_MODES } from './policy.js';
import {
  JAM_DENSITY_VPKM,
  approachCongestion,
  cityTrafficSummary,
  classifyIntersection,
  congestionScore,
  countFromQueueLength,
  densityVpkpl,
  estimateDelay,
  intersectionPressure,
  levelOfService,
  queueLengthFromCount,
  recommendGreenSplit,
} from './congestion.js';
import { createIntersection, normalizeRoad } from './network.js';

function approach(overrides = {}) {
  return {
    direction: 'N',
    axis: 'NS',
    roadId: 'RD-1',
    roadName: 'Test Road',
    roadClass: 'primary',
    lengthM: 120,
    lanes: 2,
    vehicleCount: 0,
    queueVehicles: 0,
    queueM: 0,
    speedMps: 14,
    congestion: 0,
    cameraId: null,
    signalPhase: 'green',
    ...overrides,
  };
}

test('queueLengthFromCount uses jam density rather than a made-up constant', () => {
  // 130 vehicles on a single lane occupy one kilometre.
  assert.equal(queueLengthFromCount(130, 1), 1000);
  // Across two lanes the same count is half as long.
  assert.equal(queueLengthFromCount(130, 2), 500);
  assert.equal(queueLengthFromCount(0), 0);
  assert.equal(queueLengthFromCount(-5), 0);
  assert.equal(queueLengthFromCount(NaN), 0);
});

test('countFromQueueLength inverts queueLengthFromCount', () => {
  for (const lanes of [1, 2, 3]) {
    const count = 47;
    const metres = queueLengthFromCount(count, lanes);
    assert.equal(countFromQueueLength(metres, lanes), count);
  }
  assert.equal(countFromQueueLength(0), 0);
});

test('densityVpkpl needs a length and refuses nonsense', () => {
  // 26 vehicles over 1 km on 1 lane is 26 veh/km/lane.
  assert.equal(densityVpkpl(26, 1000, 1), 26);
  assert.equal(densityVpkpl(26, 1000, 2), 13);
  assert.equal(densityVpkpl(26, 0, 1), null);
  assert.equal(densityVpkpl(NaN, 1000, 1), null);
});

test('congestionScore trusts a provider level absolutely and labels it LIVE', () => {
  const result = congestionScore({
    trafficLevel: 0.4,
    // Deliberately contradictory measurements: the provider level must win.
    speedMps: 14,
    freeFlowMps: 14,
    vehicleCount: 0,
    lengthM: 1000,
  });
  assert.equal(result.score, 0.4);
  assert.equal(result.mode, DATA_MODES.live);
  assert.equal(result.components.provider, 0.4);
  assert.equal(result.components.speed, null);
});

test('congestionScore blends speed and density when no provider level exists', () => {
  const result = congestionScore({
    speedMps: 7,
    freeFlowMps: 14,
    vehicleCount: 130,
    lengthM: 1000,
    lanes: 1,
  });
  assert.equal(result.components.speed, 0.5);
  assert.equal(result.components.density, 1);
  assert.equal(result.score, 0.75);
  assert.equal(result.mode, DATA_MODES.estimated);
});

test('congestionScore reports UNAVAILABLE with no inputs at all', () => {
  const result = congestionScore({});
  assert.equal(result.score, null);
  assert.equal(result.bucket, null);
  assert.equal(result.mode, DATA_MODES.unavailable);
});

test('congestionScore uses whichever single signal it was given', () => {
  const speedOnly = congestionScore({ speedMps: 3.5, freeFlowMps: 14 });
  assert.equal(speedOnly.components.density, null);
  assert.equal(speedOnly.score, 0.25);

  const densityOnly = congestionScore({ vehicleCount: 65, lengthM: 1000, lanes: 1 });
  assert.equal(densityOnly.components.speed, null);
  assert.equal(densityOnly.score, 0.5);
});

test('levelOfService maps delay onto the HCM letters', () => {
  assert.equal(levelOfService(5), 'A');
  assert.equal(levelOfService(10), 'A');
  assert.equal(levelOfService(15), 'B');
  assert.equal(levelOfService(30), 'C');
  assert.equal(levelOfService(45), 'D');
  assert.equal(levelOfService(70), 'E');
  assert.equal(levelOfService(200), 'F');
  assert.equal(levelOfService(null), null);
});

test('estimateDelay grows monotonically as an approach saturates', () => {
  const flowing = estimateDelay({ arrivalVph: 200, greenMs: 40000, cycleMs: 90000, lanes: 2 });
  const busy = estimateDelay({ arrivalVph: 1600, greenMs: 30000, cycleMs: 90000, lanes: 2 });
  const saturated = estimateDelay({ arrivalVph: 3000, greenMs: 20000, cycleMs: 90000, lanes: 1 });
  assert.ok(flowing.delayS < busy.delayS, `${flowing.delayS} vs ${busy.delayS}`);
  assert.ok(busy.delayS < saturated.delayS, `${busy.delayS} vs ${saturated.delayS}`);
  assert.ok(saturated.degreeOfSaturation > 1);
  assert.equal(flowing.mode, DATA_MODES.estimated);
});

test('estimateDelay reports UNAVAILABLE when its inputs are missing', () => {
  const result = estimateDelay({ arrivalVph: 100, greenMs: 0, cycleMs: 90000 });
  assert.equal(result.delayS, null);
  assert.equal(result.mode, DATA_MODES.unavailable);
  assert.equal(estimateDelay({}).mode, DATA_MODES.unavailable);
});

test('intersectionPressure identifies the worst approach and names a reason', () => {
  const intersection = {
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: 0.95, queueVehicles: 40 }),
      S: approach({ congestion: 0.9, queueVehicles: 30 }),
      E: approach({ axis: 'EW', congestion: 0.1, queueVehicles: 2 }),
      W: approach({ axis: 'EW', congestion: 0.1, queueVehicles: 2 }),
    },
  };
  const pressure = intersectionPressure(intersection);
  assert.ok(pressure.pressure > 0.5, `got ${pressure.pressure}`);
  assert.ok(['N', 'S'].includes(pressure.worst));
  assert.ok(pressure.reasons.some((reason) => /high queue/.test(reason)));
  assert.ok(pressure.reasons.some((reason) => /imbalanced/.test(reason)));
  assert.equal(pressure.mode, DATA_MODES.estimated);
});

test('intersectionPressure reports UNAVAILABLE when no approach has data', () => {
  const intersection = {
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: null, speedMps: null, vehicleCount: null, queueVehicles: 0, queueM: 0, lengthM: null }),
    },
  };
  const pressure = intersectionPressure(intersection);
  assert.equal(pressure.pressure, 0);
  assert.equal(pressure.mode, DATA_MODES.unavailable);
});

test('approachCongestion prefers a measured congestion value over its fallbacks', () => {
  assert.equal(approachCongestion(approach({ congestion: 0.42 })), 0.42);
  // With no congestion value it derives from speed against free flow.
  const fromSpeed = approachCongestion(approach({ congestion: null, speedMps: 7 }));
  assert.ok(Math.abs(fromSpeed - 0.5) < 1e-9, `got ${fromSpeed}`);
  assert.equal(approachCongestion(null), null);
});

test('classifyIntersection reports a fault ahead of congestion', () => {
  const congested = {
    id: 'INT-1',
    health: 'FAULT',
    approaches: { N: approach({ congestion: 0.99 }) },
  };
  const classified = classifyIntersection(congested);
  assert.equal(classified.status, 'fault');
  assert.equal(classified.glyph, '✖');
  assert.ok(classified.reasons.length);
});

test('classifyIntersection grades congestion and always carries a word and a glyph', () => {
  const make = (level) => ({
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: level }),
      S: approach({ congestion: level }),
      E: approach({ axis: 'EW', congestion: level }),
      W: approach({ axis: 'EW', congestion: level }),
    },
  });
  const flowing = classifyIntersection(make(0.05));
  const slowing = classifyIntersection(make(0.65));
  const congested = classifyIntersection(make(0.95));
  assert.equal(flowing.status, 'flowing');
  assert.equal(slowing.status, 'slowing');
  assert.equal(congested.status, 'congested');
  for (const classified of [flowing, slowing, congested]) {
    // Accessibility: the status is never only a colour.
    assert.ok(classified.label.length > 0);
    assert.ok(classified.glyph.length > 0);
    assert.match(classified.color, /^#[0-9a-f]{6}$/i);
  }
});

test('recommendGreenSplit allocates the cycle toward the busier axis and floors the other', () => {
  const intersection = {
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: 0.95, queueVehicles: 40, queueM: 300 }),
      S: approach({ congestion: 0.9, queueVehicles: 35, queueM: 260 }),
      E: approach({ axis: 'EW', congestion: 0.05, queueVehicles: 1, queueM: 8 }),
      W: approach({ axis: 'EW', congestion: 0.05, queueVehicles: 1, queueM: 8 }),
    },
  };
  const recommendation = recommendGreenSplit(intersection, { cycleMs: 90000 });
  assert.ok(recommendation.recommended.NS > recommendation.current.NS - 1);
  // The starved axis never drops below the minimum green.
  assert.ok(recommendation.recommended.EW >= 8000, `got ${recommendation.recommended.EW}`);
  assert.ok(recommendation.recommended.NS <= 75000);
  assert.match(recommendation.reason, /queue/);
  assert.equal(recommendation.mode, DATA_MODES.estimated);
  assert.ok(recommendation.confidence > 0 && recommendation.confidence <= 1);
});

test('recommendGreenSplit refuses an intersection with no data', () => {
  const intersection = {
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: null, speedMps: null, vehicleCount: null, queueVehicles: 0, queueM: 0, lengthM: null }),
    },
  };
  assert.equal(recommendGreenSplit(intersection), null);
  assert.equal(recommendGreenSplit(null), null);
});

test('cityTrafficSummary aggregates roads and names the busiest intersection', () => {
  const roads = [
    normalizeRoad({ coordinates: [[80.2, 13.08], [80.21, 13.08]], type: 'primary' }, { id: 'RD-1' }),
  ];
  const junction = {
    id: 'INT-1',
    approaches: {
      N: approach({ congestion: 0.9 }),
      S: approach({ congestion: 0.9 }),
      E: approach({ axis: 'EW', congestion: 0.9 }),
      W: approach({ axis: 'EW', congestion: 0.9 }),
    },
  };
  const summary = cityTrafficSummary([junction], roads);
  assert.equal(summary.roads, 1);
  assert.equal(summary.intersections, 1);
  assert.equal(summary.unknownRoads, 1);
  assert.equal(summary.busiestIntersectionId, 'INT-1');
  assert.ok(summary.worstPressure > 0.5);
  // No live road level was present, so the city readout is simulated.
  assert.equal(summary.mode, DATA_MODES.simulated);
});

test('cityTrafficSummary labels an empty city UNAVAILABLE rather than guessing', () => {
  const summary = cityTrafficSummary([], []);
  assert.equal(summary.roads, 0);
  assert.equal(summary.mode, DATA_MODES.unavailable);
  assert.equal(summary.busiestIntersectionId, null);
});

test('a normalized intersection round-trips through the pressure calculation', () => {
  const eastWest = normalizeRoad(
    {
      coordinates: [
        [80.19, 13.08],
        [80.2, 13.08],
        [80.21, 13.08],
      ],
      type: 'primary',
    },
    { id: 'RD-EW' },
  );
  const northSouth = normalizeRoad(
    {
      coordinates: [
        [80.2, 13.07],
        [80.2, 13.08],
        [80.2, 13.09],
      ],
      type: 'secondary',
    },
    { id: 'RD-NS' },
  );
  const intersection = createIntersection({
    id: 'INT-1',
    lon: 80.2,
    lat: 13.08,
    roads: [eastWest, northSouth],
  });
  const pressure = intersectionPressure(intersection);
  // A freshly-built intersection has no queue, so it reads free.
  assert.equal(pressure.pressure, 0);
  assert.equal(pressure.mode, DATA_MODES.estimated);
  assert.equal(JAM_DENSITY_VPKM, 130);
});
