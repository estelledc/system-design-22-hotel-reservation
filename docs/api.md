# HTTP and error contract

## Common rules

- JSON only; unknown keys, duplicate semantic fields, non-canonical dates, unbounded arrays/strings, and malformed UUIDs reject.
- State routes require `Authorization: Bearer <token>`; `/healthz` is public and discloses no state.
- Mutations require `Idempotency-Key` of 8–80 visible ASCII characters. Server receipts bind principal, operation, key, and
  canonical intent digest.
- Entity and request IDs are UUIDs. Synthetic property/room-type/worker IDs use bounded lowercase slugs.
- Errors use `{ "error": { "code", "message", "retryable" } }` and no payload echo.

## Planned routes

### `POST /v1/properties`

Creates/replays one synthetic property `{ propertyId, timezone }`.

### `PUT /v1/inventory-days/{propertyId}/{roomTypeId}/{stayDate}`

Operator mutation:

```json
{
  "expectedRevision": 0,
  "capacity": 20,
  "oversellUnits": 0,
  "blockedUnits": 0
}
```

It rejects a reduction that cannot preserve current held/booked ownership.

### `POST /v1/availability-queries`

```json
{
  "queryId": "00000000-0000-4000-8000-000000000001",
  "propertyId": "property-a",
  "roomTypeId": "standard",
  "checkInDate": "2027-03-13",
  "checkOutDate": "2027-03-16",
  "units": 1
}
```

Returns an immutable result with three per-night rows, minimum availability, inventory revisions, and `ownershipProved: false`.

### `GET /v1/availability-queries/{queryId}`

Returns the stored result only. It does not re-read current inventory.

### `POST /v1/holds`

Creates an all-night hold:

```json
{
  "holdId": "00000000-0000-4000-8000-000000000002",
  "propertyId": "property-a",
  "roomTypeId": "standard",
  "checkInDate": "2027-03-13",
  "checkOutDate": "2027-03-16",
  "units": 1,
  "leaseSeconds": 30
}
```

Returns state `active`, PostgreSQL-authored expiry, revision `1`, and the inventory-only evidence flags.

### `POST /v1/holds/{holdId}/confirm`

Body `{ "bookingId": "...", "expectedHoldRevision": 1 }`. Returns one `confirmed` booking or a typed `hold_expired` /
`hold_not_active` result. The booking does not include a price or payment state.

### `POST /v1/expiry-assignments/0`

Body `{ "workerId": "reaper-a", "expectedGeneration": 0 }`. Returns the next generation.

### `POST /v1/holds/{holdId}/reap`

Body `{ "workerId": "reaper-a", "expectedGeneration": 1 }`. It succeeds only when the hold is expired and assignment remains
current; an unexpired hold returns a typed non-mutating result.

### `POST /v1/bookings/{bookingId}/cancel`

Body `{ "expectedBookingRevision": 1 }`. Exact replay returns the same cancellation receipt and cannot release twice.

### `GET /v1/state`

Returns bounded counts by state plus invariant status and oldest active-hold age. It contains no entity IDs, dates, counts by
property/room type, rate/payment data, or payload digests.

## Error vocabulary

| Code | Meaning | Retry |
|---|---|---|
| `authentication_required` | bearer token absent/invalid | no |
| `invalid_request` | exact-shape/bound/date/range failure | no |
| `idempotency_conflict` | request key reused with changed intent | no |
| `entity_conflict` | hold/query/booking ID reused with changed intent | no |
| `inventory_horizon_gap` | one or more exact stay dates are not configured | after operator action |
| `inventory_unavailable` | at least one live date lacks requested units | after state change |
| `inventory_revision_conflict` | expected inventory revision is stale | re-read then decide |
| `capacity_below_obligation` | proposed capacity/block/oversell cannot conserve owned units | no without new plan |
| `hold_expired` | authority serialized expiry before confirmation | no |
| `hold_not_active` | terminal hold cannot transition as requested | no |
| `booking_not_confirmed` | terminal booking cannot cancel as requested | no |
| `stale_assignment` | worker generation lost ownership | no for stale worker |
| `not_expired` | reap attempted before authoritative expiry | later |
| `database_unavailable` | PostgreSQL request failed before a known receipt | yes with same key |
