# Verification ledger

## Current status

Local implementation gates pass on Node `v26.7.0` and PostgreSQL `17.11 (Homebrew)`. Public repository, clean-clone reproduction,
Node 22/24/26 GitHub Actions, and external acceptance are pending. This page will not call the repository complete until public
receipts exist.

## Local correctness receipts

| Gate | Current local result | Proves | Does not prove |
|---|---|---|---|
| `npm test` | 18 pure tests, 0 failed/skipped/todo | exact contracts, dates, conservation, evidence flags, HTTP/auth/log shape | persistence, concurrency, restart |
| `npm run test:infra` | 9 PostgreSQL tests, 0 failed/skipped/todo | snapshots, atomic multi-night/final-unit behavior, replay/conflict, expiry, fencing, cancellation, oversell | PostgreSQL failover, distributed services |
| `npm run smoke:infra` | 4 API processes ended by `SIGKILL`; all exact retries recovered | response-loss recovery after four real commit boundaries | power loss, host/disk failure, external participants |
| `npm run benchmark:infra` | fixed fixture completed | bounded observation for this implementation/runtime/database | production demand, throughput, occupancy, cost, SLA |
| `npm audit --audit-level=high` | 0 vulnerabilities at lock generation | current registry advisory result | absence of unknown/supply-chain vulnerabilities |

## True-process crash receipt

The smoke uses separate operating-system processes and kills them after these repository methods commit but before HTTP response:

1. hold commit: exact request recovers active hold revision `1` without another debit;
2. hold-to-booking commit: exact request recovers booking revision `1` with held units converted once;
3. authoritative reap commit: exact request recovers expired hold revision `2` without another release;
4. cancellation commit: exact request recovers cancelled booking revision `2` without another release.

The final state has zero held units and three booked inventory-day units for one remaining three-night booking. Every receipt reports
payment authorization/capture, property acceptance, physical room assignment, check-in, stay completion, and external acceptance
as false.

## Fixed benchmark fixture and local observation

Fixture:

- 2 properties, 4 room types each, and 256 configured inventory days;
- 64 materialized availability queries and 32 regular two-night holds;
- 16 confirmations, 8 cancellations, 8 one-second holds, and 8 authoritative reaps;
- 8 concurrent final-unit attempts with exactly 1 winner and 7 typed inventory conflicts.

One local Node `v26.7.0` / PostgreSQL `17.11` run observed:

| Observation | Value |
|---|---:|
| inventory configuration | 1,641.497 rows/s; 155.955 ms total |
| materialized query | p50 0.595 ms; p95 0.812 ms |
| all-night hold | p50 0.863 ms; p95 1.232 ms |
| confirmation | p50 1.075 ms; p95 3.779 ms |
| cancellation | p50 0.745 ms |
| expiry reap | p50 1.074 ms |
| 8-way final-unit race | 28.115 ms total |

This was one sequential local run. It excludes catalogue/ranking, network queueing, rates/taxes/payment/refund/ledger, property
channel/physical room/check-in, database replication/failover, distributed services, and production demand/capacity/SLA.

## Failures found before public CI

The first PostgreSQL command failed before loading tests because only the lockfile had been generated and `pg` was not installed.
After `npm ci`, 7/9 tests passed; the two expiry fixtures attempted to set `expires_at` before `created_at`, correctly violating the
schema. The fixture now moves both timestamps into the past while preserving `expires_at > created_at`. No product constraint or
assertion was weakened. The eventual public history must still disclose whether its first run is green.

## Remaining completion gates

- repository policy/link/privacy scan and full local `check:ci`;
- implementation commit with clean worktree;
- public GitHub repository, topics, description, and default branch;
- public Node 22/24/26 + PostgreSQL 17.11 run with zero skips and exact per-job results;
- final documentation commit and a second green public run if evidence text changes;
- parent project card/plan/restore metadata update bound to the final remote commit.
