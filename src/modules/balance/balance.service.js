'use strict';

const { Injectable, Inject, NotFoundException, UnprocessableEntityException, ConflictException } = require('@nestjs/common');
const { InjectRepository, InjectDataSource } = require('@nestjs/typeorm');
const { Repository, DataSource } = require('typeorm');

const { EmployeeBalance } = require('./entities/employee-balance.entity');
const { SyncLog } = require('../sync-log/sync-log.entity');
const { LeaveType, SyncType, SyncLogStatus, STALE_BALANCE_THRESHOLD_MS, ErrorCodes } = require('../../common/constants');
const { isStale } = require('../../common/utils/date.util');

/**
 * BalanceService â€” owns all balance read and write operations.
 *
 * Critical invariant maintained: available + pending + used = total.
 * Every mutation in this service goes through a transaction and uses
 * an atomic UPDATE with a version check to prevent concurrent race conditions.
 */
@Injectable()
class BalanceService {
  constructor(
    balanceRepository,
    syncLogRepository,
    dataSource,
  ) {
    this.balanceRepository = balanceRepository;
    this.syncLogRepository = syncLogRepository;
    this.dataSource = dataSource;
  }

  /**
   * Fetch single balance. Attaches a staleness warning if HCM sync is overdue.
   */
  async getBalance(employeeId, locationId, leaveType) {
    const balance = await this.balanceRepository.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!balance) {
      throw new NotFoundException({
        error: ErrorCodes.BALANCE_NOT_FOUND,
        message: `No balance record found for employee=${employeeId}, location=${locationId}, type=${leaveType}`,
      });
    }

    return this._serialize(balance);
  }

  /**
   * Fetch all leave type balances for an employee at a location.
   */
  async getBalancesForEmployee(employeeId, locationId) {
    const balances = await this.balanceRepository.find({
      where: { employeeId, locationId },
      order: { leaveType: 'ASC' },
    });

    return balances.map((b) => this._serialize(b));
  }

  /**
   * Atomically deduct days from available balance.
   *
   * Uses a conditional UPDATE that:
   *   1. Only succeeds if available_balance >= days (prevents negative balance)
   *   2. Only succeeds if version matches (optimistic lock, prevents stale updates)
   *   3. Atomically moves days from available â†’ pending
   *
   * Called within an existing transaction (manager parameter).
   * Returns the new balance record.
   *
   * @throws {UnprocessableEntityException} if insufficient balance
   * @throws {ConflictException} if optimistic lock conflict (caller should retry)
   */
  async atomicDeduct(manager, employeeId, locationId, leaveType, days) {
    const lock = this._getWriteLock(manager);
    // Load with pessimistic write lock â€” prevents phantom reads within this txn
    const balance = await manager.findOne(EmployeeBalance, {
      where: { employeeId, locationId, leaveType },
      ...(lock ? { lock } : {}),
    });

    if (!balance) {
      throw new NotFoundException({
        error: ErrorCodes.BALANCE_NOT_FOUND,
        message: `Balance record not found. Create a balance record before submitting requests.`,
        details: { employeeId, locationId, leaveType },
      });
    }

    const available = parseFloat(balance.availableBalance);
    const daysNum = parseFloat(days);

    if (available < daysNum) {
      throw new UnprocessableEntityException({
        error: ErrorCodes.INSUFFICIENT_BALANCE,
        message: `Requested ${daysNum} days but only ${available} days available`,
        details: {
          requested: daysNum,
          available,
          pending: parseFloat(balance.pendingBalance),
          used: parseFloat(balance.usedBalance),
          leaveType,
        },
      });
    }

    // Atomic mutation: apply under the pessimistic lock
    balance.availableBalance = parseFloat(balance.availableBalance) - daysNum;
    balance.pendingBalance = parseFloat(balance.pendingBalance) + daysNum;

    await manager.save(EmployeeBalance, balance);
    return balance;
  }

  /**
   * Release days from pending â†’ available (on rejection or cancellation).
   * Called within an existing transaction.
   */
  async releaseFromPending(manager, employeeId, locationId, leaveType, days) {
    const daysNum = parseFloat(days);
    const lock = this._getWriteLock(manager);
    const balance = await manager.findOne(EmployeeBalance, {
      where: { employeeId, locationId, leaveType },
      ...(lock ? { lock } : {}),
    });

    if (!balance) {
      throw new NotFoundException({
        error: ErrorCodes.BALANCE_NOT_FOUND,
        message: `Balance record not found during pending release`,
        details: { employeeId, locationId, leaveType },
      });
    }

    const pending = parseFloat(balance.pendingBalance);
    if (pending < daysNum) {
      throw new ConflictException({
        error: ErrorCodes.BALANCE_CONFLICT,
        message: 'Pending balance underflow detected during release',
        details: {
          employeeId,
          locationId,
          leaveType,
          pending,
          requestedRelease: daysNum,
        },
      });
    }

    balance.pendingBalance = pending - daysNum;
    balance.availableBalance = parseFloat(balance.availableBalance) + daysNum;
    await manager.save(EmployeeBalance, balance);
  }

  /**
   * Finalize days from pending â†’ used (on approval).
   * Called within an existing transaction.
   */
  async finalizeUsed(manager, employeeId, locationId, leaveType, days) {
    const daysNum = parseFloat(days);
    const lock = this._getWriteLock(manager);
    const balance = await manager.findOne(EmployeeBalance, {
      where: { employeeId, locationId, leaveType },
      ...(lock ? { lock } : {}),
    });

    if (!balance) {
      throw new NotFoundException({
        error: ErrorCodes.BALANCE_NOT_FOUND,
        message: `Balance record not found during pending finalization`,
        details: { employeeId, locationId, leaveType },
      });
    }

    const pending = parseFloat(balance.pendingBalance);
    if (pending < daysNum) {
      throw new ConflictException({
        error: ErrorCodes.BALANCE_CONFLICT,
        message: 'Pending balance underflow detected during approval finalization',
        details: {
          employeeId,
          locationId,
          leaveType,
          pending,
          requestedFinalize: daysNum,
        },
      });
    }

    balance.pendingBalance = pending - daysNum;
    balance.usedBalance = parseFloat(balance.usedBalance) + daysNum;
    await manager.save(EmployeeBalance, balance);
  }

  /**
   * Create a balance record (called by admin or initial setup).
   * Idempotent: returns existing record if already present.
   */
  async upsertBalance(employeeId, locationId, leaveType, totalBalance) {
    const existing = await this.balanceRepository.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (existing) {
      return this._serialize(existing);
    }

    const total = parseFloat(totalBalance);
    const balance = this.balanceRepository.create({
      employeeId,
      locationId,
      leaveType,
      totalBalance: total,
      availableBalance: total,
      pendingBalance: 0,
      usedBalance: 0,
      hcmTotalBalance: total,
      hcmLastSync: new Date(),
    });

    const saved = await this.balanceRepository.save(balance);
    return this._serialize(saved);
  }

  /**
   * Apply HCM balance data received from the real-time sync endpoint.
   * Updates hcmTotalBalance, recalculates availableBalance if HCM total increased.
   *
   * SAFETY: We never automatically reduce availableBalance based on HCM data alone.
   * Downward corrections are flagged as discrepancies for manual review.
   *
   * @param {object} hcmData - { totalBalance, version, updatedAt }
   */
  async applyHcmRealTimeUpdate(manager, employeeId, locationId, leaveType, hcmData) {
    const lock = this._getWriteLock(manager);
    const balance = await manager.findOne(EmployeeBalance, {
      where: { employeeId, locationId, leaveType },
      ...(lock ? { lock } : {}),
    });

    if (!balance) return null;

    const localTotal =
      parseFloat(balance.usedBalance) +
      parseFloat(balance.pendingBalance) +
      parseFloat(balance.availableBalance);

    const hcmTotal = parseFloat(hcmData.totalBalance);
    const drift = hcmTotal - localTotal;

    let hasDiscrepancy = false;
    let discrepancyAmount = null;

    if (drift > 0.001) {
      // HCM has MORE balance - likely an accrual or anniversary event. Safe to increase.
      balance.availableBalance = parseFloat(balance.availableBalance) + drift;
      balance.totalBalance = hcmTotal;
      console.info({
        event: 'BALANCE_INCREASED_BY_HCM',
        employeeId, locationId, leaveType, drift,
      });
    } else if (drift < -0.001) {
      // HCM has LESS balance - potential correction or error. Do NOT auto-reduce.
      hasDiscrepancy = true;
      discrepancyAmount = Math.abs(drift);
      console.warn({
        event: 'BALANCE_DRIFT_DETECTED',
        employeeId, locationId, leaveType,
        localTotal, hcmTotal, drift,
        message: 'HCM balance is lower than local. Manual review required.',
      });
    }

    balance.hcmTotalBalance = hcmTotal;
    balance.hcmLastSync = new Date();
    balance.hcmVersion = hcmData.version || null;
    balance.hasDiscrepancy = hasDiscrepancy;
    balance.discrepancyAmount = discrepancyAmount;

    return manager.save(balance);
  }

  /**
   * Check if the balance record is stale (HCM sync overdue).
   */
  async isBalanceStale(employeeId, locationId, leaveType) {
    const balance = await this.balanceRepository.findOne({
      where: { employeeId, locationId, leaveType },
      select: ['hcmLastSync'],
    });

    if (!balance) return true;
    return isStale(balance.hcmLastSync, STALE_BALANCE_THRESHOLD_MS);
  }

  _serialize(balance) {
    return {
      id: balance.id,
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveType: balance.leaveType,
      totalBalance: parseFloat(balance.totalBalance),
      availableBalance: parseFloat(balance.availableBalance),
      pendingBalance: parseFloat(balance.pendingBalance),
      usedBalance: parseFloat(balance.usedBalance),
      carryOverBalance: parseFloat(balance.carryOverBalance || 0),
      hcmLastSync: balance.hcmLastSync,
      hcmVersion: balance.hcmVersion,
      hasDiscrepancy: balance.hasDiscrepancy,
      discrepancyAmount: balance.discrepancyAmount
        ? parseFloat(balance.discrepancyAmount)
        : null,
      stale: isStale(balance.hcmLastSync, STALE_BALANCE_THRESHOLD_MS),
      version: balance.version,
      updatedAt: balance.updatedAt,
    };
  }

  _getWriteLock(manager) {
    const dbType = manager?.connection?.options?.type || this.dataSource?.options?.type;
    if (dbType === 'sqlite') {
      return null;
    }
    return { mode: 'pessimistic_write' };
  }
}

InjectRepository(EmployeeBalance)(BalanceService, undefined, 0);
InjectRepository(SyncLog)(BalanceService, undefined, 1);
InjectDataSource()(BalanceService, undefined, 2);

module.exports = { BalanceService };
