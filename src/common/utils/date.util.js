'use strict';

/**
 * Calculate calendar days between two dates (inclusive of both endpoints).
 *
 * We use calendar days rather than business days for simplicity. Switching to
 * business days requires a holiday calendar — a separate service dependency
 * outside this scope. This function is isolated here so it can be swapped.
 *
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate   - ISO date string (YYYY-MM-DD)
 * @returns {number} Number of calendar days (always >= 1)
 */
function calculateDaysRequested(startDate, endDate) {
  const [sYear, sMonth, sDay] = startDate.split('-').map(Number);
  const [eYear, eMonth, eDay] = endDate.split('-').map(Number);
  const start = Date.UTC(sYear, sMonth - 1, sDay);
  const end = Date.UTC(eYear, eMonth - 1, eDay);
  const diffMs = end - start;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(days, 1);
}

/**
 * Check if a date string represents a future or present date (>= today).
 */
function isNotInPast(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const targetDate = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return targetDate >= today;
}

/**
 * Check if two date ranges overlap (inclusive).
 * Ranges [s1,e1] and [s2,e2] overlap if s1 <= e2 AND s2 <= e1.
 */
function datesOverlap(start1, end1, start2, end2) {
  const [s1Y, s1M, s1D] = start1.split('-').map(Number);
  const [e1Y, e1M, e1D] = end1.split('-').map(Number);
  const [s2Y, s2M, s2D] = start2.split('-').map(Number);
  const [e2Y, e2M, e2D] = end2.split('-').map(Number);
  
  const s1 = Date.UTC(s1Y, s1M - 1, s1D);
  const e1 = Date.UTC(e1Y, e1M - 1, e1D);
  const s2 = Date.UTC(s2Y, s2M - 1, s2D);
  const e2 = Date.UTC(e2Y, e2M - 1, e2D);

  return s1 <= e2 && s2 <= e1;
}

/**
 * Returns true if the given timestamp is older than thresholdMs.
 */
function isStale(timestamp, thresholdMs) {
  if (!timestamp) return true;
  return Date.now() - new Date(timestamp).getTime() > thresholdMs;
}

module.exports = { calculateDaysRequested, isNotInPast, datesOverlap, isStale };
