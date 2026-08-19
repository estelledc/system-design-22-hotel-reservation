import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { ReservationError } from '../../src/errors.js';
import { initializeDatabase, resetDatabase, ReservationRepository } from '../../src/repository.js';
import { ReservationService } from '../../src/service.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Infrastructure tests never skip.');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16, statement_timeout: 10_000 });
const repository = new ReservationRepository(pool);
const service = new ReservationService(repository);
const principal = 'integration-client';
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
let keyCounter = 0;
const key = (label = 'request') => `${label}-${String(++keyCounter).padStart(8, '0')}`;

function call(body, requestKey = key()) {
  return { principal, requestKey, body };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof ReservationError && error.code === code);
}

async function seed({ dates = ['2027-03-13', '2027-03-14', '2027-03-15'], capacity = 2, oversell = 0 } = {}) {
  await service.createProperty(call({ propertyId: 'property-a', timezone: 'America/New_York' }, key('property')));
  for (const date of dates) {
    await service.putInventoryDay({
      principal,
      requestKey: key('inventory'),
      propertyId: 'property-a',
      roomTypeId: 'room-a',
      stayDate: date,
      body: { expectedRevision: 0, capacity, oversellUnits: oversell, blockedUnits: 0 },
    });
  }
}

function holdBody(id, overrides = {}) {
  return {
    holdId: uuid(id), propertyId: 'property-a', roomTypeId: 'room-a',
    checkInDate: '2027-03-13', checkOutDate: '2027-03-16', units: 1, leaseSeconds: 30,
    ...overrides,
  };
}

before(async () => initializeDatabase(pool));
beforeEach(async () => { keyCounter = 0; await resetDatabase(pool); });
after(async () => pool.end());

test('materialized availability is half-open and remains stable after a hold', async () => {
  await seed();
  const query = await service.createAvailabilityQuery(call({
    queryId: uuid(10), propertyId: 'property-a', roomTypeId: 'room-a',
    checkInDate: '2027-03-13', checkOutDate: '2027-03-16', units: 1,
  }, key('query')));
  assert.equal(query.nights.length, 3);
  assert.equal(query.minimumAvailable, 2);
  await service.createHold(call(holdBody(11), key('hold')));
  assert.deepEqual(await repository.getAvailabilityQuery(uuid(10)), query);
  const live = await service.createAvailabilityQuery(call({
    queryId: uuid(12), propertyId: 'property-a', roomTypeId: 'room-a',
    checkInDate: '2027-03-13', checkOutDate: '2027-03-16', units: 1,
  }, key('query-live')));
  assert.equal(live.minimumAvailable, 1);
});

test('missing middle inventory date rolls back the whole hold', async () => {
  await seed({ dates: ['2027-03-13', '2027-03-15'] });
  await expectCode(service.createHold(call(holdBody(20), key('hold'))), 'inventory_horizon_gap');
  const state = await repository.getState();
  assert.equal(state.heldUnits, 0);
  assert.equal(state.holds.active, 0);
});

test('two callers racing for the final all-night unit produce one owner', async () => {
  await seed({ capacity: 1 });
  const results = await Promise.allSettled([
    service.createHold(call(holdBody(30), key('hold-a'))),
    service.createHold(call(holdBody(31), key('hold-b'))),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected'
    && result.reason.code === 'inventory_unavailable').length, 1);
  const state = await repository.getState();
  assert.equal(state.heldUnits, 3);
  assert.equal(state.holds.active, 1);
  assert.equal(state.invariantOk, true);
});

test('hold exact retry replays while changed key or entity intent conflicts', async () => {
  await seed();
  const requestKey = key('hold');
  const first = await service.createHold(call(holdBody(40), requestKey));
  const replay = await service.createHold(call(holdBody(40), requestKey));
  assert.deepEqual(replay, first);
  await expectCode(service.createHold(call(holdBody(40, { units: 2 }), requestKey)), 'idempotency_conflict');
  await expectCode(service.createHold(call(holdBody(40, { units: 2 }), key('changed-entity'))), 'entity_conflict');
  assert.equal((await repository.getState()).heldUnits, 3);
});

test('confirm converts held units to booked units exactly once', async () => {
  await seed();
  await service.createHold(call(holdBody(50), key('hold')));
  const requestKey = key('confirm');
  const body = { bookingId: uuid(51), expectedHoldRevision: 1 };
  const first = await service.confirmHold({ principal, requestKey, holdId: uuid(50), body });
  const replay = await service.confirmHold({ principal, requestKey, holdId: uuid(50), body });
  assert.deepEqual(replay, first);
  const state = await repository.getState();
  assert.equal(state.heldUnits, 0);
  assert.equal(state.bookedUnits, 3);
  assert.equal(state.holds.converted, 1);
  assert.equal(state.bookings.confirmed, 1);
});

test('authoritative expiry and confirmation cannot both own inventory', async () => {
  await seed();
  await service.createHold(call(holdBody(60), key('hold')));
  await pool.query(`
    UPDATE holds
    SET created_at = statement_timestamp() - interval '2 seconds',
        expires_at = statement_timestamp() - interval '1 second'
    WHERE hold_id = $1
  `, [uuid(60)]);
  const requestKey = key('confirm');
  const confirm = () => service.confirmHold({
    principal, requestKey, holdId: uuid(60), body: { bookingId: uuid(61), expectedHoldRevision: 1 },
  });
  await expectCode(confirm(), 'hold_expired');
  await expectCode(confirm(), 'hold_expired');
  const state = await repository.getState();
  assert.equal(state.heldUnits, 0);
  assert.equal(state.bookedUnits, 0);
  assert.equal(state.holds.expired, 1);
});

test('assignment takeover fences the stale reaper', async () => {
  await seed();
  await service.createHold(call(holdBody(70), key('hold')));
  await pool.query(`
    UPDATE holds
    SET created_at = statement_timestamp() - interval '2 seconds',
        expires_at = statement_timestamp() - interval '1 second'
    WHERE hold_id = $1
  `, [uuid(70)]);
  await service.assignExpiryWorker(call({ workerId: 'reaper-a', expectedGeneration: 0 }, key('assign-a')));
  await service.assignExpiryWorker(call({ workerId: 'reaper-b', expectedGeneration: 1 }, key('assign-b')));
  await expectCode(service.reapHold({
    principal, requestKey: key('reap-a'), holdId: uuid(70),
    body: { workerId: 'reaper-a', expectedGeneration: 1 },
  }), 'stale_assignment');
  const result = await service.reapHold({
    principal, requestKey: key('reap-b'), holdId: uuid(70),
    body: { workerId: 'reaper-b', expectedGeneration: 2 },
  });
  assert.equal(result.outcome, 'expired');
  assert.equal((await repository.getState()).heldUnits, 0);
});

test('capacity changes preserve obligations and cancellation releases once', async () => {
  await seed({ capacity: 1 });
  await service.createHold(call(holdBody(80), key('hold')));
  await service.confirmHold({
    principal, requestKey: key('confirm'), holdId: uuid(80),
    body: { bookingId: uuid(81), expectedHoldRevision: 1 },
  });
  await expectCode(service.putInventoryDay({
    principal, requestKey: key('inventory-low'), propertyId: 'property-a', roomTypeId: 'room-a', stayDate: '2027-03-13',
    body: { expectedRevision: 3, capacity: 0, oversellUnits: 0, blockedUnits: 0 },
  }), 'capacity_below_obligation');
  const requestKey = key('cancel');
  const body = { expectedBookingRevision: 1 };
  const first = await service.cancelBooking({ principal, requestKey, bookingId: uuid(81), body });
  const replay = await service.cancelBooking({ principal, requestKey, bookingId: uuid(81), body });
  assert.deepEqual(replay, first);
  const updated = await service.putInventoryDay({
    principal, requestKey: key('inventory-after-cancel'), propertyId: 'property-a', roomTypeId: 'room-a', stayDate: '2027-03-13',
    body: { expectedRevision: 4, capacity: 0, oversellUnits: 0, blockedUnits: 0 },
  });
  assert.equal(updated.capacity, 0);
  const state = await repository.getState();
  assert.equal(state.bookedUnits, 0);
  assert.equal(state.bookings.cancelled, 1);
  assert.equal(state.invariantOk, true);
});

test('explicit oversell units are bounded inventory, not an implicit percentage', async () => {
  await seed({ capacity: 1, oversell: 1 });
  await service.createHold(call(holdBody(90), key('hold-a')));
  await service.createHold(call(holdBody(91), key('hold-b')));
  await expectCode(service.createHold(call(holdBody(92), key('hold-c'))), 'inventory_unavailable');
  assert.equal((await repository.getState()).heldUnits, 6);
});
