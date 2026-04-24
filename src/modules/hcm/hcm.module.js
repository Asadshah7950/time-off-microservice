'use strict';

const { Module } = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { EmployeeBalance } = require('../balance/entities/employee-balance.entity');
const { TimeOffRequest } = require('../timeoff/entities/timeoff-request.entity');
const { SyncLog } = require('../sync-log/sync-log.entity');
const { HcmService } = require('./hcm.service');
const { HcmSyncService } = require('./hcm-sync.service');
const { HcmController } = require('./hcm.controller');

@Module({
  imports: [TypeOrmModule.forFeature([EmployeeBalance, TimeOffRequest, SyncLog])],
  controllers: [HcmController],
  providers: [HcmService, HcmSyncService],
  exports: [HcmService, HcmSyncService],
})
class HcmModule {}

module.exports = { HcmModule };
