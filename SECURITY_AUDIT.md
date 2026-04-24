# Security Audit

## Scope

Audit scope covered:

- API entry points and request validation.
- Concurrency and data-integrity controls.
- Error handling and information disclosure.
- External HCM integration resilience.
- Runtime hardening defaults.

## Executive Summary

Overall security posture is improved and suitable for controlled environments. Core integrity controls are strong (idempotency, transactional balance mutation, overlap prevention), and runtime hardening now includes security headers and rate limiting.

Remaining high-impact gap is missing authentication/authorization, which must be implemented before public deployment.

## Findings

### 1) Missing Authentication and Authorization

- Severity: High
- Status: Open (not implemented in this pass)
- Risk:
  - Any client can create/approve/reject/cancel requests.
  - Admin-like endpoints are reachable without identity checks.
- Recommendation:
  - Add JWT or mTLS-based identity.
  - Enforce RBAC (employee, manager, admin) on write/admin routes.

### 2) CORS Was Previously Open by Default

- Severity: Medium
- Status: Mitigated
- Fix implemented:
  - CORS is now configurable via `CORS_ORIGINS`.
  - Explicit methods/headers are configured.
- Residual risk:
  - If `CORS_ORIGINS` is unset, fallback remains permissive for local usability.

### 3) No Runtime Security Headers

- Severity: Medium
- Status: Mitigated
- Fix implemented:
  - Added `helmet` middleware.
  - Disabled `X-Powered-By` header.

### 4) No Request Rate Limiting

- Severity: Medium
- Status: Mitigated
- Fix implemented:
  - Added global rate limiting with configurable window and budget:
    - `RATE_LIMIT_WINDOW_MS`
    - `RATE_LIMIT_MAX_REQUESTS`
  - Automatically disabled during `NODE_ENV=test` for test determinism.

### 5) Error Detail Exposure Risk

- Severity: Low
- Status: Mitigated
- Existing control:
  - Global exception filter returns normalized safe envelope.
  - Unexpected exceptions are logged server-side and not leaked to client.

### 6) ORM Safety and Injection Surface

- Severity: Low
- Status: Mitigated
- Existing control:
  - TypeORM repository/query APIs are used for persistence.
  - No dynamic raw SQL construction in critical write paths.

### 7) Data Integrity Under Concurrency

- Severity: Low (security-by-integrity)
- Status: Mitigated
- Existing control:
  - Idempotency hash checks and transaction-bound writes.
  - SQLite contention handling with retry and lock-lane serialization.
  - Overlap detection and status transition matrix enforcement.

## Hardening Changes Implemented in This Pass

- Added `helmet` middleware in API bootstrap.
- Added configurable global rate limiting.
- Added configurable CORS origins and explicit allowed headers/methods.
- Disabled `X-Powered-By` header.

## Recommended Next Steps (Pre-Production)

1. Implement authn/authz on all mutating and admin routes.
2. Add secret management policy (no plaintext secrets in local files for deployed envs).
3. Replace SQLite with managed RDBMS and controlled migrations.
4. Add audit logging fields for actor identity after auth is introduced.
5. Add abuse monitoring dashboards and alerting for rate-limit violations.
