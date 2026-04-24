'use strict';

const { Module } = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { EmployeeBalance } = require('./entities/employee-balance.entity');
const { SyncLog } = require('../sync-log/sync-log.entity');
const { BalanceService } = require('./balance.service');
const { BalanceController } = require('./balance.controller');

@Module({
  imports: [TypeOrmModule.forFeature([EmployeeBalance, SyncLog])],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
class BalanceModule {}

module.exports = { BalanceModule };
