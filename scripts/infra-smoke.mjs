import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initializeDatabase, resetDatabase } from '../src/repository.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; infrastructure smoke never skips');

const root = fileURLToPath(new URL('..', import.meta.url));
const apiToken = 'synthetic-smoke-token-0001';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, statement_timeout: 10_000 });
const children = new Set();
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function exitReceipt(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/main.js', 'serve'], {
    cwd: root,
    env: { ...process.env, HOTEL_API_TOKEN: apiToken, PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => reject(new Error(
      `server exited before readiness: code=${code} signal=${signal} stderr=${stderr}`,
    ));
    child.once('exit', onExit);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.event === 'hotel_reservation_ready') {
          child.off('exit', onExit);
          resolve({ child, base: `http://127.0.0.1:${event.port}` });
        }
      }
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitReceipt(child);
  child.kill('SIGTERM');
  await exited;
}

async function request(base, method, path, body, { key, expected } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function crashRequest(server, method, path, body, key) {
  const exited = exitReceipt(server.child);
  await assert.rejects(fetch(`${server.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  }));
  const receipt = await exited;
  assert.equal(receipt.signal, 'SIGKILL');
  return receipt;
}

const stay = {
  propertyId: 'property-a', roomTypeId: 'room-a',
  checkInDate: '2027-03-13', checkOutDate: '2027-03-16', units: 1,
};

let api;
try {
  await initializeDatabase(pool);
  await resetDatabase(pool);

  const holdCrashApi = await startServer({ HOTEL_CRASH_AFTER_HOLD_COMMIT: '1' });
  await request(holdCrashApi.base, 'POST', '/v1/properties', {
    propertyId: 'property-a', timezone: 'America/New_York',
  }, { key: 'smoke-property-0001', expected: 201 });
  for (const [index, date] of ['2027-03-13', '2027-03-14', '2027-03-15'].entries()) {
    await request(holdCrashApi.base, 'PUT', `/v1/inventory-days/property-a/room-a/${date}`, {
      expectedRevision: 0, capacity: 2, oversellUnits: 0, blockedUnits: 0,
    }, { key: `smoke-inventory-${String(index).padStart(4, '0')}`, expected: 200 });
  }
  const firstHold = { holdId: uuid(1), ...stay, leaseSeconds: 30 };
  const holdCrash = await crashRequest(
    holdCrashApi, 'POST', '/v1/holds', firstHold, 'smoke-hold-0000001',
  );

  api = await startServer();
  let replay = await request(api.base, 'POST', '/v1/holds', firstHold, {
    key: 'smoke-hold-0000001', expected: 201,
  });
  assert.equal(replay.revision, 1);
  assert.equal(replay.state, 'active');

  await stop(api.child);
  const bookingCrashApi = await startServer({ HOTEL_CRASH_AFTER_BOOKING_COMMIT: '1' });
  const confirmBody = { bookingId: uuid(2), expectedHoldRevision: 1 };
  const bookingCrash = await crashRequest(
    bookingCrashApi, 'POST', `/v1/holds/${uuid(1)}/confirm`, confirmBody, 'smoke-confirm-0001',
  );

  api = await startServer();
  replay = await request(api.base, 'POST', `/v1/holds/${uuid(1)}/confirm`, confirmBody, {
    key: 'smoke-confirm-0001', expected: 201,
  });
  assert.equal(replay.bookingRevision, 1);
  assert.equal(replay.bookingState, 'confirmed');

  const expiringHold = { holdId: uuid(3), ...stay, leaseSeconds: 1 };
  await request(api.base, 'POST', '/v1/holds', expiringHold, { key: 'smoke-hold-0000003', expected: 201 });
  await request(api.base, 'POST', '/v1/expiry-assignments/0', {
    workerId: 'reaper-a', expectedGeneration: 0,
  }, { key: 'smoke-assign-0001', expected: 201 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await stop(api.child);
  const reapCrashApi = await startServer({ HOTEL_CRASH_AFTER_REAP_COMMIT: '1' });
  const reapCrash = await crashRequest(reapCrashApi, 'POST', `/v1/holds/${uuid(3)}/reap`, {
    workerId: 'reaper-a', expectedGeneration: 1,
  }, 'smoke-reap-0000001');

  api = await startServer();
  replay = await request(api.base, 'POST', `/v1/holds/${uuid(3)}/reap`, {
    workerId: 'reaper-a', expectedGeneration: 1,
  }, { key: 'smoke-reap-0000001', expected: 200 });
  assert.equal(replay.state, 'expired');
  assert.equal(replay.revision, 2);

  const cancellableHold = { holdId: uuid(4), ...stay, leaseSeconds: 30 };
  await request(api.base, 'POST', '/v1/holds', cancellableHold, {
    key: 'smoke-hold-0000004', expected: 201,
  });
  await request(api.base, 'POST', `/v1/holds/${uuid(4)}/confirm`, {
    bookingId: uuid(5), expectedHoldRevision: 1,
  }, { key: 'smoke-confirm-0005', expected: 201 });
  await stop(api.child);
  const cancelCrashApi = await startServer({ HOTEL_CRASH_AFTER_CANCEL_COMMIT: '1' });
  const cancelCrash = await crashRequest(cancelCrashApi, 'POST', `/v1/bookings/${uuid(5)}/cancel`, {
    expectedBookingRevision: 1,
  }, 'smoke-cancel-0001');

  api = await startServer();
  replay = await request(api.base, 'POST', `/v1/bookings/${uuid(5)}/cancel`, {
    expectedBookingRevision: 1,
  }, { key: 'smoke-cancel-0001', expected: 200 });
  assert.equal(replay.bookingState, 'cancelled');
  assert.equal(replay.bookingRevision, 2);
  const state = await request(api.base, 'GET', '/v1/state', undefined, { expected: 200 });
  assert.equal(state.invariantOk, true);
  assert.equal(state.heldUnits, 0);
  assert.equal(state.bookedUnits, 3);
  assert.deepEqual(state.holds, {
    active: 0, converted: 2, expired: 1, oldestActiveSeconds: null,
  });
  assert.deepEqual(state.bookings, { confirmed: 1, cancelled: 1 });

  process.stdout.write(`${JSON.stringify({
    evidence: 'true_process_crash_recovery',
    killedProcesses: [holdCrash.signal, bookingCrash.signal, reapCrash.signal, cancelCrash.signal],
    holdReplayRevision: 1,
    bookingReplayRevision: 1,
    reapReplayRevision: 2,
    cancellationReplayRevision: 2,
    finalHeldUnits: state.heldUnits,
    finalBookedUnits: state.bookedUnits,
    paymentAuthorized: state.paymentAuthorized,
    paymentCaptured: state.paymentCaptured,
    propertyAccepted: state.propertyAccepted,
    physicalRoomAssigned: state.physicalRoomAssigned,
    checkedIn: state.checkedIn,
    stayCompleted: state.stayCompleted,
    externalAcceptanceProved: state.externalAcceptanceProved,
  })}\n`);
} finally {
  await Promise.all([...children].map((child) => stop(child)));
  await pool.end();
}
