/**
 * PostgresLedgerStore: a LedgerStore on Postgres.
 *
 * Works on anything that speaks the `SqlClient` shape: a `pg` pool through
 * `pgPoolClient`, or PGlite directly. The package still has no runtime
 * dependencies; the driver is the caller's.
 *
 * What this implementation is for, beyond being usable: the port documents two
 * rules that a store can break silently, and one that only a real database can
 * keep at all. Voided payments must not come back from
 * `findTransactionsByAccount`. The event log must reject a duplicate
 * (organizationId, idempotencyKey). And `lockAccount` must actually block a
 * concurrent writer, which no in-memory store can demonstrate. The contract
 * suite runs against this store for the first two, and a real Postgres for the
 * third.
 *
 * Tenant scoping is in the SQL, on every statement. Allocations, which carry
 * no tenant column, are always reached by joining the invoice or the payment
 * that does.
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
import type { SqlClient, SqlQueryable } from './sql-client'
import { isSqlClient } from './sql-client'
import type { Row } from './rows'
import {
  toAccount,
  toInvoice,
  toTransaction,
  toAllocation,
  toCreditNote,
  toLedgerEntry,
  toTemplate,
  toEventLog,
} from './rows'

/** Postgres SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = '23505'

/**
 * The constraint in schema.sql that means "this idempotency key was already
 * used in this tenant". Known here and nowhere above: the store translates it
 * into `DuplicateIdempotencyKeyError`, and the ledger never sees the name.
 */
export const EVENT_LOG_KEY_CONSTRAINT = 'event_log_org_key_uq'

/**
 * Translates a driver error into the ledger's own error types, so a caller
 * never has to know which driver is underneath. Both `pg` and PGlite raise
 * pg-protocol's DatabaseError, which carries `code` and `constraint`; the
 * SQLSTATE is what is matched, never the message text, which is localised.
 */
function asStoreError(error: unknown, context: string): never {
  const driverError = error as { code?: string; constraint?: string; message?: string }
  if (driverError?.code === UNIQUE_VIOLATION) {
    throw new UniqueViolationError(
      `${context}: unique constraint ${driverError.constraint ?? '(unnamed)'} failed: ${driverError.message ?? ''}`,
      driverError.constraint,
      error
    )
  }
  if (error instanceof StoreError) throw error
  throw new StoreError(`${context}: ${driverError?.message ?? String(error)}`, error)
}

export class PostgresLedgerStore implements LedgerStore {
  /**
   * @param db    a `SqlClient` (a pool through `pgPoolClient`, or PGlite), or
   *              a plain queryable when this instance is already bound to an
   *              open transaction.
   * @param inTx  true when `db` is a transaction-bound connection.
   */
  constructor(
    private readonly db: SqlClient | SqlQueryable,
    private readonly inTx = false
  ) {}

  private async rows(context: string, text: string, params: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.db.query<Row>(text, params)
      return result.rows
    } catch (error) {
      asStoreError(error, context)
    }
  }

  private async one(context: string, text: string, params: readonly unknown[] = []): Promise<Row | null> {
    const rows = await this.rows(context, text, params)
    return rows[0] ?? null
  }

  /** For writes that must affect exactly one row: a miss is a StoreError. */
  private async exactlyOne(context: string, text: string, params: readonly unknown[] = []): Promise<Row> {
    const row = await this.one(context, text, params)
    if (!row) {
      throw new StoreError(`${context}: no row matched, in this tenant or at all`)
    }
    return row
  }

  // ── Transaction support ──────────────────────────────────────────────────

  /**
   * Opens one transaction, or joins the one already open.
   *
   * The nested case matters: a service may call `runTransaction` on a store it
   * was handed inside another transaction, and re-entering would either
   * deadlock (PGlite serialises on one connection) or open a second
   * independent transaction that could commit while the outer one rolls back.
   * Joining is also what the in-memory store does, so both behave the same.
   */
  async runTransaction<T>(fn: (tx: LedgerStore) => Promise<T>): Promise<T> {
    if (this.inTx || !isSqlClient(this.db)) {
      return fn(this)
    }
    return this.db.transaction(connection => fn(this.bindTo(connection)))
  }

  /**
   * Builds the store the transaction body runs against, bound to the
   * connection the transaction holds.
   *
   * Constructing this class by name would silently drop a subclass: a store
   * that overrides a query would find its override used outside transactions
   * and ignored inside them, which is the half of the code that matters.
   * `this.constructor` keeps the subclass, and this stays a named, overridable
   * method for anything that needs more than the two constructor arguments.
   */
  protected bindTo(connection: SqlQueryable): LedgerStore {
    const Self = this.constructor as new (
      db: SqlClient | SqlQueryable,
      inTx: boolean
    ) => LedgerStore
    return new Self(connection, true)
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  async findAccountById(id: string, organizationId: string): Promise<Account | null> {
    const row = await this.one(
      'findAccountById',
      'SELECT id, organization_id FROM accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
    return row ? toAccount(row) : null
  }

  /**
   * Takes the row lock that serialises allocation on this account.
   *
   * FOR UPDATE holds until the enclosing transaction ends. A second caller
   * reaching this line for the same account waits here, and then reads the
   * balances the first one committed rather than the ones it started from.
   * That is the whole mechanism: without it, two payments read the same open
   * charge and both allocate against it.
   *
   * Called outside a transaction this is an ordinary read that locks nothing
   * useful, because the lock is released immediately.
   */
  async lockAccount(accountId: string, organizationId: string): Promise<Account | null> {
    const row = await this.one(
      'lockAccount',
      'SELECT id, organization_id FROM accounts WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [accountId, organizationId]
    )
    return row ? toAccount(row) : null
  }

  // ── Invoices ─────────────────────────────────────────────────────────────

  async findInvoiceById(id: string, organizationId: string): Promise<Invoice | null> {
    const row = await this.one(
      'findInvoiceById',
      'SELECT * FROM invoices WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
    return row ? toInvoice(row) : null
  }

  async findInvoicesByAccount(accountId: string, organizationId: string): Promise<Invoice[]> {
    const rows = await this.rows(
      'findInvoicesByAccount',
      `SELECT * FROM invoices
        WHERE account_id = $1 AND organization_id = $2
        ORDER BY created_at ASC, seq ASC`,
      [accountId, organizationId]
    )
    return rows.map(toInvoice)
  }

  async createInvoice(data: CreateInvoiceInput, organizationId: string): Promise<Invoice> {
    const row = await this.exactlyOne(
      'createInvoice',
      `INSERT INTO invoices
         (organization_id, account_id, amount, currency, status, due_date, month, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        organizationId,
        data.accountId,
        data.amount,
        data.currency,
        data.status,
        data.dueDate,
        data.month ?? null,
        data.reference ?? null,
        data.notes ?? null,
        data.createdBy ?? null,
      ]
    )
    return toInvoice(row)
  }

  async updateInvoice(
    id: string,
    data: UpdateInvoiceInput,
    organizationId: string
  ): Promise<Invoice> {
    // COALESCE leaves a column alone when the parameter is null, so one
    // statement covers every subset of the update input.
    const row = await this.exactlyOne(
      'updateInvoice',
      `UPDATE invoices
          SET status     = COALESCE($3, status),
              notes      = CASE WHEN $4::boolean THEN $5 ELSE notes END,
              updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [id, organizationId, data.status ?? null, data.notes !== undefined, data.notes ?? null]
    )
    return toInvoice(row)
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async findTransactionById(
    id: string,
    organizationId: string
  ): Promise<FinancialTransaction | null> {
    const row = await this.one(
      'findTransactionById',
      'SELECT * FROM financial_transactions WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
    return row ? toTransaction(row) : null
  }

  async createTransaction(
    data: CreateTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction> {
    const row = await this.exactlyOne(
      'createTransaction',
      `INSERT INTO financial_transactions
         (organization_id, account_id, amount, currency, payment_method, payment_date,
          month, notes, idempotency_key, recorded_by, payer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        organizationId,
        data.accountId,
        data.amount,
        data.currency,
        data.paymentMethod,
        data.paymentDate,
        data.month ?? null,
        data.notes ?? null,
        data.idempotencyKey,
        data.recordedBy,
        data.payerId,
      ]
    )
    return toTransaction(row)
  }

  /**
   * Live payments only. The WHERE clause is not an optimisation: a voided
   * payment returned here reads as standing credit on the account, and the
   * money it represents can be spent a second time.
   */
  async findTransactionsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<FinancialTransaction[]> {
    const rows = await this.rows(
      'findTransactionsByAccount',
      `SELECT * FROM financial_transactions
        WHERE account_id = $1 AND organization_id = $2 AND voided_at IS NULL
        ORDER BY created_at ASC, seq ASC`,
      [accountId, organizationId]
    )
    return rows.map(toTransaction)
  }

  async voidTransaction(
    id: string,
    data: VoidTransactionInput,
    organizationId: string
  ): Promise<FinancialTransaction> {
    const row = await this.exactlyOne(
      'voidTransaction',
      `UPDATE financial_transactions
          SET voided_by = $3, voided_at = now(), void_reason = $4
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [id, organizationId, data.voidedBy, data.voidReason ?? null]
    )
    return toTransaction(row)
  }

  // ── Allocations ──────────────────────────────────────────────────────────

  /**
   * The insert reads its own tenant check: both the payment and the charge
   * have to exist in `organizationId`, or no row is produced and this throws.
   * An allocation is the one entity with no tenant column, so this is where
   * the tenant is enforced for it.
   */
  async createAllocation(
    data: CreateAllocationInput,
    organizationId: string
  ): Promise<Allocation> {
    const row = await this.exactlyOne(
      'createAllocation',
      `INSERT INTO allocations (amount, created_by, transaction_id, invoice_id)
       SELECT $1, $2, t.id, i.id
         FROM invoices i
         JOIN financial_transactions t
           ON t.id = $4 AND t.organization_id = $5
        WHERE i.id = $3 AND i.organization_id = $5
       RETURNING *`,
      [data.amount, data.createdBy, data.invoiceId, data.transactionId, organizationId]
    )
    return toAllocation(row)
  }

  async findAllocationsByInvoice(
    invoiceId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    const rows = await this.rows(
      'findAllocationsByInvoice',
      `SELECT a.* FROM allocations a
         JOIN invoices i ON i.id = a.invoice_id
        WHERE a.invoice_id = $1 AND i.organization_id = $2
        ORDER BY a.created_at ASC, a.id ASC`,
      [invoiceId, organizationId]
    )
    return rows.map(toAllocation)
  }

  async findAllocationsByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    const rows = await this.rows(
      'findAllocationsByTransaction',
      `SELECT a.* FROM allocations a
         JOIN financial_transactions t ON t.id = a.transaction_id
        WHERE a.transaction_id = $1 AND t.organization_id = $2
        ORDER BY a.created_at ASC, a.id ASC`,
      [transactionId, organizationId]
    )
    return rows.map(toAllocation)
  }

  async findAllocationsByAccount(
    accountId: string,
    organizationId: string
  ): Promise<Allocation[]> {
    const rows = await this.rows(
      'findAllocationsByAccount',
      `SELECT a.* FROM allocations a
         JOIN invoices i ON i.id = a.invoice_id
        WHERE i.account_id = $1 AND i.organization_id = $2
        ORDER BY a.created_at ASC, a.id ASC`,
      [accountId, organizationId]
    )
    return rows.map(toAllocation)
  }

  /** A missing row, or one in another tenant, is a no-op rather than an error. */
  async deleteAllocation(id: string, organizationId: string): Promise<void> {
    await this.rows(
      'deleteAllocation',
      `DELETE FROM allocations a
        USING invoices i
        WHERE a.id = $1 AND i.id = a.invoice_id AND i.organization_id = $2`,
      [id, organizationId]
    )
  }

  // ── Credit notes ─────────────────────────────────────────────────────────

  async createCreditNote(
    data: CreateCreditNoteInput,
    organizationId: string
  ): Promise<CreditNote> {
    const row = await this.exactlyOne(
      'createCreditNote',
      `INSERT INTO credit_notes
         (organization_id, account_id, amount, currency, reason, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        organizationId,
        data.accountId,
        data.amount,
        data.currency,
        data.reason,
        data.notes ?? null,
        data.createdBy,
      ]
    )
    return toCreditNote(row)
  }

  async findCreditNotesByAccount(
    accountId: string,
    organizationId: string
  ): Promise<CreditNote[]> {
    const rows = await this.rows(
      'findCreditNotesByAccount',
      `SELECT * FROM credit_notes
        WHERE account_id = $1 AND organization_id = $2
        ORDER BY created_at ASC, id ASC`,
      [accountId, organizationId]
    )
    return rows.map(toCreditNote)
  }

  // ── Cash ledger ──────────────────────────────────────────────────────────

  async createLedgerEntry(
    data: CreateLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry> {
    const row = await this.exactlyOne(
      'createLedgerEntry',
      `INSERT INTO ledger_entries
         (organization_id, direction, category, amount, currency, occurred_at, month,
          note, source, created_by, transaction_id, counterparty_id, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        organizationId,
        data.direction,
        data.category,
        data.amount,
        data.currency,
        data.occurredAt,
        data.month,
        data.note ?? null,
        data.source,
        data.createdBy,
        data.transactionId ?? null,
        data.counterpartyId ?? null,
        data.templateId ?? null,
      ]
    )
    return toLedgerEntry(row)
  }

  async findLedgerEntryById(id: string, organizationId: string): Promise<LedgerEntry | null> {
    const row = await this.one(
      'findLedgerEntryById',
      'SELECT * FROM ledger_entries WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
    return row ? toLedgerEntry(row) : null
  }

  async voidLedgerEntry(
    id: string,
    data: VoidLedgerEntryInput,
    organizationId: string
  ): Promise<LedgerEntry> {
    const row = await this.exactlyOne(
      'voidLedgerEntry',
      `UPDATE ledger_entries
          SET voided_by = $3, voided_at = now(), void_reason = $4
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [id, organizationId, data.voidedBy, data.voidReason ?? null]
    )
    return toLedgerEntry(row)
  }

  /** Live rows only: a voided cash row has left the totals for good. */
  async findLedgerEntriesByTransaction(
    transactionId: string,
    organizationId: string
  ): Promise<LedgerEntry[]> {
    const rows = await this.rows(
      'findLedgerEntriesByTransaction',
      `SELECT * FROM ledger_entries
        WHERE transaction_id = $1 AND organization_id = $2 AND voided_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [transactionId, organizationId]
    )
    return rows.map(toLedgerEntry)
  }

  async findLedgerEntryByTemplateMonth(
    templateId: string,
    month: string,
    organizationId: string
  ): Promise<LedgerEntry | null> {
    const row = await this.one(
      'findLedgerEntryByTemplateMonth',
      `SELECT * FROM ledger_entries
        WHERE template_id = $1 AND month = $2 AND organization_id = $3`,
      [templateId, month, organizationId]
    )
    return row ? toLedgerEntry(row) : null
  }

  // ── Recurring expense templates ──────────────────────────────────────────

  async createRecurringExpenseTemplate(
    data: CreateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate> {
    const row = await this.exactlyOne(
      'createRecurringExpenseTemplate',
      `INSERT INTO recurring_expense_templates
         (organization_id, name, category, amount, currency, day_of_month,
          counterparty_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        organizationId,
        data.name,
        data.category,
        data.amount,
        data.currency,
        data.dayOfMonth,
        data.counterpartyId ?? null,
        data.note ?? null,
        data.createdBy,
      ]
    )
    return toTemplate(row)
  }

  async findActiveRecurringExpenseTemplates(
    organizationId: string
  ): Promise<RecurringExpenseTemplate[]> {
    const rows = await this.rows(
      'findActiveRecurringExpenseTemplates',
      `SELECT * FROM recurring_expense_templates
        WHERE organization_id = $1 AND active
        ORDER BY day_of_month ASC, id ASC`,
      [organizationId]
    )
    return rows.map(toTemplate)
  }

  async findRecurringExpenseTemplateById(
    id: string,
    organizationId: string
  ): Promise<RecurringExpenseTemplate | null> {
    const row = await this.one(
      'findRecurringExpenseTemplateById',
      'SELECT * FROM recurring_expense_templates WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
    return row ? toTemplate(row) : null
  }

  async updateRecurringExpenseTemplate(
    id: string,
    data: UpdateRecurringExpenseTemplateInput,
    organizationId: string
  ): Promise<RecurringExpenseTemplate> {
    const row = await this.exactlyOne(
      'updateRecurringExpenseTemplate',
      `UPDATE recurring_expense_templates
          SET name = $3, category = $4, amount = $5, day_of_month = $6,
              counterparty_id = $7, note = $8
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [
        id,
        organizationId,
        data.name,
        data.category,
        data.amount,
        data.dayOfMonth,
        data.counterpartyId ?? null,
        data.note ?? null,
      ]
    )
    return toTemplate(row)
  }

  /** Soft delete. Rows already posted from this template are real expenses. */
  async deactivateRecurringExpenseTemplate(id: string, organizationId: string): Promise<void> {
    await this.rows(
      'deactivateRecurringExpenseTemplate',
      'UPDATE recurring_expense_templates SET active = false WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    )
  }

  // ── Event log ────────────────────────────────────────────────────────────

  /**
   * Append one event row. The unique constraint on
   * (organization_id, idempotency_key) is what makes idempotency real: the
   * service's pre-flight read can lose a race, this cannot. A duplicate comes
   * back as `UniqueViolationError` and the service turns it into
   * `IdempotencyError`.
   */
  async createEventLog(
    data: CreateEventLogInput,
    organizationId: string
  ): Promise<EventLog> {
    let row: Row
    try {
      row = await this.exactlyOne(
        'createEventLog',
      `INSERT INTO event_log
         (organization_id, type, payload, actor_id, actor_type, job_id, idempotency_key)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING *`,
      [
        organizationId,
        data.type,
        // Stringified rather than passed as an object: an array payload would
        // otherwise be ambiguous with a Postgres array under `pg`.
        JSON.stringify(data.payload ?? {}),
        data.actorId,
        data.actorType,
        data.jobId ?? null,
        data.idempotencyKey,
      ]
      )
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === EVENT_LOG_KEY_CONSTRAINT) {
        throw new DuplicateIdempotencyKeyError(organizationId, data.idempotencyKey, error.cause)
      }
      throw error
    }
    return toEventLog(row)
  }

  async findEventLogByKey(
    idempotencyKey: string,
    organizationId: string
  ): Promise<EventLog | null> {
    const row = await this.one(
      'findEventLogByKey',
      'SELECT * FROM event_log WHERE idempotency_key = $1 AND organization_id = $2',
      [idempotencyKey, organizationId]
    )
    return row ? toEventLog(row) : null
  }
}
