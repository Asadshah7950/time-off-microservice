# Time-Off Service

## GitHub Repository
https://github.com/Asadshah7950/time-off-microservice

This submission implements a production-minded NestJS + SQLite time-off microservice that goes beyond CRUD by handling idempotent writes, concurrency-safe balance mutations, and eventually consistent HCM synchronization under upstream instability. The design matters because it protects user-facing request flow even when HCM is slow or unavailable, while still preserving balance invariants and auditability. Core paths include transactional create/approve/reject/cancel workflows, asynchronous HCM sync state tracking, retry with circuit breaking, and batch reconciliation with safe drift handling. The test suite is intentionally failure-mode driven: it covers race conditions, idempotency collisions, transient HCM outages, deterministic mismatches, and reconciliation scenarios that are common in real production systems. Coverage is high across statements, branches, functions, and lines, with branch-focused tests added for control-heavy utilities and sync logic. A deliberate tradeoff is local-first commit with eventual upstream convergence, which favors availability and predictable latency over strict cross-system immediacy.

Resilient NestJS service for employee leave requests with idempotent writes, balance invariants, and eventual consistency against an unreliable external HCM.

## What This Service Guarantees

- Exactly-once write semantics for create requests via `X-Idempotency-Key`.
- No negative balances through transactional mutations (`available + pending + used = total`).
- No overlapping active requests (`PENDING` or `APPROVED`) for the same employee/location date window.
- Local commit is never blocked by HCM outages; upstream sync is retried asynchronously.
- Batch reconciliation detects drift and safely applies only non-destructive corrections.

## Architecture and Design Docs

- Technical requirements and decision log: `TRD.md`
- Security audit and hardening summary: `SECURITY_AUDIT.md`

## Prerequisites

- Node.js 18+
- npm 9+
- Windows note: use `npm.cmd` instead of `npm` in PowerShell environments with restricted execution policy.

## Setup

Three-step quick start:

```bash
npm install
copy .env.example .env
npm run start:mock-hcm
```

Linux/macOS copy command:

```bash
cp .env.example .env
```

## Run Locally

Start the mock HCM in terminal 1:

```bash
npm run start:mock-hcm
```

Start the API in terminal 2:

```bash
npm run start:dev
```

Default ports:

- API: `3000`
- Mock HCM data API: `3001`
- Mock HCM admin API: `3101`

## API Surface

Time-off:

- `POST /time-off/requests` (requires `X-Idempotency-Key`)
- `GET /time-off/requests`
- `GET /time-off/requests/:id`
- `PATCH /time-off/requests/:id/approve`
- `PATCH /time-off/requests/:id/reject`
- `PATCH /time-off/requests/:id/cancel`

Balances:

- `GET /balances/:employeeId/:locationId`
- `GET /balances/:employeeId/:locationId/:leaveType`
- `POST /balances/admin/seed/:employeeId/:locationId/:leaveType/:total`

HCM sync:

- `POST /hcm/batch-sync`
- `GET /hcm/sync-logs`

## Mock HCM Admin Endpoints

- `POST /admin/inject`
- `POST /admin/anniversary-refresh`
- `POST /admin/year-refresh`
- `POST /admin/behavior`
- `POST /admin/reset-behavior`

## Example Flow

Seed local balance:

```bash
curl -X POST http://localhost:3000/balances/admin/seed/EMP001/LOC1/VACATION/15
```

Create idempotent request:

```bash
curl -X POST http://localhost:3000/time-off/requests \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: req-emp001-2026-06-01" \
  -d '{
    "employeeId": "EMP001",
    "locationId": "LOC1",
    "leaveType": "VACATION",
    "startDate": "2026-06-01",
    "endDate": "2026-06-03"
  }'
```

Approve request:

```bash
curl -X PATCH http://localhost:3000/time-off/requests/<REQUEST_ID>/approve \
  -H "Content-Type: application/json" \
  -d '{ "approverId": "MGR_JANE" }'
```

## Test Commands

One-line smoke check for reviewers:

```bash
npm test
```

Full coverage run:

```bash
npm run test:coverage
```

Latest coverage output:

```text
All files        | Stmts 94.03 | Branch 84.98 | Funcs 91.66 | Lines 94.64
```

Latest verified run:

- Unit: pass
- Integration: pass
- E2E: pass
- Global coverage: `94.03% statements`, `84.98% branches`, `91.66% functions`, `94.64% lines`
- Service-layer coverage:
  - `balance.service.js`: `94.68% statements`, `78.57% branches`, `83.33% functions`, `95.6% lines`
  - `hcm-sync.service.js`: `92.02% statements`, `83.58% branches`, `90.9% functions`, `92.59% lines`
  - `hcm.service.js`: `89.28% statements`, `94.73% branches`, `80% functions`, `89.28% lines`
  - `timeoff.service.js`: `93.65% statements`, `82.29% branches`, `100% functions`, `94.44% lines`

## Operational Notes

- Database is SQLite and currently uses `synchronize: true` for local development speed.
- For production, use migrations and a managed RDBMS (for example PostgreSQL).
- Cron-driven retry and batch schedules are configurable in `.env`.
- Local commit is authoritative; upstream HCM status is tracked by `hcmSyncStatus` (`PENDING/SUCCESS/FAILED/SKIPPED`).

## Test Coverage

```text
--------------------------------|---------|----------|---------|---------|------------------------------------
File                            | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
--------------------------------|---------|----------|---------|---------|------------------------------------
All files                       |   94.03 |    84.98 |   91.66 |   94.64 |
 src                            |     100 |      100 |     100 |     100 |
  app.module.js                 |     100 |      100 |     100 |     100 |
 src/common/constants           |     100 |      100 |     100 |     100 |
  index.js                      |     100 |      100 |     100 |     100 |
 src/common/filters             |     100 |     87.5 |     100 |     100 |
  all-exceptions.filter.js      |     100 |     87.5 |     100 |     100 | 29,32
 src/common/interceptors        |     100 |      100 |     100 |     100 |
  logging.interceptor.js        |     100 |      100 |     100 |     100 |
 src/common/utils               |   97.29 |    88.52 |     100 |   99.03 |
  circuit-breaker.util.js       |     100 |     91.3 |     100 |     100 | 25,29
  date.util.js                  |      96 |       75 |     100 |     100 | 57
  hash.util.js                  |   91.66 |    83.33 |     100 |     100 | 19
  retry.util.js                 |   96.55 |    89.28 |     100 |   95.83 | 74
 src/modules/balance            |   94.91 |    78.57 |   81.25 |   95.65 |
  balance.controller.js         |   94.11 |      100 |      75 |   94.11 | 21
  balance.module.js             |     100 |      100 |     100 |     100 |
  balance.service.js            |   94.68 |    78.57 |   83.33 |    95.6 | 53-58,129,169
 src/modules/balance/entities   |     100 |      100 |     100 |     100 |
  employee-balance.entity.js    |     100 |      100 |     100 |     100 |
 src/modules/hcm                |    91.2 |    86.04 |   79.31 |   91.62 |
  hcm-sync.service.js           |   92.02 |    83.58 |    90.9 |   92.59 | 95-102,347-350,379-382,386-390,430
  hcm.controller.js             |   71.42 |      100 |   33.33 |   71.42 | 19-28
  hcm.module.js                 |     100 |      100 |     100 |     100 |
  hcm.service.js                |   89.28 |    94.73 |      80 |   89.28 | 114-116,154
 src/modules/sync-log           |     100 |      100 |     100 |     100 |
  sync-log.entity.js            |     100 |      100 |     100 |     100 |
  sync-log.module.js            |     100 |      100 |     100 |     100 |
 src/modules/timeoff            |   94.69 |       83 |     100 |   95.37 |
  timeoff.controller.js         |     100 |      100 |     100 |     100 |
  timeoff.module.js             |     100 |      100 |     100 |     100 |
  timeoff.service.js            |   93.65 |    82.29 |     100 |   94.44 | 216-222,227-236,421,494,712,723
 src/modules/timeoff/dto        |   33.33 |      100 |     100 |   33.33 |
  create-timeoff-request.dto.js |   33.33 |      100 |     100 |   33.33 | 10-32
  update-request-status.dto.js  |   33.33 |      100 |     100 |   33.33 | 9-28
 src/modules/timeoff/entities   |     100 |      100 |     100 |     100 |
  idempotency-record.entity.js  |     100 |      100 |     100 |     100 |
  timeoff-request.entity.js     |     100 |      100 |     100 |     100 |
--------------------------------|---------|----------|---------|---------|------------------------------------
```
