'use strict';

const { CircuitState } = require('../constants');

/**
 * CircuitBreaker — prevents cascading failures to external services (HCM).
 *
 * States:
 *   CLOSED  — normal operation; all requests pass through
 *   OPEN    — failures exceeded threshold; reject fast without calling HCM
 *   HALF_OPEN — one probe request allowed; if it succeeds → CLOSED, else → OPEN
 *
 * Design decision: We use a time-based reset (not attempt-based) because HCM
 * outages are typically duration-bounded. A 30s reset is short enough to recover
 * quickly but long enough not to hammer a degraded HCM.
 */
class CircuitBreaker {
  /**
   * @param {Function} fn - The async function to protect
   * @param {object} options
   * @param {number} options.failureThreshold - Failures before opening circuit
   * @param {number} options.resetTimeoutMs - Time before probing from OPEN state
   * @param {string} options.name - Name for logging
   */
  constructor(fn, options = {}) {
    this.fn = fn;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.name = options.name || 'CircuitBreaker';

    this._state = CircuitState.CLOSED;
    this._failures = 0;
    this._nextAttemptAt = null;
    this._halfOpenInFlight = false;
  }

  get state() {
    return this._state;
  }

  get failures() {
    return this._failures;
  }

  /**
   * Execute the protected function.
   * @throws {Error} immediately if circuit is OPEN and reset timeout not elapsed
   */
  async call(...args) {
    if (this._state === CircuitState.OPEN) {
      if (Date.now() < this._nextAttemptAt) {
        const err = new Error(`[${this.name}] Circuit OPEN — fast fail`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
      // Transition to HALF_OPEN for probe
      this._state = CircuitState.HALF_OPEN;
      this._halfOpenInFlight = true;
    }

    if (this._state === CircuitState.HALF_OPEN && this._halfOpenInFlight === false) {
      // Another half-open probe is waiting — fast fail secondary requests
      const err = new Error(`[${this.name}] Circuit HALF_OPEN — probe in progress`);
      err.code = 'CIRCUIT_HALF_OPEN';
      throw err;
    }

    try {
      const result = await this.fn(...args);
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  _onSuccess() {
    this._failures = 0;
    this._halfOpenInFlight = false;
    if (this._state !== CircuitState.CLOSED) {
      console.info(`[${this.name}] Circuit CLOSED — service recovered`);
    }
    this._state = CircuitState.CLOSED;
  }

  _onFailure(error) {
    this._halfOpenInFlight = false;
    this._failures += 1;

    if (
      this._state === CircuitState.HALF_OPEN ||
      this._failures >= this.failureThreshold
    ) {
      this._state = CircuitState.OPEN;
      this._nextAttemptAt = Date.now() + this.resetTimeoutMs;
      console.error(
        `[${this.name}] Circuit OPEN — failures: ${this._failures}, ` +
          `resets at: ${new Date(this._nextAttemptAt).toISOString()}. Error: ${error.message}`,
      );
    }
  }

  reset() {
    this._state = CircuitState.CLOSED;
    this._failures = 0;
    this._nextAttemptAt = null;
    this._halfOpenInFlight = false;
  }

  getStatus() {
    return {
      name: this.name,
      state: this._state,
      failures: this._failures,
      nextAttemptAt: this._nextAttemptAt
        ? new Date(this._nextAttemptAt).toISOString()
        : null,
    };
  }
}

module.exports = { CircuitBreaker };
