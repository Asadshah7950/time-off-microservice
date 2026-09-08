'use strict';

const { Module } = require('@nestjs/common');
const { HealthController } = require('./health.controller');
const { HcmModule } = require('../hcm/hcm.module');

@Module({
  imports: [HcmModule],
  controllers: [HealthController],
})
class HealthModule {}

module.exports = { HealthModule };
