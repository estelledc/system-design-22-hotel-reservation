import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { percentile } from '../src/model.js';
import { initializeDatabase, resetDatabase, ReservationRepository } from '../src/repository.js';
import { ReservationService } from '../src/service.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; infrastructure benchmark never skips');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16, statement_timeout: 20_000 });
const repository = new ReservationRepository(pool);
const service = new ReservationService(repository);
const principal = 'benchmark-client';
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const key = (kind, index) => `benchmark-${kind}-${String(index).padStart(6, '0')}`;
const round = (value) => Math.round(value * 1000) / 1000;
const date = (offset) => new Date(Date.UTC(2027, 3, 1 + offset)).toISOString().slice(0, 10);

function call(body, requestKey) {
  return { principal, requestKey, body };
}

try {
  await initializeDatabase(pool);
  await resetDatabase(pool);
  const properties = ['property-a', 'property-b'];
  const roomTypes = ['room-a', 'room-b', 'room-c', 'room-d'];
  for (const [index, propertyId] of properties.entries()) {
    await service.createProperty(call(
      { propertyId, timezone: index ? 'Europe/Paris' : 'America/New_York' }, key('property', index),
    ));
  }

  const inventoryStarted = performance.now();
  let inventoryIndex = 0;
  for (const propertyId of properties) {
    for (const roomTypeId of roomTypes) {
      for (let day = 0; day < 32; day += 1) {
        await service.putInventoryDay({
          principal,
          requestKey: key('inventory', inventoryIndex++),
          propertyId,
          roomTypeId,
          stayDate: date(day),
          body: { expectedRevision: 0, capacity: 20, oversellUnits: 0, blockedUnits: 0 },
        });
      }
    }
  }
  const inventoryMs = performance.now() - inventoryStarted;
  assert.equal(inventoryIndex, 2 * 4 * 32);

  const queryLatencies = [];
  for (let index = 0; index < 64; index += 1) {
    const started = performance.now();
    await service.createAvailabilityQuery(call({
      queryId: uuid(1_000 + index),
      propertyId: properties[index % 2],
      roomTypeId: roomTypes[index % 4],
      checkInDate: date(index % 27),
      checkOutDate: date((index % 27) + 3),
      units: 1 + (index % 3),
    }, key('query', index)));
    queryLatencies.push(performance.now() - started);
  }

  const holdLatencies = [];
  for (let index = 0; index < 32; index += 1) {
    const started = performance.now();
    await service.createHold(call({
      holdId: uuid(2_000 + index), propertyId: 'property-a', roomTypeId: roomTypes[index % 3],
      checkInDate: date(4 + (index % 16)), checkOutDate: date(6 + (index % 16)),
      units: 1, leaseSeconds: 30,
    }, key('hold', index)));
    holdLatencies.push(performance.now() - started);
  }

  const confirmLatencies = [];
  for (let index = 0; index < 16; index += 1) {
    const started = performance.now();
    await service.confirmHold({
      principal, requestKey: key('confirm', index), holdId: uuid(2_000 + index),
      body: { bookingId: uuid(3_000 + index), expectedHoldRevision: 1 },
    });
    confirmLatencies.push(performance.now() - started);
  }

  const cancelLatencies = [];
  for (let index = 0; index < 8; index += 1) {
    const started = performance.now();
    await service.cancelBooking({
      principal, requestKey: key('cancel', index), bookingId: uuid(3_000 + index),
      body: { expectedBookingRevision: 1 },
    });
    cancelLatencies.push(performance.now() - started);
  }

  for (let index = 0; index < 8; index += 1) {
    await service.createHold(call({
      holdId: uuid(4_000 + index), propertyId: 'property-b', roomTypeId: 'room-c',
      checkInDate: date(20 + (index % 4)), checkOutDate: date(21 + (index % 4)),
      units: 1, leaseSeconds: 1,
    }, key('expiring-hold', index)));
  }
  await service.assignExpiryWorker(call({ workerId: 'reaper-a', expectedGeneration: 0 }, key('assign', 0)));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const reapLatencies = [];
  for (let index = 0; index < 8; index += 1) {
    const started = performance.now();
    const result = await service.reapHold({
      principal, requestKey: key('reap', index), holdId: uuid(4_000 + index),
      body: { workerId: 'reaper-a', expectedGeneration: 1 },
    });
    assert.equal(result.outcome, 'expired');
    reapLatencies.push(performance.now() - started);
  }

  await service.putInventoryDay({
    principal,
    requestKey: key('hot-inventory', 0),
    propertyId: 'property-b',
    roomTypeId: 'room-d',
    stayDate: date(0),
    body: { expectedRevision: 1, capacity: 1, oversellUnits: 0, blockedUnits: 0 },
  });
  const contentionStarted = performance.now();
  const contention = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => service.createHold(call({
    holdId: uuid(5_000 + index), propertyId: 'property-b', roomTypeId: 'room-d',
    checkInDate: date(0), checkOutDate: date(1), units: 1, leaseSeconds: 30,
  }, key('hot-hold', index)))));
  const contentionMs = performance.now() - contentionStarted;
  const winners = contention.filter((result) => result.status === 'fulfilled').length;
  const rejected = contention.filter((result) => result.status === 'rejected'
    && result.reason.code === 'inventory_unavailable').length;
  assert.deepEqual([winners, rejected], [1, 7]);
  const state = await repository.getState();
  assert.equal(state.invariantOk, true);

  process.stdout.write(`${JSON.stringify({
    evidence: 'bounded_synthetic_benchmark',
    runtime: process.version,
    postgresql: (await pool.query('SHOW server_version')).rows[0].server_version,
    fixture: {
      properties: 2,
      roomTypesPerProperty: 4,
      inventoryDays: 256,
      availabilityQueries: 64,
      regularHolds: 32,
      confirmations: 16,
      cancellations: 8,
      expiringHolds: 8,
      reapedHolds: 8,
      finalUnitAttempts: 8,
      finalUnitWinners: winners,
    },
    observations: {
      inventoryRowsPerSecond: round(inventoryIndex / (inventoryMs / 1000)),
      inventoryTotalMs: round(inventoryMs),
      queryP50Ms: round(percentile(queryLatencies, 0.5)),
      queryP95Ms: round(percentile(queryLatencies, 0.95)),
      holdP50Ms: round(percentile(holdLatencies, 0.5)),
      holdP95Ms: round(percentile(holdLatencies, 0.95)),
      confirmP50Ms: round(percentile(confirmLatencies, 0.5)),
      confirmP95Ms: round(percentile(confirmLatencies, 0.95)),
      cancelP50Ms: round(percentile(cancelLatencies, 0.5)),
      reapP50Ms: round(percentile(reapLatencies, 0.5)),
      contentionTotalMs: round(contentionMs),
    },
    exclusions: [
      'catalogue and search ranking',
      'rates, taxes, payment, refund, and ledger',
      'property channel, physical room, check-in, and stay fulfilment',
      'database replication/failover and distributed services',
      'production demand, occupancy, revenue, capacity, cost, and SLA',
    ],
  })}\n`);
} finally {
  await pool.end();
}
