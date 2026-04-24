'use strict';

const LeaveType = {
  VACATION: 'VACATION',
  SICK: 'SICK',
  PERSONAL: 'PERSONAL',
  MATERNITY: 'MATERNITY',
  PATERNITY: 'PATERNITY',
  BEREAVEMENT: 'BEREAVEMENT',
};

const RequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

const HcmSyncStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
};

const SyncType = {
  REALTIME: 'REALTIME',
  BATCH: 'BATCH',
};

const SyncLogStatus = {
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
};

const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

const ErrorCodes = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  BALANCE_CONFLICT: 'BALANCE_CONFLICT',
  OVERLAPPING_REQUEST: 'OVERLAPPING_REQUEST',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  HCM_UNAVAILABLE: 'HCM_UNAVAILABLE',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  BALANCE_NOT_FOUND: 'BALANCE_NOT_FOUND',
};

// Valid status transitions: from → allowed next states
const VALID_TRANSITIONS = {
  [RequestStatus.PENDING]: [
    RequestStatus.APPROVED,
    RequestStatus.REJECTED,
    RequestStatus.CANCELLED,
  ],
  [RequestStatus.APPROVED]: [],
  [RequestStatus.REJECTED]: [],
  [RequestStatus.CANCELLED]: [],
};

const STALE_BALANCE_THRESHOLD_MS = parseInt(
  process.env.BALANCE_STALE_THRESHOLD_HOURS || '6',
) * 60 * 60 * 1000;

const IDEMPOTENCY_TTL_MS = parseInt(
  process.env.IDEMPOTENCY_TTL_HOURS || '24',
) * 60 * 60 * 1000;

module.exports = {
  LeaveType,
  RequestStatus,
  HcmSyncStatus,
  SyncType,
  SyncLogStatus,
  CircuitState,
  ErrorCodes,
  VALID_TRANSITIONS,
  STALE_BALANCE_THRESHOLD_MS,
  IDEMPOTENCY_TTL_MS,
};
