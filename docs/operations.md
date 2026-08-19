# Operations and recovery

## Safe local setup

Use only an empty disposable PostgreSQL 17 database. `smoke:infra` and `benchmark:infra` truncate every lab table. They must never
point at a shared, staging, production, or real reservation database.

```sh
npm ci --ignore-scripts
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/hotel_reservation'
export HOTEL_API_TOKEN='a-local-synthetic-token'
npm run check:ci
```

Missing `DATABASE_URL` is a hard failure for every infrastructure gate. Missing `HOTEL_API_TOKEN` is a startup failure. No gate
turns missing infrastructure into a skip.

## Health and evidence

- `GET /healthz` proves only that the process can answer HTTP.
- Authenticated `GET /v1/state` reports inventory-day count, held/booked totals, hold/booking state counts, invariant violations,
  and oldest active-hold age. It exposes no entity IDs, dates, room types, or payload values.
- `invariantOk: true` proves only current row arithmetic in this database. It does not prove backup correctness, cache freshness,
  payment, property acceptance, physical room readiness, check-in, completed stay, or external acceptance.

## Expected retry decisions

| Error | Operator/client action |
|---|---|
| `inventory_unavailable` | refresh advisory availability or choose another bounded stay; exact retry is safe but cannot create units |
| `inventory_horizon_gap` | configure the exact missing dates; never interpret as zero inventory |
| `inventory_revision_conflict` | re-read row revision and explicitly decide the new capacity/block intent |
| `capacity_below_obligation` | preserve commitments; use a separately designed relocation/oversell workflow rather than force update |
| `idempotency_conflict` / `entity_conflict` | stop; the stable identity was reused with changed intent |
| `hold_expired` / `hold_not_active` | do not retry as a new hidden booking; obtain a new hold under a new identity if desired |
| `stale_assignment` | stale worker stops; only the current generation may retry |
| `not_expired` | wait until the authority's expiry; client time is not a release command |
| `database_unavailable` / unknown response | retry the exact operation with the exact request key and body |

## Crash boundaries

The following flags exist only for isolated tests. When set to `1`, the API process kills itself with `SIGKILL` after the named
database transaction commits and before the HTTP response is written:

- `HOTEL_CRASH_AFTER_HOLD_COMMIT`
- `HOTEL_CRASH_AFTER_BOOKING_COMMIT`
- `HOTEL_CRASH_AFTER_REAP_COMMIT`
- `HOTEL_CRASH_AFTER_CANCEL_COMMIT`

Never set them in a non-disposable environment. Recovery is exact request replay; a changed key/body is not recovery.

## Invariant triage

If `invariantViolations` is nonzero:

1. stop new mutations and retain database/WAL evidence;
2. do not repair counters by hand or delete holds/bookings;
3. compare inventory cells with `hold_nights` and `booking_nights` under a consistent database snapshot;
4. identify whether the mismatch came from an unsupported manual write, schema drift, corruption, or an implementation defect;
5. design a versioned reconciliation receipt before mutation;
6. rerun pure, PostgreSQL, crash, and benchmark gates on an isolated copy.

No production reconciliation, backup, point-in-time recovery, replica promotion, or disaster-recovery procedure is implemented.

## Capacity interpretation

The benchmark reports one fixed fixture and raw local/CI timings. Shared runner load, database storage, CPU, and concurrency differ.
Do not compare Node versions from concurrent jobs or turn the observation into demand, occupancy, bookings/s, revenue, cost, SLA,
or production capacity.
