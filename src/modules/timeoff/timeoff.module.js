'use strict';

const { Module } = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { TimeOffRequest } = require('./entities/timeoff-request.entity');
const { IdempotencyRecord } = require('./entities/idempotency-record.entity');
const { TimeOffService } = require('./timeoff.service');
const { TimeOffController } = require('./timeoff.controller');
const { BalanceModule } = require('../balance/balance.module');
const { HcmModule } = require('../hcm/hcm.module');

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, IdempotencyRecord]),
    BalanceModule,
    HcmModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
class TimeOffModule {}

module.exports = { TimeOffModule };
