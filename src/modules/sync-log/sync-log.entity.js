'use strict';

const {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} = require('typeorm');

const { SyncType, SyncLogStatus } = require('../../common/constants');

@Entity('sync_logs')
@Index(['syncType', 'status'])
@Index(['employeeId'])
class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id = undefined;

  @Column({
    type: 'varchar',
    enum: Object.values(SyncType),
  })
  syncType = undefined;

  @Column({
    type: 'varchar',
    enum: Object.values(SyncLogStatus),
    default: SyncLogStatus.STARTED,
  })
  status = SyncLogStatus.STARTED;

  // Null for BATCH syncs; populated for REALTIME syncs
  @Column({ type: 'varchar', nullable: true })
  employeeId = undefined;

  @Column({ type: 'varchar', nullable: true })
  locationId = undefined;

  @Column({ type: 'int', default: 0 })
  recordsProcessed = 0;

  @Column({ type: 'int', default: 0 })
  recordsUpdated = 0;

  @Column({ type: 'int', default: 0 })
  recordsFailed = 0;

  // JSON array of per-record errors for PARTIAL syncs
  @Column({ type: 'simple-json', nullable: true })
  errorDetails = undefined;

  @Column({ type: 'datetime' })
  startedAt = undefined;

  @Column({ type: 'datetime', nullable: true })
  completedAt = undefined;

  @CreateDateColumn()
  createdAt = undefined;
}

module.exports = { SyncLog };
