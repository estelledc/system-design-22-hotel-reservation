# Threat and misuse model

## Assets and trust boundary

The only accepted domain data is synthetic property, room-type, date, inventory, query, hold, booking, cancellation, and failure
data. Protected assets are the bearer token, request/entity identity bindings, per-night inventory ownership, worker generation,
mutation receipts, and evidence wording.

The lab trusts one PostgreSQL 17 instance and the local process environment. It does not trust HTTP callers, client clocks,
request retries, stale workers, advisory reads, arbitrary JSON, logs, or claims attached to booking IDs.

## Threats and controls

| Threat | Control | Residual boundary |
|---|---|---|
| duplicate POST after response loss | operation-scoped request key + immutable digest + durable result | receipt retention horizon is not physically pruned/tested |
| same key/entity with changed dates or units | typed idempotency/entity conflict | caller identity is one lab principal, not production IAM |
| final-unit double sale | ordered `FOR UPDATE` date rows + row conservation constraint | one PostgreSQL authority only |
| partial multi-night hold | exact date-count check + one transaction | no cross-database itinerary |
| checkout night over-debit | canonical `[check_in, check_out)` enumeration and generated tests | arrival/departure instants not modelled |
| client releases by local clock | PostgreSQL statement time under locked hold | clock discipline/failover not proven |
| stale reaper releases current ownership | late assignment generation check | one fixed expiry shard |
| capacity/block change deletes obligations | expected revision + current held/booked conservation check | no relocation workflow |
| cancellation releases twice | locked booking transition + exact receipt | payment/property cancellation is absent |
| stale availability called a reservation | immutable result says `ownershipProved: false`; live hold rechecks | no cache or read replica implementation |
| ID/date/rate/token leakage in logs | low-cardinality structured logs and repository scan | database contents and infrastructure logs need separate controls |
| booking ID upgraded to payment/check-in proof | explicit false evidence flags in every result/state | external consumers can still misuse data outside this lab |
| dependency/action/image drift | exact npm lock, full action SHAs, PostgreSQL image digest, audit | unknown/supply-chain vulnerabilities remain possible |

## Deliberately absent sensitive fields

There are no real guest/property/staff names, addresses, contacts, room numbers, confirmation codes, prices, currencies, cards,
payment tokens, loyalty IDs, identity documents, access keys, notes, production occupancy, or internal topology. The API rejects
unknown fields so they cannot be silently stored as metadata.

## Not proved

TLS termination, production authentication/authorization, tenant isolation, secret rotation, rate limiting, WAF/abuse prevention,
database encryption, backup/restore, PostgreSQL HA, audit export, data-subject rights, PCI/privacy compliance, payment/fraud,
property integration, physical safety/access, deployment, SLA, and external acceptance are outside v0.1.
