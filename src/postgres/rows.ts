/**
 * Row mapping: snake_case columns to the ledger's entities.
 *
 * Two driver differences are handled here rather than at every call site.
 *
 * `bigint` comes back as a string from `pg` (because a Postgres bigint does
 * not fit in a JS number in general) and as a number from PGlite. Money in
 * this ledger is minor units and always inside Number.MAX_SAFE_INTEGER, so
 * `toMoney` accepts either and returns a number. If you are recording more
 * than 90 trillion of anything, this is the line to revisit.
 *
 * `timestamptz` comes back as a Date from both. `date` does not agree between
 * them, which is why the schema has no `date` column.
 */

import type {
  Account,
  Invoice,
  FinancialTransaction,
  Allocation,
  CreditNote,
  LedgerEntry,
  RecurringExpenseTemplate,
  EventLog,
  InvoiceStatus,
  PaymentMethod,
  CreditNoteReason,
  LedgerDirection,
  LedgerSource,
} from '../store'
import type { ActorType, EventType } from '../events'
import type { Money } from '../money'
import { StoreError } from '../errors'

/** A row as the driver handed it over. */
export type Row = Record<string, unknown>

export function toMoney(value: unknown): Money {
  const amount = typeof value === 'string' ? Number(value) : (value as number)
  if (!Number.isSafeInteger(amount)) {
    throw new StoreError(`Amount is not a safe integer: ${String(value)}`)
  }
  return amount
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string)
}

function toNullableDate(value: unknown): Date | null {
  return value == null ? null : toDate(value)
}

function text(value: unknown): string {
  return value as string
}

function nullableText(value: unknown): string | null {
  return (value as string | null) ?? null
}

export function toAccount(row: Row): Account {
  return {
    id:             text(row.id),
    organizationId: text(row.organization_id),
  }
}

export function toInvoice(row: Row): Invoice {
  return {
    id:             text(row.id),
    amount:         toMoney(row.amount),
    currency:       text(row.currency),
    status:         row.status as InvoiceStatus,
    dueDate:        toDate(row.due_date),
    month:          nullableText(row.month),
    reference:      nullableText(row.reference),
    notes:          nullableText(row.notes),
    createdBy:      nullableText(row.created_by),
    createdAt:      toDate(row.created_at),
    updatedAt:      toDate(row.updated_at),
    accountId:      text(row.account_id),
    organizationId: text(row.organization_id),
  }
}

export function toTransaction(row: Row): FinancialTransaction {
  return {
    id:             text(row.id),
    amount:         toMoney(row.amount),
    currency:       text(row.currency),
    paymentMethod:  row.payment_method as PaymentMethod,
    paymentDate:    toDate(row.payment_date),
    month:          nullableText(row.month),
    notes:          nullableText(row.notes),
    idempotencyKey: text(row.idempotency_key),
    recordedBy:     text(row.recorded_by),
    payerId:        text(row.payer_id),
    accountId:      text(row.account_id),
    organizationId: text(row.organization_id),
    createdAt:      toDate(row.created_at),
    voidedBy:       nullableText(row.voided_by),
    voidedAt:       toNullableDate(row.voided_at),
    voidReason:     nullableText(row.void_reason),
  }
}

export function toAllocation(row: Row): Allocation {
  return {
    id:            text(row.id),
    amount:        toMoney(row.amount),
    createdBy:     text(row.created_by),
    createdAt:     toDate(row.created_at),
    transactionId: text(row.transaction_id),
    invoiceId:     text(row.invoice_id),
  }
}

export function toCreditNote(row: Row): CreditNote {
  return {
    id:             text(row.id),
    amount:         toMoney(row.amount),
    currency:       text(row.currency),
    reason:         row.reason as CreditNoteReason,
    notes:          nullableText(row.notes),
    createdBy:      text(row.created_by),
    createdAt:      toDate(row.created_at),
    accountId:      text(row.account_id),
    organizationId: text(row.organization_id),
  }
}

export function toLedgerEntry(row: Row): LedgerEntry {
  return {
    id:             text(row.id),
    direction:      row.direction as LedgerDirection,
    category:       text(row.category),
    amount:         toMoney(row.amount),
    currency:       text(row.currency),
    occurredAt:     toDate(row.occurred_at),
    month:          text(row.month),
    note:           nullableText(row.note),
    source:         row.source as LedgerSource,
    createdBy:      text(row.created_by),
    transactionId:  nullableText(row.transaction_id),
    counterpartyId: nullableText(row.counterparty_id),
    templateId:     nullableText(row.template_id),
    voidedBy:       nullableText(row.voided_by),
    voidedAt:       toNullableDate(row.voided_at),
    voidReason:     nullableText(row.void_reason),
    createdAt:      toDate(row.created_at),
    organizationId: text(row.organization_id),
  }
}

export function toTemplate(row: Row): RecurringExpenseTemplate {
  return {
    id:             text(row.id),
    name:           text(row.name),
    category:       text(row.category),
    amount:         toMoney(row.amount),
    currency:       text(row.currency),
    dayOfMonth:     Number(row.day_of_month),
    counterpartyId: nullableText(row.counterparty_id),
    note:           nullableText(row.note),
    active:         Boolean(row.active),
    createdBy:      text(row.created_by),
    organizationId: text(row.organization_id),
  }
}

export function toEventLog(row: Row): EventLog {
  return {
    id:             text(row.id),
    type:           row.type as EventType,
    // jsonb: both drivers parse it. A string means someone stored text.
    payload:        (typeof row.payload === 'string'
                      ? JSON.parse(row.payload)
                      : row.payload) as Record<string, unknown>,
    actorId:        text(row.actor_id),
    actorType:      row.actor_type as ActorType,
    jobId:          nullableText(row.job_id),
    idempotencyKey: text(row.idempotency_key),
    createdAt:      toDate(row.created_at),
    organizationId: text(row.organization_id),
  }
}
