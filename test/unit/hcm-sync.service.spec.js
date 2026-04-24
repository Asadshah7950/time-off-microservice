'use strict';

const { HcmSyncService } = require('../../src/modules/hcm/hcm-sync.service');
const { HcmSyncStatus, RequestStatus } = require('../../src/common/constants');

describe('HcmSyncService (Unit)', () => {
  let service;
  let hcmService;
  let requestRepository;
  let balanceRepository;
  let syncLogRepository;

  beforeEach(() => {
    hcmService = {
      validateRequest: jest.fn(),
      notifyApproval: jest.fn(),
      getBatchBalances: jest.fn(),
    };

    requestRepository = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    service = new HcmSyncService();
    service.hcmService = hcmService;
    balanceRepository = { findOne: jest.fn(), save: jest.fn(), update: jest.fn(), find: jest.fn() };
    syncLogRepository = { save: jest.fn(), update: jest.fn(), find: jest.fn() };
    service.balanceRepository = balanceRepository;
    service.requestRepository = requestRepository;
    service.syncLogRepository = syncLogRepository;
    service.dataSource = { transaction: jest.fn() };
  });

  it('marks deterministic validation mismatch as FAILED', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-1',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.PENDING,
        daysRequested: 2,
        hcmValidated: false,
        hcmSyncAttempts: 0,
      },
    ]);
    hcmService.validateRequest.mockResolvedValue({ valid: false, hcmBalance: 0 });

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({
        hcmSyncStatus: HcmSyncStatus.FAILED,
        hcmValidated: false,
        hcmSyncAttempts: 1,
      }),
    );
  });

  it('marks REJECTED/CANCELLED requests as SKIPPED without HCM calls', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-2',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.REJECTED,
        daysRequested: 1,
        hcmValidated: false,
        hcmSyncAttempts: 0,
      },
    ]);

    await service.retryPendingHcmSyncs();

    expect(hcmService.validateRequest).not.toHaveBeenCalled();
    expect(hcmService.notifyApproval).not.toHaveBeenCalled();
    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-2',
      expect.objectContaining({
        hcmSyncStatus: HcmSyncStatus.SKIPPED,
        hcmSyncAttempts: 1,
      }),
    );
  });

  it('keeps APPROVED request as PENDING when approval notification fails transiently', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-3',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.APPROVED,
        daysRequested: 2,
        hcmValidated: true,
        hcmSyncAttempts: 2,
      },
    ]);
    hcmService.notifyApproval.mockResolvedValue(null);

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-3',
      expect.objectContaining({
        hcmSyncStatus: HcmSyncStatus.PENDING,
        hcmValidated: true,
        hcmSyncAttempts: 3,
      }),
    );
  });

  it('marks APPROVED request as SUCCESS after validate + notify succeeds', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-4',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.APPROVED,
        daysRequested: 2,
        hcmValidated: false,
        hcmSyncAttempts: 1,
      },
    ]);
    hcmService.validateRequest.mockResolvedValue({ valid: true, hcmBalance: 10 });
    hcmService.notifyApproval.mockResolvedValue({ success: true });

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-4',
      expect.objectContaining({
        hcmSyncStatus: HcmSyncStatus.SUCCESS,
        hcmValidated: true,
        hcmSyncAttempts: 2,
      }),
    );
  });

  it('marks request as FAILED when max pending retry attempts are exceeded', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-max',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.PENDING,
        daysRequested: 1,
        hcmValidated: false,
        hcmSyncAttempts: 10,
      },
    ]);

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-max',
      expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.FAILED }),
    );
  });

  it('creates a new local balance record when reconcile receives unknown employee/type', async () => {
    balanceRepository.findOne.mockResolvedValue(null);

    const changed = await service._reconcileRecord({
      employeeId: 'EMP2',
      locationId: 'LOC1',
      leaveType: 'SICK',
      totalBalance: 9,
      version: 'v1',
    });

    expect(changed).toBe(true);
    expect(balanceRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'EMP2',
      leaveType: 'SICK',
      totalBalance: 9,
    }));
  });

  it('reconcile returns false when drift is within tolerance', async () => {
    balanceRepository.findOne.mockResolvedValue({
      id: 'bal-1',
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      availableBalance: 8,
      pendingBalance: 1,
      usedBalance: 1,
    });

    const changed = await service._reconcileRecord({
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 10.005,
      version: 'v2',
    });

    expect(changed).toBe(false);
    expect(balanceRepository.update).toHaveBeenCalledWith('bal-1', expect.objectContaining({
      hasDiscrepancy: false,
      discrepancyAmount: null,
    }));
  });

  it('reconcile increases available balance on positive drift', async () => {
    balanceRepository.findOne.mockResolvedValue({
      id: 'bal-2',
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      availableBalance: 7,
      pendingBalance: 1,
      usedBalance: 2,
    });

    const changed = await service._reconcileRecord({
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 14,
      version: 'v3',
    });

    expect(changed).toBe(true);
    expect(balanceRepository.update).toHaveBeenCalledWith('bal-2', expect.objectContaining({
      totalBalance: 14,
      availableBalance: 11,
      hasDiscrepancy: false,
    }));
  });

  it('reconcile marks discrepancy on negative drift without reducing local totals', async () => {
    balanceRepository.findOne.mockResolvedValue({
      id: 'bal-3',
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      availableBalance: 8,
      pendingBalance: 2,
      usedBalance: 2,
    });

    const changed = await service._reconcileRecord({
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 7,
      version: 'v4',
    });

    expect(changed).toBe(true);
    expect(balanceRepository.update).toHaveBeenCalledWith('bal-3', expect.objectContaining({
      hasDiscrepancy: true,
    }));
  });

  it('triggerManualBatchSync throws when a batch is already running', async () => {
    service._batchRunning = true;
    await expect(service.triggerManualBatchSync()).rejects.toThrow('Batch sync already in progress');
  });

  it('triggerManualBatchSync returns triggered=true when idle', async () => {
    const runSpy = jest.spyOn(service, 'runBatchSync').mockResolvedValue(undefined);

    const res = await service.triggerManualBatchSync();

    expect(res.triggered).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runSpy).toHaveBeenCalled();
  });

  it('runBatchSync returns early when a previous run is still in progress', async () => {
    service._batchRunning = true;

    await service.runBatchSync();

    expect(syncLogRepository.save).not.toHaveBeenCalled();
  });

  it('runBatchSync marks FAILED when HCM batch payload is invalid', async () => {
    syncLogRepository.save.mockResolvedValue({ id: 'sync-invalid' });
    hcmService.getBatchBalances.mockResolvedValue(null);

    await service.runBatchSync();

    expect(syncLogRepository.update).toHaveBeenCalledWith(
      'sync-invalid',
      expect.objectContaining({ status: HcmSyncStatus.FAILED }),
    );
  });

  it('runBatchSync marks PARTIAL when HCM omits a local balance', async () => {
    syncLogRepository.save.mockResolvedValue({ id: 'sync-partial' });
    hcmService.getBatchBalances.mockResolvedValue([
      {
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        totalBalance: 10,
        version: 'v1',
      },
    ]);

    jest.spyOn(service, '_reconcileRecord').mockResolvedValue(true);

    balanceRepository.find.mockResolvedValue([
      {
        id: 'bal-present',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        hasDiscrepancy: false,
        discrepancyAmount: null,
      },
      {
        id: 'bal-missing',
        employeeId: 'EMP2',
        locationId: 'LOC1',
        leaveType: 'SICK',
        hasDiscrepancy: false,
        discrepancyAmount: null,
      },
    ]);

    await service.runBatchSync();

    expect(syncLogRepository.update).toHaveBeenCalledWith(
      'sync-partial',
      expect.objectContaining({ status: 'PARTIAL' }),
    );
    expect(balanceRepository.update).toHaveBeenCalledWith(
      'bal-missing',
      expect.objectContaining({ hasDiscrepancy: true }),
    );
  });

  it('marks unknown request status as FAILED in retryPendingHcmSyncs', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-unknown',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: 'ON_HOLD',
        daysRequested: 1,
        hcmValidated: false,
        hcmSyncAttempts: 0,
      },
    ]);

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-unknown',
      expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.FAILED }),
    );
  });

  it('keeps request PENDING when retry handler throws unexpectedly', async () => {
    requestRepository.find.mockResolvedValue([
      {
        id: 'req-throw',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        status: RequestStatus.PENDING,
        daysRequested: 1,
        hcmValidated: false,
        hcmSyncAttempts: 2,
      },
    ]);

    hcmService.validateRequest.mockRejectedValue(new Error('network failure'));

    await service.retryPendingHcmSyncs();

    expect(requestRepository.update).toHaveBeenCalledWith(
      'req-throw',
      expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmSyncAttempts: 3 }),
    );
  });
});
