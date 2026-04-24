'use strict';

const { UnprocessableEntityException } = require('@nestjs/common');
const { TimeOffController } = require('../../src/modules/timeoff/timeoff.controller');
const { RequestStatus } = require('../../src/common/constants');

describe('TimeOffController (Unit)', () => {
  let controller;
  let timeOffService;

  beforeEach(() => {
    timeOffService = {
      createRequest: jest.fn(),
      listRequests: jest.fn(),
      getRequest: jest.fn(),
      approveRequest: jest.fn(),
      rejectRequest: jest.fn(),
      cancelRequest: jest.fn(),
    };

    controller = new TimeOffController(timeOffService);
  });

  it('forwards createRequest payload and idempotency key', async () => {
    const dto = { employeeId: 'EMP1' };
    timeOffService.createRequest.mockResolvedValue({ id: 'req-1' });

    const result = await controller.createRequest(dto, 'idem-1');

    expect(timeOffService.createRequest).toHaveBeenCalledWith(dto, 'idem-1');
    expect(result).toEqual({ id: 'req-1' });
  });

  it('listRequests forwards valid status filter', async () => {
    timeOffService.listRequests.mockResolvedValue({ data: [], total: 0 });

    const result = await controller.listRequests('EMP1', 'LOC1', RequestStatus.PENDING, '10', '0');

    expect(timeOffService.listRequests).toHaveBeenCalledWith({
      employeeId: 'EMP1',
      locationId: 'LOC1',
      status: RequestStatus.PENDING,
      limit: '10',
      offset: '0',
    });
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('listRequests throws for invalid status values', async () => {
    await expect(controller.listRequests('EMP1', 'LOC1', 'NOT_A_REAL_STATUS', '10', '0')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('forwards getRequest by id', async () => {
    timeOffService.getRequest.mockResolvedValue({ id: 'req-2' });

    const result = await controller.getRequest('req-2');

    expect(timeOffService.getRequest).toHaveBeenCalledWith('req-2');
    expect(result).toEqual({ id: 'req-2' });
  });

  it('forwards approve/reject/cancel actions', async () => {
    timeOffService.approveRequest.mockResolvedValue({ status: RequestStatus.APPROVED });
    timeOffService.rejectRequest.mockResolvedValue({ status: RequestStatus.REJECTED });
    timeOffService.cancelRequest.mockResolvedValue({ status: RequestStatus.CANCELLED });

    const approveRes = await controller.approveRequest('req-3', { approverId: 'MGR1' });
    const rejectRes = await controller.rejectRequest('req-3', { approverId: 'MGR1', reason: 'Policy' });
    const cancelRes = await controller.cancelRequest('req-3', { reason: 'User request' });

    expect(timeOffService.approveRequest).toHaveBeenCalledWith('req-3', 'MGR1');
    expect(timeOffService.rejectRequest).toHaveBeenCalledWith('req-3', 'MGR1', 'Policy');
    expect(timeOffService.cancelRequest).toHaveBeenCalledWith('req-3', 'User request');

    expect(approveRes.status).toBe(RequestStatus.APPROVED);
    expect(rejectRes.status).toBe(RequestStatus.REJECTED);
    expect(cancelRes.status).toBe(RequestStatus.CANCELLED);
  });
});
