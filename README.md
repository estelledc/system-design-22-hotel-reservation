# Hotel Reservation Lab

This clean-room system-design practice starts with one question: how can a multi-night inventory hold become one durable booking
without overselling any night, while keeping search visibility, price quotation, payment, room assignment, and check-in as
different receipts?

The prompt title is “Hotel Reservation System.” This repository does not copy a travel product, source chapter, protocol,
diagram, property catalogue, rate, guest record, benchmark, or proprietary behavior. The initial contract is frozen from the title
alone before reading the fixed secondary chapter.

## What is implemented

The closed-book contract and source-calibrated design are frozen in separate commits. The v0.1 slice uses PostgreSQL 17 as one
transactional authority around:

- property-local canonical dates and bounded `[check_in, check_out)` stays;
- per-room-type/date capacity, explicit integer oversell, blocks, held units, booked units, and one enforced conservation equation;
- immutable materialized availability results that remain advisory rather than owning inventory;
- all-night `FOR UPDATE` acquisition in ascending date order, durable request/entity intent, and exact response-loss replay;
- PostgreSQL-authored hold expiry, confirm-versus-expiry serialization, worker assignment generations, and stale reaper fencing;
- one-way hold-to-booking conversion, idempotent cancellation, and explicit false payment/property/room/check-in/stay receipts.

The implementation, pure tests, real PostgreSQL tests, four-boundary true-process crash smoke, and bounded benchmark pass locally.
Public remote and public multi-runtime CI receipts are pending.

The fixed secondary chapter is useful for room-type-per-date inventory, concurrency choices, stale-cache tolerance, and keeping
dependent inventory/reservation writes in one relational boundary. It does not define hold expiry or stable recovery receipts, and
its inclusive date query, one inventory update predicate, overbooking/check-constraint examples, and optimistic-lock description
need correction. The evidence log records those differences instead of silently inheriting them.

## One reservation, several different facts

```text
materialized availability (advisory)
  -> active all-night inventory hold
  -> confirmed booking-system receipt
  != price/payment authorization or capture
  != property/channel acknowledgement
  != physical room assignment/readiness or key
  != guest check-in, completed stay, refund, settlement, or external acceptance
```

## Run locally

Requirements: Node.js 22 or newer and PostgreSQL 17.

```sh
npm ci --ignore-scripts
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/hotel_reservation'
export HOTEL_API_TOKEN='replace-with-a-local-token-at-least-16-characters'
npm start
```

Run the gates against an empty disposable database:

```sh
npm run check
npm run test:infra
npm run smoke:infra
npm run benchmark:infra
```

`test:infra`, `smoke:infra`, and `benchmark:infra` fail when `DATABASE_URL` is absent. The smoke and benchmark reset the named
database and are destructive to data in that disposable database.

## Evidence produced locally

- Pure tests cover exact contracts, DST-adjacent half-open calendar dates, generated stays, conservation, evidence flags, auth,
  routing, content type, and bounded logging.
- PostgreSQL tests cover snapshot materialization, horizon rollback, final-unit concurrency, exact/changed retries, hold conversion,
  authoritative expiry, worker fencing, capacity conflicts, cancellation, and explicit oversell.
- The smoke kills four separate API processes after hold, booking, reap, and cancellation commits. Exact retries recover revisions
  `1`, `1`, `2`, and `2`; the final state has no held units and preserves one three-night confirmed booking.
- The fixed benchmark uses 2 properties, 4 room types each, 256 inventory days, 64 queries, 32 regular holds, 16 confirmations,
  8 cancellations, 8 expiries, and an eight-way final-unit race. Results are runtime observations only.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison and evidence log](docs/research-log.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [ADR 0001](docs/adr/0001-postgres-conserved-inventory.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification ledger](docs/verification.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Search result, quote, active hold, inventory debit, booking confirmation, payment authorization/capture, room assignment, property
acknowledgement, check-in, completed stay, refund, and business acceptance are different facts. This lab will name and test only
the boundaries it reaches. It will abstain from real availability, price accuracy, payment, revenue, occupancy, guest arrival,
room access, SLA, or external acceptance without matching evidence.

## Deliberate limits

This is one database, one process at a time, bounded synthetic data, room-type/date inventory, positive units, one expiry shard, and
no amendment. It has no rate/price/tax/currency, payment/refund/ledger, physical room, property channel, guest identity, check-in,
distributed cache/broker, PostgreSQL failover, deployment, or production traffic. A green test or CI run proves only the named
synthetic boundary.

## License

MIT. Third-party study material and real hospitality, guest, rate, or payment data are not included.
