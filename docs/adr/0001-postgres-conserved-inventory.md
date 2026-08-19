# ADR 0001: PostgreSQL authority for conserved per-night inventory

- Status: accepted for v0.1 design
- Date: 2026-08-19

## Context

The central unknown is not search throughput. It is whether concurrent multi-night holds, expiry, confirmation, capacity changes,
and cancellation preserve one explainable per-date inventory equation under retries and process death. Splitting those mutations
across a cache, broker, inventory service, booking service, payment service, and property channel would add unproved failure windows
before the first invariant is executable.

The fixed chapter already converges inventory and reservation on one relational boundary, but its sample date/predicate/constraint
semantics are not sufficient for a clean implementation. PostgreSQL 17 documents canonical date ranges, row locks, consistent lock
ordering, transaction snapshots/retries, row-local constraints, and distinct server clocks needed by the chosen slice.

## Decision

Use one PostgreSQL 17 database as the only authority for v0.1:

- one row per property/room-type/local-stay-date;
- explicit capacity, oversell, blocked, held, and booked counters with a row-local conservation check;
- complete date-set `FOR UPDATE` acquisition in ascending order for each multi-night mutation;
- hold/booking/night ledgers and durable idempotency receipts in the same transaction as counter changes;
- PostgreSQL `statement_timestamp()` for authoritative expiry comparisons;
- worker assignment generations for stale reaper fencing;
- immutable materialized availability results rather than a cache/read-replica claim.

Payment, rates, physical rooms, property acknowledgement, and check-in are excluded instead of represented by placeholder success
states.

## Alternatives rejected for this slice

- **Cache as inventory authority:** fast advisory reads do not serialize the final-unit write and make invalidation/recovery another
  correctness problem.
- **Optimistic counter only:** possible, but a multi-date compare-and-swap needs deterministic retries and partial-failure handling;
  row locks make the first conservation oracle clearer under the bounded 14-night range.
- **Serializable without explicit ownership order:** still requires whole-transaction retry and does not document the intended
  date-cell contention boundary as clearly as stable row locks.
- **Database check only:** protects one row after update, not stable request replay, all-night acquisition, expiry/confirm exclusion,
  or cross-row lock order.
- **Saga/payment integration:** useful only after each participant has a real idempotent state/reconciliation contract. Adding fake
  participants would not prove external compensation.

## Consequences

- All contending writes for one inventory date serialize; long transactions would damage throughput, so no external/user wait is
  allowed inside a transaction.
- A 14-night request locks at most 14 inventory rows and must follow one order to bound deadlock risk.
- One database failure is one availability boundary; PostgreSQL HA/DR remains unproved.
- The design demonstrates inventory/booking recovery, not a distributed reservation platform.
- Introducing a broker/cache/service split later requires new lineage, checkpoint/outbox, stale-read, fencing, and reconciliation
  receipts; this ADR cannot be quoted as proof for that topology.
