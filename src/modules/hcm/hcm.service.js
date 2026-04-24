'use strict';

const { Injectable } = require('@nestjs/common');
const axios = require('axios');

const { CircuitBreaker } = require('../../common/utils/circuit-breaker.util');
const { withRetry } = require('../../common/utils/retry.util');

/**
 * HcmService — facade for all HTTP communication with the external HCM system.
 *
 * Architecture decisions:
 * - Single Axios instance with baseURL and timeout.
 * - ONE CircuitBreaker for all HCM calls (shared failure tracking).
 * - withRetry wraps every call for transient fault resilience.
 * - All methods return null / throw; callers decide how to handle absence.
 *
 * The circuit breaker is the outermost layer:
 *   CircuitBreaker → withRetry → axiosInstance
 * This means if 5 retried-requests all fail, CB opens. Good trade-off.
 */
@Injectable()
class HcmService {
  constructor() {
    this.config = {
      baseUrl: process.env.HCM_BASE_URL || 'http://localhost:3001',
      timeoutMs: parseInt(process.env.HCM_TIMEOUT_MS || '5000', 10),
      retryMaxAttempts: parseInt(process.env.HCM_RETRY_MAX_ATTEMPTS || '3', 10),
      retryBaseDelayMs: parseInt(process.env.HCM_RETRY_BASE_DELAY_MS || '1000', 10),
      circuitThreshold: parseInt(process.env.HCM_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      circuitResetMs: parseInt(process.env.HCM_CIRCUIT_BREAKER_RESET_MS || '30000', 10),
    };

    this.httpClient = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'X-Service': 'timeoff-service',
      },
    });

    this.circuitBreaker = new CircuitBreaker(
      (config) => this.httpClient.request(config),
      {
        name: 'HCM',
        failureThreshold: this.config.circuitThreshold,
        resetTimeoutMs: this.config.circuitResetMs,
      },
    );
  }

  /**
   * Get current balance for an employee from HCM.
   * returns null if HCM unavailable (caller decides whether to proceed with local data).
   */
  async getBalance(employeeId, locationId, leaveType) {
    return this._callWithResilience(
      () =>
        this.circuitBreaker.call({
          method: 'GET',
          url: `/hcm/balance/${employeeId}/${locationId}/${leaveType}`,
        }),
      { operation: 'GET_BALANCE', employeeId, locationId, leaveType },
    );
  }

  /**
   * Validate a time-off request against HCM before committing locally.
   * HCM may return a different balance than our local copy — we log but don't block.
   *
   * @returns {{ valid: boolean, hcmBalance: number, message?: string } | null}
   */
  async validateRequest(employeeId, locationId, leaveType, daysRequested) {
    return this._callWithResilience(
      () =>
        this.circuitBreaker.call({
          method: 'POST',
          url: '/hcm/validate',
          data: { employeeId, locationId, leaveType, daysRequested },
        }),
      { operation: 'VALIDATE_REQUEST', employeeId, locationId, leaveType, daysRequested },
    );
  }

  /**
   * Notify HCM that a request was approved. HCM subtracts from its balance.
   * Best-effort — we've already committed locally.
   */
  async notifyApproval(employeeId, locationId, leaveType, daysRequested, requestId) {
    return this._callWithResilience(
      () =>
        this.circuitBreaker.call({
          method: 'PUT',
          url: '/hcm/balance',
          data: {
            employeeId,
            locationId,
            leaveType,
            daysRequested,
            action: 'APPROVE',
            referenceId: requestId,
          },
        }),
      { operation: 'NOTIFY_APPROVAL', employeeId, locationId, leaveType },
    );
  }

  /**
   * Notify HCM that a request was rejected/cancelled. HCM restores the balance.
   * Best-effort.
   */
  async notifyRejection(employeeId, locationId, leaveType, daysRequested, requestId) {
    return this._callWithResilience(
      () =>
        this.circuitBreaker.call({
          method: 'PUT',
          url: '/hcm/balance',
          data: {
            employeeId,
            locationId,
            leaveType,
            daysRequested,
            action: 'REJECT',
            referenceId: requestId,
          },
        }),
      { operation: 'NOTIFY_REJECTION', employeeId, locationId, leaveType },
    );
  }

  /**
   * Fetch full balance snapshot for all employees — used by batch reconciliation.
   * Returns array of { employeeId, locationId, leaveType, totalBalance, version }
   *
   * @returns {Array | null}
   */
  async getBatchBalances(locationId = null) {
    return this._callWithResilience(
      () =>
        this.circuitBreaker.call({
          method: 'GET',
          url: '/hcm/batch-sync',
          params: locationId ? { locationId } : undefined,
        }),
      { operation: 'BATCH_SYNC', locationId },
    );
  }

  /**
   * Returns the current circuit breaker status for health checks.
   */
  getCircuitStatus() {
    return this.circuitBreaker.getStatus();
  }

  /**
   * Internal: wraps a call with retry logic and normalizes errors.
   * Returns { data } from Axios response on success, null on circuit open or max retries exhausted.
   */
  async _callWithResilience(callFn, logContext) {
    try {
      const response = await withRetry(callFn, {
        maxAttempts: this.config.retryMaxAttempts,
        baseDelayMs: this.config.retryBaseDelayMs,
        onRetry: (error, attempt) => {
          console.warn({
            event: 'HCM_RETRY',
            attempt,
            error: error.message,
            ...logContext,
          });
        },
      });
      return response.data;
    } catch (error) {
      // Circuit open or all retries exhausted — caller receives null and decides
      if (error.code === 'CIRCUIT_OPEN' || error.code === 'CIRCUIT_HALF_OPEN') {
        console.error({
          event: 'HCM_CIRCUIT_OPEN',
          message: 'HCM circuit breaker is OPEN — fast failing',
          ...logContext,
        });
      } else {
        console.error({
          event: 'HCM_CALL_FAILED',
          error: error.message,
          status: error.response?.status,
          ...logContext,
        });
      }
      return null;
    }
  }
}

module.exports = { HcmService };
