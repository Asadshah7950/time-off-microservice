'use strict';

const { Injectable, Inject } = require('@nestjs/common');
const { InjectRepository, InjectDataSource } = require('@nestjs/typeorm');
const { Repository, DataSource, LessThan } = require('typeorm');
const { Cron, CronExpression } = require('@nestjs/schedule');

const { HcmService } = require('./hcm.service');
const { EmployeeBalance } = require('../balance/entities/employee-balance.entity');
const { TimeOffRequest } = require('../timeoff/entities/timeoff-request.entity');
const { SyncLog } = require('../sync-log/sync-log.entity');
const { SyncType, SyncLogStatus, HcmSyncStatus, RequestStatus } = require('../../common/constants');

const BATCH_SYNC_CRON = process.env.BATCH_SYNC_CRON || '0 2 * * *';
const PENDING_RETRY_CRON = process.env.HCM_PENDING_RETRY_CRON || '*/15 * * * *';
const MAX_PENDING_SYNC_RETRIES = 10;

/**
 * HcmSyncService — manages all batch reconciliation and background HCM sync retries.
 *
 * Two scheduled jobs:
 *   1. runBatchSync() — nightly: full balance reconciliation against HCM
 *   2. retryPendingHcmSyncs() — every 15min: retry failed HCM notifications
 *
 * Batch reconciliation strategy:
 *   - Load all balances from HCM in one call (cheaper than N per-employee calls).
 *   - For each record: compute drift = hcmTotal - (used + pending + available)
 *   - Positive drift (HCM has MORE): accrual event — safely increase available
 *   - Negative drift (HCM has LESS): discrepancy — flag, do NOT auto-reduce
 *   - Records not returned by HCM are left unchanged (HCM might be returning partial data)
 */
@Injectable()
class HcmSyncService {
  constructor(
    hcmService,
    balanceRepository,
    requestRepository,
    syncLogRepository,
    dataSource,
  ) {
    this.hcmService = hcmService;
    this.balanceRepository = balanceRepository;
    this.requestRepository = requestRepository;
    this.syncLogRepository = syncLogRepository;
    this.dataSource = dataSource;
    this._batchRunning = false;
  }

  /**
   * Nightly batch reconciliation.
   * Guards against overlapping runs with a simple in-process lock.
   * In a multi-instance deployment, use a distributed lock (Redis SETNX or DB advisory lock).
   */
  @Cron(BATCH_SYNC_CRON)
  async runBatchSync() {
    if (this._batchRunning) {
      console.warn({ event: 'BATCH_SYNC_SKIPPED', reason: 'Previous run still in progress' });
      return;
    }

    this._batchRunning = true;
    const syncLog = await this.syncLogRepository.save({
      syncType: SyncType.BATCH,
      status: SyncLogStatus.STARTED,
      startedAt: new Date(),
      recordsProcessed: 0,
      recordsUpdated: 0,
      recordsFailed: 0,
    });

    console.info({ event: 'BATCH_SYNC_STARTED', syncLogId: syncLog.id });

    let recordsProcessed = 0;
    let recordsUpdated = 0;
    let recordsFailed = 0;
    const errors = [];

    try {
      const hcmBalances = await this.hcmService.getBatchBalances();

      if (!hcmBalances || !Array.isArray(hcmBalances)) {
        throw new Error('HCM batch endpoint returned invalid or empty response');
      }

      const hcmKeySet = new Set(
        hcmBalances.map((r) => `${r.employeeId}|${r.locationId}|${r.leaveType}`),
      );

      for (const hcmRecord of hcmBalances) {
        recordsProcessed++;
        try {
          const updated = await this._reconcileRecord(hcmRecord);
          if (updated) recordsUpdated++;
        } catch (err) {
          recordsFailed++;
          errors.push({
            employeeId: hcmRecord.employeeId,
            locationId: hcmRecord.locationId,
            leaveType: hcmRecord.leaveType,
            error: err.message,
          });
          console.error({
            event: 'BATCH_SYNC_RECORD_FAILED',
            record: hcmRecord,
            error: err.message,
          });
        }
      }

      // Full-refresh safety: account for local records omitted by HCM snapshot.
      const localBalances = await this.balanceRepository.find({
        select: ['id', 'employeeId', 'locationId', 'leaveType', 'hasDiscrepancy', 'discrepancyAmount'],
      });

      for (const local of localBalances) {
        const key = `${local.employeeId}|${local.locationId}|${local.leaveType}`;
        if (hcmKeySet.has(key)) {
          continue;
        }

        recordsProcessed++;
        recordsFailed++;
        errors.push({
          employeeId: local.employeeId,
          locationId: local.locationId,
          leaveType: local.leaveType,
          error: 'Balance missing from HCM batch payload',
        });

        await this.balanceRepository.update(local.id, {
          hasDiscrepancy: true,
          discrepancyAmount: local.discrepancyAmount || 0,
          hcmLastSync: new Date(),
        });
      }

      const finalStatus =
        recordsFailed === 0
          ? SyncLogStatus.COMPLETED
          : recordsFailed < recordsProcessed
          ? SyncLogStatus.PARTIAL
          : SyncLogStatus.FAILED;

      await this.syncLogRepository.update(syncLog.id, {
        status: finalStatus,
        recordsProcessed,
        recordsUpdated,
        recordsFailed,
        errorDetails: errors.length > 0 ? errors : null,
        completedAt: new Date(),
      });

      console.info({
        event: 'BATCH_SYNC_COMPLETED',
        syncLogId: syncLog.id,
        status: finalStatus,
        recordsProcessed,
        recordsUpdated,
        recordsFailed,
      });
    } catch (err) {
      await this.syncLogRepository.update(syncLog.id, {
        status: SyncLogStatus.FAILED,
        recordsProcessed,
        recordsUpdated,
        recordsFailed,
        errorDetails: [{ error: err.message }],
        completedAt: new Date(),
      });

      console.error({
        event: 'BATCH_SYNC_FAILED',
        syncLogId: syncLog.id,
        error: err.message,
      });
    } finally {
      this._batchRunning = false;
    }
  }

  /**
   * Reconcile a single HCM balance record against local state.
   * Returns true if local balance was updated.
   */
  async _reconcileRecord(hcmRecord) {
    const { employeeId, locationId, leaveType, totalBalance: hcmTotalStr, version } = hcmRecord;
    const hcmTotal = parseFloat(hcmTotalStr);

    const localBalance = await this.balanceRepository.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!localBalance) {
      // New employee or leave type not yet in local DB — create it
      await this.balanceRepository.save({
        employeeId,
        locationId,
        leaveType,
        totalBalance: hcmTotal,
        availableBalance: hcmTotal,
        pendingBalance: 0,
        usedBalance: 0,
        hcmTotalBalance: hcmTotal,
        hcmLastSync: new Date(),
        hcmVersion: version || null,
      });
      return true;
    }

    const localUsed = parseFloat(localBalance.usedBalance);
    const localPending = parseFloat(localBalance.pendingBalance);
    const localAvailable = parseFloat(localBalance.availableBalance);
    const localTotal = localUsed + localPending + localAvailable;

    const drift = hcmTotal - localTotal;
    const DRIFT_TOLERANCE = 0.01; // Accept up to 0.01 floating point noise

    if (Math.abs(drift) <= DRIFT_TOLERANCE) {
      // No meaningful drift — just update sync metadata
      await this.balanceRepository.update(localBalance.id, {
        hcmTotalBalance: hcmTotal,
        hcmLastSync: new Date(),
        hcmVersion: version || null,
        hasDiscrepancy: false,
        discrepancyAmount: null,
      });
      return false;
    }

    if (drift > DRIFT_TOLERANCE) {
      // HCM increased balance (accrual, anniversary, manual correction) — safe to increase
      const newAvailable = localAvailable + drift;
      await this.balanceRepository.update(localBalance.id, {
        totalBalance: hcmTotal,
        availableBalance: newAvailable,
        hcmTotalBalance: hcmTotal,
        hcmLastSync: new Date(),
        hcmVersion: version || null,
        hasDiscrepancy: false,
        discrepancyAmount: null,
      });
      console.info({
        event: 'BALANCE_INCREASED_BY_BATCH_SYNC',
        employeeId, locationId, leaveType,
        drift, newAvailable,
      });
      return true;
    }

    // drift < -DRIFT_TOLERANCE: HCM has LESS than we tracked
    // We do NOT auto-reduce because:
    //   a) Approved requests already committed — revoking would surprise employees
    //   b) The drift could be a temporary HCM data issue
    //   c) Admins should confirm before any reduction
    await this.balanceRepository.update(localBalance.id, {
      hcmTotalBalance: hcmTotal,
      hcmLastSync: new Date(),
      hcmVersion: version || null,
      hasDiscrepancy: true,
      discrepancyAmount: Math.abs(drift),
    });

    console.warn({
      event: 'BALANCE_DRIFT_DETECTED',
      employeeId, locationId, leaveType,
      localTotal, hcmTotal, drift,
      message: 'Local balance exceeds HCM total. Manual admin review required.',
    });

    return true;
  }

  /**
   * Retries requests with hcmSyncStatus=PENDING (HCM notification failed on original attempt).
   * Runs every 15 minutes.
   */
  @Cron(PENDING_RETRY_CRON)
  async retryPendingHcmSyncs() {
    const pendingRequests = await this.requestRepository.find({
      where: { hcmSyncStatus: HcmSyncStatus.PENDING },
      take: 50,
      order: { hcmSyncAttempts: 'ASC', createdAt: 'ASC' },
    });

    if (pendingRequests.length === 0) return;

    console.info({
      event: 'HCM_PENDING_RETRY_START',
      count: pendingRequests.length,
    });

    for (const request of pendingRequests) {
      if (request.hcmSyncAttempts >= MAX_PENDING_SYNC_RETRIES) {
        await this.requestRepository.update(request.id, {
          hcmSyncStatus: HcmSyncStatus.FAILED,
          hcmLastSyncAt: new Date(),
        });
        console.error({
          event: 'HCM_SYNC_MAX_RETRIES_EXCEEDED',
          requestId: request.id,
          employeeId: request.employeeId,
          attempts: request.hcmSyncAttempts,
        });
        continue;
      }

      try {
        if (request.status === RequestStatus.REJECTED || request.status === RequestStatus.CANCELLED) {
          await this._updateSyncAttempt(request, {
            hcmSyncStatus: HcmSyncStatus.SKIPPED,
          });
          continue;
        }

        if (request.status === RequestStatus.PENDING) {
          await this._retryValidationOnly(request);
          continue;
        }

        if (request.status === RequestStatus.APPROVED) {
          await this._retryApprovalFlow(request);
          continue;
        }

        await this._updateSyncAttempt(request, {
          hcmSyncStatus: HcmSyncStatus.FAILED,
        });
      } catch (err) {
        await this._updateSyncAttempt(request, {
          hcmSyncStatus: HcmSyncStatus.PENDING,
        });
      }
    }
  }

  async _retryValidationOnly(request) {
    const validation = request.hcmValidated
      ? { valid: true }
      : await this.hcmService.validateRequest(
          request.employeeId,
          request.locationId,
          request.leaveType,
          parseFloat(request.daysRequested),
        );

    if (validation === null) {
      await this._updateSyncAttempt(request, {
        hcmSyncStatus: HcmSyncStatus.PENDING,
      });
      return;
    }

    if (validation.valid !== true) {
      await this._updateSyncAttempt(request, {
        hcmSyncStatus: HcmSyncStatus.FAILED,
        hcmValidated: false,
      });
      return;
    }

    await this._updateSyncAttempt(request, {
      hcmSyncStatus: HcmSyncStatus.SUCCESS,
      hcmValidated: true,
    });
  }

  async _retryApprovalFlow(request) {
    let isValidated = request.hcmValidated;

    if (!isValidated) {
      const validation = await this.hcmService.validateRequest(
        request.employeeId,
        request.locationId,
        request.leaveType,
        parseFloat(request.daysRequested),
      );

      if (validation === null) {
        await this._updateSyncAttempt(request, {
          hcmSyncStatus: HcmSyncStatus.PENDING,
        });
        return;
      }

      if (validation.valid !== true) {
        await this._updateSyncAttempt(request, {
          hcmSyncStatus: HcmSyncStatus.FAILED,
          hcmValidated: false,
        });
        return;
      }

      isValidated = true;
    }

    const approval = await this.hcmService.notifyApproval(
      request.employeeId,
      request.locationId,
      request.leaveType,
      parseFloat(request.daysRequested),
      request.id,
    );

    if (approval !== null && approval.success !== false) {
      await this._updateSyncAttempt(request, {
        hcmSyncStatus: HcmSyncStatus.SUCCESS,
        hcmValidated: isValidated,
      });
      return;
    }

    await this._updateSyncAttempt(request, {
      hcmSyncStatus: HcmSyncStatus.PENDING,
      hcmValidated: isValidated,
    });
  }

  async _updateSyncAttempt(request, patch) {
    await this.requestRepository.update(request.id, {
      ...patch,
      hcmSyncAttempts: request.hcmSyncAttempts + 1,
      hcmLastSyncAt: new Date(),
    });
  }

  /**
   * Get sync logs (for admin endpoint).
   */
  async getSyncLogs(limit = 20) {
    return this.syncLogRepository.find({
      order: { startedAt: 'DESC' },
      take: Math.min(limit, 100),
    });
  }

  /**
   * Manually trigger batch sync (for admin use).
   * Only allowed if no batch is already running.
   */
  async triggerManualBatchSync() {
    if (this._batchRunning) {
      throw new Error('Batch sync already in progress');
    }
    // Run asynchronously so the HTTP response returns immediately
    setImmediate(() => this.runBatchSync());
    return { triggered: true, message: 'Batch sync started in background' };
  }
}

Inject(HcmService)(HcmSyncService, undefined, 0);
InjectRepository(EmployeeBalance)(HcmSyncService, undefined, 1);
InjectRepository(TimeOffRequest)(HcmSyncService, undefined, 2);
InjectRepository(SyncLog)(HcmSyncService, undefined, 3);
InjectDataSource()(HcmSyncService, undefined, 4);

module.exports = { HcmSyncService };
