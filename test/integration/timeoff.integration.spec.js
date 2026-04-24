'use strict';

const path = require('path');
const { spawn } = require('child_process');
const request = require('supertest');
const { Test } = require('@nestjs/testing');
const { v4: uuidv4 } = require('uuid');

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`POST ${url} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForHttp(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch (err) {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

describe('TimeOff Integration (SQLite + Mock HCM)', () => {
  let app;
  let hcmSyncService;
  let mockHcmProcess;

  const mockHcmPort = 3201;
  const adminBaseUrl = `http://127.0.0.1:${mockHcmPort + 100}`;

  async function waitForRequestStatus(requestId, acceptedStatuses, timeoutMs = 5000) {
    const expected = Array.isArray(acceptedStatuses)
      ? acceptedStatuses
      : [acceptedStatuses];

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await request(app.getHttpServer())
        .get(`/time-off/requests/${requestId}`)
        .expect(200);

      if (expected.includes(res.body.hcmSyncStatus)) {
        return res.body;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for request ${requestId} to reach ${expected.join(', ')}`);
  }

  beforeAll(async () => {
    const mockServerPath = path.join(__dirname, '../../mock-hcm/src/server.js');
    mockHcmProcess = spawn(process.execPath, [mockServerPath], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        MOCK_HCM_PORT: String(mockHcmPort),
        MOCK_HCM_FLAKINESS: '0',
        MOCK_HCM_TIMEOUT_PROBABILITY: '0',
      },
      stdio: 'pipe',
    });

    await waitForHttp(`http://127.0.0.1:${mockHcmPort}/hcm/batch-sync`);

    process.env.DB_PATH = ':memory:';
    process.env.HCM_BASE_URL = `http://127.0.0.1:${mockHcmPort}`;
    process.env.HCM_RETRY_MAX_ATTEMPTS = '1';
    process.env.HCM_RETRY_BASE_DELAY_MS = '1';

    const { AppModule } = require('../../src/app.module');
    const { HcmSyncService } = require('../../src/modules/hcm/hcm-sync.service');

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    hcmSyncService = app.get(HcmSyncService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    if (mockHcmProcess && !mockHcmProcess.killed) {
      mockHcmProcess.kill('SIGTERM');
    }
  });

  beforeEach(async () => {
    await postJson(`${adminBaseUrl}/admin/reset-behavior`, {});
  });

  it('happy path: request + approve + HCM confirmation', async () => {
    const employeeId = `EMP_INT_HAPPY_${Date.now()}`;
    const locationId = 'LOC1';
    const leaveType = 'VACATION';

    await postJson(`${adminBaseUrl}/admin/inject`, {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 12,
      availableBalance: 12,
    });

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/${locationId}/${leaveType}/12`)
      .expect(201);

    const createRes = await request(app.getHttpServer())
      .post('/time-off/requests')
      .set('X-Idempotency-Key', uuidv4())
      .send({
        employeeId,
        locationId,
        leaveType,
        startDate: '2043-01-10',
        endDate: '2043-01-11',
      })
      .expect(201);

    await waitForRequestStatus(createRes.body.id, 'SUCCESS');

    await request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/approve`)
      .send({ approverId: 'MGR_INT' })
      .expect(200);

    await waitForRequestStatus(createRes.body.id, 'SUCCESS');

    const balance = await request(app.getHttpServer())
      .get(`/balances/${employeeId}/${locationId}/${leaveType}`)
      .expect(200);

    expect(balance.body.pendingBalance).toBe(0);
    expect(balance.body.usedBalance).toBe(2);
  });

  it('sad path: HCM unavailable then retry recovers', async () => {
    const employeeId = `EMP_INT_REC_${Date.now()}`;
    const locationId = 'LOC1';
    const leaveType = 'VACATION';

    await postJson(`${adminBaseUrl}/admin/inject`, {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 8,
      availableBalance: 8,
    });

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/${locationId}/${leaveType}/8`)
      .expect(201);

    await postJson(`${adminBaseUrl}/admin/behavior`, {
      forcedFailureMode: '503',
      forcedFailureCount: 1,
    });

    const createRes = await request(app.getHttpServer())
      .post('/time-off/requests')
      .set('X-Idempotency-Key', uuidv4())
      .send({
        employeeId,
        locationId,
        leaveType,
        startDate: '2043-02-01',
        endDate: '2043-02-01',
      })
      .expect(201);

    await waitForRequestStatus(createRes.body.id, 'PENDING');

    await postJson(`${adminBaseUrl}/admin/reset-behavior`, {});
    await hcmSyncService.retryPendingHcmSyncs();

    const finalState = await waitForRequestStatus(createRes.body.id, 'SUCCESS');
    expect(finalState.hcmValidated).toBe(true);
  });

  it('defensive local check rejects stale HCM 200/valid response when local balance is insufficient', async () => {
    const employeeId = `EMP_INT_DEF_${Date.now()}`;
    const locationId = 'LOC1';
    const leaveType = 'VACATION';

    await postJson(`${adminBaseUrl}/admin/inject`, {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 100,
      availableBalance: 100,
    });

    await postJson(`${adminBaseUrl}/admin/behavior`, {
      validationOverride: 'always-valid',
    });

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/${locationId}/${leaveType}/1`)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/time-off/requests')
      .set('X-Idempotency-Key', uuidv4())
      .send({
        employeeId,
        locationId,
        leaveType,
        startDate: '2043-03-05',
        endDate: '2043-03-07',
      })
      .expect(422);

    expect(response.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  it('race condition with 1-day balance only allows one success', async () => {
    const employeeId = `EMP_INT_RACE_${Date.now()}`;
    const locationId = 'LOC1';
    const leaveType = 'VACATION';

    await postJson(`${adminBaseUrl}/admin/inject`, {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 1,
      availableBalance: 1,
    });

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/${locationId}/${leaveType}/1`)
      .expect(201);

    const payload = {
      employeeId,
      locationId,
      leaveType,
      startDate: '2043-04-01',
      endDate: '2043-04-01',
    };

    const responses = await Promise.all([
      request(app.getHttpServer()).post('/time-off/requests').set('X-Idempotency-Key', uuidv4()).send(payload),
      request(app.getHttpServer()).post('/time-off/requests').set('X-Idempotency-Key', uuidv4()).send(payload),
    ]);

    const statusSet = responses.map((r) => r.status).sort();
    expect(statusSet).toEqual([201, 409]);

    const balance = await request(app.getHttpServer())
      .get(`/balances/${employeeId}/${locationId}/${leaveType}`)
      .expect(200);

    expect(balance.body.availableBalance).toBeGreaterThanOrEqual(0);
    expect(balance.body.pendingBalance).toBe(1);
  });

  it('batch sync + anniversary refresh updates local balances', async () => {
    const employeeId = `EMP_INT_SYNC_${Date.now()}`;
    const locationId = 'LOC1';
    const leaveType = 'VACATION';

    await postJson(`${adminBaseUrl}/admin/inject`, {
      employeeId,
      locationId,
      leaveType,
      totalBalance: 10,
      availableBalance: 10,
    });

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/${locationId}/${leaveType}/10`)
      .expect(201);

    await postJson(`${adminBaseUrl}/admin/anniversary-refresh`, {
      employeeId,
      locationId,
      leaveType,
      grantDays: 5,
    });

    await hcmSyncService.runBatchSync();

    const updated = await request(app.getHttpServer())
      .get(`/balances/${employeeId}/${locationId}/${leaveType}`)
      .expect(200);

    expect(updated.body.availableBalance).toBe(15);
    expect(updated.body.totalBalance).toBe(15);
  });

  it('invalid dimensions: wrong location is rejected cleanly', async () => {
    const employeeId = `EMP_INT_DIM_${Date.now()}`;
    const leaveType = 'VACATION';

    await request(app.getHttpServer())
      .post(`/balances/admin/seed/${employeeId}/LOC1/${leaveType}/5`)
      .expect(201);

    await request(app.getHttpServer())
      .post('/time-off/requests')
      .set('X-Idempotency-Key', uuidv4())
      .send({
        employeeId,
        locationId: 'LOC_DOES_NOT_EXIST',
        leaveType,
        startDate: '2043-05-01',
        endDate: '2043-05-01',
      })
      .expect(404);
  });
});
