'use strict';

const { withRetry, isRetryable } = require('../../src/common/utils/retry.util');

describe('retry.util (Unit)', () => {
  it('isRetryable returns false for circuit-open and circuit-half-open errors', () => {
    expect(isRetryable({ code: 'CIRCUIT_OPEN' })).toBe(false);
    expect(isRetryable({ code: 'CIRCUIT_HALF_OPEN' })).toBe(false);
  });

  it('isRetryable returns expected values for HTTP statuses', () => {
    expect(isRetryable({ response: { status: 429 } })).toBe(true);
    expect(isRetryable({ response: { status: 408 } })).toBe(true);
    expect(isRetryable({ response: { status: 400 } })).toBe(false);
    expect(isRetryable({ response: { status: 404 } })).toBe(false);
    expect(isRetryable({ response: { status: 503 } })).toBe(true);
  });

  it('isRetryable returns true for network-level failures', () => {
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
  });

  it('withRetry retries retryable failures and eventually returns success', async () => {
    const onRetry = jest.fn();
    let callCount = 0;

    const fn = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        const error = new Error('temporary 503');
        error.response = { status: 503 };
        throw error;
      }
      return 'ok';
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitter: false,
        onRetry,
      }),
    ).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('withRetry does not retry deterministic 4xx errors', async () => {
    const fn = jest.fn(async () => {
      const error = new Error('bad request');
      error.response = { status: 400 };
      throw error;
    });

    await expect(withRetry(fn, { maxAttempts: 4, baseDelayMs: 1, jitter: false })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry exhausts max attempts for retryable failures', async () => {
    const fn = jest.fn(async () => {
      const error = new Error('server down');
      error.response = { status: 503 };
      throw error;
    });

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: false })).rejects.toThrow('server down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withRetry does not retry CIRCUIT_OPEN failures', async () => {
    const fn = jest.fn(async () => {
      const error = new Error('circuit open');
      error.code = 'CIRCUIT_OPEN';
      throw error;
    });

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false })).rejects.toThrow('circuit open');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
