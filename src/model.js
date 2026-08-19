import { invalid } from './errors.js';

export const dateEnvelope = Object.freeze({ minimum: '2020-01-01', maximumExclusive: '2100-01-01' });

export const evidenceFlags = Object.freeze({
  paymentAuthorized: false,
  paymentCaptured: false,
  propertyAccepted: false,
  physicalRoomAssigned: false,
  checkedIn: false,
  stayCompleted: false,
  externalAcceptanceProved: false,
});

export function parseCanonicalDate(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid(`${name} must use canonical YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalid(`${name} is not a calendar date`);
  }
  if (value < dateEnvelope.minimum || value >= dateEnvelope.maximumExclusive) {
    throw invalid(`${name} is outside the lab date envelope`);
  }
  return value;
}

export function enumerateStayDates(checkInDate, checkOutDate, maximumNights = 14) {
  const checkIn = parseCanonicalDate(checkInDate, 'checkInDate');
  const checkOut = parseCanonicalDate(checkOutDate, 'checkOutDate');
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const end = new Date(`${checkOut}T00:00:00.000Z`);
  const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (!Number.isSafeInteger(nights) || nights < 1 || nights > maximumNights) {
    throw invalid(`stay must contain 1 through ${maximumNights} nights`);
  }
  return Array.from({ length: nights }, (_, index) => (
    new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10)
  ));
}

export function inventoryAvailable(row) {
  return Number(row.capacity) + Number(row.oversell_units ?? row.oversellUnits)
    - Number(row.blocked_units ?? row.blockedUnits)
    - Number(row.held_units ?? row.heldUnits)
    - Number(row.booked_units ?? row.bookedUnits);
}

export function assertConserved(row) {
  const values = [
    row.capacity,
    row.oversell_units ?? row.oversellUnits,
    row.blocked_units ?? row.blockedUnits,
    row.held_units ?? row.heldUnits,
    row.booked_units ?? row.bookedUnits,
  ].map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || inventoryAvailable(row) < 0) {
    throw invalid('inventory counters violate conservation');
  }
  return true;
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || !values.length || fraction < 0 || fraction > 1) {
    throw invalid('percentile input is invalid');
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}
