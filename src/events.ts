/**
 * The event-log vocabulary.
 *
 * Every mutating ledger method writes exactly one event row inside the same
 * storage transaction as its data writes. That row carries the caller's
 * idempotency key, and the store enforces uniqueness on
 * (organizationId, idempotencyKey). The event row is therefore both the audit
 * trail and the idempotency anchor: if the transaction rolls back, the key is
 * released with it, and the operation is safe to retry.
 */

/** Who performed an action. */
export type ActorType = 'HUMAN' | 'SYSTEM'

/**
 * Reserved actorId for writes that no human asked for directly, a scheduled
 * job posting a recurring expense, for instance. The actorType must be
 * 'SYSTEM' whenever this is used.
 */
export const SYSTEM_ACTOR_ID = 'system' as const

/** Canonical event type values written by the ledger. */
export const EVENT_TYPES = {
  INVOICE_CREATED:                'INVOICE_CREATED',
  INVOICE_VOIDED:                 'INVOICE_VOIDED',
  TRANSACTION_RECORDED:           'TRANSACTION_RECORDED',
  TRANSACTION_VOIDED:             'TRANSACTION_VOIDED',
  ALLOCATION_APPLIED:             'ALLOCATION_APPLIED',
  CREDIT_NOTE_ISSUED:             'CREDIT_NOTE_ISSUED',
  LEDGER_ENTRY_ADDED:             'LEDGER_ENTRY_ADDED',
  LEDGER_ENTRY_VOIDED:            'LEDGER_ENTRY_VOIDED',
  RECURRING_EXPENSE_MATERIALIZED: 'RECURRING_EXPENSE_MATERIALIZED',
} as const

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]
