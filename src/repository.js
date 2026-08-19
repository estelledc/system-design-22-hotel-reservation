import { readFile } from 'node:fs/promises';
import {
  bookingNotConfirmed,
  capacityBelowObligation,
  entityConflict,
  holdNotActive,
  idempotencyConflict,
  inventoryGap,
  inventoryRevisionConflict,
  inventoryUnavailable,
  notExpired,
  notFound,
  staleAssignment,
} from './errors.js';
import { evidenceFlags, inventoryAvailable } from './model.js';

const schemaUrl = new URL('../sql/schema.sql', import.meta.url);

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function number(value) {
  return Number(value);
}

export async function initializeDatabase(pool) {
  await pool.query(await readFile(schemaUrl, 'utf8'));
}

export async function resetDatabase(pool) {
  await initializeDatabase(pool);
  await pool.query(`
    TRUNCATE TABLE
      mutation_receipts,
      booking_nights,
      bookings,
      hold_nights,
      holds,
      availability_queries,
      expiry_assignments,
      inventory_days,
      properties
    RESTART IDENTITY CASCADE
  `);
}

export class ReservationRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async #transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #lock(client, value) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [value]);
  }

  async #receipt(client, { principal, requestKey, operation, intentDigest }) {
    await this.#lock(client, `receipt:${principal}:${operation}:${requestKey}`);
    const found = await client.query(`
      SELECT intent_digest, result
      FROM mutation_receipts
      WHERE principal = $1 AND request_key = $2 AND operation = $3
    `, [principal, requestKey, operation]);
    if (!found.rowCount) return null;
    if (found.rows[0].intent_digest !== intentDigest) throw idempotencyConflict();
    return found.rows[0].result;
  }

  async #storeReceipt(client, { principal, requestKey, operation, intentDigest }, result) {
    await client.query(`
      INSERT INTO mutation_receipts (principal, request_key, operation, intent_digest, result)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [principal, requestKey, operation, intentDigest, JSON.stringify(result)]);
  }

  async #inventoryRows(client, request, lock = false) {
    const rows = await client.query(`
      SELECT property_id, room_type_id, stay_date::text AS stay_date,
             capacity, oversell_units, blocked_units, held_units, booked_units, revision
      FROM inventory_days
      WHERE property_id = $1 AND room_type_id = $2 AND stay_date = ANY($3::date[])
      ORDER BY property_id, room_type_id, stay_date
      ${lock ? 'FOR UPDATE' : ''}
    `, [request.propertyId, request.roomTypeId, request.stayDates]);
    if (rows.rowCount !== request.stayDates.length
      || rows.rows.some((row, index) => row.stay_date !== request.stayDates[index])) {
      throw inventoryGap();
    }
    return rows.rows;
  }

  async #holdInventoryRows(client, holdId) {
    const rows = await client.query(`
      SELECT i.property_id, i.room_type_id, i.stay_date::text AS stay_date,
             i.capacity, i.oversell_units, i.blocked_units, i.held_units, i.booked_units, i.revision,
             n.units
      FROM hold_nights n
      JOIN inventory_days i
        ON i.property_id = n.property_id
       AND i.room_type_id = n.room_type_id
       AND i.stay_date = n.stay_date
      WHERE n.hold_id = $1
      ORDER BY i.property_id, i.room_type_id, i.stay_date
      FOR UPDATE OF i
    `, [holdId]);
    if (!rows.rowCount) throw inventoryGap();
    return rows.rows;
  }

  async #bookingInventoryRows(client, bookingId) {
    const rows = await client.query(`
      SELECT i.property_id, i.room_type_id, i.stay_date::text AS stay_date,
             i.capacity, i.oversell_units, i.blocked_units, i.held_units, i.booked_units, i.revision,
             n.units
      FROM booking_nights n
      JOIN inventory_days i
        ON i.property_id = n.property_id
       AND i.room_type_id = n.room_type_id
       AND i.stay_date = n.stay_date
      WHERE n.booking_id = $1
      ORDER BY i.property_id, i.room_type_id, i.stay_date
      FOR UPDATE OF i
    `, [bookingId]);
    if (!rows.rowCount) throw inventoryGap();
    return rows.rows;
  }

  async createProperty(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'create_property';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      await this.#lock(client, `property:${request.propertyId}`);
      const existing = await client.query(
        'SELECT intent_digest, creation_result FROM properties WHERE property_id = $1',
        [request.propertyId],
      );
      if (existing.rowCount) {
        if (existing.rows[0].intent_digest !== request.intentDigest) throw entityConflict('property');
        const result = existing.rows[0].creation_result;
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      const result = {
        propertyId: request.propertyId,
        timezone: request.timezone,
        revision: 1,
        ...evidenceFlags,
      };
      await client.query(`
        INSERT INTO properties (property_id, timezone, intent_digest, creation_result)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [request.propertyId, request.timezone, request.intentDigest, JSON.stringify(result)]);
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async putInventoryDay(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'put_inventory_day';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      const property = await client.query('SELECT 1 FROM properties WHERE property_id = $1', [request.propertyId]);
      if (!property.rowCount) throw notFound('property was not found');
      const current = await client.query(`
        SELECT capacity, oversell_units, blocked_units, held_units, booked_units, revision
        FROM inventory_days
        WHERE property_id = $1 AND room_type_id = $2 AND stay_date = $3::date
        FOR UPDATE
      `, [request.propertyId, request.roomTypeId, request.stayDate]);
      let nextRevision;
      let heldUnits = 0;
      let bookedUnits = 0;
      if (!current.rowCount) {
        if (request.expectedRevision !== 0) throw inventoryRevisionConflict(0);
        nextRevision = 1;
      } else {
        const row = current.rows[0];
        if (number(row.revision) !== request.expectedRevision) throw inventoryRevisionConflict(number(row.revision));
        heldUnits = number(row.held_units);
        bookedUnits = number(row.booked_units);
        nextRevision = number(row.revision) + 1;
      }
      if (heldUnits + bookedUnits + request.blockedUnits > request.capacity + request.oversellUnits) {
        throw capacityBelowObligation();
      }
      if (!current.rowCount) {
        await client.query(`
          INSERT INTO inventory_days (
            property_id, room_type_id, stay_date, capacity, oversell_units, blocked_units, revision
          ) VALUES ($1, $2, $3::date, $4, $5, $6, $7)
        `, [
          request.propertyId, request.roomTypeId, request.stayDate,
          request.capacity, request.oversellUnits, request.blockedUnits, nextRevision,
        ]);
      } else {
        await client.query(`
          UPDATE inventory_days
          SET capacity = $4, oversell_units = $5, blocked_units = $6,
              revision = $7, updated_at = statement_timestamp()
          WHERE property_id = $1 AND room_type_id = $2 AND stay_date = $3::date
        `, [
          request.propertyId, request.roomTypeId, request.stayDate,
          request.capacity, request.oversellUnits, request.blockedUnits, nextRevision,
        ]);
      }
      const result = {
        propertyId: request.propertyId,
        roomTypeId: request.roomTypeId,
        stayDate: request.stayDate,
        capacity: request.capacity,
        oversellUnits: request.oversellUnits,
        blockedUnits: request.blockedUnits,
        heldUnits,
        bookedUnits,
        availableUnits: request.capacity + request.oversellUnits - request.blockedUnits - heldUnits - bookedUnits,
        revision: nextRevision,
        ...evidenceFlags,
      };
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async createAvailabilityQuery(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'create_availability_query';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      await this.#lock(client, `availability:${request.queryId}`);
      const existing = await client.query(
        'SELECT intent_digest, result FROM availability_queries WHERE query_id = $1',
        [request.queryId],
      );
      if (existing.rowCount) {
        if (existing.rows[0].intent_digest !== request.intentDigest) throw entityConflict('availability query');
        const result = existing.rows[0].result;
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      const rows = await this.#inventoryRows(client, request);
      const nights = rows.map((row) => ({
        stayDate: row.stay_date,
        availableUnits: inventoryAvailable(row),
        inventoryRevision: number(row.revision),
      }));
      const minimumAvailable = Math.min(...nights.map((row) => row.availableUnits));
      const result = {
        queryId: request.queryId,
        propertyId: request.propertyId,
        roomTypeId: request.roomTypeId,
        checkInDate: request.checkInDate,
        checkOutDate: request.checkOutDate,
        requestedUnits: request.units,
        minimumAvailable,
        canHold: minimumAvailable >= request.units,
        nights,
        ownershipProved: false,
        ...evidenceFlags,
      };
      await client.query(`
        INSERT INTO availability_queries (query_id, principal, intent_digest, result)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [request.queryId, envelope.principal, request.intentDigest, JSON.stringify(result)]);
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async getAvailabilityQuery(queryId) {
    const found = await this.pool.query('SELECT result FROM availability_queries WHERE query_id = $1', [queryId]);
    if (!found.rowCount) throw notFound('availability query was not found');
    return found.rows[0].result;
  }

  async createHold(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'create_hold';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      await this.#lock(client, `hold:${request.holdId}`);
      const existing = await client.query(
        'SELECT intent_digest, creation_result FROM holds WHERE hold_id = $1',
        [request.holdId],
      );
      if (existing.rowCount) {
        if (existing.rows[0].intent_digest !== request.intentDigest) throw entityConflict('hold');
        const result = existing.rows[0].creation_result;
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      const rows = await this.#inventoryRows(client, request, true);
      if (rows.some((row) => inventoryAvailable(row) < request.units)) throw inventoryUnavailable();
      const clock = await client.query(`
        SELECT statement_timestamp() AS created_at,
               statement_timestamp() + ($1 * interval '1 second') AS expires_at
      `, [request.leaseSeconds]);
      const createdAt = iso(clock.rows[0].created_at);
      const expiresAt = iso(clock.rows[0].expires_at);
      const result = {
        holdId: request.holdId,
        state: 'active',
        revision: 1,
        propertyId: request.propertyId,
        roomTypeId: request.roomTypeId,
        checkInDate: request.checkInDate,
        checkOutDate: request.checkOutDate,
        units: request.units,
        createdAt,
        expiresAt,
        inventoryOwnershipProved: true,
        ...evidenceFlags,
      };
      await client.query(`
        INSERT INTO holds (
          hold_id, property_id, room_type_id, check_in_date, check_out_date, units, lease_seconds,
          intent_digest, state, revision, created_at, expires_at, creation_result
        ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, 'active', 1, $9, $10, $11::jsonb)
      `, [
        request.holdId, request.propertyId, request.roomTypeId, request.checkInDate, request.checkOutDate,
        request.units, request.leaseSeconds, request.intentDigest, createdAt, expiresAt, JSON.stringify(result),
      ]);
      await client.query(`
        INSERT INTO hold_nights (hold_id, property_id, room_type_id, stay_date, units)
        SELECT $1, $2, $3, unnest($4::date[]), $5
      `, [request.holdId, request.propertyId, request.roomTypeId, request.stayDates, request.units]);
      const updated = await client.query(`
        UPDATE inventory_days
        SET held_units = held_units + $4, revision = revision + 1, updated_at = statement_timestamp()
        WHERE property_id = $1 AND room_type_id = $2 AND stay_date = ANY($3::date[])
      `, [request.propertyId, request.roomTypeId, request.stayDates, request.units]);
      if (updated.rowCount !== request.stayDates.length) throw inventoryGap();
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async confirmHold(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'confirm_hold';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      await this.#lock(client, `booking:${request.bookingId}`);
      const priorBooking = await client.query(
        'SELECT intent_digest, creation_result FROM bookings WHERE booking_id = $1',
        [request.bookingId],
      );
      if (priorBooking.rowCount) {
        if (priorBooking.rows[0].intent_digest !== request.intentDigest) throw entityConflict('booking');
        const result = priorBooking.rows[0].creation_result;
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      const selected = await client.query(`
        SELECT hold_id, property_id, room_type_id, check_in_date::text, check_out_date::text,
               units, state, revision, expires_at, statement_timestamp() AS decision_time
        FROM holds WHERE hold_id = $1 FOR UPDATE
      `, [request.holdId]);
      if (!selected.rowCount) throw notFound('hold was not found');
      const hold = selected.rows[0];
      if (hold.state === 'converted') {
        const booking = await client.query(
          'SELECT booking_id, intent_digest, creation_result FROM bookings WHERE hold_id = $1',
          [request.holdId],
        );
        if (booking.rowCount && booking.rows[0].booking_id === request.bookingId
          && booking.rows[0].intent_digest === request.intentDigest) {
          const result = booking.rows[0].creation_result;
          await this.#storeReceipt(client, { ...envelope, operation }, result);
          return result;
        }
        throw holdNotActive();
      }
      if (hold.state !== 'active' || number(hold.revision) !== request.expectedHoldRevision) throw holdNotActive();
      const inventory = await this.#holdInventoryRows(client, request.holdId);
      const decisionTime = iso(hold.decision_time);
      if (new Date(decisionTime).getTime() >= new Date(hold.expires_at).getTime()) {
        await client.query(`
          UPDATE inventory_days i
          SET held_units = i.held_units - n.units,
              revision = i.revision + 1,
              updated_at = statement_timestamp()
          FROM hold_nights n
          WHERE n.hold_id = $1
            AND i.property_id = n.property_id
            AND i.room_type_id = n.room_type_id
            AND i.stay_date = n.stay_date
        `, [request.holdId]);
        const revision = number(hold.revision) + 1;
        await client.query("UPDATE holds SET state = 'expired', revision = $2 WHERE hold_id = $1", [request.holdId, revision]);
        const result = {
          outcome: 'expired', holdId: request.holdId, state: 'expired', revision, decisionTime,
          releasedNights: inventory.length, inventoryOwnershipProved: false, ...evidenceFlags,
        };
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      await client.query(`
        UPDATE inventory_days i
        SET held_units = i.held_units - n.units,
            booked_units = i.booked_units + n.units,
            revision = i.revision + 1,
            updated_at = statement_timestamp()
        FROM hold_nights n
        WHERE n.hold_id = $1
          AND i.property_id = n.property_id
          AND i.room_type_id = n.room_type_id
          AND i.stay_date = n.stay_date
      `, [request.holdId]);
      const result = {
        outcome: 'confirmed',
        bookingId: request.bookingId,
        bookingState: 'confirmed',
        bookingRevision: 1,
        holdId: request.holdId,
        holdRevision: number(hold.revision) + 1,
        propertyId: hold.property_id,
        roomTypeId: hold.room_type_id,
        checkInDate: hold.check_in_date,
        checkOutDate: hold.check_out_date,
        units: number(hold.units),
        confirmedAt: decisionTime,
        inventoryOwnershipProved: true,
        ...evidenceFlags,
      };
      await client.query(`
        INSERT INTO bookings (
          booking_id, hold_id, property_id, room_type_id, check_in_date, check_out_date, units,
          intent_digest, state, revision, created_at, updated_at, creation_result
        ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, 'confirmed', 1, $9, $9, $10::jsonb)
      `, [
        request.bookingId, request.holdId, hold.property_id, hold.room_type_id,
        hold.check_in_date, hold.check_out_date, hold.units, request.intentDigest, decisionTime, JSON.stringify(result),
      ]);
      await client.query(`
        INSERT INTO booking_nights (booking_id, property_id, room_type_id, stay_date, units)
        SELECT $1, property_id, room_type_id, stay_date, units FROM hold_nights WHERE hold_id = $2
      `, [request.bookingId, request.holdId]);
      await client.query("UPDATE holds SET state = 'converted', revision = revision + 1 WHERE hold_id = $1", [request.holdId]);
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async assignExpiryWorker(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'assign_expiry_worker';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      const current = await client.query(
        'SELECT worker_id, generation FROM expiry_assignments WHERE shard_id = 0 FOR UPDATE',
      );
      const generation = current.rowCount ? number(current.rows[0].generation) : 0;
      if (generation !== request.expectedGeneration) throw staleAssignment(generation);
      const nextGeneration = generation + 1;
      await client.query(`
        INSERT INTO expiry_assignments (shard_id, worker_id, generation)
        VALUES (0, $1, $2)
        ON CONFLICT (shard_id) DO UPDATE
        SET worker_id = EXCLUDED.worker_id, generation = EXCLUDED.generation,
            updated_at = statement_timestamp()
      `, [request.workerId, nextGeneration]);
      const result = { shardId: 0, workerId: request.workerId, generation: nextGeneration, ...evidenceFlags };
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async reapHold(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'reap_hold';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      const selected = await client.query(`
        SELECT hold_id, state, revision, expires_at, statement_timestamp() AS decision_time
        FROM holds WHERE hold_id = $1 FOR UPDATE
      `, [request.holdId]);
      if (!selected.rowCount) throw notFound('hold was not found');
      const assignment = await client.query(
        'SELECT worker_id, generation FROM expiry_assignments WHERE shard_id = 0 FOR UPDATE',
      );
      const currentGeneration = assignment.rowCount ? number(assignment.rows[0].generation) : 0;
      if (!assignment.rowCount || assignment.rows[0].worker_id !== request.workerId
        || currentGeneration !== request.expectedGeneration) {
        throw staleAssignment(currentGeneration);
      }
      const hold = selected.rows[0];
      if (hold.state !== 'active') {
        const result = {
          outcome: 'terminal', holdId: request.holdId, state: hold.state,
          revision: number(hold.revision), releasedNights: 0, ...evidenceFlags,
        };
        await this.#storeReceipt(client, { ...envelope, operation }, result);
        return result;
      }
      const decisionTime = iso(hold.decision_time);
      if (new Date(decisionTime).getTime() < new Date(hold.expires_at).getTime()) throw notExpired();
      const inventory = await this.#holdInventoryRows(client, request.holdId);
      await client.query(`
        UPDATE inventory_days i
        SET held_units = i.held_units - n.units,
            revision = i.revision + 1,
            updated_at = statement_timestamp()
        FROM hold_nights n
        WHERE n.hold_id = $1
          AND i.property_id = n.property_id
          AND i.room_type_id = n.room_type_id
          AND i.stay_date = n.stay_date
      `, [request.holdId]);
      const revision = number(hold.revision) + 1;
      await client.query("UPDATE holds SET state = 'expired', revision = $2 WHERE hold_id = $1", [request.holdId, revision]);
      const result = {
        outcome: 'expired', holdId: request.holdId, state: 'expired', revision,
        releasedNights: inventory.length, decisionTime, ...evidenceFlags,
      };
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async cancelBooking(envelope) {
    return this.#transaction(async (client) => {
      const operation = 'cancel_booking';
      const prior = await this.#receipt(client, { ...envelope, operation });
      if (prior) return prior;
      const request = envelope.request;
      const selected = await client.query(`
        SELECT booking_id, state, revision, statement_timestamp() AS decision_time
        FROM bookings WHERE booking_id = $1 FOR UPDATE
      `, [request.bookingId]);
      if (!selected.rowCount) throw notFound('booking was not found');
      const booking = selected.rows[0];
      if (booking.state !== 'confirmed' || number(booking.revision) !== request.expectedBookingRevision) {
        throw bookingNotConfirmed();
      }
      const inventory = await this.#bookingInventoryRows(client, request.bookingId);
      await client.query(`
        UPDATE inventory_days i
        SET booked_units = i.booked_units - n.units,
            revision = i.revision + 1,
            updated_at = statement_timestamp()
        FROM booking_nights n
        WHERE n.booking_id = $1
          AND i.property_id = n.property_id
          AND i.room_type_id = n.room_type_id
          AND i.stay_date = n.stay_date
      `, [request.bookingId]);
      const revision = number(booking.revision) + 1;
      const cancelledAt = iso(booking.decision_time);
      await client.query(`
        UPDATE bookings SET state = 'cancelled', revision = $2, updated_at = $3
        WHERE booking_id = $1
      `, [request.bookingId, revision, cancelledAt]);
      const result = {
        bookingId: request.bookingId,
        bookingState: 'cancelled',
        bookingRevision: revision,
        releasedNights: inventory.length,
        cancelledAt,
        inventoryOwnershipProved: false,
        ...evidenceFlags,
      };
      await this.#storeReceipt(client, { ...envelope, operation }, result);
      return result;
    });
  }

  async getState() {
    const [inventory, holds, bookings] = await Promise.all([
      this.pool.query(`
        SELECT COUNT(*)::integer AS inventory_days,
               COUNT(*) FILTER (WHERE held_units + booked_units + blocked_units > capacity + oversell_units)::integer
                 AS invariant_violations,
               COALESCE(SUM(held_units), 0)::integer AS held_units,
               COALESCE(SUM(booked_units), 0)::integer AS booked_units
        FROM inventory_days
      `),
      this.pool.query(`
        SELECT COUNT(*) FILTER (WHERE state = 'active')::integer AS active,
               COUNT(*) FILTER (WHERE state = 'converted')::integer AS converted,
               COUNT(*) FILTER (WHERE state = 'expired')::integer AS expired,
               EXTRACT(EPOCH FROM statement_timestamp() - MIN(created_at) FILTER (WHERE state = 'active')) AS oldest_active_seconds
        FROM holds
      `),
      this.pool.query(`
        SELECT COUNT(*) FILTER (WHERE state = 'confirmed')::integer AS confirmed,
               COUNT(*) FILTER (WHERE state = 'cancelled')::integer AS cancelled
        FROM bookings
      `),
    ]);
    return {
      inventoryDays: inventory.rows[0].inventory_days,
      invariantViolations: inventory.rows[0].invariant_violations,
      heldUnits: inventory.rows[0].held_units,
      bookedUnits: inventory.rows[0].booked_units,
      holds: {
        active: holds.rows[0].active,
        converted: holds.rows[0].converted,
        expired: holds.rows[0].expired,
        oldestActiveSeconds: holds.rows[0].oldest_active_seconds === null
          ? null : Math.max(0, Math.round(Number(holds.rows[0].oldest_active_seconds) * 1000) / 1000),
      },
      bookings: bookings.rows[0],
      invariantOk: inventory.rows[0].invariant_violations === 0,
      ...evidenceFlags,
    };
  }
}
