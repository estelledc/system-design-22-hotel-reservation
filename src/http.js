import { createServer } from 'node:http';
import { equalHex, sha256 } from './crypto.js';
import { limits, validateSlug, validateUuid } from './contracts.js';
import { invalid, notFound, ReservationError, unauthorized } from './errors.js';
import { parseCanonicalDate } from './model.js';

export async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw invalid('Content-Type must be application/json');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limits.requestBodyBytes) throw invalid('request body is too large');
    chunks.push(chunk);
  }
  if (!bytes) throw invalid('JSON request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalid('request body must be valid JSON');
  }
}

export function writeJson(response, status, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': bytes.length,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(bytes);
}

export function authorize(request, expectedToken, principal = 'synthetic-client') {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw unauthorized();
  const candidate = authorization.slice('Bearer '.length);
  if (!candidate.length || !equalHex(sha256(candidate), sha256(expectedToken))) throw unauthorized();
  return principal;
}

function requiredHeader(request, name) {
  const value = request.headers[name.toLowerCase()];
  if (typeof value !== 'string' || !value.length) throw invalid(`${name} header is required`);
  return value;
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid('path segment is invalid');
  }
}

export function writeError(response, error, logger) {
  const known = error instanceof ReservationError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'internal_error';
  logger({ event: 'request_failed', status, reasonCode: code });
  writeJson(response, status, {
    error: {
      code,
      message: known ? error.message : 'internal server error',
      retryable: known ? error.retryable : true,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

export function createReservationServer({ service, repository, apiToken, logger = () => {} }) {
  if (typeof apiToken !== 'string' || apiToken.length < 16) {
    throw new Error('HOTEL_API_TOKEN must contain at least 16 characters');
  }
  return createServer(async (request, response) => {
    const started = performance.now();
    try {
      const url = new URL(request.url, 'http://hotel-reservation.invalid');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      const principal = authorize(request, apiToken);
      const mutation = (extra = {}) => ({
        principal,
        requestKey: requiredHeader(request, 'Idempotency-Key'),
        ...extra,
      });
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        writeJson(response, 200, await repository.getState());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/properties') {
        writeJson(response, 201, await service.createProperty(mutation({ body: await readJson(request) })));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/availability-queries') {
        writeJson(response, 201, await service.createAvailabilityQuery(mutation({ body: await readJson(request) })));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/holds') {
        writeJson(response, 201, await service.createHold(mutation({ body: await readJson(request) })));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/expiry-assignments/0') {
        writeJson(response, 201, await service.assignExpiryWorker(mutation({ body: await readJson(request) })));
        return;
      }
      let match = url.pathname.match(
        /^\/v1\/inventory-days\/([a-z][a-z0-9-]{2,31})\/([a-z][a-z0-9-]{2,31})\/(\d{4}-\d{2}-\d{2})$/,
      );
      if (request.method === 'PUT' && match) {
        writeJson(response, 200, await service.putInventoryDay(mutation({
          propertyId: validateSlug(decodeSegment(match[1]), 'propertyId'),
          roomTypeId: validateSlug(decodeSegment(match[2]), 'roomTypeId'),
          stayDate: parseCanonicalDate(decodeSegment(match[3]), 'stayDate'),
          body: await readJson(request),
        })));
        return;
      }
      match = url.pathname.match(
        /^\/v1\/availability-queries\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
      );
      if (request.method === 'GET' && match) {
        writeJson(response, 200, await repository.getAvailabilityQuery(validateUuid(match[1], 'queryId')));
        return;
      }
      match = url.pathname.match(
        /^\/v1\/holds\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/confirm$/,
      );
      if (request.method === 'POST' && match) {
        writeJson(response, 201, await service.confirmHold(mutation({
          holdId: validateUuid(match[1], 'holdId'), body: await readJson(request),
        })));
        return;
      }
      match = url.pathname.match(
        /^\/v1\/holds\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/reap$/,
      );
      if (request.method === 'POST' && match) {
        writeJson(response, 200, await service.reapHold(mutation({
          holdId: validateUuid(match[1], 'holdId'), body: await readJson(request),
        })));
        return;
      }
      match = url.pathname.match(
        /^\/v1\/bookings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/cancel$/,
      );
      if (request.method === 'POST' && match) {
        writeJson(response, 200, await service.cancelBooking(mutation({
          bookingId: validateUuid(match[1], 'bookingId'), body: await readJson(request),
        })));
        return;
      }
      throw notFound();
    } catch (error) {
      writeError(response, error, logger);
    } finally {
      logger({ event: 'request_finished', durationMs: Math.round((performance.now() - started) * 1000) / 1000 });
    }
  });
}
