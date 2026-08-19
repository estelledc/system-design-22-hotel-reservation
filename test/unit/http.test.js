import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createReservationServer } from '../../src/http.js';

const token = 'unit-test-token-0001';
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

async function withServer(run) {
  const calls = [];
  const result = { ok: true };
  const service = Object.fromEntries([
    'createProperty', 'putInventoryDay', 'createAvailabilityQuery', 'createHold',
    'confirmHold', 'assignExpiryWorker', 'reapHold', 'cancelBooking',
  ].map((name) => [name, async (value) => { calls.push([name, value]); return result; }]));
  const repository = {
    getState: async () => ({ invariantOk: true }),
    getAvailabilityQuery: async (id) => ({ queryId: id }),
  };
  const logs = [];
  const server = createReservationServer({ service, repository, apiToken: token, logger: (entry) => logs.push(entry) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run({ base: `http://127.0.0.1:${server.address().port}`, calls, logs });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function options(method, body, key = 'request-0001') {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('health is public while state requires authentication', async () => withServer(async ({ base }) => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/state`)).status, 401);
  assert.equal((await fetch(`${base}/v1/state`, options('GET', undefined, null))).status, 200);
}));

test('property and inventory routes preserve exact body and path fields', async () => withServer(async ({ base, calls }) => {
  const property = { propertyId: 'property-a', timezone: 'Etc/UTC' };
  assert.equal((await fetch(`${base}/v1/properties`, options('POST', property))).status, 201);
  const inventory = { expectedRevision: 0, capacity: 2, oversellUnits: 0, blockedUnits: 0 };
  assert.equal((await fetch(
    `${base}/v1/inventory-days/property-a/room-a/2027-03-13`, options('PUT', inventory, 'request-0002'),
  )).status, 200);
  assert.equal(calls[0][0], 'createProperty');
  assert.deepEqual(calls[0][1].body, property);
  assert.equal(calls[1][1].stayDate, '2027-03-13');
  assert.deepEqual(calls[1][1].body, inventory);
}));

test('availability and hold lifecycle routes are exact', async () => withServer(async ({ base, calls }) => {
  const queryId = uuid(1);
  const holdId = uuid(2);
  const bookingId = uuid(3);
  const stay = {
    propertyId: 'property-a', roomTypeId: 'room-a', checkInDate: '2027-03-13',
    checkOutDate: '2027-03-14', units: 1,
  };
  await fetch(`${base}/v1/availability-queries`, options('POST', { queryId, ...stay }, 'request-0010'));
  assert.equal((await fetch(`${base}/v1/availability-queries/${queryId}`, options('GET', undefined, null))).status, 200);
  await fetch(`${base}/v1/holds`, options('POST', { holdId, ...stay, leaseSeconds: 30 }, 'request-0011'));
  await fetch(`${base}/v1/holds/${holdId}/confirm`, options(
    'POST', { bookingId, expectedHoldRevision: 1 }, 'request-0012',
  ));
  await fetch(`${base}/v1/expiry-assignments/0`, options(
    'POST', { workerId: 'reaper-a', expectedGeneration: 0 }, 'request-0013',
  ));
  await fetch(`${base}/v1/holds/${holdId}/reap`, options(
    'POST', { workerId: 'reaper-a', expectedGeneration: 1 }, 'request-0014',
  ));
  await fetch(`${base}/v1/bookings/${bookingId}/cancel`, options(
    'POST', { expectedBookingRevision: 1 }, 'request-0015',
  ));
  assert.deepEqual(calls.map(([name]) => name), [
    'createAvailabilityQuery', 'createHold', 'confirmHold', 'assignExpiryWorker', 'reapHold', 'cancelBooking',
  ]);
}));

test('request logs omit paths, tokens, identities, dates, and bodies', async () => withServer(async ({ base, logs }) => {
  const queryId = uuid(9);
  await fetch(`${base}/v1/availability-queries/${queryId}`, options('GET', undefined, null));
  const serialized = JSON.stringify(logs);
  for (const forbidden of [token, queryId, '/v1/', '2027-', 'property-a']) assert.ok(!serialized.includes(forbidden));
}));

test('state-changing routes reject a non-JSON media type', async () => withServer(async ({ base }) => {
  const response = await fetch(`${base}/v1/properties`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/plain',
      'idempotency-key': 'request-plain-0001',
    },
    body: '{}',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_request');
}));
