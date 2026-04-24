'use strict';

const {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} = require('typeorm');

/**
 * IdempotencyRecord — stores the cached response for a given idempotency key.
 *
 * Stored inside the SAME transaction as the business operation it guards.
 * If the transaction rolls back, this record is also rolled back — meaning
 * a failed request does NOT leave behind a phantom idempotency entry.
 *
 * Intentional trade-off: If the server crashes AFTER committing but BEFORE
 * returning the response, the client will retry. The idempotency record exists,
 * so the retry will receive the original response — correct behavior.
 */
@Entity('idempotency_records')
@Index(['employeeId'])
class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id = undefined;

  @Column({ type: 'varchar', unique: true })
  idempotencyKey = undefined;

  @Column({ type: 'varchar' })
  employeeId = undefined;

  // SHA-256 of sorted request body — detects key reuse with different payload
  @Column({ type: 'varchar' })
  requestHash = undefined;

  @Column({ type: 'int' })
  responseStatus = undefined;

  // Stored as JSON text in SQLite
  @Column({ type: 'simple-json' })
  responseBody = undefined;

  // Records expire after 24h (configurable via IDEMPOTENCY_TTL_HOURS)
  @Column({ type: 'datetime' })
  expiresAt = undefined;

  @CreateDateColumn()
  createdAt = undefined;
}

module.exports = { IdempotencyRecord };
