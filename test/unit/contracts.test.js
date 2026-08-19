import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalStringify,
  digestValue,
  normalizeAvailability,
  normalizeHold,
  normalizeInventoryMutation,
  normalizeProperty,
  validateRequestKey,
  validateUuid,
} from '../../src/contracts.js';
import { ReservationError } from '../../src/errors.js';
import { enumerateStayDates } from '../../src/model.js';

const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

test('canonical JSON and digest do not depend on object insertion order', () => {
  assert.equal(canonicalStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(digestValue({ b: 2, a: 1 }), digestValue({ a: 1, b: 2 }));
});

test('stay dates are half-open calendar dates across a DST-adjacent weekend', () => {
  assert.deepEqual(enumerateStayDates('2027-03-13', '2027-03-16'), [
    '2027-03-13', '2027-03-14', '2027-03-15',
  ]);
  assert.equal(enumerateStayDates('2027-11-06', '2027-11-08').length, 2);
});

test('stay rejects zero, reversed, non-canonical, and overlong intervals', () => {
  for (const [start, end] of [
    ['2027-03-13', '2027-03-13'],
    ['2027-03-14', '2027-03-13'],
    ['2027-3-13', '2027-03-14'],
    ['2027-03-01', '2027-03-17'],
  ]) assert.throws(() => enumerateStayDates(start, end), ReservationError);
});

test('property contract freezes a bounded timezone vocabulary', () => {
  assert.deepEqual(normalizeProperty({ propertyId: 'property-a', timezone: 'America/New_York' }).propertyId, 'property-a');
  assert.throws(() => normalizeProperty({ propertyId: 'property-a', timezone: 'Local/Machine' }), ReservationError);
  assert.throws(
    () => normalizeProperty({ propertyId: 'property-a', timezone: 'Etc/UTC', extra: true }),
    ReservationError,
  );
});

test('hold intent includes checkout exclusion, units, and lease', () => {
  const body = {
    holdId: uuid(1), propertyId: 'property-a', roomTypeId: 'room-a',
    checkInDate: '2027-03-13', checkOutDate: '2027-03-16', units: 2, leaseSeconds: 30,
  };
  const first = normalizeHold(body);
  const second = normalizeHold({ ...body });
  const changed = normalizeHold({ ...body, leaseSeconds: 31 });
  assert.deepEqual(first.stayDates, ['2027-03-13', '2027-03-14', '2027-03-15']);
  assert.equal(first.intentDigest, second.intentDigest);
  assert.notEqual(first.intentDigest, changed.intentDigest);
});

test('availability and hold IDs must be canonical UUIDs', () => {
  assert.equal(validateUuid(uuid(4)), uuid(4));
  assert.throws(() => validateUuid('not-an-id'), ReservationError);
  const request = normalizeAvailability({
    queryId: uuid(5), propertyId: 'property-a', roomTypeId: 'room-a',
    checkInDate: '2027-03-13', checkOutDate: '2027-03-14', units: 1,
  });
  assert.equal(request.stayDates.length, 1);
});

test('inventory mutation has exact shape and explicit oversell units', () => {
  const request = normalizeInventoryMutation({
    propertyId: 'property-a', roomTypeId: 'room-a', stayDate: '2027-03-13',
    body: { expectedRevision: 0, capacity: 2, oversellUnits: 1, blockedUnits: 0 },
  });
  assert.equal(request.capacity + request.oversellUnits, 3);
  assert.throws(() => normalizeInventoryMutation({
    propertyId: 'property-a', roomTypeId: 'room-a', stayDate: '2027-03-13',
    body: { expectedRevision: 0, capacity: 2, oversellUnits: -1, blockedUnits: 0 },
  }), ReservationError);
});

test('request keys are bounded and explicit', () => {
  assert.equal(validateRequestKey('request-0001'), 'request-0001');
  assert.throws(() => validateRequestKey('short'), ReservationError);
  assert.throws(() => validateRequestKey('request with spaces'), ReservationError);
});
