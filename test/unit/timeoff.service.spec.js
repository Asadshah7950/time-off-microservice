'use strict';

const { Test } = require('@nestjs/testing');
const { TimeOffService } = require('../../src/modules/timeoff/timeoff.service');
const { BalanceService } = require('../../src/modules/balance/balance.service');
const { HcmService } = require('../../src/modules/hcm/hcm.service');
const { TimeOffRequest } = require('../../src/modules/timeoff/entities/timeoff-request.entity');
const { IdempotencyRecord } = require('../../src/modules/timeoff/entities/idempotency-record.entity');
const { getRepositoryToken, getDataSourceToken } = require('@nestjs/typeorm');
const { RequestStatus, HcmSyncStatus } = require('../../src/common/constants');
const { hashObject } = require('../../src/common/utils/hash.util');

describe('TimeOffService (Unit)', () => {
  let service;
  let requestRepository;
  let balanceService;
  let hcmService;
  let idempotencyRepository;
  let dataSource;
  let manager;

  const mockEmployeeId = 'EMP1';
  const mockLocationId = 'LOC1';
  const mockLeaveType = 'VACATION';

  const flushImmediate = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  };

  beforeEach(async () => {
    requestRepository = {
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    idempotencyRepository = { findOne: jest.fn() };

    balanceService = {
      atomicDeduct: jest.fn(),
      finalizeUsed: jest.fn(),
      releaseFromPending: jest.fn(),
    };

    hcmService = {
      validateRequest: jest.fn(),
      notifyApproval: jest.fn(),
    };

    manager = {
      create: jest.fn((entity, data) => data),
      save: jest.fn().mockImplementation((entity, data) => ({ id: 'req-id-1', ...data })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (isolationOrCb, maybeCb) => {
        const cb = typeof isolationOrCb === 'function' ? isolationOrCb : maybeCb;
        return await cb(manager);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepository },
        { provide: getRepositoryToken(IdempotencyRecord), useValue: idempotencyRepository },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmService, useValue: hcmService },
      ],
    }).compile();

    service = moduleRef.get(TimeOffService);
  });

  describe('createRequest', () => {
    const validDto = {
      employeeId: mockEmployeeId,
      locationId: mockLocationId,
      leaveType: mockLeaveType,
      startDate: '2040-01-01', // future
      endDate: '2040-01-02',
    };
    const key = 'idem-key-1';

    it('should throw if idempotency key is missing', async () => {
      await expect(service.createRequest(validDto, null)).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'MISSING_IDEMPOTENCY_KEY' }),
      });
    });

    it('should return cached response if idempotency key matches perfectly', async () => {
      const cachedResponse = { id: 'req-id-1', status: 'PENDING' };
      idempotencyRepository.findOne.mockResolvedValue({
        idempotencyKey: key,
        requestHash: hashObject(validDto),
        expiresAt: new Date(Date.now() + 100000), // future
        responseBody: cachedResponse,
      });

      const res = await service.createRequest(validDto, key);
      expect(res).toEqual(cachedResponse);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should throw 409 Conflict if idempotency key points to a different payload (hash mismatch)', async () => {
      idempotencyRepository.findOne.mockResolvedValue({
        idempotencyKey: key,
        requestHash: 'different-hash',
        expiresAt: new Date(Date.now() + 100000),
      });

      await expect(service.createRequest(validDto, key)).rejects.toThrow('Idempotency key has already been used');
    });

    it('should reject when start date is in the past', async () => {
      const dto = {
        ...validDto,
        startDate: '2000-01-01',
        endDate: '2000-01-03',
      };

      await expect(service.createRequest(dto, key)).rejects.toThrow('startDate cannot be in the past');
    });

    it('should reject when end date is before start date', async () => {
      const dto = {
        ...validDto,
        startDate: '2040-01-10',
        endDate: '2040-01-08',
      };

      await expect(service.createRequest(dto, key)).rejects.toThrow('endDate must be on or after startDate');
    });

    it('should process normally and call balanceService.atomicDeduct if valid', async () => {
      idempotencyRepository.findOne.mockResolvedValue(null);

      const res = await service.createRequest(validDto, key);

      expect(balanceService.atomicDeduct).toHaveBeenCalledWith(
        expect.anything(),
        mockEmployeeId,
        mockLocationId,
        mockLeaveType,
        2 // dates range from 01 to 02 is 2 days
      );
      expect(res.status).toBe(RequestStatus.PENDING);
    });
  });

  describe('overlap validation', () => {
    it('should throw when an overlapping request exists', async () => {
      const dto = {
        employeeId: mockEmployeeId,
        locationId: mockLocationId,
        leaveType: mockLeaveType,
        startDate: '2040-01-01',
        endDate: '2040-01-05',
      };

      idempotencyRepository.findOne.mockResolvedValue(null);
      manager.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'existing',
            startDate: '2040-01-03',
            endDate: '2040-01-10',
            status: RequestStatus.PENDING,
          },
        ]);

      await expect(service.createRequest(dto, 'key2')).rejects.toThrow('Request overlaps');
    });
  });

  describe('approve/reject/cancel', () => {
    function pendingRequest(overrides = {}) {
      return {
        id: 'req-1',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        status: RequestStatus.PENDING,
        hcmValidated: false,
        hcmSyncAttempts: 0,
        ...overrides,
      };
    }

    it('approves request and finalizes balance usage', async () => {
      manager.findOne.mockResolvedValue(pendingRequest());
      jest.spyOn(service, '_notifyApprovalToHcmAsync').mockResolvedValue(undefined);

      const res = await service.approveRequest('req-1', 'MGR1');

      expect(res.status).toBe(RequestStatus.APPROVED);
      expect(balanceService.finalizeUsed).toHaveBeenCalledWith(
        manager,
        'EMP1',
        'LOC1',
        'VACATION',
        2,
      );
    });

    it('rejects request and releases pending balance', async () => {
      manager.findOne.mockResolvedValue(pendingRequest());

      const res = await service.rejectRequest('req-1', 'MGR2', 'Policy mismatch');

      expect(res.status).toBe(RequestStatus.REJECTED);
      expect(balanceService.releaseFromPending).toHaveBeenCalledWith(
        manager,
        'EMP1',
        'LOC1',
        'VACATION',
        2,
      );
    });

    it('cancels request and releases pending balance', async () => {
      manager.findOne.mockResolvedValue(pendingRequest());

      const res = await service.cancelRequest('req-1', 'User changed plans');

      expect(res.status).toBe(RequestStatus.CANCELLED);
      expect(balanceService.releaseFromPending).toHaveBeenCalledTimes(1);
    });

    it('throws on invalid transition from APPROVED to CANCELLED', async () => {
      manager.findOne.mockResolvedValue(pendingRequest({ status: RequestStatus.APPROVED }));

      await expect(service.cancelRequest('req-1')).rejects.toThrow('Cannot transition from APPROVED to CANCELLED');
    });
  });

  describe('read operations', () => {
    it('getRequest returns serialized record when found', async () => {
      requestRepository.findOne.mockResolvedValue({
        id: 'req-1',
        idempotencyKey: 'k',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        startDate: '2040-01-01',
        endDate: '2040-01-02',
        daysRequested: 2,
        status: RequestStatus.PENDING,
      });

      const res = await service.getRequest('req-1');
      expect(res.id).toBe('req-1');
      expect(res.daysRequested).toBe(2);
    });

    it('getRequest throws when missing', async () => {
      requestRepository.findOne.mockResolvedValue(null);
      await expect(service.getRequest('missing')).rejects.toThrow('not found');
    });

    it('listRequests applies limit/offset and serializes data', async () => {
      requestRepository.findAndCount.mockResolvedValue([
        [
          {
            id: 'r1',
            employeeId: 'EMP1',
            locationId: 'LOC1',
            leaveType: 'VACATION',
            startDate: '2040-01-01',
            endDate: '2040-01-01',
            daysRequested: 1,
            status: RequestStatus.PENDING,
          },
        ],
        1,
      ]);

      const result = await service.listRequests({ employeeId: 'EMP1', limit: '10', offset: '2' });

      expect(result.total).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(2);
      expect(result.data[0].id).toBe('r1');
    });
  });

  describe('HCM async notification helpers', () => {
    it('notifyApproval marks request PENDING when validation is unavailable', async () => {
      hcmService.validateRequest.mockResolvedValue(null);

      await service._notifyApprovalToHcmAsync({
        id: 'req-a',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        hcmValidated: false,
        hcmSyncAttempts: 1,
      }, 'req-a');

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-a',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmSyncAttempts: 2 }),
      );
    });

    it('notifyApproval marks request FAILED when validation rejects', async () => {
      hcmService.validateRequest.mockResolvedValue({ valid: false });

      await service._notifyApprovalToHcmAsync({
        id: 'req-b',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        hcmValidated: false,
        hcmSyncAttempts: 0,
      }, 'req-b');

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-b',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.FAILED, hcmValidated: false }),
      );
    });

    it('notifyApproval marks SUCCESS when already validated and approval succeeds', async () => {
      hcmService.notifyApproval.mockResolvedValue({ success: true });

      await service._notifyApprovalToHcmAsync({
        id: 'req-c',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        hcmValidated: true,
        hcmSyncAttempts: 2,
      }, 'req-c');

      expect(hcmService.validateRequest).not.toHaveBeenCalled();
      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-c',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.SUCCESS, hcmValidated: true }),
      );
    });

    it('notifyApproval keeps PENDING when approval response is unsuccessful', async () => {
      hcmService.validateRequest.mockResolvedValue({ valid: true });
      hcmService.notifyApproval.mockResolvedValue({ success: false });

      await service._notifyApprovalToHcmAsync({
        id: 'req-d',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        hcmValidated: false,
        hcmSyncAttempts: 0,
      }, 'req-d');

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-d',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmValidated: true }),
      );
    });

    it('notifyApproval catches thrown errors and marks PENDING', async () => {
      hcmService.notifyApproval.mockRejectedValue(new Error('network'));

      await service._notifyApprovalToHcmAsync({
        id: 'req-e',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        daysRequested: 2,
        hcmValidated: true,
        hcmSyncAttempts: 4,
      }, 'req-e');

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-e',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmSyncAttempts: 5 }),
      );
    });

    it('notifyHcmAsync marks FAILED when validation returns valid=false', async () => {
      hcmService.validateRequest.mockResolvedValue({ valid: false, hcmBalance: 0, message: 'invalid' });

      service._notifyHcmAsync('req-f', 'EMP1', 'LOC1', 'VACATION', 2);
      await flushImmediate();

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-f',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.FAILED, hcmValidated: false }),
      );
    });

    it('notifyHcmAsync marks SUCCESS for valid responses', async () => {
      hcmService.validateRequest.mockResolvedValue({ valid: true, hcmBalance: 5 });

      service._notifyHcmAsync('req-g', 'EMP1', 'LOC1', 'VACATION', 2);
      await flushImmediate();

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-g',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.SUCCESS, hcmValidated: true, hcmSyncAttempts: 1 }),
      );
    });

    it('notifyHcmAsync keeps PENDING when validation returns null', async () => {
      hcmService.validateRequest.mockResolvedValue(null);

      service._notifyHcmAsync('req-h', 'EMP1', 'LOC1', 'VACATION', 2);
      await flushImmediate();

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-h',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmSyncAttempts: 1 }),
      );
    });

    it('notifyHcmAsync catches thrown errors and keeps PENDING', async () => {
      hcmService.validateRequest.mockRejectedValue(new Error('upstream down'));

      service._notifyHcmAsync('req-i', 'EMP1', 'LOC1', 'VACATION', 2);
      await flushImmediate();

      expect(requestRepository.update).toHaveBeenCalledWith(
        'req-i',
        expect.objectContaining({ hcmSyncStatus: HcmSyncStatus.PENDING, hcmSyncAttempts: 1 }),
      );
    });
  });

  describe('retry and lock helpers', () => {
    it('detects sqlite transient transaction errors by code and message', () => {
      expect(service._isSqliteTransientTxError({ code: 'SQLITE_BUSY' })).toBe(true);
      expect(service._isSqliteTransientTxError({ message: 'database is locked' })).toBe(true);
      expect(service._isSqliteTransientTxError({ message: 'some other failure' })).toBe(false);
    });

    it('retries transaction function on transient sqlite errors', async () => {
      jest.useFakeTimers();
      const tx = jest
        .fn()
        .mockRejectedValueOnce({ code: 'SQLITE_BUSY' })
        .mockResolvedValueOnce('ok');

      const promise = service._runCreateTransactionWithRetry(tx);
      await jest.advanceTimersByTimeAsync(20);

      await expect(promise).resolves.toBe('ok');
      expect(tx).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('throws immediately when error is not transient', async () => {
      const tx = jest.fn().mockRejectedValue(new Error('fatal'));
      await expect(service._runCreateTransactionWithRetry(tx)).rejects.toThrow('fatal');
      expect(tx).toHaveBeenCalledTimes(1);
    });

    it('serializes same-key create calls via _withCreateLock', async () => {
      const order = [];
      const first = service._withCreateLock('EMP1:LOC1', async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('first-end');
        return 1;
      });

      const second = service._withCreateLock('EMP1:LOC1', async () => {
        order.push('second');
        return 2;
      });

      const result = await Promise.all([first, second]);

      expect(result).toEqual([1, 2]);
      expect(order).toEqual(['first-start', 'first-end', 'second']);
      expect(service._createLocks.size).toBe(0);
    });

    it('recovers from constraint conflict using existing request fallback', async () => {
      jest.spyOn(service, '_checkIdempotency').mockResolvedValue(null);
      requestRepository.findOne.mockResolvedValue({
        id: 'req-existing',
        idempotencyKey: 'k-1',
        employeeId: 'EMP1',
        locationId: 'LOC1',
        leaveType: 'VACATION',
        startDate: '2040-01-01',
        endDate: '2040-01-01',
        daysRequested: 1,
        status: RequestStatus.PENDING,
      });

      const recovered = await service._recoverAfterConstraint('k-1', 'EMP1', 'hash');
      expect(recovered.id).toBe('req-existing');
    });
  });

});
