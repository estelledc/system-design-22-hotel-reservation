# Hotel Reservation Lab

This clean-room system-design practice starts with one question: how can a multi-night inventory hold become one durable booking
without overselling any night, while keeping search visibility, price quotation, payment, room assignment, and check-in as
different receipts?

The prompt title is “Hotel Reservation System.” This repository does not copy a travel product, source chapter, protocol,
diagram, property catalogue, rate, guest record, benchmark, or proprietary behavior. The initial contract is frozen from the title
alone before reading the fixed secondary chapter.

## Current phase

The closed-book contract and source-calibrated v0.1 design are frozen separately. The planned slice uses PostgreSQL 17 as one
transactional authority for bounded local-date inventory, all-night holds, authoritative expiry, booking conversion,
cancellation, worker fencing, and materialized availability receipts. Implementation, tests, benchmark, public remote, CI,
deployment, payment/property integration, SLA, and external acceptance are pending.

The fixed secondary chapter is useful for room-type-per-date inventory, concurrency choices, stale-cache tolerance, and keeping
dependent inventory/reservation writes in one relational boundary. It does not define hold expiry or stable recovery receipts, and
its inclusive date query, one inventory update predicate, overbooking/check-constraint examples, and optimistic-lock description
need correction. The evidence log records those differences instead of silently inheriting them.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison and evidence log](docs/research-log.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [ADR 0001](docs/adr/0001-postgres-conserved-inventory.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Search result, quote, active hold, inventory debit, booking confirmation, payment authorization/capture, room assignment, property
acknowledgement, check-in, completed stay, refund, and business acceptance are different facts. This lab will name and test only
the boundaries it reaches. It will abstain from real availability, price accuracy, payment, revenue, occupancy, guest arrival,
room access, SLA, or external acceptance without matching evidence.

## License

MIT. Third-party study material and real hospitality, guest, rate, or payment data are not included.
