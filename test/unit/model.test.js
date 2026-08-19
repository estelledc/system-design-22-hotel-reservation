import assert from 'node:assert/strict';
import test from 'node:test';
import { ReservationError } from '../../src/errors.js';
import {
  assertConserved,
  enumerateStayDates,
  evidenceFlags,
  inventoryAvailable,
  percentile,
} from '../../src/model.js';

test('explicit oversell participates in one conservation equation', () => {
  const row = { capacity: 2, oversellUnits: 1, blockedUnits: 1, heldUnits: 1, bookedUnits: 1 };
  assert.equal(inventoryAvailable(row), 0);
  assert.equal(assertConserved(row), true);
  assert.throws(() => assertConserved({ ...row, heldUnits: 2 }), ReservationError);
});

test('negative counters never satisfy conservation', () => {
  assert.throws(() => assertConserved({
    capacity: 2, oversellUnits: 0, blockedUnits: 0, heldUnits: -1, bookedUnits: 0,
  }), ReservationError);
});

test('booking evidence never implies payment, property, room, check-in, or acceptance', () => {
  assert.deepEqual(Object.values(evidenceFlags), Array(Object.keys(evidenceFlags).length).fill(false));
});

test('percentile uses a deterministic nearest-rank observation', () => {
  assert.equal(percentile([9, 1, 5, 3], 0.5), 3);
  assert.equal(percentile([9, 1, 5, 3], 0.95), 9);
});

test('generated calendar stays preserve checkout exclusion', () => {
  for (let index = 0; index < 2_000; index += 1) {
    const start = new Date(Date.UTC(2028, 0, 1 + (index % 300)));
    const nights = 1 + (index % 14);
    const end = new Date(start.getTime() + nights * 86_400_000);
    const dates = enumerateStayDates(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    assert.equal(dates.length, nights);
    assert.equal(dates.at(-1), new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10));
    assert.ok(!dates.includes(end.toISOString().slice(0, 10)));
  }
});
