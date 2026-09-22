/**
 * tenant-ledger: the append-only, event-sourced, multi-tenant accounting core
 * extracted from Lumo.
 *
 * Two ledgers, one event log:
 *   BillingService: what is owed, what was paid, and what covers what.
 *   LedgerService: what money actually moved, in and out.
 *
 * Every mutating call writes one event row, in the same storage transaction as
 * its data, keyed by a caller-supplied idempotency key.
 */

// ── Money ────────────────────────────────────────────────────────────────────
export type { Money } from './money'
export { money, isMoney, sumMoney, MAX_MONEY } from './money'

// ── Errors ───────────────────────────────────────────────────────────────────
export {
  DomainError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  IdempotencyError,
  StoreError,
  UniqueViolationError,
  DuplicateIdempotencyKeyError,
} from './errors'

// ── Events ───────────────────────────────────────────────────────────────────
export { EVENT_TYPES, SYSTEM_ACTOR_ID } from './events'
export type { EventType, ActorType } from './events'

// ── Permissions ──────────────────────────────────────────────────────────────
export { PERMISSIONS, hasPermission, requirePermission } from './permissions'
export type { Permission } from './permissions'

// ── Storage port ─────────────────────────────────────────────────────────────
export type {
  LedgerStore,
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
  LedgerCategory,
  CategoryTaxonomy,
  CreateInvoiceInput,
  UpdateInvoiceInput,
  CreateTransactionInput,
  VoidTransactionInput,
  CreateAllocationInput,
  CreateCreditNoteInput,
  CreateLedgerEntryInput,
  VoidLedgerEntryInput,
  CreateRecurringExpenseTemplateInput,
  UpdateRecurringExpenseTemplateInput,
  CreateEventLogInput,
} from './store'

export { InMemoryLedgerStore } from './testing/InMemoryLedgerStore'

// ── Receivables ledger ───────────────────────────────────────────────────────
export { BillingService } from './receivables/BillingService'
export type {
  BillingConfig,
  RecordPaymentParams,
  RecordPaymentResult,
  RecordPaymentForInvoiceParams,
  PreviewAllocationParams,
  PreviewAllocationResult,
  AllocationStep,
  VoidInvoicePaymentsParams,
  VoidInvoicePaymentsResult,
  ReversePaymentParams,
  ReversePaymentResult,
  VoidInvoiceParams,
  VoidInvoiceResult,
  ApplyCreditParams,
  ApplyCreditResult,
  ApplyCreditNoteParams,
  CreateManualInvoiceParams,
} from './receivables/BillingService'

export {
  sumAllocations,
  computeBalance,
  computeEffectiveStatus,
} from './receivables/invoice-status'
export type { HasAmount } from './receivables/invoice-status'

export {
  planWaterfall,
  selectOpenInvoices,
  sumAllocationsByInvoice,
} from './receivables/waterfall'
export type { OpenCharge, WaterfallPlan } from './receivables/waterfall'

// ── Cash ledger ──────────────────────────────────────────────────────────────
export {
  LedgerService,
  computeLedgerTotals,
  categoryMatchesDirection,
  monthKey,
} from './cash/LedgerService'
export type {
  LedgerServiceOptions,
  AddLedgerEntryParams,
  VoidLedgerEntryParams,
  CreateTemplateParams,
  UpdateTemplateParams,
  DeleteTemplateParams,
  MaterializeTemplatesParams,
  LedgerTotals,
} from './cash/LedgerService'
