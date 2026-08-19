import process from 'node:process';
import {
  normalizeAssignment,
  normalizeAvailability,
  normalizeCancel,
  normalizeConfirm,
  normalizeHold,
  normalizeInventoryMutation,
  normalizeProperty,
  normalizeReap,
  validateRequestKey,
} from './contracts.js';
import { holdExpired } from './errors.js';

function crashAfterCommit(environmentName) {
  if (process.env[environmentName] === '1') process.kill(process.pid, 'SIGKILL');
}

export class ReservationService {
  constructor(repository, logger = () => {}) {
    this.repository = repository;
    this.logger = logger;
  }

  #envelope({ principal, requestKey, request }) {
    return {
      principal,
      requestKey: validateRequestKey(requestKey),
      intentDigest: request.intentDigest,
      request,
    };
  }

  async createProperty(input) {
    const result = await this.repository.createProperty(this.#envelope({
      ...input,
      request: normalizeProperty(input.body),
    }));
    this.logger({ event: 'property_mutation_finished', status: 'succeeded' });
    return result;
  }

  async putInventoryDay(input) {
    const result = await this.repository.putInventoryDay(this.#envelope({
      ...input,
      request: normalizeInventoryMutation(input),
    }));
    this.logger({ event: 'inventory_mutation_finished', status: 'succeeded' });
    return result;
  }

  async createAvailabilityQuery(input) {
    const result = await this.repository.createAvailabilityQuery(this.#envelope({
      ...input,
      request: normalizeAvailability(input.body),
    }));
    this.logger({ event: 'availability_materialized', status: 'succeeded' });
    return result;
  }

  async createHold(input) {
    const result = await this.repository.createHold(this.#envelope({
      ...input,
      request: normalizeHold(input.body),
    }));
    this.logger({ event: 'hold_mutation_finished', status: 'succeeded' });
    crashAfterCommit('HOTEL_CRASH_AFTER_HOLD_COMMIT');
    return result;
  }

  async confirmHold(input) {
    const result = await this.repository.confirmHold(this.#envelope({
      ...input,
      request: normalizeConfirm(input.holdId, input.body),
    }));
    this.logger({ event: 'confirm_mutation_finished', status: result.outcome });
    if (result.outcome === 'expired') throw holdExpired();
    crashAfterCommit('HOTEL_CRASH_AFTER_BOOKING_COMMIT');
    return result;
  }

  async assignExpiryWorker(input) {
    const result = await this.repository.assignExpiryWorker(this.#envelope({
      ...input,
      request: normalizeAssignment(input.body),
    }));
    this.logger({ event: 'assignment_mutation_finished', status: 'succeeded' });
    return result;
  }

  async reapHold(input) {
    const result = await this.repository.reapHold(this.#envelope({
      ...input,
      request: normalizeReap(input.holdId, input.body),
    }));
    this.logger({ event: 'reap_mutation_finished', status: result.outcome });
    if (result.outcome === 'expired') crashAfterCommit('HOTEL_CRASH_AFTER_REAP_COMMIT');
    return result;
  }

  async cancelBooking(input) {
    const result = await this.repository.cancelBooking(this.#envelope({
      ...input,
      request: normalizeCancel(input.bookingId, input.body),
    }));
    this.logger({ event: 'cancel_mutation_finished', status: 'succeeded' });
    crashAfterCommit('HOTEL_CRASH_AFTER_CANCEL_COMMIT');
    return result;
  }
}
