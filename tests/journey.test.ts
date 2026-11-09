import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyFor, journeyTime } from '../src/core/journey';
import { search } from '../src/core/router';
import { BAND_COLORS, bandColors, colorFor, defaults } from '../src/core/settings';
import { stockholmInstant } from '../src/core/time';
import type { Network } from '../src/core/types';

const base = stockholmInstant('2026-10-19', '08:00');
function network(): Network {
  return { stops: Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: String(i), station: String(i), platform: 'A', lat: 59, lon: 18 })),
    routes: [{ id: 'bus', name: '1', mode: 'bus' }], walks: [], transfers: [], connections: [] };
}
function ride(n: Network, from: number, to: number, dep: number, arr: number, trip: string, sequence = 0, pickup = true, dropoff = true) {
  n.connections.push({ from, to, departure: base + dep * 60, arrival: base + arr * 60, trip, sequence, route: 0, pickup, dropoff });
}
function walk(n: Network, from: number, to: number, minutes: number) { n.walks.push({ from, to, seconds: minutes * 60, source: 'fixture' }); }
function run(n: Network) { return search(n, { ...defaults(n.stops[0]), date: '2026-10-19', time: '08:00' }); }

test('itinerary clocks reproduce displayed cost with access walk, transfer wait and final walk', () => {
  const n = network(); walk(n, 0, 1, 5); ride(n, 1, 2, 15, 35, 'a'); walk(n, 2, 3, 4); ride(n, 3, 4, 42, 52, 'b'); walk(n, 4, 5, 8);
  const result = run(n), legs = journeyFor(result, 5);
  assert.deepEqual(legs.map(l => l.kind), ['walk', 'transit', 'walk', 'transit', 'walk']);
  assert.equal(legs[0].departure, base + 10 * 60); // 10 min initial wait excluded
  assert.equal(legs[0].arrival, legs[1].departure);
  assert.equal(legs[3].departure - legs[2].arrival, 3 * 60);
  assert.equal(legs.at(-1)!.arrival - legs[0].departure, result.values[5]!.seconds);
  assert.equal(result.values[5]!.seconds, 50 * 60);
  assert.deepEqual(journeyFor(result, 6), []);
});

test('destination witness keeps a useful alternative even when another journey wins at the transfer stop', () => {
  const n = network(); ride(n, 0, 1, 0, 5, 'early'); ride(n, 0, 1, 20, 26, 'late'); ride(n, 1, 2, 30, 35, 'next');
  const result = run(n);
  assert.equal(journeyFor(result, 1)[0].departure, base);
  assert.equal(journeyFor(result, 2)[0].departure, base + 20 * 60);
  assert.equal(result.values[2]!.seconds, 15 * 60);
});

test('ride geometry follows intermediate stops even where boarding and alighting are forbidden', () => {
  const n = network(); ride(n, 0, 1, 5, 10, 'through', 0, true, false); ride(n, 1, 2, 11, 15, 'through', 1, false, true);
  const legs = journeyFor(run(n), 2);
  assert.equal(legs.length, 1); assert.deepEqual(legs[0].stops, [0, 1, 2]);
  assert.equal(legs[0].departure, base + 300); assert.equal(legs[0].arrival, base + 900);
});

test('continuous walking is grouped without mutating shared witness nodes', () => {
  const n = network(); walk(n, 0, 1, 4); walk(n, 1, 2, 6); ride(n, 2, 3, 20, 25, 'a');
  const result = run(n), before = JSON.stringify(result.journeys), walkOnly = journeyFor(result, 2);
  assert.equal(walkOnly.length, 1); assert.deepEqual(walkOnly[0].stops, [0, 1, 2]); assert.equal(walkOnly[0].departure, base);
  assert.equal(journeyFor(result, 3)[0].departure, base + 600);
  assert.equal(JSON.stringify(result.journeys), before);
  assert.deepEqual(journeyFor(result, 0), []);
});

test('itinerary time uses Stockholm and explicitly labels arrival on another date', () => {
  assert.equal(journeyTime(Date.parse('2026-10-19T06:15:00Z') / 1000, '2026-10-19'), '08:15');
  assert.equal(journeyTime(Date.parse('2026-10-19T06:15:30Z') / 1000, '2026-10-19'), '08:15');
  assert.equal(journeyTime(Date.parse('2026-10-19T22:15:00Z') / 1000, '2026-10-19'), '00:15 (2026-10-20)');
  assert.equal(journeyTime(Date.parse('2026-12-01T07:15:00Z') / 1000, '2026-12-01'), '08:15');
});

test('every multi-band scale runs from light green to dark red with inclusive 10-minute boundaries', () => {
  for (const max of [20, 60, 75, 120]) {
    const colors = bandColors(max);
    assert.equal(colors[0], '#d9f0a3'); assert.equal(colors.at(-1), '#7f0000');
    assert.equal(colors.length, Math.ceil(max / 10));
    assert.equal(colorFor(600, max), colors[0]); assert.equal(colorFor(601, max), colors[1]);
    assert.equal(colorFor(max * 60, max), colors.at(-1));
  }
  assert.equal(colorFor(600, 10), BAND_COLORS[0]);
});

test('assumed access remains labelled and shares the continuous walking budget', () => {
  const n=network();
  n.walks=[{from:0,to:1,seconds:300,source:'mapped',metres:400},{from:1,to:2,seconds:120,source:'Assumed same-name stop transfer; <=250m',metres:160}, {from:2,to:3,seconds:240,source:'mapped',metres:320}];
  const settings={...defaults(n.stops[0]),date:'2026-10-19',time:'08:00',walkMinutes:10};
  const r=search(n,settings),legs=journeyFor(r,2);
  assert.equal(legs.length,1);
  assert.equal(legs[0].estimated,true);
  assert.deepEqual(legs[0].stops,[0,1,2]);
  assert.equal(legs[0].metres,560);
  assert.equal(legs[0].arrival-legs[0].departure,420);
  assert.equal(r.values[2]?.seconds,420);
  assert.equal(r.values[3],null); // An assumed transfer does not start a fresh walking allowance.
  const longer=search(n,{...settings,walkMinutes:15}),before=JSON.stringify(longer.journeys);
  const merged=journeyFor(longer,3);
  assert.equal(merged.length,1);
  assert.deepEqual(merged[0].stops,[0,1,2,3]);
  assert.equal(merged[0].metres,880);
  assert.equal(merged[0].estimated,true);
  assert.equal(merged[0].arrival-merged[0].departure,660);
  assert.equal(JSON.stringify(longer.journeys),before);
});

test('reviewed station access is estimated and cannot reset the walking allowance', () => {
  const n=network();
  n.walks=[{from:0,to:1,seconds:360,source:'Assumed reviewed station access; terminal',metres:400}, {from:1,to:2,seconds:300,source:'mapped',metres:400}];
  const settings={...defaults(n.stops[0]),date:'2026-10-19',time:'08:00',walkMinutes:10};
  const r=search(n,settings);
  assert.equal(journeyFor(r,1)[0].estimated,true);
  assert.equal(r.values[1]?.seconds,360);
  assert.equal(r.values[2],null);
});
