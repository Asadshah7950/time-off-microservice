'use strict';

const { HcmService } = require('../../src/modules/hcm/hcm.service');
const { CircuitState } = require('../../src/common/constants');

describe('HcmService (Unit)', () => {
  let service;

  beforeEach(() => {
    service = new HcmService();
  });

  it('should return data successfully on 200 OK', async () => {
    jest.spyOn(service.circuitBreaker, 'call').mockResolvedValue({
      data: { totalBalance: 20 },
    });

    const res = await service.getBalance('EMP1', 'LOC1', 'VACATION');
    expect(res).toEqual({ totalBalance: 20 });
  });

  it('should return null on upstream 5xx errors after retry budget is exhausted', async () => {
    jest.spyOn(service.circuitBreaker, 'call').mockRejectedValue({
      message: 'HCM 503',
      response: { status: 503 },
    });

    const res = await service.getBalance('EMP', 'LOC', 'VAC');
    expect(res).toBeNull();
  });

  it('should fast-fail when circuit breaker is already OPEN', async () => {
    service.circuitBreaker._state = CircuitState.OPEN;
    service.circuitBreaker._nextAttemptAt = Date.now() + 60_000;
    const httpSpy = jest.spyOn(service.httpClient, 'request');

    const immediateNull = await service.validateRequest('EMP', 'LOC', 'VAC', 5);

    expect(immediateNull).toBeNull();
    expect(httpSpy).not.toHaveBeenCalled();
  });

});
