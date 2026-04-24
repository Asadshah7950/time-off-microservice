'use strict';

const { Module } = require('@nestjs/common');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { APP_FILTER, APP_INTERCEPTOR } = require('@nestjs/core');
const { ScheduleModule } = require('@nestjs/schedule');

const { TimeOffModule } = require('./modules/timeoff/timeoff.module');
const { BalanceModule } = require('./modules/balance/balance.module');
const { HcmModule } = require('./modules/hcm/hcm.module');
const { SyncLogModule } = require('./modules/sync-log/sync-log.module');
const { AllExceptionsFilter } = require('./common/filters/all-exceptions.filter');
const { LoggingInterceptor } = require('./common/interceptors/logging.interceptor');

const dbPath = process.env.DB_PATH || './data/timeoff.db';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: dbPath,
      autoLoadEntities: true,
      synchronize: true, // Only for development/demo. Use migrations in prod!
      logging: false, // Set to true to debug SQL execution
    }),
    SyncLogModule,
    BalanceModule,
    HcmModule,
    TimeOffModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
class AppModule {}

module.exports = { AppModule };
