import { sha256 } from './crypto.js';
import { invalid } from './errors.js';
import { enumerateStayDates, parseCanonicalDate } from './model.js';

export const limits = Object.freeze({
  requestBodyBytes: 64 * 1024,
  requestKeyChars: 80,
  slugChars: 32,
  maximumNights: 14,
  maximumUnits: 5,
  maximumLeaseSeconds: 300,
});

const slugPattern = /^[a-z][a-z0-9-]{2,31}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timezones = new Set(['Etc/UTC', 'America/New_York', 'Europe/Paris', 'Asia/Tokyo']);

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(`${name} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, expected, name) {
  plainObject(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(`${name} must contain exactly: ${wanted.join(', ')}`);
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function validateSlug(value, name = 'identifier') {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limits.slugChars || !slugPattern.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

export function validateUuid(value, name = 'id') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(`${name} must be a canonical UUID`);
  return value;
}

export function validateRequestKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > limits.requestKeyChars
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(value)) {
    throw invalid('Idempotency-Key is invalid');
  }
  return value;
}

export function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('canonical JSON cannot contain NaN or infinity');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  plainObject(value, 'canonical value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function digestValue(value) {
  return sha256(Buffer.from(`${canonicalStringify(value)}\n`, 'utf8'));
}

function stay(body, name) {
  const checkInDate = parseCanonicalDate(body.checkInDate, `${name}.checkInDate`);
  const checkOutDate = parseCanonicalDate(body.checkOutDate, `${name}.checkOutDate`);
  const stayDates = enumerateStayDates(checkInDate, checkOutDate, limits.maximumNights);
  return { checkInDate, checkOutDate, stayDates };
}

function withDigest(request) {
  return { ...request, intentDigest: digestValue(request) };
}

export function normalizeProperty(body) {
  exactKeys(body, ['propertyId', 'timezone'], 'property body');
  if (typeof body.timezone !== 'string' || !timezones.has(body.timezone)) throw invalid('timezone is not supported');
  return withDigest({ propertyId: validateSlug(body.propertyId, 'propertyId'), timezone: body.timezone });
}

export function normalizeInventoryMutation({ propertyId, roomTypeId, stayDate, body }) {
  exactKeys(body, ['expectedRevision', 'capacity', 'oversellUnits', 'blockedUnits'], 'inventory body');
  return withDigest({
    propertyId: validateSlug(propertyId, 'propertyId'),
    roomTypeId: validateSlug(roomTypeId, 'roomTypeId'),
    stayDate: parseCanonicalDate(stayDate, 'stayDate'),
    expectedRevision: integer(body.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    capacity: integer(body.capacity, 'capacity', 0, 10_000),
    oversellUnits: integer(body.oversellUnits, 'oversellUnits', 0, 1_000),
    blockedUnits: integer(body.blockedUnits, 'blockedUnits', 0, 10_000),
  });
}

export function normalizeAvailability(body) {
  exactKeys(body, ['queryId', 'propertyId', 'roomTypeId', 'checkInDate', 'checkOutDate', 'units'], 'availability body');
  return withDigest({
    queryId: validateUuid(body.queryId, 'queryId'),
    propertyId: validateSlug(body.propertyId, 'propertyId'),
    roomTypeId: validateSlug(body.roomTypeId, 'roomTypeId'),
    ...stay(body, 'availability'),
    units: integer(body.units, 'units', 1, limits.maximumUnits),
  });
}

export function normalizeHold(body) {
  exactKeys(
    body,
    ['holdId', 'propertyId', 'roomTypeId', 'checkInDate', 'checkOutDate', 'units', 'leaseSeconds'],
    'hold body',
  );
  return withDigest({
    holdId: validateUuid(body.holdId, 'holdId'),
    propertyId: validateSlug(body.propertyId, 'propertyId'),
    roomTypeId: validateSlug(body.roomTypeId, 'roomTypeId'),
    ...stay(body, 'hold'),
    units: integer(body.units, 'units', 1, limits.maximumUnits),
    leaseSeconds: integer(body.leaseSeconds, 'leaseSeconds', 1, limits.maximumLeaseSeconds),
  });
}

export function normalizeConfirm(holdId, body) {
  exactKeys(body, ['bookingId', 'expectedHoldRevision'], 'confirm body');
  return withDigest({
    holdId: validateUuid(holdId, 'holdId'),
    bookingId: validateUuid(body.bookingId, 'bookingId'),
    expectedHoldRevision: integer(body.expectedHoldRevision, 'expectedHoldRevision', 1, Number.MAX_SAFE_INTEGER),
  });
}

export function normalizeAssignment(body) {
  exactKeys(body, ['workerId', 'expectedGeneration'], 'assignment body');
  return withDigest({
    shardId: 0,
    workerId: validateSlug(body.workerId, 'workerId'),
    expectedGeneration: integer(body.expectedGeneration, 'expectedGeneration', 0, Number.MAX_SAFE_INTEGER),
  });
}

export function normalizeReap(holdId, body) {
  exactKeys(body, ['workerId', 'expectedGeneration'], 'reap body');
  return withDigest({
    holdId: validateUuid(holdId, 'holdId'),
    shardId: 0,
    workerId: validateSlug(body.workerId, 'workerId'),
    expectedGeneration: integer(body.expectedGeneration, 'expectedGeneration', 1, Number.MAX_SAFE_INTEGER),
  });
}

export function normalizeCancel(bookingId, body) {
  exactKeys(body, ['expectedBookingRevision'], 'cancel body');
  return withDigest({
    bookingId: validateUuid(bookingId, 'bookingId'),
    expectedBookingRevision: integer(body.expectedBookingRevision, 'expectedBookingRevision', 1, Number.MAX_SAFE_INTEGER),
  });
}
