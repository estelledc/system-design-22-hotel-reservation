# Verification ledger

## Current status

Local implementation gates pass on Node `v26.7.0` and PostgreSQL `17.11 (Homebrew)`. The first public implementation run,
[GitHub Actions 32203383219](https://github.com/estelledc/system-design-22-hotel-reservation/actions/runs/32203383219), passed from
commit `5e5b10c2b42b8500918737db69e1185abe04a75e` in clean GitHub checkouts on Node 22/24/26 with the pinned PostgreSQL 17.11
container. Payment, property, room, check-in, production capacity, SLA, and external acceptance remain unproved and out of scope.

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
assertion was weakened. The public history shows that the first implementation run was green.

## First public implementation run

Run `32203383219` used PostgreSQL `17.11` in every job. Each job passed the repository policy/link/privacy scan, dependency audit,
18 pure tests, 9 real-PostgreSQL tests, four-process crash smoke, and the fixed benchmark with zero test failures, skips, or todos.

| Job | Runtime | Result | Inventory rows/s | Query p50 / p95 | Hold p50 / p95 | Confirm p50 / p95 | Cancel / reap p50 | 8-way race |
|---|---|---|---:|---:|---:|---:|---:|---:|
| [`95921655731`](https://github.com/estelledc/system-design-22-hotel-reservation/actions/runs/32203383219/job/95921655731) | Node `v22.23.2` | 18 + 9 tests; 0 fail/skip/todo | 354.896 | 3.001 / 3.831 ms | 4.222 / 8.779 ms | 4.869 / 8.747 ms | 3.324 / 3.683 ms | 39.071 ms |
| [`95921655735`](https://github.com/estelledc/system-design-22-hotel-reservation/actions/runs/32203383219/job/95921655735) | Node `v24.19.0` | 18 + 9 tests; 0 fail/skip/todo | 393.057 | 2.644 / 3.136 ms | 4.066 / 4.365 ms | 5.092 / 7.807 ms | 3.340 / 3.713 ms | 39.845 ms |
| [`95921655769`](https://github.com/estelledc/system-design-22-hotel-reservation/actions/runs/32203383219/job/95921655769) | Node `v26.7.0` | 18 + 9 tests; 0 fail/skip/todo | 393.093 | 2.571 / 3.610 ms | 3.925 / 5.011 ms | 4.839 / 7.795 ms | 3.372 / 3.563 ms | 42.205 ms |

These are concurrent hosted-runner observations, not a controlled Node-version comparison. Runner load, shared database-container
resources, and scheduling differ; the values establish only that the bounded fixture completed and emitted its receipt.

## Completion accounting

- Repository policy/link/privacy scan and full local `check:ci`: complete.
- Implementation commit with clean worktree: complete at `5e5b10c2b42b8500918737db69e1185abe04a75e`.
- Public repository, topics, description, and default `main`: complete.
- First public Node 22/24/26 + PostgreSQL 17.11 run: complete and green at `32203383219`.
- Documentation evidence update: this commit must pass the same public matrix before the final remote commit is recorded in parent
  restore metadata.
- External acceptance: not requested, not run, and not implied by repository completion.
