'use strict';

const {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
  Unique,
} = require('typeorm');

const { LeaveType } = require('../../../common/constants');

@Entity('employee_balances')
@Unique(['employeeId', 'locationId', 'leaveType'])
@Index(['employeeId', 'locationId'])
class EmployeeBalance {
  @PrimaryGeneratedColumn('uuid')
  id = undefined;

  @Column({ type: 'varchar' })
  employeeId = undefined;

  @Column({ type: 'varchar' })
  locationId = undefined;

  @Column({
    type: 'varchar',
    enum: Object.values(LeaveType),
  })
  leaveType = undefined;

  // Annual entitlement from HCM (updated by batch sync or accrual events)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  totalBalance = 0;

  // availableBalance = totalBalance - usedBalance - pendingBalance
  // Decremented atomically at request creation.
  // INVARIANT: never goes below 0.
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  availableBalance = 0;

  // Balances held by PENDING requests — released on rejection/cancellation
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  pendingBalance = 0;

  // Balances consumed by APPROVED requests
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  usedBalance = 0;

  // Carries over from the previous year — informational only in v1
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  carryOverBalance = 0;

  // Last known HCM total — used to detect positive/negative drift in batch reconciliation
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  hcmTotalBalance = 0;

  @Column({ type: 'datetime', nullable: true })
  hcmLastSync = undefined;

  // ETag / revision from HCM for optimistic conflict detection on HCM side
  @Column({ type: 'varchar', nullable: true })
  hcmVersion = undefined;

  // Drift flag set during batch reconciliation when local < HCM (negative drift)
  @Column({ type: 'boolean', default: false })
  hasDiscrepancy = false;

  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  discrepancyAmount = undefined;

  // Optimistic lock: all balance mutations must include current version
  @VersionColumn()
  version = 1;

  @CreateDateColumn()
  createdAt = undefined;

  @UpdateDateColumn()
  updatedAt = undefined;
}

module.exports = { EmployeeBalance };
