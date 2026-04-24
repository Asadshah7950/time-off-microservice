'use strict';

const { CircuitBreaker } = require('../../src/common/utils/circuit-breaker.util');
const { CircuitState } = require('../../src/common/constants');

describe('CircuitBreaker (Unit)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fast-fails with CIRCUIT_OPEN when circuit is open and reset window is not reached', async () => {
    const breaker = new CircuitBreaker(async () => 'ok', { name: 'HCM_TEST' });
    breaker._state = CircuitState.OPEN;
    breaker._nextAttemptAt = Date.now() + 10_000;

    await expect(breaker.call()).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });

  it('transitions from OPEN to HALF_OPEN probe and closes on successful probe', async () => {
    const fn = jest.fn().mockResolvedValue({ success: true });
    const breaker = new CircuitBreaker(fn, { name: 'HCM_TEST' });

    breaker._state = CircuitState.OPEN;
    breaker._nextAttemptAt = Date.now() - 1;

    const result = await breaker.call('payload');

    expect(result).toEqual({ success: true });
    expect(fn).toHaveBeenCalledWith('payload');
    expect(breaker.state).toBe(CircuitState.CLOSED);
    expect(breaker.failures).toBe(0);
  });

  it('fast-fails with CIRCUIT_HALF_OPEN when another probe is already in progress', async () => {
    const breaker = new CircuitBreaker(async () => 'ok', { name: 'HCM_TEST' });
    breaker._state = CircuitState.HALF_OPEN;
    breaker._halfOpenInFlight = false;

    await expect(breaker.call()).rejects.toMatchObject({ code: 'CIRCUIT_HALF_OPEN' });
  });

  it('opens circuit after reaching failure threshold while closed', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('upstream failed'));
    const breaker = new CircuitBreaker(fn, {
      name: 'HCM_TEST',
      failureThreshold: 2,
      resetTimeoutMs: 5000,
    });

    await expect(breaker.call()).rejects.toThrow('upstream failed');
    expect(breaker.state).toBe(CircuitState.CLOSED);

    await expect(breaker.call()).rejects.toThrow('upstream failed');
    expect(breaker.state).toBe(CircuitState.OPEN);
    expect(breaker.failures).toBe(2);
    expect(typeof breaker._nextAttemptAt).toBe('number');
  });

  it('re-opens immediately when HALF_OPEN probe fails', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('still down'));
    const breaker = new CircuitBreaker(fn, {
      name: 'HCM_TEST',
      failureThreshold: 5,
      resetTimeoutMs: 5000,
    });

    breaker._state = CircuitState.HALF_OPEN;
    breaker._halfOpenInFlight = true;

    await expect(breaker.call()).rejects.toThrow('still down');
    expect(breaker.state).toBe(CircuitState.OPEN);
  });

  it('reset clears circuit state and getStatus serializes nextAttemptAt safely', () => {
    const breaker = new CircuitBreaker(async () => 'ok', { name: 'HCM_TEST' });
    breaker._state = CircuitState.OPEN;
    breaker._failures = 3;
    breaker._nextAttemptAt = Date.now() + 1000;

    const before = breaker.getStatus();
    expect(before.state).toBe(CircuitState.OPEN);
    expect(typeof before.nextAttemptAt).toBe('string');

    breaker.reset();
    const after = breaker.getStatus();

    expect(after.state).toBe(CircuitState.CLOSED);
    expect(after.failures).toBe(0);
    expect(after.nextAttemptAt).toBeNull();
  });
});
