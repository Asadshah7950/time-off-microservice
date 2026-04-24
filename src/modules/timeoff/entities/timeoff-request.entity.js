'use strict';

const {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} = require('typeorm');

const { LeaveType, RequestStatus, HcmSyncStatus } = require('../../../common/constants');

@Entity('time_off_requests')
@Index(['employeeId', 'locationId', 'status'])
@Index(['employeeId', 'startDate', 'endDate'])
class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id = undefined;

  // Client-supplied replay protection. Unique constraint prevents duplicate processing.
  @Column({ type: 'varchar', unique: true })
  idempotencyKey = undefined;

  @Column({ type: 'varchar' })
  employeeId = undefined;

  @Column({ type: 'varchar' })
  locationId = undefined;

  @Column({
    type: 'varchar',
    enum: Object.values(LeaveType),
  })
  leaveType = undefined;

  @Column({ type: 'date' })
  startDate = undefined;

  @Column({ type: 'date' })
  endDate = undefined;

  // Pre-computed and stored to avoid recalculation on every read.
  // Always cast to number when reading — SQLite stores DECIMAL as string.
  @Column({ type: 'decimal', precision: 5, scale: 2 })
  daysRequested = undefined;

  @Column({
    type: 'varchar',
    enum: Object.values(RequestStatus),
    default: RequestStatus.PENDING,
  })
  status = RequestStatus.PENDING;

  @Column({ type: 'varchar' })
  requestedBy = undefined;

  @Column({ type: 'varchar', nullable: true })
  approvedBy = undefined;

  @Column({ type: 'datetime', nullable: true })
  approvedAt = undefined;

  @Column({ type: 'text', nullable: true })
  rejectionReason = undefined;

  @Column({ type: 'text', nullable: true })
  notes = undefined;

  // HCM sync tracking — decoupled from the main request lifecycle
  @Column({ type: 'boolean', default: false })
  hcmValidated = false;

  @Column({
    type: 'varchar',
    enum: Object.values(HcmSyncStatus),
    default: HcmSyncStatus.PENDING,
  })
  hcmSyncStatus = HcmSyncStatus.PENDING;

  @Column({ type: 'int', default: 0 })
  hcmSyncAttempts = 0;

  @Column({ type: 'datetime', nullable: true })
  hcmLastSyncAt = undefined;

  // Optimistic lock version — incremented on every update.
  // Prevents stale-read → write races.
  @VersionColumn()
  version = 1;

  @CreateDateColumn()
  createdAt = undefined;

  @UpdateDateColumn()
  updatedAt = undefined;
}

module.exports = { TimeOffRequest };
