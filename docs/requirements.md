# Requirements and acceptance contract

## v0.1 users

- Synthetic caller: materializes availability, creates an all-night hold, confirms one booking, and cancels it under stable keys.
- Inventory operator: creates/updates bounded room-type/date capacity and explicit oversell allowance under expected revisions.
- Expiry worker: owns one assignment generation and reaps expired holds; a superseded generation is fenced.
- Evidence reader: can distinguish visibility, hold, booking, payment, property, assignment, check-in, and acceptance facts.

## Functional scope

1. Configure one or more synthetic properties with an IANA timezone label and bounded room types/date horizons.
2. Upsert capacity, blocked units, and explicit integer oversell units for one exact inventory day under expected revision.
3. Materialize one availability result for a property/room type and canonical `[check_in, check_out)` date range.
4. Atomically create one hold across every requested night after locking all inventory days in ascending order.
5. Replay exact mutation intent and reject one key/entity reused with changed dates, units, lease, or expected generation.
6. Confirm an active, unexpired hold into one booking without changing total owned inventory; expired holds cannot confirm.
7. Reap expired holds under a current worker generation; stale workers cannot release inventory.
8. Cancel one confirmed booking exactly once and release every night exactly once.
9. Return bounded low-cardinality operational state and explicit false evidence flags for payment/property/room/check-in/stay.

## Non-functional and safety requirements

- Node.js 22 or newer; PostgreSQL 17 is the only durable authority in v0.1.
- Dates are canonical `YYYY-MM-DD`; stay length is 1–14 nights and checkout is excluded.
- Units per hold are 1–5; hold lease is 1–300 seconds; request bodies and result sets are strictly bounded.
- Mutations are short transactions. No database lock is held while waiting on a person or external service.
- All multi-date locks use property, room type, and ascending stay date order.
- Inventory rows enforce `held >= 0`, `booked >= 0`, `blocked >= 0`, and
  `held + booked + blocked <= capacity + oversell_units`.
- Authenticated routes require a bearer token. Logs expose operation/status/reason/duration only, never request/entity IDs, dates,
  room types, counts, digests, tokens, or payload fragments.
- Missing PostgreSQL causes infrastructure gates to fail, never skip.

## Explicit non-goals

- search ranking/catalogue/photos/reviews, price/rate/tax/currency, payment/refund/ledger, guest identity/contact, physical room
  assignment/readiness/access, property/channel acknowledgement, check-in/out, housekeeping, or stay fulfilment;
- arbitrary overbooking percentage, amendment/relocation, shared rooms/beds, waitlists, group blocks, multi-property itinerary,
  sharding, CDC cache, distributed transactions, PostgreSQL failover, deployment, SLA, or production capacity;
- compatibility with a hotel/OTA/GDS/CRS/PMS/channel/payment protocol;
- real property, guest, rate, payment, booking, occupancy, demand, or operational data.

## Synthetic estimate used only to size the lab

The benchmark will configure 2 synthetic properties, 4 room types each, 32 sellable dates, and 20 units per date. It will issue a
fixed set of availability queries, uncontended and final-unit contended holds, expiries, confirmations, and cancellations. Exact
fixture counts and raw timings must be emitted by the script. The result is a single-process/single-database observation and cannot
be extrapolated to bookings/s, hotel capacity, occupancy, revenue, cost, or SLA.

## Completion gates

1. Pure tests cover exact shapes, date parsing/enumeration including DST-adjacent dates, canonical intent, conservation math,
   evidence flags, auth, and bounded logging.
2. PostgreSQL tests cover all-night rollback, final-unit concurrency, exact/changing retry, authoritative expiry, confirm/reap
   exclusion, worker fencing, capacity/block conflict, cancellation, materialized reads, and invariant reconciliation.
3. Four separate API processes are actually killed after hold, confirm, reap, and cancel commit but before response; exact retries
   recover one effect each.
4. A fixed benchmark emits fixture, runtime/database versions, raw observations, and exclusions.
5. Repository link/privacy/syntax/schema scans and dependency audit pass.
6. Public Node 22/24/26 × PostgreSQL 17.11 CI executes every infrastructure gate with zero skips.
7. README and verification ledger bind exact commits/runs and keep all payment/property/check-in/external claims false.
