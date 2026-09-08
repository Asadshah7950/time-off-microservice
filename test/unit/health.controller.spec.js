'use strict';

const { HealthController } = require('../../src/modules/health/health.controller');

describe('HealthController (Unit)', () => {
  let controller;
  let mockDataSource;
  let mockHcmService;
  let mockResponse;

  beforeEach(() => {
    mockDataSource = {
      isInitialized: true,
      query: jest.fn().mockResolvedValue([{ 1: 1 }]),
    };
    mockHcmService = {
      getCircuitStatus: jest.fn().mockReturnValue({
        state: 'CLOSED',
        consecutiveFailures: 0,
        nextAttemptAt: null,
      }),
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    controller = new HealthController(mockDataSource, mockHcmService);
  });

  it('returns 200 OK with status UP when database and circuit breaker are healthy', async () => {
    await controller.getHealth(mockResponse);

    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'UP',
        details: expect.objectContaining({
          database: { status: 'UP', driver: 'sqlite' },
          hcmCircuitBreaker: expect.objectContaining({ state: 'CLOSED' }),
        }),
      }),
    );
  });

  it('returns 200 OK with status DEGRADED when HCM circuit breaker is OPEN', async () => {
    mockHcmService.getCircuitStatus.mockReturnValue({
      state: 'OPEN',
      consecutiveFailures: 5,
      nextAttemptAt: new Date().toISOString(),
    });

    await controller.getHealth(mockResponse);

    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DEGRADED',
      }),
    );
  });

  it('returns 503 SERVICE_UNAVAILABLE with status DOWN when database query fails', async () => {
    mockDataSource.query.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

    await controller.getHealth(mockResponse);

    expect(mockResponse.status).toHaveBeenCalledWith(503);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DOWN',
        details: expect.objectContaining({
          database: expect.objectContaining({
            status: 'DOWN',
            error: 'SQLITE_BUSY: database is locked',
          }),
        }),
      }),
    );
  });
});
