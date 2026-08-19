# Closed-book contract: conserved stay inventory and receipted booking transitions

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Hotel Reservation
System” names a problem family, not one product, distribution channel, property-management protocol, rate contract, or payment
flow. Property search, room-type inventory, per-room assignment, quotes, temporary holds, bookings, cancellations, overbooking,
payments, check-in, loyalty, channel management, and settlement are hypotheses for this lab—not facts about any hotel, OTA, GDS,
PMS, payment processor, or other system. Later research must record confirmations, conflicts, omissions, and changes instead of
silently rewriting this baseline.

## Users and core behavior

### Synthetic traveller

1. A caller searches a bounded property/date/occupancy request and receives a revisioned visibility result, not a reservation.
2. The caller requests a bounded quote and then a temporary inventory hold under stable request identities. Exact retry returns the
   prior receipt; changed intent conflicts.
3. A hold either covers every requested local stay date and occupancy unit or covers none. Its expiry, inventory revision, and
   conversion state are explicit.
4. Confirming a hold produces one booking receipt only after current ownership and inventory preconditions commit. It does not by
   itself prove payment, property acknowledgement, room assignment, check-in, room access, completed stay, refund, or acceptance.

### Property inventory operator

1. An authenticated operator creates versioned sellable capacity and bounded maintenance/channel blocks for a synthetic property,
   room type, and local stay date.
2. Capacity reduction cannot make already committed obligations disappear. A rejected reduction names the blocking dates/counts;
   an explicit oversell policy, if ever added, has its own revision and budget.
3. Lease expiry/reaping, cancellation, booking amendment, and room assignment use current generations and durable receipts. A stale
   worker cannot release or reassign inventory after takeover.
4. Ordinary health exposes backlog, oldest lease, conflict/retry counts, and invariant status without guest, property, quote,
   booking, rate, or payment identifiers.

### Search or catalogue consumer

1. Search and availability pages bind a catalogue/inventory snapshot or explicitly declare that results are advisory.
2. Pagination under one query identity cannot mix property-catalogue, rate-plan, or inventory revisions.
3. “No result,” “zero currently sellable units,” “stale/partial source,” “request outside horizon,” and “retained-away evidence” are
   different results.

### Payment, property, or stay consumer

1. A booking receipt may be an input candidate only.
2. Payment authorization, capture, refund, tax, commission, ledger entry, channel/property acknowledgement, room assignment,
   identity verification, key issuance, check-in, stay completion, chargeback, and reconciliation require independent contracts.
3. No inventory or booking row is called “paid,” “revenue,” “checked in,” “fulfilled,” or “accepted by hotel” without those receipts.

## Non-goals for v0.1

- real travellers, properties, staff, addresses, contacts, room numbers, confirmation codes, rates, discounts, taxes, currencies,
  payment methods, invoices, loyalty accounts, access credentials, occupancy, demand, or production traffic;
- maps/recommendations, photos/reviews, dynamic pricing, promotions, bundles, flights/cars, loyalty, identity/KYC, fraud screening,
  physical room assignment, digital keys, check-in/out, housekeeping, point of sale, or customer support;
- protocol compatibility with any OTA, GDS, CRS, PMS, channel manager, payment provider, or vendor;
- globally distributed search/booking, multi-region consensus, production failover, arbitrary property/timezone rules, shared-room or
  bed inventory, packages, waitlists, walk-ins, group blocks, production backup/restore, deployment, SLA, cost, or revenue claims;
- unbounded stay length, occupancy, inventory horizon, property/room/rate cardinality, hold duration, amendment chain, query range,
  result set, replay, or retention;
- proving real-time hotel availability, price parity, payment, property acknowledgement, room readiness/access, guest arrival,
  completed stay, occupancy, revenue, refund, settlement, or external acceptance.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- ten million searches/day is about 116 searches/s average; a 20× burst is about 2,315 searches/s;
- one hundred thousand hold attempts/day is about 1.16/s average, but popular properties can concentrate most writes on a small
  property/room-type/date range;
- one million room types across 365 sellable dates is 365 million logical inventory cells before revisions, blocks, holds,
  bookings, indexes, audit history, and replicas;
- a seven-night stay touches seven inventory cells atomically; one failed middle date must not leave six nights reserved;
- a 10-minute hold lease with 100,000 attempts/day has roughly 694 average concurrent holds if every attempt lasts to expiry;
- retaining ten immutable booking transitions for one million bookings/year produces ten million transition records before
  indexes, receipts, audit metadata, and replicas.

The runnable lab will use a small synthetic fixture, report exact properties/room types/dates/holds/bookings/retries/expiries, and
never extrapolate it to a marketplace or hotel fleet.

## Candidate data and state model

Local-date inventory identity:

```text
property + room_type + stay_date + inventory_generation -> capacity, blocks, committed, active-held
stay interval -> property-local dates [check_in_date, check_out_date)
sellable_without_explicit_oversell = capacity - blocks
```

Quote and hold identity:

```text
quote_id -> immutable property/room_type/date/occupancy/rate-plan/revision/expiry digest
hold_id + request_key -> immutable quote intent + lease generation + expiry + all-night debit receipt
```

Booking lifecycle:

```text
active hold -> booking confirmed -> cancelled
     | expiry -> expired

booking amendment -> explicit replacement/transition, never silent mutation of the prior receipt
```

Room-type capacity and physical room assignment remain separate. A booking can reserve one unit of a room type without naming a
physical room; assignment cannot retroactively change what inventory was sold.

## Core invariants

1. **Stay dates are canonical local dates.** A property timezone/version is explicit. Nights use half-open
   `[check_in_date, check_out_date)` local-date intervals; DST does not create a fractional or duplicate inventory night.
2. **One request, one immutable intent.** Search, quote, hold, confirm, cancel, amend, and operator mutations have stable request
   identities and canonical digests. Exact retry replays; changed intent conflicts.
3. **Visibility is not ownership.** Search availability and quote generation never debit inventory or guarantee later confirmation.
4. **Quote meaning is frozen.** Property, room type, stay dates, occupancy, rate-plan revision, price components, currency, policy,
   expiry, and catalogue/inventory basis are immutable for one quote. The lab may omit money entirely rather than invent accuracy.
5. **Multi-night acquisition is all or nothing.** One hold reserves every requested date in one atomic transaction/protocol or no
   date. Partial stays are never returned as a successful hold.
6. **Inventory is conserved per date.** Without an explicit versioned oversell budget,
   `active holds + confirmed bookings <= capacity - active blocks` for every property/room-type/date cell.
7. **Capacity is not a mutable counter without lineage.** Capacity, blocks, holds, bookings, releases, and corrections have
   separate durable events/rows and revisions; a current count can be reconciled to them.
8. **Hold expiry has one owner.** Lease expiry is persisted. Confirm and reap serialize on the current hold generation so only one
   transition can consume or release its inventory.
9. **Wall-clock observation is not authority.** A client deciding that a hold “looks expired” cannot release it. The authority
   compares its transaction time/persisted deadline and commits the transition.
10. **Workers are fenced.** Reaper, inventory importer, amendment, and reconciliation workers carry assignment/lease generations.
    Superseded workers cannot release, overwrite, or publish current state.
11. **Confirmation consumes the hold once.** A successful confirm atomically creates/replays one booking and converts the hold's
    inventory ownership; crash or response loss cannot create another debit or booking.
12. **Expired or cancelled ownership cannot resurrect.** Retrying an old confirm/cancel after a terminal transition returns the
    terminal receipt or conflicts; it cannot reactivate inventory implicitly.
13. **Cancellation releases exactly once.** One cancellable booking transition creates one release effect. Replaying it cannot
    increase availability repeatedly; non-refundable/payment consequences stay outside this inventory fact.
14. **Amendment is a receipted replacement.** Date/room/occupancy changes acquire the new obligation and release/replace the old
    under an explicit transition, with rollback semantics that cannot lose both or retain both accidentally.
15. **Capacity reductions respect obligations.** A maintenance block or capacity decrease either fits around active holds/bookings,
    is rejected, or invokes an explicit relocation/oversell workflow. It never deletes commitments to make arithmetic pass.
16. **Room type and room assignment differ.** Inventory can be conserved at room-type/date granularity without claiming a specific
    room is ready, accessible, or assigned.
17. **One read, one snapshot.** A multi-date availability/booking read and every page under one query identity bind one revision or
    explicitly expose staleness; it cannot combine dates from unrelated snapshots and call them current.
18. **No-result states remain distinct.** Zero inventory, no configured inventory, closed sale, stale/partial feed, unsupported
    occupancy, outside horizon, expired quote, and evidence retained away are not interchangeable.
19. **Retention preserves retry safety.** Request/hold/booking terminal receipts outlive every supported retry/replay horizon. After
    expiry, the system returns an explicit unknown/beyond-horizon result rather than risking a second booking.
20. **Reconciliation repairs through versions.** A detected mismatch produces a bounded repair/correction generation and audit
    receipt; it does not silently rewrite historical booking or inventory transitions.
21. **Backpressure is visible.** Search, quote, hold, booking, expiry, reconciliation, and storage limits reject/throttle with typed
    receipts; timeout or overload is not labelled “unavailable” or “confirmed” without evidence.
22. **Booking is not payment or stay.** Confirmation proves only this lab's inventory/booking commit. Authorization, capture,
    property acknowledgement, assignment, check-in, room access, stay completion, refund, and settlement remain false/unknown.
23. **Evidence is privacy-bounded.** Ordinary logs/metrics omit property/guest/booking/quote/request IDs, dates, rate/occupancy
    values, digests, auth values, payment data, and free text; diagnostics use low-cardinality reason codes.
24. **Self-monitoring is not self-proof.** Reconciliation and invariant alarms need an independent query/receipt path; a cache or
    projection served by the same stalled updater cannot prove inventory correctness.

## Initial API and event sketch

Advisory reads:

- `POST /v1/searches` with bounded property/date/occupancy filters and a stable query key;
- `GET /v1/searches/{id}/pages/{cursor}` bound to one catalogue/inventory visibility snapshot;
- `POST /v1/quotes` with an immutable room type, local stay interval, occupancy, and revision basis.

Inventory and booking mutations:

- `POST /v1/holds` with quote ID, stable request key, bounded lease, and all-night precondition;
- `POST /v1/holds/{id}/confirm` with expected hold generation and stable booking intent;
- `POST /v1/bookings/{id}/cancel` and `/amend` with expected booking revision;
- `GET /v1/mutation-receipts/{id}` for response-loss recovery without guest/property payload logging.

Operator mutations:

- `POST /v1/inventory/generations` for bounded capacity/block changes with expected revision;
- `POST /v1/expiry-assignments` and fenced reap completion;
- `POST /v1/reconciliations` with bounded property/date scope and explicit repair generation;
- `GET /v1/state` for low-cardinality invariant, backlog, age, conflict, and retry signals.

Exact capacity model, overbooking policy, catalogue/rate representation, quote pricing, lease duration, storage, sharding, expiry
scheduler, amendment semantics, auth, error vocabulary, and retention remain hypotheses until primary sources are reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| search/cache is stale | result says advisory/snapshot revision; it is not a hold or confirmation |
| two callers hold the final unit | at most one all-night hold commits unless an explicit oversell budget permits more |
| one night of a seven-night stay is full | entire hold fails; no six-night debit remains |
| client loses response after hold commit | exact request returns original hold/expiry; changed request conflicts |
| confirmer races authoritative expiry | exactly one terminal transition owns/releases inventory; no booking plus release |
| confirmer dies after booking commit before response | exact retry returns the same booking and inventory debit |
| stale reaper finishes after takeover | generation fence rejects release/current-state mutation |
| cancellation response is lost | exact retry returns one cancellation/release; availability does not increment twice |
| capacity drops below obligations | change rejects or enters explicit relocation/oversell workflow; bookings remain visible |
| block creation races a hold | one serial order wins; per-date conservation remains true |
| amendment cannot acquire a new date | original booking remains, or an explicit compensating state is visible; no silent loss |
| query paginates during inventory changes | all pages remain bound to one snapshot or terminate with a typed revision error |
| retry receipt was retained away | explicit beyond-idempotency-horizon result; no second booking attempt is called safe |
| payment succeeds but booking times out | this lab exposes only its booking receipt; payment reconciliation is a separate contract |
| property rejects or cannot assign a room | booking remains a booking-system fact; no hotel acceptance/check-in claim is fabricated |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API/events, operations, threat model, and at least one ADR.
2. Exact local-date/stay/occupancy/inventory/quote/hold/booking/cancel validation, canonical digests, and typed-error tests.
3. Generated/property tests for half-open nights, DST-independent date enumeration, all-night atomicity, conservation, retry
   identity, expiry/confirm exclusivity, cancellation algebra, and snapshot-stable reads.
4. Real persistence/concurrency tests for final-unit races, multi-date rollback, durable retry, changed-intent conflict, current-time
   expiry, worker fencing, capacity/block conflicts, booking conversion, cancellation, retention horizon, and restart.
5. A true-process crash/restart smoke covering hold response loss, confirm/expiry race, booking response loss, stale reaper, cancel
   response loss, and explicit false payment/property/check-in/external flags.
6. A bounded benchmark with exact properties/room types/dates/searches/holds/contention/expiries/bookings/cancellations fixture,
   runtime/service versions, exclusions, and raw observations—without demand, occupancy, revenue, SLA, or capacity extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Privacy/evidence scans that reject realistic guest/property/payment/rate sentinels and any claim of payment, hotel acceptance,
   room readiness, check-in, revenue, SLA, or external acceptance without matching evidence.

## Initial design choices to challenge after source review

- Does the chapter model room-type/date inventory, physical rooms, or both, and does it preserve their different meanings?
- Are stays half-open property-local dates, or does the design accidentally use UTC timestamps across DST boundaries?
- Is a search result merely advisory, and what exact transition creates an inventory hold?
- Can a multi-night hold partially debit dates, and what transaction/partition boundary prevents that?
- What serializes the final-unit race, and is any oversell an explicit policy/budget rather than an accident?
- Are hold expiry and booking confirmation mutually exclusive under an authoritative clock and current generation?
- Do stable request identities survive response loss for hold, confirm, cancel, and amend?
- Can capacity/maintenance changes invalidate existing obligations, and how is reconciliation audited?
- Is price/quote immutability separated from inventory and from payment authorization/capture?
- Are booking confirmation, property acknowledgement, room assignment/readiness, check-in, completed stay, refund, and settlement
  kept as separate evidence boundaries?
