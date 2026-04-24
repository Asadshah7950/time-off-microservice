'use strict';

const request = require('supertest');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../../src/app.module');
const { HcmService } = require('../../src/modules/hcm/hcm.service');
const { HcmSyncService } = require('../../src/modules/hcm/hcm-sync.service');
const { v4: uuidv4 } = require('uuid');

describe('TimeOffController (e2e)', () => {
  let app;
  let createdRequestId;
   let hcmService;
   let hcmSyncService;
  
  beforeAll(async () => {
    // Force SQLite Memory DB for hermetic test execution
    process.env.DB_PATH = ':memory:';
      process.env.HCM_RETRY_MAX_ATTEMPTS = '1';
      process.env.HCM_RETRY_BASE_DELAY_MS = '1';
    
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
      hcmService = app.get(HcmService);
      hcmSyncService = app.get(HcmSyncService);
  });

  afterAll(async () => {
    await app.close();
  });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   async function waitForHcmStatus(requestId, acceptedStatuses, timeoutMs = 2500) {
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

         await new Promise((resolve) => setTimeout(resolve, 25));
      }

      throw new Error(`Timed out waiting for status ${expected.join(', ')} for request ${requestId}`);
   }

  const empId = `EMP_${Date.now()}`;
  const locId = 'LOC1';
  const type = 'VACATION';

  describe('Integration E2E Flow', () => {
      it('Seed -> Request -> Approve', async () => {
             jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 20 });
             jest.spyOn(hcmService, 'notifyApproval').mockResolvedValue({ success: true });

         // Step 1: Seed balance
         await request(app.getHttpServer())
            .post(`/balances/admin/seed/${empId}/${locId}/${type}/20`)
            .expect(201);
            
         const balanceRes = await request(app.getHttpServer())
            .get(`/balances/${empId}/${locId}/${type}`);
         expect(balanceRes.body.availableBalance).toBe(20);

         // Step 2: Submit Request
         const key1 = uuidv4();
         const res1 = await request(app.getHttpServer())
            .post('/time-off/requests')
            .set('X-Idempotency-Key', key1)
            .send({
                employeeId: empId,
                locationId: locId,
                leaveType: type,
                startDate: '2040-02-01',
                endDate: '2040-02-02' // 2 days
            })
            .expect(201);
            
         createdRequestId = res1.body.id;
         expect(res1.body.status).toBe('PENDING');
         await waitForHcmStatus(createdRequestId, 'SUCCESS');

         // Verify balance was deducted
         const balanceRes2 = await request(app.getHttpServer())
            .get(`/balances/${empId}/${locId}/${type}`);
         expect(balanceRes2.body.availableBalance).toBe(18); // 20 - 2
         expect(balanceRes2.body.pendingBalance).toBe(2);

         // Step 3: Approve Request
         await request(app.getHttpServer())
            .patch(`/time-off/requests/${createdRequestId}/approve`)
            .send({ approverId: 'MGR1' })
            .expect(200);

         await waitForHcmStatus(createdRequestId, 'SUCCESS');

         // Verify balance was finalized
         const balanceRes3 = await request(app.getHttpServer())
            .get(`/balances/${empId}/${locId}/${type}`);
         expect(balanceRes3.body.pendingBalance).toBe(0);
         expect(balanceRes3.body.usedBalance).toBe(2);
      });
      
      it('Idempotency - should return same payload for same idempotency key', async () => {
         jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 20 });

         const keyIdem = uuidv4();
         const payload = {
                employeeId: empId,
                locationId: locId,
                leaveType: type,
                startDate: '2040-03-01',
                endDate: '2040-03-01' // 1 day
         };
         const req1 = await request(app.getHttpServer())
            .post('/time-off/requests')
            .set('X-Idempotency-Key', keyIdem)
            .send(payload)
            .expect(201);
            
         const req2 = await request(app.getHttpServer())
            .post('/time-off/requests')
            .set('X-Idempotency-Key', keyIdem)
            .send(payload)
            .expect(201); // Still 201
            
         expect(req1.body.id).toEqual(req2.body.id);
      });

      it('Concurrency - exact overlapping requests should only allow one via TOCTOU isolation', async () => {
            jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 10 });

         const concEmpId = `EMP_CONC_${Date.now()}`;
         await request(app.getHttpServer()).post(`/balances/admin/seed/${concEmpId}/${locId}/${type}/10`);
         
         const payload = {
             employeeId: concEmpId,
             locationId: locId,
             leaveType: type,
             startDate: '2041-05-10',
             endDate: '2041-05-15'
         };

         // Both have different idempotency keys but overlap
         const res = await Promise.all([
             request(app.getHttpServer()).post('/time-off/requests').set('X-Idempotency-Key', uuidv4()).send(payload),
             request(app.getHttpServer()).post('/time-off/requests').set('X-Idempotency-Key', uuidv4()).send(payload)
         ]);

         const statuses = res.map(r => r.status).sort();
         // One should succeed (201), the other should fail overlapping (409)
         expect(statuses).toEqual([201, 409]);
      });

         it('High-concurrency overlap race - only one request is accepted across 20 parallel calls', async () => {
             jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 20 });

             const employee = `EMP_PAR_${Date.now()}`;
             await request(app.getHttpServer())
                  .post(`/balances/admin/seed/${employee}/${locId}/${type}/20`)
                  .expect(201);

             const payload = {
                  employeeId: employee,
                  locationId: locId,
                  leaveType: type,
                  startDate: '2041-06-10',
                  endDate: '2041-06-12',
             };

             const responses = await Promise.all(
                  Array.from({ length: 20 }).map(() =>
                     request(app.getHttpServer())
                        .post('/time-off/requests')
                        .set('X-Idempotency-Key', uuidv4())
                        .send(payload),
                  ),
             );

             const successCount = responses.filter((r) => r.status === 201).length;
             const conflictCount = responses.filter((r) => r.status === 409).length;

             expect(successCount).toBe(1);
             expect(conflictCount).toBe(19);

             const balance = await request(app.getHttpServer())
                .get(`/balances/${employee}/${locId}/${type}`)
                .expect(200);

             expect(balance.body.availableBalance).toBe(17);
             expect(balance.body.pendingBalance).toBe(3);
         });

         it('High-concurrency idempotency - same key returns one logical request for 15 parallel calls', async () => {
             jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 20 });

             const employee = `EMP_IDEM_${Date.now()}`;
             await request(app.getHttpServer())
                .post(`/balances/admin/seed/${employee}/${locId}/${type}/10`)
                .expect(201);

             const idempotencyKey = uuidv4();
             const payload = {
                employeeId: employee,
                locationId: locId,
                leaveType: type,
                startDate: '2041-07-01',
                endDate: '2041-07-02',
             };

             const responses = await Promise.all(
                Array.from({ length: 15 }).map(() =>
                   request(app.getHttpServer())
                      .post('/time-off/requests')
                      .set('X-Idempotency-Key', idempotencyKey)
                      .send(payload),
                ),
             );

             const statusSet = new Set(responses.map((r) => r.status));
             expect(Array.from(statusSet)).toEqual([201]);

             const ids = new Set(responses.map((r) => r.body.id));
             expect(ids.size).toBe(1);
         });

         it('HCM validation failure is explicit (FAILED) and not silently marked success', async () => {
             jest.spyOn(hcmService, 'validateRequest').mockResolvedValueOnce({
                valid: false,
                hcmBalance: 0,
                message: 'Forced invalid state',
             });

         const key = uuidv4();
         const res = await request(app.getHttpServer())
            .post('/time-off/requests')
            .set('X-Idempotency-Key', key)
            .send({
                employeeId: empId,
                locationId: locId,
                leaveType: type,
                startDate: '2042-01-01',
                endDate: '2042-01-02'
            })
                  .expect(201);

             expect(res.body.status).toBe('PENDING');
             const finalState = await waitForHcmStatus(res.body.id, 'FAILED');
             expect(finalState.hcmValidated).toBe(false);
         });

         it('HCM transient failure recovers via retry worker', async () => {
             jest
                .spyOn(hcmService, 'validateRequest')
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ valid: true, hcmBalance: 20 });

             const employee = `EMP_REC_${Date.now()}`;
             await request(app.getHttpServer())
                .post(`/balances/admin/seed/${employee}/${locId}/${type}/8`)
                .expect(201);

             const createRes = await request(app.getHttpServer())
                .post('/time-off/requests')
                .set('X-Idempotency-Key', uuidv4())
                .send({
                   employeeId: employee,
                   locationId: locId,
                   leaveType: type,
                   startDate: '2042-02-10',
                   endDate: '2042-02-10',
                })
                .expect(201);

             await waitForHcmStatus(createRes.body.id, 'PENDING');
             await hcmSyncService.retryPendingHcmSyncs();

             const recovered = await waitForHcmStatus(createRes.body.id, 'SUCCESS');
             expect(recovered.hcmValidated).toBe(true);
         });

         it('Approval retry does not roll back committed balances', async () => {
             jest.spyOn(hcmService, 'validateRequest').mockResolvedValue({ valid: true, hcmBalance: 10 });
             jest
                .spyOn(hcmService, 'notifyApproval')
                .mockResolvedValueOnce(null)
                .mockResolvedValue({ success: true });

             const employee = `EMP_APR_${Date.now()}`;
             await request(app.getHttpServer())
                .post(`/balances/admin/seed/${employee}/${locId}/${type}/10`)
                .expect(201);

             const createRes = await request(app.getHttpServer())
                .post('/time-off/requests')
                .set('X-Idempotency-Key', uuidv4())
                .send({
                   employeeId: employee,
                   locationId: locId,
                   leaveType: type,
                   startDate: '2042-03-15',
                   endDate: '2042-03-16',
                })
                .expect(201);

             await waitForHcmStatus(createRes.body.id, 'SUCCESS');

             await request(app.getHttpServer())
                .patch(`/time-off/requests/${createRes.body.id}/approve`)
                .send({ approverId: 'MGR2' })
                .expect(200);

             await waitForHcmStatus(createRes.body.id, 'PENDING');

             const balanceAfterApprove = await request(app.getHttpServer())
                .get(`/balances/${employee}/${locId}/${type}`)
                .expect(200);

             expect(balanceAfterApprove.body.pendingBalance).toBe(0);
             expect(balanceAfterApprove.body.usedBalance).toBe(2);

             await hcmSyncService.retryPendingHcmSyncs();
             await waitForHcmStatus(createRes.body.id, 'SUCCESS');

             const balanceAfterRetry = await request(app.getHttpServer())
                .get(`/balances/${employee}/${locId}/${type}`)
                .expect(200);

             expect(balanceAfterRetry.body.pendingBalance).toBe(0);
             expect(balanceAfterRetry.body.usedBalance).toBe(2);
      });
  });
});
