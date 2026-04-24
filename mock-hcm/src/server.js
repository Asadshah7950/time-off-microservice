const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));

const PORT = parseInt(process.env.MOCK_HCM_PORT || 3001, 10);

// Simulate slightly unreliable behavior
const FLAKINESS_PROBABILITY = parseFloat(process.env.MOCK_HCM_FLAKINESS || '0.1');
const LIKELY_TIMEOUT_PROBABILITY = parseFloat(process.env.MOCK_HCM_TIMEOUT_PROBABILITY || '0.05');

const mockBehavior = {
  forcedFailureMode: null, // null | '503' | 'timeout'
  forcedFailureRemaining: 0,
  validationOverride: null, // null | 'always-valid' | 'always-invalid'
  batchPartial: false,
  staleVersionMode: false,
};

// In-memory Mock Data
const hcmBalances = {
  // Employee: EMP123
  'EMP123_LOC1_VACATION': { employeeId: 'EMP123', locationId: 'LOC1', leaveType: 'VACATION', totalBalance: 15, availableBalance: 15, version: 'v1' },
  'EMP123_LOC1_SICK': { employeeId: 'EMP123', locationId: 'LOC1', leaveType: 'SICK', totalBalance: 10, availableBalance: 10, version: 'v1' },
};

function getBalanceKey(employeeId, locationId, leaveType) {
  return `${employeeId}_${locationId}_${leaveType}`;
}

function ensureBalanceRecord(employeeId, locationId, leaveType) {
  const key = getBalanceKey(employeeId, locationId, leaveType);
  if (!hcmBalances[key]) {
    hcmBalances[key] = {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 0,
      availableBalance: 0,
      version: 'v1',
    };
  }
  return hcmBalances[key];
}

function simulateInstability(req, res, next) {
  if (mockBehavior.forcedFailureMode && mockBehavior.forcedFailureRemaining > 0) {
    mockBehavior.forcedFailureRemaining -= 1;

    if (mockBehavior.forcedFailureMode === 'timeout') {
      console.log('[MOCK HCM] Forced timeout mode');
      return setTimeout(() => next(), 6000);
    }

    if (mockBehavior.forcedFailureMode === '503') {
      console.log('[MOCK HCM] Forced 503 mode');
      return res.status(503).json({ error: 'Service Unavailable (forced)' });
    }
  }

  const rand = Math.random();
  
  if (rand < LIKELY_TIMEOUT_PROBABILITY) {
    console.log('[MOCK HCM] Simulating timeout latency...');
    return setTimeout(() => next(), 6000); // Exceeds 5000ms threshold
  }
  
  if (rand < LIKELY_TIMEOUT_PROBABILITY + FLAKINESS_PROBABILITY) {
    console.log('[MOCK HCM] Simulating 503 Service Unavailable');
    return res.status(503).json({ error: 'Service Unavailable' });
  }

  // Normal latency 50-200ms
  setTimeout(() => next(), 50 + Math.random() * 150);
}

app.use(simulateInstability);

// GET /hcm/balance/:employeeId/:locationId/:leaveType
app.get('/hcm/balance/:employeeId/:locationId/:leaveType', (req, res) => {
  const { employeeId, locationId, leaveType } = req.params;
  const key = getBalanceKey(employeeId, locationId, leaveType);
  const record = hcmBalances[key] || { employeeId, locationId, leaveType, totalBalance: 0, availableBalance: 0, version: 'v1' };
  
  res.json(record);
});

// POST /hcm/validate
app.post('/hcm/validate', (req, res) => {
  const { employeeId, locationId, leaveType, daysRequested } = req.body;
  const key = getBalanceKey(employeeId, locationId, leaveType);
  const record = hcmBalances[key];

  if (mockBehavior.validationOverride === 'always-invalid') {
    return res.json({
      valid: false,
      hcmBalance: record ? record.availableBalance : 0,
      message: 'Forced invalid validation response',
    });
  }

  if (mockBehavior.validationOverride === 'always-valid') {
    return res.json({
      valid: true,
      hcmBalance: record ? record.availableBalance : 0,
      message: 'Forced valid validation response',
    });
  }
  
  if (!record || record.availableBalance < daysRequested) {
    return res.json({
      valid: false,
      hcmBalance: record ? record.availableBalance : 0,
      message: 'Insufficient balance in HCM system',
    });
  }
  
  res.json({
    valid: true,
    hcmBalance: record.availableBalance,
  });
});

// POST /hcm/time-off
// Realtime API to file time-off directly in HCM.
app.post('/hcm/time-off', (req, res) => {
  const { employeeId, locationId, leaveType, daysRequested, referenceId } = req.body || {};

  if (!employeeId || !locationId || !leaveType || daysRequested === undefined) {
    return res.status(400).json({
      error: 'INVALID_INPUT',
      message: 'employeeId, locationId, leaveType, and daysRequested are required',
    });
  }

  const days = parseFloat(daysRequested);
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({
      error: 'INVALID_DAYS_REQUESTED',
      message: 'daysRequested must be a positive number',
    });
  }

  const record = ensureBalanceRecord(employeeId, locationId, leaveType);
  if (record.availableBalance < days) {
    return res.status(422).json({
      error: 'INSUFFICIENT_BALANCE',
      message: `Requested ${days} but only ${record.availableBalance} available in HCM`,
      details: {
        employeeId,
        locationId,
        leaveType,
        availableBalance: record.availableBalance,
      },
    });
  }

  record.availableBalance -= days;
  record.totalBalance -= days;
  record.version = `v${Date.now()}`;

  return res.status(201).json({
    success: true,
    referenceId: referenceId || null,
    updatedBalance: record.availableBalance,
    version: record.version,
  });
});

// PUT /hcm/balance
app.put('/hcm/balance', (req, res) => {
  const { employeeId, locationId, leaveType, daysRequested, action } = req.body;
  const record = ensureBalanceRecord(employeeId, locationId, leaveType);
  const days = parseFloat(daysRequested || 0);

  if (action === 'APPROVE') {
    if (record.availableBalance < days) {
      return res.status(422).json({
        error: 'INSUFFICIENT_BALANCE',
        message: `Requested ${days} but only ${record.availableBalance} available in HCM`,
      });
    }
    record.availableBalance -= days;
    record.totalBalance -= days;
  } else if (action === 'REJECT') {
    record.availableBalance += days;
    record.totalBalance += days;
  } else {
    return res.status(400).json({
      error: 'INVALID_ACTION',
      message: 'action must be APPROVE or REJECT',
    });
  }
  
  record.version = mockBehavior.staleVersionMode
    ? record.version
    : `v${Date.now()}`; // update version ETag

  res.json({ success: true, updatedBalance: record.availableBalance, version: record.version });
});

// GET /hcm/batch-sync
app.get('/hcm/batch-sync', (req, res) => {
  const values = Object.values(hcmBalances);

  if (!mockBehavior.batchPartial) {
    return res.json(values);
  }

  // Return a deterministic partial snapshot to simulate eventual-consistency windows.
  const partial = values.filter((_, idx) => idx % 2 === 0);
  return res.json(partial);
});

// Admin endpoint to inject data into mock without instability
const adminApp = express();
adminApp.use(express.json());
adminApp.post('/admin/inject', (req, res) => {
  const { employeeId, locationId, leaveType, totalBalance, availableBalance } = req.body;
  const key = getBalanceKey(employeeId, locationId, leaveType);
  hcmBalances[key] = {
    employeeId, locationId, leaveType, totalBalance, availableBalance, version: `v${Date.now()}`
  };
  res.json(hcmBalances[key]);
});

// Simulate anniversary accrual or mid-cycle grant events.
adminApp.post('/admin/anniversary-refresh', (req, res) => {
  const { employeeId, locationId, leaveType, grantDays = 1 } = req.body || {};
  const grant = parseFloat(grantDays);
  if (!Number.isFinite(grant) || grant <= 0) {
    return res.status(400).json({ error: 'grantDays must be a positive number' });
  }

  const updated = [];
  for (const record of Object.values(hcmBalances)) {
    if (employeeId && record.employeeId !== employeeId) continue;
    if (locationId && record.locationId !== locationId) continue;
    if (leaveType && record.leaveType !== leaveType) continue;

    record.totalBalance += grant;
    record.availableBalance += grant;
    record.version = `v${Date.now()}`;
    updated.push(record);
  }

  return res.json({ updatedCount: updated.length, grantDays: grant, records: updated });
});

// Simulate year refresh where entitlements are reset by policy.
adminApp.post('/admin/year-refresh', (req, res) => {
  const { defaultTotal = 15 } = req.body || {};
  const total = parseFloat(defaultTotal);
  if (!Number.isFinite(total) || total < 0) {
    return res.status(400).json({ error: 'defaultTotal must be a non-negative number' });
  }

  const refreshed = [];
  for (const record of Object.values(hcmBalances)) {
    record.totalBalance = total;
    record.availableBalance = total;
    record.version = `v${Date.now()}`;
    refreshed.push(record);
  }

  return res.json({ refreshedCount: refreshed.length, defaultTotal: total, records: refreshed });
});

adminApp.post('/admin/behavior', (req, res) => {
  const {
    forcedFailureMode,
    forcedFailureCount,
    validationOverride,
    batchPartial,
    staleVersionMode,
  } = req.body || {};

  if (forcedFailureMode !== undefined) {
    if (![null, '503', 'timeout'].includes(forcedFailureMode)) {
      return res.status(400).json({ error: 'forcedFailureMode must be null, 503, or timeout' });
    }
    mockBehavior.forcedFailureMode = forcedFailureMode;
  }

  if (forcedFailureCount !== undefined) {
    const count = parseInt(forcedFailureCount, 10);
    if (Number.isNaN(count) || count < 0) {
      return res.status(400).json({ error: 'forcedFailureCount must be a non-negative number' });
    }
    mockBehavior.forcedFailureRemaining = count;
  }

  if (validationOverride !== undefined) {
    if (![null, 'always-valid', 'always-invalid'].includes(validationOverride)) {
      return res.status(400).json({ error: 'validationOverride must be null, always-valid, or always-invalid' });
    }
    mockBehavior.validationOverride = validationOverride;
  }

  if (batchPartial !== undefined) {
    mockBehavior.batchPartial = Boolean(batchPartial);
  }

  if (staleVersionMode !== undefined) {
    mockBehavior.staleVersionMode = Boolean(staleVersionMode);
  }

  return res.json({ ...mockBehavior });
});

adminApp.post('/admin/reset-behavior', (req, res) => {
  mockBehavior.forcedFailureMode = null;
  mockBehavior.forcedFailureRemaining = 0;
  mockBehavior.validationOverride = null;
  mockBehavior.batchPartial = false;
  mockBehavior.staleVersionMode = false;

  res.json({ ...mockBehavior });
});

app.listen(PORT, () => {
    console.log(`Mock HCM Server running on port ${PORT}`);
});
adminApp.listen(PORT + 100, () => {
    console.log(`Mock HCM Admin Server running on port ${PORT + 100}`);
});
