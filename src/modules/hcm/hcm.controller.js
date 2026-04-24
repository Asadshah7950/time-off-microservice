'use strict';

const { Controller, Post, Get, HttpCode, HttpStatus, Inject } = require('@nestjs/common');
const { HcmSyncService } = require('./hcm-sync.service');

@Controller('hcm')
class HcmController {
  constructor(hcmSyncService) {
    this.hcmSyncService = hcmSyncService;
  }

  /**
   * POST /hcm/batch-sync
   * Manually trigger the batch reconciliation process.
   */
  @Post('batch-sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerBatchSync() {
    return this.hcmSyncService.triggerManualBatchSync();
  }

  /**
   * GET /hcm/sync-logs
   * List recent sync audit logs.
   */
  @Get('sync-logs')
  async getSyncLogs() {
    return this.hcmSyncService.getSyncLogs();
  }
}

Inject(HcmSyncService)(HcmController, undefined, 0);

module.exports = { HcmController };
