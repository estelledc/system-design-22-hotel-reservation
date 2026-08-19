export class ReservationError extends Error {
  constructor(code, status, message, retryable = false, details) {
    super(message);
    this.name = 'ReservationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export const invalid = (message = 'request is invalid') => (
  new ReservationError('invalid_request', 400, message)
);
export const unauthorized = () => (
  new ReservationError('authentication_required', 401, 'authorization failed')
);
export const notFound = (message = 'resource was not found') => (
  new ReservationError('not_found', 404, message)
);
export const idempotencyConflict = () => new ReservationError(
  'idempotency_conflict', 409, 'request key conflicts with prior intent', false,
);
export const entityConflict = (kind) => new ReservationError(
  'entity_conflict', 409, `${kind} identity conflicts with prior intent`, false,
);
export const inventoryGap = () => new ReservationError(
  'inventory_horizon_gap', 409, 'one or more stay dates are not configured', true,
);
export const inventoryUnavailable = () => new ReservationError(
  'inventory_unavailable', 409, 'one or more stay dates lack requested inventory', true,
);
export const inventoryRevisionConflict = (currentRevision) => new ReservationError(
  'inventory_revision_conflict', 409, 'inventory revision is stale', true, { currentRevision },
);
export const capacityBelowObligation = () => new ReservationError(
  'capacity_below_obligation', 409, 'proposed inventory cannot preserve current obligations', false,
);
export const holdExpired = () => new ReservationError(
  'hold_expired', 409, 'hold expired before confirmation', false,
);
export const holdNotActive = () => new ReservationError(
  'hold_not_active', 409, 'hold is not active', false,
);
export const bookingNotConfirmed = () => new ReservationError(
  'booking_not_confirmed', 409, 'booking is not confirmed', false,
);
export const staleAssignment = (currentGeneration) => new ReservationError(
  'stale_assignment', 409, 'expiry worker assignment is stale', false, { currentGeneration },
);
export const notExpired = () => new ReservationError(
  'not_expired', 409, 'hold has not reached its authoritative expiry', true,
);
