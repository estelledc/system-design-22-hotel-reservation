# Architecture and state semantics

## Smallest useful boundary

```text
authenticated HTTP request
  -> exact contract + canonical intent digest
  -> PostgreSQL transaction
       -> replay/conflict receipt
       -> lock hold/booking or all inventory dates in stable order
       -> check authoritative statement time + generation + conservation
       -> write state, per-night ownership, counters, and result receipt atomically
  -> response
```

PostgreSQL 17 is the only authority. There is no cache, broker, payment service, property channel, or physical room system in v0.1.
That deliberate shape lets real concurrency and response-loss recovery be tested without claiming a distributed transaction.

## Tables and ownership

| Table | Authority |
|---|---|
| `properties` | synthetic property timezone label and monotonic configuration revision |
| `inventory_days` | one room-type/stay-date capacity, oversell, block, held, booked, and revision row |
| `availability_queries` | immutable materialized per-night/minimum availability result and inventory revision vector |
| `holds` | immutable stay intent, units, PostgreSQL-authored expiry, state, and state revision |
| `hold_nights` | exact inventory dates owned by one hold |
| `bookings` | one booking identity converted from one hold, state, and revision |
| `booking_nights` | exact inventory dates owned by one booking |
| `expiry_assignments` | shard worker ID and monotonic generation used to fence reapers |
| `mutation_receipts` | principal/key/operation + canonical intent digest -> durable result |

Every inventory day is a self-contained arithmetic cell. Cross-night correctness comes from locking the complete validated date set
and committing all rows plus the hold/booking/receipt together.

## Conservation equation

For every `(property_id, room_type_id, stay_date)`:

```text
sellable_limit = capacity + oversell_units
owned_or_blocked = held_units + booked_units + blocked_units
0 <= each counter
owned_or_blocked <= sellable_limit
available_units = sellable_limit - owned_or_blocked
```

`oversell_units` is explicit and defaults to zero. It is neither a percentage nor a claim that overselling is safe. Capacity,
oversell, or block updates use an expected row revision and reject any value that cannot preserve current obligations.

## Date model

- API boundaries accept canonical local dates only.
- A stay is `[check_in_date, check_out_date)` and contains every calendar date from check-in through the day before checkout.
- The property stores an IANA timezone label for lineage, but v0.1 does not convert arrival instants or implement check-in times.
- Enumerating dates uses calendar arithmetic, so a stay across a daylight-saving transition still owns one cell per local night.
- Every date must already exist in the configured inventory horizon; a missing row is not zero availability.

## Availability materialization

1. Validate one bounded date interval.
2. In one database statement/transaction read every exact inventory day in ascending order.
3. Require the exact number of dates; otherwise return `inventory_horizon_gap`.
4. Store each available count, the minimum across nights, and each inventory revision in one immutable query result.
5. Later inventory changes do not mutate that result. The result is advisory and cannot be used as an ownership receipt.

## Hold transaction

1. Check `(principal, request_key, operation)` receipt; replay exact digest, conflict on changed digest.
2. Bind `hold_id` to one immutable intent; changed entity reuse conflicts.
3. Lock every required inventory row ordered by property, room type, and date.
4. Recompute live conservation and reject the whole request if any date lacks units.
5. Increment `held_units` on every date, create the hold/night ledger, and let PostgreSQL author `expires_at` from
   `statement_timestamp()` plus the bounded lease.
6. Store the result receipt in the same transaction.

No hold is partially visible. A lost HTTP response can be retried without re-debiting inventory.

## Confirm versus expiry

Both paths first lock the hold row:

```text
active + statement_time < expires_at + confirm -> converted + one booking
active + statement_time >= expires_at + confirm -> expired + release + typed rejection receipt
active + statement_time >= expires_at + current reaper -> expired + release
converted / expired -> replay terminal state; never transition again
```

Confirm locks the owned inventory dates, decrements `held_units`, increments `booked_units`, creates booking/night rows, and stores
the receipt atomically. Reap locks the same dates and only decrements `held_units`. The hold lock makes booking plus release
impossible in committed state.

## Reaper fencing

An operator assigns shard `0` to one worker under expected generation. Each reap transaction late-checks worker ID/generation after
locking the candidate hold and before mutation. A reassigned generation makes the stale worker fail with `stale_assignment`; it
cannot release inventory even if it discovered the hold earlier.

## Cancellation

Cancellation locks the booking, then its inventory dates in stable order. A confirmed booking becomes cancelled while
`booked_units` decrements once. Exact retry returns the stored receipt. This does not imply a payment refund, hotel notification,
room release in a PMS, or guest acknowledgement.

## Failure and recovery

- Database rollback removes state, counter, and receipt together.
- Process death after commit but before response leaves the full mutation plus its replay receipt.
- Four opt-in test hooks kill the API after hold, booking, reap, and cancellation commits. They are disabled unless the exact
  environment flag is set.
- PostgreSQL crash/failover, storage corruption, backup restore, and an independently failing sink are not covered.

## Query/evidence boundary

All mutation results include explicit booleans that remain false for `paymentAuthorized`, `paymentCaptured`, `propertyAccepted`,
`physicalRoomAssigned`, `checkedIn`, `stayCompleted`, and `externalAcceptanceProved`. A booking ID cannot upgrade any of them.
