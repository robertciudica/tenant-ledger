/**
 * InMemoryLedgerStore: a complete LedgerStore with no dependencies.
 *
 * All data is held in plain arrays on the `seed` property, so a caller can push
 * pre-built fixtures directly instead of going through the create methods.
 *
 * Multi-tenant contract: every method that takes organizationId only reads or
 * writes rows belonging to that tenant. The same guarantee holds for rows that
 * carry no tenant column of their own (Allocation): they are reached through
 * their parent.
 *
 * Transactions: the outermost `runTransaction` snapshots every table before
 * running the callback and restores the snapshot if it throws, so a failed
 * operation leaves nothing behind, the same as a real database. A nested call
 * joins the open transaction. What this does not model is concurrency: there
 * is one caller at a time, so `lockAccount` has nothing to lock.
 */

import type {
  LedgerStore,
  Account,
  Invoice,
  FinancialTransaction,
  Allocation,
  CreditNote,
  LedgerEntry,
  RecurringExpenseTemplate,
  EventLog,
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
} from '../store'
import { StoreError, UniqueViolationError, DuplicateIdempotencyKeyError } from '../errors'

export class InMemoryLedgerStore implements LedgerStore {
  /** Per-instance id counter, so two stores in one process never share ids. */
  private idCounter = 0
  private genId(): string {
    return `mem_${++this.idCounter}`
  }

  /** Public so callers can seed rows directly. */
  seed = {
    accounts:     [] as Account[],
    invoices:     [] as Invoice[],
    transactions: [] as FinancialTransaction[],
    allocations:  [] as Allocation[],
    creditNotes:  [] as CreditNote[],
    ledgerEntries: [] as LedgerEntry[],
    recurringExpenseTemplates: [] as RecurringExpenseTemplate[],
    eventLogs:    [] as EventLog[],
  }

  reset(): void {
    this.seed = {
      accounts:     [],
      invoices:     [],
      transactions: [],
      allocations:  [],
      creditNotes:  [],
      ledgerEntries: [],
      recurringExpenseTemplates: [],
      eventLogs:    [],
    }
    this.idCounter = 0
  }

  // ── Transaction support ──────────────────────────────────────────────────

  private transactionDepth = 0

  private snapshotSeed(): typeof this.seed {
    const copy = <T extends object>(rows: T[]): T[] => rows.map(row => ({ ...row }))
    return {
      accounts:                  copy(this.seed.accounts),
      invoices:                  copy(this.seed.invoices),
      transactions:              copy(this.seed.transactions),
      allocations:               copy(this.seed.allocations),
      creditNotes:               copy(this.seed.creditNotes),
      ledgerEntries:             copy(this.seed.ledgerEntries),
      recurringExpenseTemplates: copy(this.seed.recurringExpenseTemplates),
      eventLogs:                 copy(this.seed.eventLogs),
    }
  }

  async runTransaction<T>(fn: (tx: LedgerStore) => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) {
      return fn(this) // join the open transaction
    }
    // Rows are flat objects that are replaced, not mutated in place, apart
    // from the void and template updates, which assign top-level fields. A
    // per-row shallow copy is therefore a complete snapshot. structuredClone
    // would do too, but it hands back arrays from another realm inside a
    // test sandbox and strict deep-equality then fails on []. Rows handed out
    // before the snapshot keep pointing at the old objects; the store's own
    // state is what gets restored.
    const snapshot = this.snapshotSeed()
    const counter = this.idCounter
    this.transactionDepth += 1
    try {
      return await fn(this)
    } catch (error) {
      this.seed = snapshot
      this.idCounter = counter
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  async findAccountById(id: string, organizationId: string): Promise<Account | null> {
    return (
      this.seed.accounts.find(
        a => a.id === id && a.organizationId === organizationId
      ) ?? null
    )
  }

  /**
   * A plain read. There is nothing to lock: this store is single-threaded and
   * every await resolves in order, so two operations on one account cannot
   * interleave inside a transaction. A real store takes a row lock here.
   */
  async lockAccount(accountId: string, organizationId: string): Promise<Account | null> {
    return this.findAccountById(accountId, organizationId)
  }

  // ── Invoices ─────────────────────────────────────────────────────────────

  async findInvoiceById(id: string, organizationId: string): Promise<Invoice | null> {
    return (
      this.seed.invoices.find(
        inv => inv.id === id && inv.organizationId === organizationId
      ) ?? null
    )
  }

  async findInvoicesByAccount(
    accountId: string,
    organizationId: string
  ): Promise<Invoice[]> {
    return this.seed.invoices.filter(
      inv => inv.accountId === accountId && inv.organizationId === organizationId
    )
  }

  async createInvoice(
    data: CreateInvoiceInput,
    organizationId: string
  ): Promise<Invoice> {
    const now = new Date()
    const invoice: Invoice = {
      id:        this.genId(),
      amount:    data.amount,
      currency:  data.currency,
      status:    data.status,
      dueDate:   data.dueDate,
      month:     data.month ?? null,
      reference: data.reference ?? null,
      notes:     data.notes ?? null,
      createdBy: data.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      accountId: data.accountId,
      organizationId,
    }
    this.seed.invoices.push(invoice)
    return invoice
  }

  async updateInvoice(
    id: string,
    data: UpdateInvoiceInput,
    organizationId: string
  ): Promise<Invoice> {
    const idx = this.seed.invoices.findIndex(
      inv => inv.id === id && inv.organizationId === organizationId
    )
    if (idx === -1) {
      throw new StoreError(`InMemoryLedgerStore.updateInvoice: Invoice not found: ${id}`)
    }
    const existing = this.seed.invoices[idx]
    const updated: Invoice = {
      ...existing,
      ...(data.status !== undefined && { status: data.status }),
      ...(data.notes  !== undefined && { notes:  data.notes ?? null }),
      updatedAt: new Date(),
    }
    this.seed.invoices[idx] = updated
    return updated
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async findTransactionById(
    id: string,
    organizationId: string
  ): Promise<FinancialTransaction | null> {
    return (
      this.seed.transactions.find(
        t => t.id === id && t.organizationId === organizationId
      ) ?? null
    )
  }

  async createTransaction(
    data: CreateTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction> {
    const now = new Date()
    const transaction: FinancialTransaction = {
      id:             this.genId(),
      amount:         data.amount,
      currency:       data.currency,
      paymentMethod:  data.paymentMethod,
      paymentDate:    data.paymentDate,
      month:          data.month ?? null,
      notes:          data.notes ?? null,
      idempotencyKey: data.idempotencyKey,
      recordedBy:     data.recordedBy,
      payerId:        data.payerId,
      accountId:      data.accountId,
      organizationId,
      createdAt:      now,
      voidedBy:       null,
      voidedAt:       null,
      voidReason:     null,
    }
    this.seed.transactions.push(transaction)
    return transaction
  }

  async findTransactionsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<FinancialTransaction[]> {
    // Voided payments are excluded, as the port requires. Without this, a
    // reversed payment would read back as standing credit on the account.
    return this.seed.transactions.filter(
      t =>
        t.accountId === accountId &&
        t.organizationId === organizationId &&
        t.voidedAt == null
    )
  }

  async voidTransaction(
    id: string,
    data: VoidTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction> {
    const transaction = this.seed.transactions.find(
      t => t.id === id && t.organizationId === organizationId
    )
    if (!transaction) throw new StoreError(`InMemoryLedgerStore.voidTransaction: not found: ${id}`)
    transaction.voidedBy   = data.voidedBy
    transaction.voidedAt   = new Date()
    transaction.voidReason = data.voidReason ?? null
    return transaction
  }

  // ── Allocations ──────────────────────────────────────────────────────────

  async createAllocation(
    data: CreateAllocationInput,
    // organizationId is accepted for interface compliance. An allocation has no
    // tenant column: it is reached through its transaction and its invoice.
    _organizationId: string
  ): Promise<Allocation> {
    // Mirror the schema's UNIQUE (transaction_id, invoice_id).
    const duplicate = this.seed.allocations.some(
      a => a.transactionId === data.transactionId && a.invoiceId === data.invoiceId
    )
    if (duplicate) {
      throw new UniqueViolationError(
        `unique constraint allocations_txn_invoice_uq failed on (transactionId, invoiceId): ${data.transactionId}, ${data.invoiceId}`,
        'allocations_txn_invoice_uq'
      )
    }
    const allocation: Allocation = {
      id:            this.genId(),
      amount:        data.amount,
      createdBy:     data.createdBy,
      createdAt:     new Date(),
      transactionId: data.transactionId,
      invoiceId:     data.invoiceId,
    }
    this.seed.allocations.push(allocation)
    return allocation
  }

  /**
   * Reached through the invoice, which is what carries the tenant. Filtering
   * on `invoiceId` alone would return another tenant's rows to a caller who
   * guessed an id, and nothing above this line could catch it.
   */
  async findAllocationsByInvoice(
    invoiceId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    const visible = this.seed.invoices.some(
      inv => inv.id === invoiceId && inv.organizationId === organizationId
    )
    return visible ? this.seed.allocations.filter(a => a.invoiceId === invoiceId) : []
  }

  /** Reached through the payment, for the same reason. */
  async findAllocationsByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    const visible = this.seed.transactions.some(
      t => t.id === transactionId && t.organizationId === organizationId
    )
    return visible ? this.seed.allocations.filter(a => a.transactionId === transactionId) : []
  }

  async findAllocationsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    // Allocations carry no accountId: reach them through their invoice, which
    // is also how the tenant filter gets applied.
    const accountInvoiceIds = new Set(
      this.seed.invoices
        .filter(inv => inv.accountId === accountId && inv.organizationId === organizationId)
        .map(inv => inv.id)
    )
    return this.seed.allocations.filter(a => accountInvoiceIds.has(a.invoiceId))
  }

  /** A missing row, or one in another tenant, is a no-op rather than a throw. */
  async deleteAllocation(id: string, organizationId: string): Promise<void> {
    const idx = this.seed.allocations.findIndex(a => a.id === id)
    if (idx < 0) return
    const parent = this.seed.invoices.find(
      inv => inv.id === this.seed.allocations[idx].invoiceId
    )
    if (parent?.organizationId !== organizationId) return
    this.seed.allocations.splice(idx, 1)
  }

  // ── Credit notes ─────────────────────────────────────────────────────────

  async createCreditNote(
    data: CreateCreditNoteInput,
    organizationId: string
  ): Promise<CreditNote> {
    const creditNote: CreditNote = {
      id:        this.genId(),
      amount:    data.amount,
      currency:  data.currency,
      reason:    data.reason,
      notes:     data.notes ?? null,
      createdBy: data.createdBy,
      createdAt: new Date(),
      accountId: data.accountId,
      organizationId,
    }
    this.seed.creditNotes.push(creditNote)
    return creditNote
  }

  async findCreditNotesByAccount(
    accountId: string,
    organizationId: string
  ): Promise<CreditNote[]> {
    return this.seed.creditNotes.filter(
      cn => cn.accountId === accountId && cn.organizationId === organizationId
    )
  }

  // ── Cash ledger ──────────────────────────────────────────────────────────

  async createLedgerEntry(
    data: CreateLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry> {
    const entry: LedgerEntry = {
      id:             this.genId(),
      direction:      data.direction,
      category:       data.category,
      amount:         data.amount,
      currency:       data.currency,
      occurredAt:     data.occurredAt,
      month:          data.month,
      note:           data.note ?? null,
      source:         data.source,
      createdBy:      data.createdBy,
      transactionId:  data.transactionId ?? null,
      counterpartyId: data.counterpartyId ?? null,
      templateId:     data.templateId ?? null,
      voidedBy:       null,
      voidedAt:       null,
      voidReason:     null,
      createdAt:      new Date(),
      organizationId,
    }
    this.seed.ledgerEntries.push(entry)
    return entry
  }

  async findLedgerEntryById(
    id: string,
    organizationId: string
  ): Promise<LedgerEntry | null> {
    return (
      this.seed.ledgerEntries.find(
        e => e.id === id && e.organizationId === organizationId
      ) ?? null
    )
  }

  async voidLedgerEntry(
    id: string,
    data: VoidLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry> {
    const entry = this.seed.ledgerEntries.find(
      e => e.id === id && e.organizationId === organizationId
    )
    if (!entry) {
      throw new StoreError(`InMemoryLedgerStore.voidLedgerEntry: not found: ${id}`)
    }
    entry.voidedBy = data.voidedBy
    entry.voidedAt = new Date()
    entry.voidReason = data.voidReason ?? null
    return entry
  }

  async findLedgerEntriesByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<LedgerEntry[]> {
    return this.seed.ledgerEntries.filter(
      e =>
        e.transactionId === transactionId &&
        e.organizationId === organizationId &&
        e.voidedAt == null
    )
  }

  async findLedgerEntryByTemplateMonth(
    templateId: string,
    month: string,
    organizationId: string
  ): Promise<LedgerEntry | null> {
    return (
      this.seed.ledgerEntries.find(
        e =>
          e.templateId === templateId &&
          e.month === month &&
          e.organizationId === organizationId
      ) ?? null
    )
  }

  // ── Recurring expense templates ──────────────────────────────────────────

  async createRecurringExpenseTemplate(
    data: CreateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate> {
    const template: RecurringExpenseTemplate = {
      id:             this.genId(),
      name:           data.name,
      category:       data.category,
      amount:         data.amount,
      currency:       data.currency,
      dayOfMonth:     data.dayOfMonth,
      counterpartyId: data.counterpartyId ?? null,
      note:           data.note ?? null,
      active:         true,
      createdBy:      data.createdBy,
      organizationId,
    }
    this.seed.recurringExpenseTemplates.push(template)
    return template
  }

  async findActiveRecurringExpenseTemplates(
    organizationId: string
  ): Promise<RecurringExpenseTemplate[]> {
    return this.seed.recurringExpenseTemplates
      .filter(t => t.organizationId === organizationId && t.active)
      .sort((a, b) => a.dayOfMonth - b.dayOfMonth)
  }

  async findRecurringExpenseTemplateById(
    id: string,
    organizationId: string
  ): Promise<RecurringExpenseTemplate | null> {
    return (
      this.seed.recurringExpenseTemplates.find(
        t => t.id === id && t.organizationId === organizationId
      ) ?? null
    )
  }

  async updateRecurringExpenseTemplate(
    id: string,
    data: UpdateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate> {
    const template = this.seed.recurringExpenseTemplates.find(
      t => t.id === id && t.organizationId === organizationId
    )
    if (!template) {
      throw new StoreError(`InMemoryLedgerStore.updateRecurringExpenseTemplate: not found: ${id}`)
    }
    template.name           = data.name
    template.category       = data.category
    template.amount         = data.amount
    template.dayOfMonth     = data.dayOfMonth
    template.counterpartyId = data.counterpartyId ?? null
    template.note           = data.note ?? null
    return template
  }

  async deactivateRecurringExpenseTemplate(
    id: string,
    organizationId: string
  ): Promise<void> {
    const template = this.seed.recurringExpenseTemplates.find(
      t => t.id === id && t.organizationId === organizationId
    )
    if (template) template.active = false
  }

  // ── Event log ────────────────────────────────────────────────────────────

  async createEventLog(
    data: CreateEventLogInput,
    organizationId: string
  ): Promise<EventLog> {
    // Mirror the unique constraint the port requires on
    // (organizationId, idempotencyKey). A real store throws here; so must this
    // one, or a concurrency bug would pass in tests and fail in production.
    const duplicate = this.seed.eventLogs.some(
      e => e.idempotencyKey === data.idempotencyKey && e.organizationId === organizationId
    )
    if (duplicate) {
      throw new DuplicateIdempotencyKeyError(organizationId, data.idempotencyKey)
    }
    const eventLog: EventLog = {
      id:             this.genId(),
      type:           data.type,
      payload:        data.payload,
      actorId:        data.actorId,
      actorType:      data.actorType,
      jobId:          data.jobId ?? null,
      idempotencyKey: data.idempotencyKey,
      createdAt:      new Date(),
      organizationId,
    }
    this.seed.eventLogs.push(eventLog)
    return eventLog
  }

  async findEventLogByKey(
    idempotencyKey: string,
    organizationId: string
  ): Promise<EventLog | null> {
    return (
      this.seed.eventLogs.find(
        e => e.idempotencyKey === idempotencyKey && e.organizationId === organizationId
      ) ?? null
    )
  }
}
