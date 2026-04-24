'use strict';

const {
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
} = require('@nestjs/common');
const { BalanceService } = require('../../src/modules/balance/balance.service');
const { STALE_BALANCE_THRESHOLD_MS } = require('../../src/common/constants');

describe('BalanceService (Unit)', () => {
  let service;
  let balanceRepository;
  let syncLogRepository;

  beforeEach(() => {
    balanceRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn(async (entity) => ({ id: 'bal-1', ...entity })),
      update: jest.fn(),
    };

    syncLogRepository = {
      save: jest.fn(),
      update: jest.fn(),
    };

    service = new BalanceService(
      balanceRepository,
      syncLogRepository,
      { options: { type: 'sqlite' } },
    );
  });

  function buildManager(balanceOverride = {}) {
    const balance = {
      id: 'b1',
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 15,
      availableBalance: 10,
      pendingBalance: 5,
      usedBalance: 0,
      hcmTotalBalance: 15,
      hcmLastSync: new Date(),
      hcmVersion: 'v1',
      hasDiscrepancy: false,
      discrepancyAmount: null,
      ...balanceOverride,
    };

    return {
      findOne: jest.fn().mockResolvedValue(balance),
      save: jest.fn(async (...args) => {
        if (args.length === 2) {
          return args[1];
        }
        return args[0];
      }),
    };
  }

  it('returns serialized balance from getBalance', async () => {
    balanceRepository.findOne.mockResolvedValue({
      save: jest.fn(async (entity, data) => data || entity),
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 10,
      availableBalance: 8,
      pendingBalance: 1,
      usedBalance: 1,
      carryOverBalance: 0,
      hcmLastSync: new Date(),
      version: 2,
      updatedAt: new Date(),
    });

    const res = await service.getBalance('EMP1', 'LOC1', 'VACATION');

    expect(res.employeeId).toBe('EMP1');
    expect(res.availableBalance).toBe(8);
    expect(typeof res.stale).toBe('boolean');
  });

  it('throws NotFoundException when balance is missing in getBalance', async () => {
    balanceRepository.findOne.mockResolvedValue(null);

    await expect(service.getBalance('EMP1', 'LOC1', 'VACATION')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('atomically deducts available balance and increments pending', async () => {
    const manager = buildManager({ availableBalance: 7, pendingBalance: 1 });

    const updated = await service.atomicDeduct(manager, 'EMP1', 'LOC1', 'VACATION', 3);

    expect(updated.availableBalance).toBe(4);
    expect(updated.pendingBalance).toBe(4);
    expect(manager.save).toHaveBeenCalled();
  });

  it('throws UnprocessableEntityException when available balance is insufficient', async () => {
    const manager = buildManager({ availableBalance: 1, pendingBalance: 2 });

    await expect(service.atomicDeduct(manager, 'EMP1', 'LOC1', 'VACATION', 2)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('throws NotFoundException when atomicDeduct cannot find balance', async () => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    };

    await expect(service.atomicDeduct(manager, 'EMP1', 'LOC1', 'VACATION', 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('releases pending days back to available', async () => {
    const manager = buildManager({ availableBalance: 6, pendingBalance: 4 });

    await service.releaseFromPending(manager, 'EMP1', 'LOC1', 'VACATION', 2);

    const savedBalance = manager.save.mock.calls[0][1];
    expect(savedBalance.pendingBalance).toBe(2);
    expect(savedBalance.availableBalance).toBe(8);
  });

  it('throws ConflictException when pending underflows on release', async () => {
    const manager = buildManager({ availableBalance: 6, pendingBalance: 1 });

    await expect(service.releaseFromPending(manager, 'EMP1', 'LOC1', 'VACATION', 2)).rejects.toBeInstanceOf(ConflictException);
  });

  it('finalizes pending days into used days', async () => {
    const manager = buildManager({ pendingBalance: 5, usedBalance: 2 });

    await service.finalizeUsed(manager, 'EMP1', 'LOC1', 'VACATION', 3);

    const savedBalance = manager.save.mock.calls[0][1];
    expect(savedBalance.pendingBalance).toBe(2);
    expect(savedBalance.usedBalance).toBe(5);
  });

  it('throws ConflictException when pending underflows on finalization', async () => {
    const manager = buildManager({ pendingBalance: 1, usedBalance: 0 });

    await expect(service.finalizeUsed(manager, 'EMP1', 'LOC1', 'VACATION', 2)).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns existing record during upsert when already present', async () => {
    balanceRepository.findOne.mockResolvedValue({
      id: 'existing',
      employeeId: 'EMP1',
      locationId: 'LOC1',
      leaveType: 'VACATION',
      totalBalance: 12,
      availableBalance: 10,
      pendingBalance: 1,
      usedBalance: 1,
      hcmLastSync: new Date(),
    });

    const result = await service.upsertBalance('EMP1', 'LOC1', 'VACATION', 15);

    expect(result.id).toBe('existing');
    expect(balanceRepository.create).not.toHaveBeenCalled();
  });

  it('creates a new record during upsert when none exists', async () => {
    balanceRepository.findOne.mockResolvedValue(null);

    const result = await service.upsertBalance('EMP1', 'LOC1', 'VACATION', 20);

    expect(balanceRepository.create).toHaveBeenCalled();
    expect(balanceRepository.save).toHaveBeenCalled();
    expect(result.totalBalance).toBe(20);
    expect(result.availableBalance).toBe(20);
  });

  it('applies positive HCM drift by increasing available and total', async () => {
    const manager = buildManager({
      availableBalance: 10,
      pendingBalance: 2,
      usedBalance: 1,
      totalBalance: 13,
    });

    const saved = await service.applyHcmRealTimeUpdate(
      manager,
      'EMP1',
      'LOC1',
      'VACATION',
      { totalBalance: 15, version: 'v2' },
    );

    expect(saved.availableBalance).toBe(12);
    expect(saved.totalBalance).toBe(15);
    expect(saved.hasDiscrepancy).toBe(false);
  });

  it('marks discrepancy on negative HCM drift and does not reduce local available', async () => {
    const manager = buildManager({
      availableBalance: 10,
      pendingBalance: 1,
      usedBalance: 1,
      totalBalance: 12,
    });

    const saved = await service.applyHcmRealTimeUpdate(
      manager,
      'EMP1',
      'LOC1',
      'VACATION',
      { totalBalance: 9, version: 'v3' },
    );

    expect(saved.availableBalance).toBe(10);
    expect(saved.hasDiscrepancy).toBe(true);
    expect(saved.discrepancyAmount).toBeCloseTo(3);
  });

  it('returns null from applyHcmRealTimeUpdate when balance does not exist', async () => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    };

    const result = await service.applyHcmRealTimeUpdate(
      manager,
      'EMP404',
      'LOC1',
      'VACATION',
      { totalBalance: 10, version: 'v1' },
    );

    expect(result).toBeNull();
  });

  it('isBalanceStale returns true when no balance exists', async () => {
    balanceRepository.findOne.mockResolvedValue(null);

    await expect(service.isBalanceStale('EMP1', 'LOC1', 'VACATION')).resolves.toBe(true);
  });

  it('isBalanceStale returns false for a recent hcmLastSync timestamp', async () => {
    balanceRepository.findOne.mockResolvedValue({
      hcmLastSync: new Date(Date.now() - Math.floor(STALE_BALANCE_THRESHOLD_MS / 4)),
    });

    await expect(service.isBalanceStale('EMP1', 'LOC1', 'VACATION')).resolves.toBe(false);
  });

  it('returns sqlite-safe lock strategy by driver type', () => {
    expect(service._getWriteLock({ connection: { options: { type: 'sqlite' } } })).toBeNull();
    expect(service._getWriteLock({ connection: { options: { type: 'postgres' } } })).toEqual({ mode: 'pessimistic_write' });
  });
});
