'use strict';

const { HttpException, HttpStatus } = require('@nestjs/common');
const { AllExceptionsFilter } = require('../../src/common/filters/all-exceptions.filter');

describe('AllExceptionsFilter (Unit)', () => {
  function buildHost(requestOverrides = {}) {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const request = {
      requestId: 'req-1',
      method: 'GET',
      path: '/time-off/requests',
      url: '/time-off/requests',
      ...requestOverrides,
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    };

    return { host, response, request };
  }

  it('normalizes HttpException object responses including array message and details', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = buildHost();
    const exception = new HttpException(
      {
        error: 'VALIDATION_FAILED',
        message: ['field a invalid', 'field b missing'],
        details: { field: 'leaveType' },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'VALIDATION_FAILED',
        message: 'field a invalid; field b missing',
        requestId: 'req-1',
        path: '/time-off/requests',
        details: { field: 'leaveType' },
      }),
    );
  });

  it('normalizes HttpException string responses', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = buildHost();
    const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.FORBIDDEN,
        error: String(HttpStatus.FORBIDDEN),
        message: 'Forbidden',
      }),
    );
  });

  it('returns safe internal error payload and logs context for unexpected errors', () => {
    const filter = new AllExceptionsFilter();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { host, response } = buildHost({ requestId: undefined, method: 'POST', path: '/x', url: '/x' });

    filter.catch(new Error('boom'), host);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'UNHANDLED_EXCEPTION',
        method: 'POST',
        path: '/x',
        errorMessage: 'boom',
      }),
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'unknown',
        path: '/x',
      }),
    );

    errorSpy.mockRestore();
  });
});
