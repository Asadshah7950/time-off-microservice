'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines if an error is worth retrying.
 * 4xx errors (except 429 Too Many Requests and 408 Timeout) are deterministic failures — don't retry.
 * 5xx, network errors, and CIRCUIT_OPEN should NOT be retried at this layer
 * (circuit breaker handles that separately).
 */
function isRetryable(error) {
  if (error.code === 'CIRCUIT_OPEN' || error.code === 'CIRCUIT_HALF_OPEN') {
    return false;
  }
  if (error.response) {
    const status = error.response.status;
    if (status === 429 || status === 408) return true;
    if (status >= 400 && status < 500) return false;
    return true; // 5xx
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
  return true;
}

/**
 * Retry execution with exponential backoff and jitter.
 *
 * @param {Function} fn - Async function to retry
 * @param {object} options
 * @param {number} options.maxAttempts - Maximum attempts (default: 3)
 * @param {number} options.baseDelayMs - Base delay in ms (default: 1000)
 * @param {number} options.maxDelayMs - Cap on delay (default: 10000)
 * @param {boolean} options.jitter - Apply random jitter to avoid thundering herd (default: true)
 * @param {Function} options.onRetry - Called before each retry: (error, attempt) => void
 * @returns {Promise<*>} Result of fn
 */
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    jitter = true,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff: baseDelay * 2^(attempt-1)
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      // Add jitter: multiply by random [0.5, 1.0] to spread retries
      const actualDelay = jitter
        ? cappedDelay * (0.5 + Math.random() * 0.5)
        : cappedDelay;

      if (onRetry) {
        onRetry(error, attempt);
      }

      await sleep(actualDelay);
    }
  }

  throw lastError;
}

module.exports = { withRetry, isRetryable, sleep };
