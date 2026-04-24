'use strict';

const { Module } = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { SyncLog } = require('./sync-log.entity');

@Module({
  imports: [TypeOrmModule.forFeature([SyncLog])],
  exports: [TypeOrmModule],
})
class SyncLogModule {}

module.exports = { SyncLogModule };
