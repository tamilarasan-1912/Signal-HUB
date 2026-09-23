/**
 * @file Shared test fixtures for the traffic-control suite.
 *
 * A plain `.mjs` rather than a `.test.mjs` on purpose: the unit-test runner
 * discovers every `*.test.mjs` under `src/`, so a fixture living in a test file
 * would be re-executed — and re-registered as tests — in each file that
 * imported it. Geometry fixtures belong here instead.
 *
 * @module traffic-control/fixtures
 */

/**
 * A 4×4 street grid: four east–west streets crossing four north–south avenues.
 *
 * The crossing points are explicit vertices, which is what makes this a real
 * grid — a "grid" whose intersections are not vertices produces a network with
 * no junctions at all and would quietly weaken every test built on it.
 * 16 junctions, 8 roads.
 * @returns {object[]} Roads in the traffic layer's parsed shape.
 */
export function gridRoads() {
  const roads = [];
  for (let i = 0; i < 4; i += 1) {
    const lat = 13.08 + i * 0.01;
    roads.push({
      coordinates: [
        [80.2, lat],
        [80.21, lat],
        [80.22, lat],
        [80.23, lat],
      ],
      type: 'primary',
      oneway: 0,
    });
  }
  for (let j = 0; j < 4; j += 1) {
    const lon = 80.2 + j * 0.01;
    roads.push({
      coordinates: [
        [lon, 13.08],
        [lon, 13.09],
        [lon, 13.1],
        [lon, 13.11],
      ],
      type: 'secondary',
      oneway: 0,
    });
  }
  return roads;
}

/**
 * Two roads crossing at a point that deliberately lands on a 1e-3° grid-cell
 * boundary — where a naive clustering implementation splits one junction into
 * two.
 * @returns {object[]}
 */
export function boundaryCrossingRoads() {
  const lon = 80.2;
  const lat = 13.08;
  return [
    {
      coordinates: [
        [lon - 0.001, lat],
        [lon, lat],
        [lon + 0.001, lat],
      ],
      type: 'primary',
      oneway: 0,
    },
    {
      coordinates: [
        [lon, lat - 0.001],
        [lon, lat],
        [lon, lat + 0.001],
      ],
      type: 'secondary',
      oneway: 0,
    },
  ];
}

/**
 * A single intersection with both of its crossing roads, for tests that need a
 * four-approach junction with real approach geometry.
 * @param {object} [options]
 * @param {number} [options.lon=80.2] @param {number} [options.lat=13.08]
 * @returns {{eastWest:object, northSouth:object, lon:number, lat:number}}
 */
export function crossingRoadPair({ lon = 80.2, lat = 13.08 } = {}) {
  return {
    lon,
    lat,
    eastWest: {
      coordinates: [
        [lon - 0.01, lat],
        [lon, lat],
        [lon + 0.01, lat],
      ],
      type: 'primary',
      oneway: 0,
    },
    northSouth: {
      coordinates: [
        [lon, lat - 0.01],
        [lon, lat],
        [lon, lat + 0.01],
      ],
      type: 'secondary',
      oneway: 0,
    },
  };
}

/**
 * A clock and timer source under the test's control, with no real timers.
 *
 * Signal controllers schedule their next phase transition. A controller built
 * with the platform's real `setTimeout` keeps the Node event loop alive for its
 * whole green interval, which makes any test that builds a network hang for
 * thirty seconds after it has already passed or failed. Injecting this instead
 * means the tests are instant and a phase transition is proven by firing it.
 * @param {number} [start=0]
 * @returns {object}
 */
export function createVirtualClock(start = 0) {
  let now = start;
  let queue = [];
  return {
    /** @returns {number} */
    clock() {
      return now;
    },
    /** @returns {number} */
    get now() {
      return now;
    },
    /** Advance the clock without firing timers. @param {number} ms */
    advance(ms) {
      now += ms;
    },
    /** The scheduler handed to a controller's `scheduler` option. */
    scheduler: {
      setTimer(fn, ms) {
        const handle = { fn, ms, at: now + ms };
        queue.push(handle);
        return handle;
      },
      clearTimer(handle) {
        queue = queue.filter((item) => item !== handle);
      },
    },
    /** Fire the next due timer, advancing the clock to it. */
    fireNext() {
      if (!queue.length) return null;
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      now = Math.max(now, next.at);
      next.fn();
      return next;
    },
    /** Fire up to `steps` timers. @param {number} [steps=20] */
    drain(steps = 20) {
      const fired = [];
      for (let i = 0; i < steps; i += 1) {
        const stepped = this.fireNext();
        if (!stepped) break;
        fired.push(stepped);
      }
      return fired;
    },
    /** @returns {number} Timers still pending. */
    get pending() {
      return queue.length;
    },
  };
}
