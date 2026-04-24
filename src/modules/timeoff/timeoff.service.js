'use strict';

const {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  BadRequestException,
} = require('@nestjs/common');
const { InjectRepository, InjectDataSource } = require('@nestjs/typeorm');
const { Repository, DataSource, In } = require('typeorm');

const { TimeOffRequest } = require('./entities/timeoff-request.entity');
const { IdempotencyRecord } = require('./entities/idempotency-record.entity');
const { EmployeeBalance } = require('../balance/entities/employee-balance.entity');
const { BalanceService } = require('../balance/balance.service');
const { HcmService } = require('../hcm/hcm.service');

const {
  RequestStatus,
  HcmSyncStatus,
  VALID_TRANSITIONS,
  IDEMPOTENCY_TTL_MS,
  ErrorCodes,
} = require('../../common/constants');

const { calculateDaysRequested, isNotInPast, datesOverlap } = require('../../common/utils/date.util');
const { hashObject } = require('../../common/utils/hash.util');

/**
 * TimeOffService — core business logic for the time-off request lifecycle.
 *
 * Key design principles enforced here:
 *
 * 1. IDEMPOTENCY FIRST: Every write checks the idempotency store before processing.
 *    The idempotency record is written inside the same DB transaction as the balance update.
 *    If the server crashes after commit but before returning, the retry gets the cached response.
 *
 * 2. LOCAL-FIRST COMMIT: The DB transaction (balance deduction + request record) commits
 *    before any HCM communication. HCM is notified asynchronously. This decouples
 *    employee-facing latency from HCM reliability.
 *
 * 3. ATOMIC BALANCE DEDUCTION: Uses pessimistic_write lock + conditional UPDATE with
 *    version check. If affected rows = 0, we surface a 409 to the caller (safe to retry).
 *
 * 4. OVERLAP CHECK: An employee cannot have two PENDING/APPROVED requests for overlapping dates.
 *    This is checked inside the transaction to prevent races.
 */
@Injectable()
class TimeOffService {
  constructor(
    requestRepository,
    idempotencyRepository,
    dataSource,
    balanceService,
    hcmService,
  ) {
    this.requestRepository = requestRepository;
    this.idempotencyRepository = idempotencyRepository;
    this.dataSource = dataSource;
    this.balanceService = balanceService;
    this.hcmService = hcmService;
    this._createLocks = new Map();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CREATE REQUEST
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Submit a time-off request.
   *
   * Flow:
   *   1. Validate input (dates, not in past)
   *   2. Check idempotency — return cached if duplicate
   *   3. Open DB transaction
   *   4. Check for overlapping PENDING/APPROVED requests
   *   5. Atomic balance deduction (pessimistic lock + version check)
   *   6. Insert TimeOffRequest
   *   7. Store idempotency record
   *   8. Commit transaction
   *   9. [Async] Notify HCM — update hcm_sync_status regardless of outcome
   *
   * @param {CreateTimeOffRequestDto} dto
   * @param {string} idempotencyKey - from X-Idempotency-Key header
   * @returns {object} The created request
   */
  async createRequest(dto, idempotencyKey) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key header is required for all write operations',
      });
    }

    // ── Step 1: Input validation ────────────────────────────────────────────
    if (!isNotInPast(dto.startDate)) {
      throw new UnprocessableEntityException({
        error: 'INVALID_DATE_RANGE',
        message: 'startDate cannot be in the past',
      });
    }

    const startD = new Date(dto.startDate + 'T00:00:00Z');
    const endD = new Date(dto.endDate + 'T00:00:00Z');
    if (endD < startD) {
      throw new UnprocessableEntityException({
        error: 'INVALID_DATE_RANGE',
        message: 'endDate must be on or after startDate',
      });
    }

    const daysRequested = calculateDaysRequested(dto.startDate, dto.endDate);
    const requestHash = hashObject(dto);

    // ── Step 2: Idempotency check ──────────────────────────────────────────
    const idempotencyCheck = await this._checkIdempotency(
      idempotencyKey,
      dto.employeeId,
      requestHash,
    );
    if (idempotencyCheck !== null) {
      return idempotencyCheck; // Return cached response — no duplicate processing
    }

    const lockKey = `${dto.employeeId}:${dto.locationId}`;

    // Serialize same employee/location writes to avoid SQLite transaction collisions.
    return this._withCreateLock(lockKey, async () => {
      const lockedIdempotencyCheck = await this._checkIdempotency(
        idempotencyKey,
        dto.employeeId,
        requestHash,
      );
      if (lockedIdempotencyCheck !== null) {
        return lockedIdempotencyCheck;
      }

      // ── Steps 3–8: Transaction ───────────────────────────────────────────
      try {
        const createdRequest = await this._runCreateTransactionWithRetry(async () =>
          this.dataSource.transaction('SERIALIZABLE', async (manager) => {
        // Step 4: Lock all balances for this employee/location to serialize
        // overlap checks even when concurrent requests target different leave types.
        await this._lockEmployeeBalances(manager, dto.employeeId, dto.locationId);

        // Step 5: Check overlapping requests (safely serialized under the lock)
        await this._assertNoOverlap(manager, dto.employeeId, dto.locationId, dto.startDate, dto.endDate);

        // Step 6: Atomic balance deduction
        await this.balanceService.atomicDeduct(
          manager,
          dto.employeeId,
          dto.locationId,
          dto.leaveType,
          daysRequested,
        );

        // Step 7: Create the request record
        const request = manager.create(TimeOffRequest, {
          idempotencyKey,
          employeeId: dto.employeeId,
          locationId: dto.locationId,
          leaveType: dto.leaveType,
          startDate: dto.startDate,
          endDate: dto.endDate,
          daysRequested,
          status: RequestStatus.PENDING,
          requestedBy: dto.employeeId,
          notes: dto.notes || null,
          hcmSyncStatus: HcmSyncStatus.PENDING,
        });
        const saved = await manager.save(TimeOffRequest, request);

        // Step 8: Store idempotency record inside the same transaction.
        // If this transaction rolls back (e.g., balance conflict), the idempotency
        // record is also rolled back — preventing phantom records.
        const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
        await manager.save(IdempotencyRecord, {
          idempotencyKey,
          employeeId: dto.employeeId,
          requestHash,
          responseStatus: 201,
          responseBody: this._serializeRequest(saved),
          expiresAt,
        });

        return saved;
      }));

        // ── Step 9: [Async] HCM notification ───────────────────────────────
        // Fire-and-forget. Failures here do NOT roll back the accepted request.
        this._notifyHcmAsync(
          createdRequest.id,
          dto.employeeId,
          dto.locationId,
          dto.leaveType,
          daysRequested,
        );

        console.info({
          event: 'TIME_OFF_REQUEST_CREATED',
          requestId: createdRequest.id,
          employeeId: dto.employeeId,
          locationId: dto.locationId,
          leaveType: dto.leaveType,
          daysRequested,
          startDate: dto.startDate,
          endDate: dto.endDate,
        });

        return this._serializeRequest(createdRequest);
      } catch (err) {
        if (this._isSqliteConstraintError(err)) {
          const recovered = await this._recoverAfterConstraint(
            idempotencyKey,
            dto.employeeId,
            requestHash,
          );
          if (recovered) {
            return recovered;
          }
        }

        if (this._isSqliteTransientTxError(err)) {
          const recovered = await this._recoverAfterConstraint(
            idempotencyKey,
            dto.employeeId,
            requestHash,
          );
          if (recovered) {
            return recovered;
          }

          throw new ConflictException({
            error: ErrorCodes.BALANCE_CONFLICT,
            message: 'Concurrent write contention detected. Please retry with the same idempotency key.',
          });
        }

        throw err;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // APPROVE
  // ─────────────────────────────────────────────────────────────────────────────

  async approveRequest(requestId, approverId) {
    return this.dataSource.transaction(async (manager) => {
      const request = await this._getRequestLockedOrThrow(manager, requestId);
      this._assertValidTransition(request.status, RequestStatus.APPROVED);

      request.status = RequestStatus.APPROVED;
      request.approvedBy = approverId;
      request.approvedAt = new Date();

      await manager.save(TimeOffRequest, request);

      // Move days: pending → used (balance invariant maintained)
      await this.balanceService.finalizeUsed(
        manager,
        request.employeeId,
        request.locationId,
        request.leaveType,
        parseFloat(request.daysRequested),
      );

      // Fire-and-forget HCM notification
      setImmediate(() =>
        this._notifyApprovalToHcmAsync(request, requestId),
      );

      console.info({
        event: 'TIME_OFF_REQUEST_APPROVED',
        requestId,
        approverId,
        employeeId: request.employeeId,
        daysRequested: parseFloat(request.daysRequested),
      });

      return this._serializeRequest(request);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // REJECT
  // ─────────────────────────────────────────────────────────────────────────────

  async rejectRequest(requestId, approverId, reason) {
    return this.dataSource.transaction(async (manager) => {
      const request = await this._getRequestLockedOrThrow(manager, requestId);
      this._assertValidTransition(request.status, RequestStatus.REJECTED);

      request.status = RequestStatus.REJECTED;
      request.approvedBy = approverId;
      request.approvedAt = new Date();
      request.rejectionReason = reason;

      await manager.save(TimeOffRequest, request);

      // Return days: pending → available
      await this.balanceService.releaseFromPending(
        manager,
        request.employeeId,
        request.locationId,
        request.leaveType,
        parseFloat(request.daysRequested),
      );

      // HCM notification logic removed: A PENDING request never touched the upstream HCM balance,
      // and VALID_TRANSITIONS prevent APPROVED requests from being rejected. Ergo, no refund mutation is needed.

      console.info({
        event: 'TIME_OFF_REQUEST_REJECTED',
        requestId,
        approverId,
        reason,
        employeeId: request.employeeId,
      });

      return this._serializeRequest(request);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────────────────────────────────────

  async cancelRequest(requestId, reason = null) {
    return this.dataSource.transaction(async (manager) => {
      const request = await this._getRequestLockedOrThrow(manager, requestId);
      this._assertValidTransition(request.status, RequestStatus.CANCELLED);

      request.status = RequestStatus.CANCELLED;
      request.rejectionReason = reason;

      await manager.save(TimeOffRequest, request);

      // Return days: pending → available
      await this.balanceService.releaseFromPending(
        manager,
        request.employeeId,
        request.locationId,
        request.leaveType,
        parseFloat(request.daysRequested),
      );
      // No HCM refund needed since ONLY PENDING requests can be CANCELLED according to our matrix.

      console.info({
        event: 'TIME_OFF_REQUEST_CANCELLED',
        requestId,
        employeeId: request.employeeId,
      });

      return this._serializeRequest(request);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────────────────────────────────────

  async getRequest(requestId) {
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException({
        error: ErrorCodes.REQUEST_NOT_FOUND,
        message: `Time-off request ${requestId} not found`,
      });
    }
    return this._serializeRequest(request);
  }

  async listRequests(filters = {}) {
    const { employeeId, locationId, status, limit = 50, offset = 0 } = filters;

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (locationId) where.locationId = locationId;
    if (status) where.status = status;

    const [requests, total] = await this.requestRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(parseInt(limit), 100),
      skip: parseInt(offset),
    });

    return {
      data: requests.map((r) => this._serializeRequest(r)),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check idempotency store.
   * Returns cached response body if key exists and hash matches.
   * Throws 409 if key exists with different hash (client bug or abuse).
   * Returns null if key is new.
   */
  async _checkIdempotency(idempotencyKey, employeeId, requestHash) {
    const existing = await this.idempotencyRepository.findOne({
      where: { idempotencyKey },
    });

    if (!existing) return null;

    // Expired records: treat as if they don't exist (allow re-processing)
    if (new Date(existing.expiresAt) < new Date()) {
      return null;
    }

    if (existing.requestHash !== requestHash) {
      throw new ConflictException({
        error: ErrorCodes.IDEMPOTENCY_CONFLICT,
        message:
          'Idempotency key has already been used for a different request payload. ' +
          'Use a new idempotency key for a new request.',
      });
    }

    // Genuine duplicate — return the original response
    return existing.responseBody;
  }

  /**
   * Check for overlapping PENDING or APPROVED requests.
   * Runs inside a transaction to prevent TOCTOU races.
   */
  async _assertNoOverlap(manager, employeeId, locationId, startDate, endDate) {
    // Load all active requests for the employee/location and check overlap in JS
    // (SQLite doesn't support date range overlap SQL easily without workarounds)
    const activeRequests = await manager.find(TimeOffRequest, {
      where: {
        employeeId,
        locationId,
        status: In([RequestStatus.PENDING, RequestStatus.APPROVED]),
      },
      select: ['id', 'startDate', 'endDate', 'status'],
    });

    for (const existing of activeRequests) {
      if (datesOverlap(startDate, endDate, existing.startDate, existing.endDate)) {
        throw new ConflictException({
          error: ErrorCodes.OVERLAPPING_REQUEST,
          message: `Request overlaps with existing ${existing.status} request`,
          details: {
            conflictingRequestId: existing.id,
            conflictingStatus: existing.status,
            conflictingRange: `${existing.startDate} → ${existing.endDate}`,
            requestedRange: `${startDate} → ${endDate}`,
          },
        });
      }
    }
  }

  /**
   * Lock all balances for the employee/location so request creation serializes
   * across leave types when overlap checks run.
   */
  async _lockEmployeeBalances(manager, employeeId, locationId) {
    const lock = this._getWriteLock(manager);
    await manager.find(EmployeeBalance, {
      where: { employeeId, locationId },
      select: ['id'],
      ...(lock ? { lock } : {}),
    });
  }

  /**
   * Load a request with a pessimistic write lock (within an active transaction).
   * Prevents concurrent status transitions on the same request.
   */
  async _getRequestLockedOrThrow(manager, requestId) {
    const lock = this._getWriteLock(manager);
    const request = await manager.findOne(TimeOffRequest, {
      where: { id: requestId },
      ...(lock ? { lock } : {}),
    });

    if (!request) {
      throw new NotFoundException({
        error: ErrorCodes.REQUEST_NOT_FOUND,
        message: `Time-off request ${requestId} not found`,
      });
    }

    return request;
  }

  /**
   * Validate a status transition.
   * Throws 409 with meaningful message if invalid.
   */
  _assertValidTransition(currentStatus, targetStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new ConflictException({
        error: ErrorCodes.INVALID_STATUS_TRANSITION,
        message: `Cannot transition from ${currentStatus} to ${targetStatus}. ` +
          `Allowed transitions from ${currentStatus}: [${allowed.join(', ') || 'none'}]`,
      });
    }
  }

  async _notifyApprovalToHcmAsync(request, requestId) {
    try {
      let isValidated = request.hcmValidated;

      if (!isValidated) {
        const validation = await this.hcmService.validateRequest(
          request.employeeId,
          request.locationId,
          request.leaveType,
          parseFloat(request.daysRequested),
        );

        if (validation === null) {
          await this.requestRepository.update(requestId, {
            hcmSyncStatus: HcmSyncStatus.PENDING,
            hcmSyncAttempts: request.hcmSyncAttempts + 1,
            hcmLastSyncAt: new Date(),
          });
          return;
        }

        if (validation.valid !== true) {
          await this.requestRepository.update(requestId, {
            hcmSyncStatus: HcmSyncStatus.FAILED,
            hcmValidated: false,
            hcmSyncAttempts: request.hcmSyncAttempts + 1,
            hcmLastSyncAt: new Date(),
          });
          return;
        }

        isValidated = true;
      }

      const res = await this.hcmService.notifyApproval(
        request.employeeId,
        request.locationId,
        request.leaveType,
        parseFloat(request.daysRequested),
        requestId,
      );

      if (res !== null && res.success !== false) {
        await this.requestRepository.update(requestId, {
          hcmSyncStatus: HcmSyncStatus.SUCCESS,
          hcmValidated: isValidated,
          hcmSyncAttempts: request.hcmSyncAttempts + 1,
          hcmLastSyncAt: new Date(),
        });
      } else {
        await this.requestRepository.update(requestId, {
          hcmSyncStatus: HcmSyncStatus.PENDING,
          hcmValidated: isValidated,
          hcmSyncAttempts: request.hcmSyncAttempts + 1,
          hcmLastSyncAt: new Date(),
        });
      }
    } catch (err) {
      await this.requestRepository.update(requestId, {
        hcmSyncStatus: HcmSyncStatus.PENDING,
        hcmSyncAttempts: request.hcmSyncAttempts + 1,
        hcmLastSyncAt: new Date(),
      });
    }
  }

  /**
   * Async HCM validation. Updates hcm_sync_status based on outcome.
   * Called with setImmediate so the main response path is not blocked.
   */
  _notifyHcmAsync(requestId, employeeId, locationId, leaveType, daysRequested) {
    setImmediate(async () => {
      try {
        const result = await this.hcmService.validateRequest(
          employeeId,
          locationId,
          leaveType,
          daysRequested,
        );

        if (result !== null) {
          if (result.valid === false) {
            console.warn({
              event: 'HCM_VALIDATION_REJECTED',
              requestId,
              employeeId,
              message: result.message,
              hcmBalance: result.hcmBalance,
            });

            await this.requestRepository.update(requestId, {
              hcmSyncStatus: HcmSyncStatus.FAILED,
              hcmValidated: false,
              hcmSyncAttempts: 1,
              hcmLastSyncAt: new Date(),
            });
            return;
          }

          await this.requestRepository.update(requestId, {
            hcmSyncStatus: HcmSyncStatus.SUCCESS,
            hcmValidated: true,
            hcmSyncAttempts: 1,
            hcmLastSyncAt: new Date(),
          });
        } else {
          // HCM unavailable — mark for retry by background job
          await this.requestRepository.update(requestId, {
            hcmSyncStatus: HcmSyncStatus.PENDING,
            hcmSyncAttempts: 1,
            hcmLastSyncAt: new Date(),
          });
        }
      } catch (err) {
        await this.requestRepository.update(requestId, {
          hcmSyncStatus: HcmSyncStatus.PENDING,
          hcmSyncAttempts: 1,
        });
      }
    });
  }

  _isSqliteConstraintError(err) {
    const code = err?.code || err?.driverError?.code;
    return code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE';
  }

  _getWriteLock(manager) {
    const dbType = manager?.connection?.options?.type || this.dataSource?.options?.type;
    if (dbType === 'sqlite') {
      return null;
    }
    return { mode: 'pessimistic_write' };
  }

  _isSqliteTransientTxError(err) {
    const code = err?.code || err?.driverError?.code;
    const message = (err?.message || '').toLowerCase();

    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      return true;
    }

    return (
      message.includes('cannot start a transaction within a transaction') ||
      message.includes('database is locked')
    );
  }

  async _runCreateTransactionWithRetry(runTx) {
    const maxAttempts = 3;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runTx();
      } catch (err) {
        if (!this._isSqliteTransientTxError(err) || attempt === maxAttempts) {
          lastErr = err;
          break;
        }

        const backoffMs = 5 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastErr;
  }

  async _withCreateLock(lockKey, fn) {
    const previous = this._createLocks.get(lockKey) || Promise.resolve();

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this._createLocks.set(lockKey, next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._createLocks.get(lockKey) === next) {
        this._createLocks.delete(lockKey);
      }
    }
  }

  async _recoverAfterConstraint(idempotencyKey, employeeId, requestHash) {
    const cached = await this._checkIdempotency(idempotencyKey, employeeId, requestHash);
    if (cached) {
      return cached;
    }

    const existingRequest = await this.requestRepository.findOne({
      where: { idempotencyKey },
    });

    if (existingRequest) {
      return this._serializeRequest(existingRequest);
    }

    return null;
  }

  _serializeRequest(request) {
    return {
      id: request.id,
      idempotencyKey: request.idempotencyKey,
      employeeId: request.employeeId,
      locationId: request.locationId,
      leaveType: request.leaveType,
      startDate: request.startDate,
      endDate: request.endDate,
      daysRequested: parseFloat(request.daysRequested),
      status: request.status,
      requestedBy: request.requestedBy,
      approvedBy: request.approvedBy,
      approvedAt: request.approvedAt,
      rejectionReason: request.rejectionReason,
      notes: request.notes,
      hcmValidated: request.hcmValidated,
      hcmSyncStatus: request.hcmSyncStatus,
      version: request.version,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }
}

InjectRepository(TimeOffRequest)(TimeOffService, undefined, 0);
InjectRepository(IdempotencyRecord)(TimeOffService, undefined, 1);
InjectDataSource()(TimeOffService, undefined, 2);
Inject(BalanceService)(TimeOffService, undefined, 3);
Inject(HcmService)(TimeOffService, undefined, 4);

module.exports = { TimeOffService };
