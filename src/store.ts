/**
 * LedgerStore: the one storage port.
 *
 * The ledger never imports a database driver. Everything it reads or writes
 * goes through this interface, which a host implements against whatever it
 * runs on. `InMemoryLedgerStore` in this package is a complete implementation
 * and is what the test suite runs against.
 *
 * Two rules hold for every method:
 *
 *   1. Every method takes `organizationId` and MUST scope to it. A row
 *      belonging to another tenant must read as absent, not as forbidden.
 *   2. Rows that carry no tenant column of their own (`Allocation`) are
 *      reached through a parent that does. An implementation that filters
 *      them by id alone is wrong, and nothing in the ledger can catch that
 *      for you.
 *
 * `runTransaction` must be atomic. The ledger relies on it: the event-log row
 * that anchors idempotency is written inside the same transaction as the data,
 * so that a rollback releases the key. READ COMMITTED is enough, provided
 * `lockAccount` does what it says: every operation that changes what is
 * allocated on an account takes that lock first, so two of them cannot read
 * the same outstanding balance and both spend it.
 *
 * Storage failures cross back into the ledger as `StoreError` (or its
 * subclass `UniqueViolationError`), never as a driver's own error type.
 */

import type { Money } from './money'
import type { ActorType, EventType } from './events'

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | 'PENDING'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERDUE'
  | 'VOID'

export type PaymentMethod =
  | 'CASH'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'CHECK'
  | 'OTHER'
  /** Historical payments created when migrating in from another system. */
  | 'IMPORTED'

export type CreditNoteReason =
  | 'DISCOUNT'
  | 'CORRECTION'
  | 'REFUND'
  | 'GOODWILL'
  | 'OTHER'

/** Which way the cash moved. The amount itself is always positive. */
export type LedgerDirection = 'IN' | 'OUT'

/**
 * What wrote a cash row.
 *   PAYMENT: written automatically alongside a payment on the receivables side.
 *   MANUAL: a human typed it in.
 *   RECURRING: posted from a recurring expense template.
 */
export type LedgerSource = 'PAYMENT' | 'MANUAL' | 'RECURRING'

/**
 * A category name, from the caller's own chart of accounts. The ledger does
 * not define a taxonomy; it only enforces that a category is used in the
 * direction its owner declared. See `CategoryTaxonomy`.
 */
export type LedgerCategory = string

/** The caller's chart of accounts, split by direction. */
export interface CategoryTaxonomy {
  readonly in: readonly LedgerCategory[]
  readonly out: readonly LedgerCategory[]
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The party money is owed by and received from. The ledger stores nothing
 * about it: an account is an id inside a tenant, and everything else about
 * the party lives in the host system.
 */
export interface Account {
  id: string
  organizationId: string
}

/** A charge: an amount an account owes, by a date. */
export interface Invoice {
  id: string
  amount: Money
  currency: string
  status: InvoiceStatus
  dueDate: Date
  /** Billing period, "YYYY-MM". Null when the charge belongs to no period. */
  month: string | null
  /** Opaque caller reference, an order id, a contract id, anything. */
  reference: string | null
  notes: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  accountId: string
  organizationId: string
}

/** Money received. Its amount is never mutated; see `voidTransaction`. */
export interface FinancialTransaction {
  id: string
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  paymentDate: Date
  month: string | null
  notes: string | null
  idempotencyKey: string
  /** Who recorded it. */
  recordedBy: string
  /** Who handed the money over. Not the same as `recordedBy`. */
  payerId: string
  accountId: string
  organizationId: string
  createdAt: Date
  /** Set when the payment was undone. Voided payments are excluded from balances. */
  voidedBy: string | null
  voidedAt: Date | null
  voidReason: string | null
}

/**
 * A join between money received and a charge it covers. Derived, not a money
 * fact: the facts are the transaction and the invoice. Deleted rather than
 * flagged when a payment is reversed.
 */
export interface Allocation {
  id: string
  amount: Money
  createdBy: string
  createdAt: Date
  transactionId: string
  invoiceId: string
}

/**
 * A reduction in an account's standing credit, with no money moving: cash
 * handed back for an overpayment, or a correction to money that was recorded
 * but should not count. It does not touch an open charge. To reduce what is
 * owed on a charge, reverse the payment or replace the charge; to give money
 * back, this plus an OUT row on the cash ledger.
 */
export interface CreditNote {
  id: string
  amount: Money
  currency: string
  reason: CreditNoteReason
  notes: string | null
  createdBy: string
  createdAt: Date
  accountId: string
  organizationId: string
}

/**
 * A single signed cash row. `amount` is always positive minor units; the sign
 * is carried by `direction`. Voided rows (voidedAt set) drop out of totals.
 */
export interface LedgerEntry {
  id: string
  direction: LedgerDirection
  category: LedgerCategory
  amount: Money
  currency: string
  occurredAt: Date
  month: string
  note: string | null
  source: LedgerSource
  createdBy: string
  /** Set when this row was written alongside a payment. */
  transactionId: string | null
  /** Who the money went to or came from, when that is a party the host tracks. */
  counterpartyId: string | null
  templateId: string | null
  voidedBy: string | null
  voidedAt: Date | null
  voidReason: string | null
  createdAt: Date
  organizationId: string
}

/** A recurring expense, posted once per month on its day. */
export interface RecurringExpenseTemplate {
  id: string
  name: string
  category: LedgerCategory
  amount: Money
  currency: string
  dayOfMonth: number
  counterpartyId: string | null
  note: string | null
  active: boolean
  createdBy: string
  organizationId: string
}

/** One row per mutating ledger operation. Append only. */
export interface EventLog {
  id: string
  type: EventType
  payload: Record<string, unknown>
  actorId: string
  actorType: ActorType
  /** Set when a background job wrote the row, for traceability. */
  jobId: string | null
  idempotencyKey: string
  createdAt: Date
  organizationId: string
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE INPUTS
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  amount: Money
  currency: string
  status: InvoiceStatus
  dueDate: Date
  month?: string
  reference?: string
  notes?: string
  createdBy?: string
  accountId: string
}

export interface UpdateInvoiceInput {
  status?: InvoiceStatus
  notes?: string
}

export interface CreateTransactionInput {
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  paymentDate: Date
  month?: string
  notes?: string
  idempotencyKey: string
  recordedBy: string
  payerId: string
  accountId: string
}

export interface VoidTransactionInput {
  voidedBy: string
  voidReason?: string | null
}

export interface CreateAllocationInput {
  amount: Money
  createdBy: string
  transactionId: string
  invoiceId: string
}

export interface CreateCreditNoteInput {
  amount: Money
  currency: string
  reason: CreditNoteReason
  notes?: string
  createdBy: string
  accountId: string
}

export interface CreateLedgerEntryInput {
  direction: LedgerDirection
  category: LedgerCategory
  amount: Money
  currency: string
  occurredAt: Date
  month: string
  note?: string | null
  source: LedgerSource
  createdBy: string
  transactionId?: string | null
  counterpartyId?: string | null
  templateId?: string | null
}

export interface VoidLedgerEntryInput {
  voidedBy: string
  voidReason?: string | null
}

export interface CreateRecurringExpenseTemplateInput {
  name: string
  category: LedgerCategory
  amount: Money
  currency: string
  dayOfMonth: number
  counterpartyId?: string | null
  note?: string | null
  createdBy: string
}

/**
 * Editable fields of a recurring expense template. Currency is intentionally
 * omitted: it is a property of the tenant, not of the template. `active` is
 * toggled via `deactivateRecurringExpenseTemplate`, not here.
 */
export interface UpdateRecurringExpenseTemplateInput {
  name: string
  category: LedgerCategory
  amount: Money
  dayOfMonth: number
  counterpartyId?: string | null
  note?: string | null
}

export interface CreateEventLogInput {
  type: EventType
  payload: Record<string, unknown>
  actorId: string
  actorType: ActorType
  jobId?: string
  idempotencyKey: string
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PORT
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerStore {
  /**
   * Runs `fn` inside one atomic storage transaction. Everything written inside
   * commits together or not at all.
   */
  runTransaction<T>(fn: (tx: LedgerStore) => Promise<T>): Promise<T>

  // ── Accounts ──────────────────────────────────────────────────────────────

  findAccountById(id: string, organizationId: string): Promise<Account | null>

  /**
   * MUST take a row lock on the account (SELECT ... FOR UPDATE, or the
   * equivalent) that lasts until the enclosing `runTransaction` commits or
   * rolls back. This is what serialises allocation on one account: a second
   * payment, credit application or reversal for the same account waits here
   * until the first has committed, then reads the balances it left behind.
   *
   * Outside a transaction this is a plain read. Returns null when the account
   * is not in this tenant, the same as `findAccountById`.
   */
  lockAccount(accountId: string, organizationId: string): Promise<Account | null>

  // ── Invoices ──────────────────────────────────────────────────────────────

  findInvoiceById(id: string, organizationId: string): Promise<Invoice | null>
  findInvoicesByAccount(accountId: string, organizationId: string): Promise<Invoice[]>
  createInvoice(data: CreateInvoiceInput, organizationId: string): Promise<Invoice>
  updateInvoice(
    id: string,
    data: UpdateInvoiceInput,
    organizationId: string
  ): Promise<Invoice>

  // ── Payments ──────────────────────────────────────────────────────────────

  findTransactionById(
    id: string,
    organizationId: string
  ): Promise<FinancialTransaction | null>
  createTransaction(
    data: CreateTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction>
  /**
   * MUST exclude voided payments. A reversed payment that still appeared here
   * would come back as standing credit on the account.
   */
  findTransactionsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<FinancialTransaction[]>
  voidTransaction(
    id: string,
    data: VoidTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction>

  // ── Allocations ───────────────────────────────────────────────────────────

  createAllocation(
    data: CreateAllocationInput,
    organizationId: string
  ): Promise<Allocation>
  findAllocationsByInvoice(
    invoiceId: string,
    organizationId: string
  ): Promise<Allocation[]>
  findAllocationsByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<Allocation[]>
  findAllocationsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<Allocation[]>
  /** A missing row is a no-op, not an error. */
  deleteAllocation(id: string, organizationId: string): Promise<void>

  // ── Credit notes ──────────────────────────────────────────────────────────

  createCreditNote(
    data: CreateCreditNoteInput,
    organizationId: string
  ): Promise<CreditNote>
  findCreditNotesByAccount(
    accountId: string,
    organizationId: string
  ): Promise<CreditNote[]>

  // ── Cash ledger ───────────────────────────────────────────────────────────

  createLedgerEntry(
    data: CreateLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry>
  findLedgerEntryById(
    id: string,
    organizationId: string
  ): Promise<LedgerEntry | null>
  voidLedgerEntry(
    id: string,
    data: VoidLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry>
  /** Live rows only, voided rows must not come back. */
  findLedgerEntriesByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<LedgerEntry[]>
  /**
   * The idempotency probe for recurring postings. A unique constraint on
   * (templateId, month) is the recommended second backstop.
   */
  findLedgerEntryByTemplateMonth(
    templateId: string,
    month: string,
    organizationId: string
  ): Promise<LedgerEntry | null>

  // ── Recurring expense templates ───────────────────────────────────────────

  createRecurringExpenseTemplate(
    data: CreateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate>
  findActiveRecurringExpenseTemplates(
    organizationId: string
  ): Promise<RecurringExpenseTemplate[]>
  findRecurringExpenseTemplateById(
    id: string,
    organizationId: string
  ): Promise<RecurringExpenseTemplate | null>
  updateRecurringExpenseTemplate(
    id: string,
    data: UpdateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate>
  deactivateRecurringExpenseTemplate(
    id: string,
    organizationId: string
  ): Promise<void>

  // ── Event log ─────────────────────────────────────────────────────────────

  /**
   * MUST enforce uniqueness on (organizationId, idempotencyKey) and throw on a
   * duplicate. This is what makes the pre-flight idempotency check safe under
   * concurrency: the check can lose the race, the constraint cannot.
   */
  createEventLog(
    data: CreateEventLogInput,
    organizationId: string
  ): Promise<EventLog>
  findEventLogByKey(
    idempotencyKey: string,
    organizationId: string
  ): Promise<EventLog | null>
}
