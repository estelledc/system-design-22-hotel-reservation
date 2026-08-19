# Source comparison and evidence log

## Evidence policy

The initial contract at commit `f9b5e820e7023e40a139ce513401f3b2b6e3cdd2` was written from the title alone. The secondary
repository has no detected license at fixed commit `9d8388721e7231442763ad37398b8d82224aa68f`, so this repository copies no
prose, diagrams, SQL, schema, fixtures, benchmark values, or code from it. Sources are used only to challenge the closed-book
invariants and to record independently written decisions.

Search discovery is not source verification. One `journal-search public` query returned the intended repository through Exa but
the GitHub adapter rejected the malformed `repo:` expression; that failed attempt is retained as a search-routing fact. The exact
chapter path/blob was then resolved with the GitHub tree API, and its raw fixed-commit URL was acquired and verified before reading.

## Fixed secondary chapter

- Source: [`liquidslr/system-design-notes`, chapter 22](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/22.%20Hotel%20Reservation%20System/README.md)
- Tree commit: `9d8388721e7231442763ad37398b8d82224aa68f`
- Chapter blob: `ab74cdf87d9c0a48d1c18784e45898e890ff5c0e`
- TraceFetch receipt: `tf_f1f5a316e0733cff_20260819T003528Z`
- Raw SHA-256: `f1f5a316e0733cff0e60492de6dbbcb12e55151770ce212de02de24d1e4dda52`
- Verification: valid, HTTP 200, complete, not truncated; license still requires review, so content remains reference-only.

### Confirmed by the chapter

- Hotel inventory is more naturally sold by room type and stay date than by assigning a physical room at search time.
- Reservation writes are low-average but hotspot/concurrency-sensitive; average global TPS does not remove final-unit races.
- An advisory cache/read replica can be stale if the authoritative booking transaction rechecks inventory and returns a typed
  conflict instead of treating the cache as ownership.
- Reservation and inventory mutation fit one relational transaction better than an early service/database split whose only
  justification is architectural fashion.
- Stable reservation identity, row locking/version checks, database constraints, sharding by property, and reconciliation across
  services are real design questions.

### Added after reading

- The chapter makes an explicit interview assumption of a 10% overbooking allowance. v0.1 generalizes this into per-date
  `oversell_units` with an explicit revision and default zero; the percentage is not treated as a hospitality fact.
- It separates relatively static property data, date-varying rates, reservation/inventory, payment, and administration. v0.1 keeps
  only inventory/reservation and records the other boundaries as false or out of scope.
- It proposes pre-populated per-room-type/date rows and property-key sharding. The lab uses a bounded pre-created inventory horizon
  but does not claim a sharded database or global user-history query.

### Conflicts and corrections

1. The availability and update examples use inclusive `BETWEEN startDate AND endDate`. A stay uses nights
   `[check_in_date, check_out_date)`; including checkout debits an extra night. PostgreSQL `daterange` uses canonical `[)` bounds.
2. The example inventory `UPDATE` filters room type and dates but omits `hotel_id`, although the preceding read includes it. That can
   modify another property's identically numbered room type; every v0.1 inventory key includes property, room type, and date.
3. The chapter allows `110% * total_inventory` but later shows a non-negative `total_inventory - total_reserved` check. The latter
   forbids the earlier oversell. v0.1 stores an explicit integer oversell allowance and checks one unambiguous equation.
4. A unique reservation ID prevents two rows with one key, but does not by itself replay the original response or reject the same
   key with changed dates/units. v0.1 stores operation, canonical intent digest, and result under the request key.
5. The optimistic-lock explanation says a database accepts a new version that exceeds the old one. Correct compare-and-swap needs
   an expected version predicate and exactly one affected row; simply writing a larger number does not prevent concurrent success.
6. A row-local check constraint can protect arithmetic stored in one inventory row, but it cannot express cross-row all-night
   atomicity by itself. PostgreSQL also warns that `CHECK` is not a cross-row/table assertion.
7. “All queries include hotel ID” conflicts with the chapter's current-user reservation-history API, which can span properties.
   Property sharding may suit booking writes but makes that global access path a separate projection/fan-out problem.
8. The payment service is said to update reservation status after full payment, but no idempotent payment state, atomic boundary,
   reconciliation receipt, or failure matrix is defined. v0.1 omits payment rather than claiming the booking transaction proves it.

### Important omissions

- property-local half-open stay dates and DST-independent night enumeration;
- immutable quote/rate-plan revision and explicit absence of price/payment evidence;
- an all-or-nothing multi-night hold before confirmation;
- authoritative lease time, expiry/confirm serialization, and stale reaper fencing;
- cancellation/amendment idempotency and release conservation;
- capacity/block change conflicts with existing holds/bookings;
- stable query snapshot, retry receipt retention, low-cardinality privacy logs, and true-process response-loss recovery;
- physical room assignment, property acknowledgement, check-in, completed stay, refund, and settlement as separate receipts.

## Primary calibration sources

### PostgreSQL 17.11 transaction isolation

- Official page: <https://www.postgresql.org/docs/17/transaction-iso.html>
- Receipt: `tf_70cf332f46ff2d05_20260819T003643Z`
- SHA-256: `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`
- Applied decision: Read Committed gives each statement a new snapshot, while Repeatable Read/Serializable can require whole-
  transaction retry. v0.1 uses explicit row locks and short transactions for mutations, and materializes availability results in
  one transaction instead of returning a multi-statement live view.

### PostgreSQL 17.11 explicit locking

- Official page: <https://www.postgresql.org/docs/17/explicit-locking.html>
- Receipt: `tf_dc13a9df72216e8b_20260819T003643Z`
- SHA-256: `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`
- Applied decision: `SELECT ... FOR UPDATE` blocks competing writers/lockers until transaction end. Every multi-date mutation locks
  inventory rows in ascending date order; PostgreSQL's deadlock guidance makes consistent acquisition order a contract, not a
  performance hint. No transaction waits for user input.

### PostgreSQL 17.11 constraints

- Official page: <https://www.postgresql.org/docs/17/ddl-constraints.html>
- Receipt: `tf_f5bad0ce59a21e53_20260819T003643Z`
- SHA-256: `f5bad0ce59a21e53cf608cf0ff330f3e413d41685bd65a4b470dd54194a8cac3`
- Applied decision: row checks enforce non-negative counters and the single-row conservation equation; unique constraints own
  stable entity/request identities. Cross-date correctness remains in one locked transaction and executable conservation tests,
  not a fictional cross-row `CHECK`.

### PostgreSQL 17.11 range types

- Official page: <https://www.postgresql.org/docs/17/rangetypes.html>
- Receipt: `tf_c7445c4d6768658a_20260819T003643Z`
- SHA-256: `c7445c4d6768658ad2c7361e50fbee4e8fb4c62ce7d6960e2b8899b816885afa`
- Applied decision: built-in `daterange` canonicalizes discrete dates to lower-inclusive, upper-exclusive `[)`. v0.1 validates the
  same shape and enumerates inventory dates with checkout excluded.

### PostgreSQL 17.11 server clocks

- Official page: <https://www.postgresql.org/docs/17/functions-datetime.html>
- Receipt: `tf_8839accf8006305a_20260819T003643Z`
- SHA-256: `8839accf8006305a4a5eef28e9580270707ddadc0da254a0ea5715de1f044f6a`
- Applied decision: transaction time is stable for the whole transaction, statement time is fixed at statement receipt, and clock
  time can change within a statement. Hold expiry/confirm/reap decisions use PostgreSQL `statement_timestamp()` under the locked
  hold row; client clocks never release inventory.

### RFC 9110 HTTP semantics

- Official page: <https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods>
- Receipt: `tf_d431760660ea44e1_20260819T003644Z`
- SHA-256: `d431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5`
- Applied decision: method-level idempotence concerns intended effect, and non-idempotent requests should not be automatically
  retried without another guarantee. v0.1 does not assume POST is safe; it requires an application request key, immutable digest,
  durable result, and changed-intent conflict.

## Evidence boundary after calibration

The source review justifies a bounded relational inventory experiment. It does not prove MySQL/PostgreSQL equivalence, an OTA/GDS/
PMS protocol, the chapter's capacity numbers, a universal overbooking rate, real-time property availability, correct pricing,
payment, property acceptance, room assignment/readiness, check-in, stay completion, refund, revenue, production capacity, SLA, or
external acceptance.
