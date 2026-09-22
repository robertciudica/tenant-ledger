/**
 * BillingService: the receivables ledger.
 *
 * Owns: recording payments, waterfall allocation, standing credit, reversal,
 * credit notes, and charge creation.
 *
 * No storage driver, no HTTP, no file I/O. All storage goes through the
 * LedgerStore port injected via the constructor.
 *
 * All monetary values are minor currency units (integers). See Money.
 *
 * The tenant arrives as an explicit `organizationId` parameter on every method.
 * There is no ambient context, no async-local storage, no closure over a
 * request. That is deliberate: it means a tenant can never be inherited by
 * accident, and every call site has to say which tenant it means.
 */

import type {
  LedgerStore,
  PaymentMethod,
  Invoice,
  InvoiceStatus,
  CreditNote,
  CreditNoteReason,
  LedgerCategory,
  FinancialTransaction,
  Allocation,
} from '../store'
import {
  NotFoundError,
  ValidationError,
  IdempotencyError,
  DuplicateIdempotencyKeyError,
} from '../errors'
import { EVENT_TYPES } from '../events'
import type { Permission } from '../permissions'
import { requirePermission } from '../permissions'
import type { Money } from '../money'
import { sumMoney } from '../money'
import { monthKey } from '../cash/LedgerService'
import {
  planWaterfall,
  selectOpenInvoices,
  sumAllocationsByInvoice,
} from './waterfall'
import type { AllocationStep, OpenCharge } from './waterfall'

export type { AllocationStep, OpenCharge } from './waterfall'

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingConfig {
  /**
   * The cash-ledger category used for the IN row written alongside every
   * payment. It must be an income category in the taxonomy the cash ledger was
   * built with, otherwise the two ledgers will disagree about direction.
   */
  readonly paymentCategory: LedgerCategory

  /**
   * Source of "now". Defaults to `() => new Date()`. Injected rather than
   * called directly so a caller can freeze time in a test, or hand the ledger
   * a clock that is not the process clock.
   */
  readonly clock?: () => Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter and result types
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordPaymentParams {
  /**
   * Caller-supplied idempotency key. Must be unique per payment attempt.
   * If the same key is submitted twice, IdempotencyError is thrown and the
   * caller can safely return the previously-recorded result.
   */
  idempotencyKey: string
  accountId: string
  /**
   * Who physically handed the money over. This is NOT the actor: the actor is
   * whoever is operating the system.
   */
  payerId: string
  /** Payment amount in minor currency units (integer). Must be > 0. */
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  notes?: string
  /** Who is recording this payment. */
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

/**
 * Result of recording a payment.
 * `allocated` is the total amount matched to open charges.
 * `credit` is the unallocated remainder that stays on account.
 * Invariant: allocated + credit === payment amount.
 */
export interface RecordPaymentResult {
  readonly transactionId: string
  readonly allocated: Money
  readonly credit: Money
}

export interface RecordPaymentForInvoiceParams {
  idempotencyKey: string
  /** The charge to pay. Amount must not exceed its outstanding balance. */
  invoiceId: string
  /** Payment amount in minor currency units. Must be > 0 and <= outstanding. */
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  notes?: string
  payerId: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface PreviewAllocationParams {
  accountId: string
  amount: Money
  /** The currency the payment would arrive in. Must match the open charges. */
  currency: string
  organizationId: string
}

export interface PreviewAllocationResult {
  steps: AllocationStep[]
  totalAllocated: Money
  credit: Money
}

export interface VoidInvoicePaymentsParams {
  idempotencyKey: string
  /** The charge to clear. EVERY live payment on it is reversed. */
  invoiceId: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface VoidInvoicePaymentsResult {
  invoiceId: string
  /** Sum of the FULL amount of every payment reversed, never a partial figure. */
  amountReversed: Money
  paymentsReversed: number
  allocationsRemoved: number
  /**
   * Every charge the reversal touched: normally just the one, but a payment
   * that waterfalled across several is reversed in full, so the others reopen.
   *
   * `month` is the charge's billing period, and the caller needs it: a read
   * model that buckets figures by billing period has to recompute that period,
   * not the current one. Undoing a payment against a March charge moves
   * March's figures even if it happens in August.
   */
  invoicesReopened: Array<{
    invoiceId: string
    month: string | null
    status: InvoiceStatus
  }>
  ledgerEntriesVoided: number
}

export interface ReversePaymentParams {
  idempotencyKey: string
  /** The payment that never arrived: bounced, mistyped, recorded twice. */
  transactionId: string
  /** Why. Recorded on the payment row and in the event. */
  reason?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface ReversePaymentResult {
  transactionId: string
  /** The payment's full amount. A payment is reversed whole or not at all. */
  amountReversed: Money
  allocationsRemoved: number
  /** Every charge the payment had covered, re-projected from what remains. */
  invoicesReopened: Array<{
    invoiceId: string
    month: string | null
    status: InvoiceStatus
  }>
  ledgerEntriesVoided: number
}

export interface VoidInvoiceParams {
  idempotencyKey: string
  /** The charge that should never have been raised, or is no longer owed. */
  invoiceId: string
  /** Why. Recorded in the event. */
  reason?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface VoidInvoiceResult {
  invoiceId: string
  status: 'VOID'
  /** Money that had landed on the charge and is now standing credit again. */
  amountReleased: Money
  allocationsReleased: number
}

export interface ApplyCreditNoteParams {
  idempotencyKey: string
  accountId: string
  amount: Money
  currency: string
  reason: CreditNoteReason
  notes?: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface ApplyCreditParams {
  idempotencyKey: string
  accountId: string
  /**
   * Target a single charge. When omitted, credit waterfalls across every open
   * charge for the account, oldest first, the same rule as `recordPayment`.
   */
  invoiceId?: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

/**
 * Outcome of applying an account's standing credit.
 *
 * Invariant: `applied + remainingCredit === spendable credit before the call`.
 */
export interface ApplyCreditResult {
  /** Credit consumed by this call, in minor units. */
  readonly applied: Money
  /** Spendable credit still sitting on the account afterwards. */
  readonly remainingCredit: Money
  /** Ids of the charges that received an allocation. */
  readonly invoicesTouched: string[]
}

export interface CreateManualInvoiceParams {
  accountId: string
  /** Amount in minor currency units. Must be a positive integer. */
  amount: Money
  currency: string
  dueDate: Date
  /** Short human-readable description. */
  description: string
  /** Opaque caller reference, an order id, a contract id, anything. */
  reference?: string
  /** Billing period this charge belongs to, as "YYYY-MM". */
  month?: string
  /** Internal memo. */
  notes?: string
  /** Who is creating the charge. Used for the event-log audit row. */
  createdBy: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

// ─────────────────────────────────────────────────────────────────────────────
// BillingService
// ─────────────────────────────────────────────────────────────────────────────

export class BillingService {
  private readonly clock: () => Date

  constructor(
    private readonly db: LedgerStore,
    private readonly config: BillingConfig
  ) {
    this.clock = config.clock ?? (() => new Date())
  }

  /**
   * Loads the account's open charges and what has already landed on each, as
   * the waterfall planner wants them. One query for the charges and one for
   * every allocation on the account, grouped in memory: no query per charge.
   */
  private async loadOpenCharges(
    db: LedgerStore,
    accountId: string,
    organizationId: string
  ): Promise<OpenCharge[]> {
    const [invoices, allocations] = await Promise.all([
      db.findInvoicesByAccount(accountId, organizationId),
      db.findAllocationsByAccount(accountId, organizationId),
    ])
    const allocated = sumAllocationsByInvoice(allocations)
    return selectOpenInvoices(invoices).map(invoice => ({
      invoice,
      priorAllocated: allocated.get(invoice.id) ?? 0,
    }))
  }

  /**
   * Money settles a charge in the charge's own currency, and nothing else.
   *
   * There is no exchange rate in a ledger. A payment in one currency landing
   * on a charge in another at face value is not a conversion, it is a wrong
   * number, so the waterfall refuses to plan across a currency boundary. An
   * account that carries charges in two currencies has to be paid in each.
   */
  private assertSameCurrency(
    currency: string,
    charges: readonly { invoice: Invoice }[] | readonly Invoice[]
  ): void {
    for (const item of charges) {
      const invoice = 'invoice' in item ? item.invoice : item
      if (invoice.currency !== currency) {
        throw new ValidationError(
          `Currency ${currency} does not match charge ${invoice.id} in ${invoice.currency}`,
          'currency'
        )
      }
    }
  }

  /**
   * Runs the body of a mutating operation and translates a lost idempotency
   * race into the same error a repeated call gets.
   *
   * The pre-flight read of the event log can lose to a concurrent caller. The
   * store's unique constraint on (organizationId, idempotencyKey) cannot, and
   * it fires on the event-log write inside the transaction, rolling the whole
   * thing back. The store reports that as `DuplicateIdempotencyKeyError`; which
   * physical constraint it came from is the store's business. From the
   * caller's side it is indistinguishable from having submitted the key twice,
   * so it is reported the same way.
   */
  private async anchored<T>(idempotencyKey: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof DuplicateIdempotencyKeyError) {
        throw new IdempotencyError(idempotencyKey)
      }
      throw error
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // recordPayment
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records a payment from a payer and performs waterfall allocation against
   * the account's open charges, oldest first.
   *
   * WATERFALL ALLOCATION ALGORITHM
   * ─────────────────────────────
   * Given: payment amount P, open charges I1, I2, … In sorted by createdAt asc
   *
   * remaining = P
   * for each charge Ii (oldest first):
   *   outstanding = Ii.amount - sum(existing allocations for Ii)
   *   toAllocate  = min(remaining, outstanding)
   *   write Allocation(transactionId, Ii.id, toAllocate)
   *   remaining  -= toAllocate
   *   if remaining == 0: break
   * credit = remaining  // unallocated portion, stays on account
   *
   * Invariant (must always hold): allocated + credit === params.amount
   *
   * WORKED EXAMPLE
   * ──────────────
   * Account has two open charges:
   *   Charge A (Jan): amount=5000, allocated=0    -> outstanding=5000
   *   Charge B (Feb): amount=5000, allocated=2000 -> outstanding=3000
   * Payment received: 7000
   *
   * Step 1: toAllocate = min(7000, 5000) = 5000 -> Charge A fully paid
   *         remaining = 7000 - 5000 = 2000
   * Step 2: toAllocate = min(2000, 3000) = 2000 -> Charge B partially paid
   *         remaining = 2000 - 2000 = 0
   *
   * Result: allocated=7000, credit=0
   *
   * @throws {ForbiddenError}     if the actor lacks RECORD_PAYMENT
   * @throws {ValidationError}    if amount <= 0 or is not an integer
   * @throws {IdempotencyError}   if this idempotencyKey was already processed
   * @throws {NotFoundError}      if the account is not in this organization
   */
  async recordPayment(params: RecordPaymentParams): Promise<RecordPaymentResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Payment amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isSafeInteger(params.amount)) {
      throw new ValidationError(
        'Payment amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    // We check before opening the transaction to avoid holding a lock during
    // the read. The event-log write inside the transaction is the atomic
    // idempotency anchor; this check is the fast path, not the guarantee.
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load account (outside transaction, read-only check) ─────────────────
    // The fast fail. The authoritative check is the lock inside the
    // transaction, which is the only one that cannot be raced.
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Atomic transaction: payment, allocations, event log, cash row ────────
    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<RecordPaymentResult> => {
      // ── Step 0: Lock the account ──────────────────────────────────────────
      // Everything below reads outstanding balances and then spends them.
      // Without this lock two concurrent payments both see the same charge as
      // open and both allocate to it, and the charge ends up overpaid. The
      // lock is held until this transaction commits.
      const locked = await tx.lockAccount(params.accountId, params.organizationId)
      if (!locked) {
        throw new NotFoundError('Account', params.accountId)
      }

      // ── Step 1: Create the payment record ─────────────────────────────────
      const now = this.clock()
      const transaction = await tx.createTransaction(
        {
          amount:         params.amount,
          currency:       params.currency,
          paymentMethod:  params.paymentMethod,
          paymentDate:    now,
          notes:          params.notes,
          idempotencyKey: params.idempotencyKey,
          recordedBy:     params.actorId,
          payerId:        params.payerId,
          accountId:      params.accountId,
        },
        params.organizationId
      )

      // ── Step 2: Load open charges and what has already landed on each ─────
      const open = await this.loadOpenCharges(tx, params.accountId, params.organizationId)
      this.assertSameCurrency(params.currency, open)

      // ── Step 3: Plan the waterfall ────────────────────────────────────────
      // The plan is a pure function of the charges and the amount, and it is
      // the same function `previewAllocation` shows the operator. See
      // `waterfall.ts` for the algorithm and the worked example.
      const plan = planWaterfall(open, params.amount)
      const allocated = plan.allocated
      const remaining = plan.credit

      // ── Step 4: Commit the plan ───────────────────────────────────────────
      // One allocation row per step, then the status projection. The
      // allocations stay the truth; the status column is a cache of them.
      const statusByInvoice = new Map(open.map(o => [o.invoice.id, o.invoice.status]))
      for (const step of plan.steps) {
        await tx.createAllocation(
          {
            amount:        step.toAllocate,
            createdBy:     params.actorId,
            transactionId: transaction.id,
            invoiceId:     step.invoiceId,
          },
          params.organizationId
        )

        if (step.newStatus !== statusByInvoice.get(step.invoiceId)) {
          await tx.updateInvoice(
            step.invoiceId,
            { status: step.newStatus },
            params.organizationId
          )
        }
      }

      // ── Step 5: Write the event log, the idempotency anchor ──────────────
      // If the transaction commits, the key is anchored and any retry hits the
      // check above. If the transaction rolls back, the event row rolls back
      // with it, and the operation is safe to retry.
      await tx.createEventLog(
        {
          type:           EVENT_TYPES.TRANSACTION_RECORDED,
          payload: {
            transactionId: transaction.id,
            amount:        params.amount,
            currency:      params.currency,
            allocated,
            credit:        remaining,
            accountId:     params.accountId,
            payerId:       params.payerId,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      // ── Step 6: Write the matching cash-ledger IN row ─────────────────────
      // Every payment lands here regardless of method: the cash ledger is the
      // money-in view, not a physical-cash-only till. It records the FULL
      // amount received, not just the allocated portion, because that is what
      // arrived. Idempotency is covered by the event row above.
      await tx.createLedgerEntry(
        {
          direction:     'IN',
          category:      this.config.paymentCategory,
          amount:        params.amount,
          currency:      params.currency,
          occurredAt:    now,
          month:         monthKey(now),
          note:          null,
          source:        'PAYMENT',
          createdBy:     params.actorId,
          transactionId: transaction.id,
        },
        params.organizationId
      )

      // ── Invariant: allocated + credit must equal the original amount ──────
      // A failure here is a programming error, not a domain error, so it
      // throws a plain Error rather than a DomainError: it must not be caught
      // and rendered to a user as though they did something wrong.
      const total: Money = allocated + remaining
      if (total !== params.amount) {
        throw new Error(
          `BillingService invariant violation: allocated(${allocated}) + credit(${remaining}) = ${total} !== amount(${params.amount})`
        )
      }

      return {
        transactionId: transaction.id,
        allocated,
        credit: remaining,
      }
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // recordPaymentForInvoice
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records a payment targeted at one specific charge.
   *
   * Targeted, not waterfall. Unlike `recordPayment`, which distributes across
   * all open charges oldest-first, this allocates the entire payment to exactly
   * one charge. Overpayment beyond that charge's outstanding balance is
   * rejected; use `recordPayment` for the "money came in, spread it" case.
   *
   * WORKED EXAMPLE
   * ──────────────
   * Charge B (Feb): amount=5000, previously allocated=2000 -> outstanding=3000
   * Payment received: 3000
   *
   * toAllocate = 3000 (exact outstanding)
   * Charge B status -> PAID
   * credit = 0  (targeted can never produce credit by contract)
   *
   * @throws {ForbiddenError}     if the actor lacks RECORD_PAYMENT
   * @throws {ValidationError}    if amount <= 0, non-integer, or exceeds outstanding
   * @throws {IdempotencyError}   if this idempotencyKey was already processed
   * @throws {NotFoundError}      if the charge is not in this organization
   * @throws {ValidationError}    if the charge is PAID or VOID (not payable)
   */
  async recordPaymentForInvoice(
    params: RecordPaymentForInvoiceParams
  ): Promise<RecordPaymentResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Payment amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isSafeInteger(params.amount)) {
      throw new ValidationError(
        'Payment amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load the charge, to fail fast and to know which account to lock ─────
    // Everything read here is read again inside the transaction, under the
    // lock. This pass exists so an obviously bad request does not pay for a
    // transaction.
    const preflight = await this.db.findInvoiceById(
      params.invoiceId,
      params.organizationId
    )
    if (!preflight) {
      throw new NotFoundError('Invoice', params.invoiceId)
    }

    // ── Atomic transaction ───────────────────────────────────────────────────
    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<RecordPaymentResult> => {
      // Step 0: Lock the account. The cap check below reads an outstanding
      // balance and then spends it, so it has to be serialised with every
      // other operation that allocates on this account.
      const locked = await tx.lockAccount(preflight.accountId, params.organizationId)
      if (!locked) {
        throw new NotFoundError('Account', preflight.accountId)
      }

      // Re-read under the lock: the charge may have been paid or voided
      // between the pre-flight and here.
      const invoice = await tx.findInvoiceById(params.invoiceId, params.organizationId)
      if (!invoice) {
        throw new NotFoundError('Invoice', params.invoiceId)
      }
      // VOID is the one stored state that is honoured. Whether the charge is
      // still owed is decided from its allocations below, not from the column.
      if (invoice.status === 'VOID') {
        throw new ValidationError('Invoice is not payable', 'invoiceId')
      }
      this.assertSameCurrency(params.currency, [invoice])

      const priorAllocations = await tx.findAllocationsByInvoice(
        params.invoiceId,
        params.organizationId
      )
      const priorAllocated: Money = sumMoney(priorAllocations.map(a => a.amount))
      const outstanding: Money = invoice.amount - priorAllocated
      if (outstanding <= 0) {
        throw new ValidationError('Invoice is not payable', 'invoiceId')
      }

      // The targeted flow rejects overpayment. No credit spillover.
      if (params.amount > outstanding) {
        throw new ValidationError(
          `Amount exceeds invoice outstanding (${outstanding})`,
          'amount'
        )
      }

      const now = this.clock()

      // Step 1: Create the payment record
      const transaction = await tx.createTransaction(
        {
          amount:         params.amount,
          currency:       params.currency,
          paymentMethod:  params.paymentMethod,
          paymentDate:    now,
          notes:          params.notes,
          idempotencyKey: params.idempotencyKey,
          recordedBy:     params.actorId,
          payerId:        params.payerId,
          accountId:      invoice.accountId,
        },
        params.organizationId
      )

      // Step 2: Create the single allocation against this charge
      await tx.createAllocation(
        {
          amount:        params.amount,
          createdBy:     params.actorId,
          transactionId: transaction.id,
          invoiceId:     params.invoiceId,
        },
        params.organizationId
      )

      // Step 3: Project the status
      const newTotalAllocated: Money = priorAllocated + params.amount
      const newStatus: InvoiceStatus =
        newTotalAllocated >= invoice.amount ? 'PAID' : 'PARTIALLY_PAID'

      await tx.updateInvoice(
        params.invoiceId,
        { status: newStatus },
        params.organizationId
      )

      // Step 4: Write the event log, the idempotency anchor.
      // `targeted: true` distinguishes this allocation from a waterfall one in
      // an audit, without needing a join through the allocation rows.
      await tx.createEventLog(
        {
          type:    EVENT_TYPES.TRANSACTION_RECORDED,
          payload: {
            transactionId: transaction.id,
            invoiceId:     params.invoiceId,
            amount:        params.amount,
            currency:      params.currency,
            accountId:     invoice.accountId,
            payerId:       params.payerId,
            targeted:      true,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      // ── Write the matching cash-ledger IN row ─────────────────────────────
      // Full amount received. Idempotency covered by the event row above.
      await tx.createLedgerEntry(
        {
          direction:     'IN',
          category:      this.config.paymentCategory,
          amount:        params.amount,
          currency:      params.currency,
          occurredAt:    now,
          month:         monthKey(now),
          note:          null,
          source:        'PAYMENT',
          createdBy:     params.actorId,
          transactionId: transaction.id,
        },
        params.organizationId
      )

      // Targeted payments never produce credit: the cap check above ensures it.
      return {
        transactionId: transaction.id,
        allocated:     params.amount,
        credit:        0,
      }
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // reversal: the shared mechanics
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Reverses each payment in `payments`, inside a transaction the caller has
   * already opened and locked. Shared by `reversePayment` (one payment, named
   * directly) and `voidInvoicePayments` (every payment on a charge).
   *
   * A payment is reversed whole: every allocation it funded is removed, every
   * charge it had covered is re-projected from the allocations that remain,
   * the payment row is voided in place, and the cash rows it wrote leave the
   * totals. The caller writes the event row, because the caller knows what
   * the operation was.
   */
  private async reversePaymentsInTx(
    tx: LedgerStore,
    payments: readonly FinancialTransaction[],
    actorId: string,
    reason: string | null,
    organizationId: string
  ) {
    // ── Load everything each payment touched ────────────────────────────────
    const perPayment = await Promise.all(
      payments.map(async payment => {
        const [allocations, ledgerEntries] = await Promise.all([
          tx.findAllocationsByTransaction(payment.id, organizationId),
          tx.findLedgerEntriesByTransaction(payment.id, organizationId),
        ])

        // Invariant: a payment can never have allocated more than it received.
        const totalAllocated: Money = sumMoney(allocations.map(a => a.amount))
        if (totalAllocated > payment.amount) {
          throw new Error(
            `BillingService invariant violation: allocations(${totalAllocated}) exceed payment amount(${payment.amount}) on ${payment.id}`
          )
        }

        return { payment, allocations, ledgerEntries }
      })
    )

    const allAllocations = perPayment.flatMap(p => p.allocations)
    const allLedgerEntries = perPayment.flatMap(p => p.ledgerEntries)

    // Every charge reached by any of these payments. Allocations are removed
    // in full, so a charge a payment also covered must be re-projected or it
    // would keep reading as paid.
    const touchedInvoiceIds = [...new Set(allAllocations.map(a => a.invoiceId))]

    // Step 1: Remove the allocations. The caller snapshots them into the event
    // row, because these rows are the audit trail and are about to stop existing.
    for (const allocation of allAllocations) {
      await tx.deleteAllocation(allocation.id, organizationId)
    }

    // Step 2: Re-project each touched charge from what is LEFT, re-read inside
    // the transaction after the deletes. Another payment may have landed on
    // this charge in the meantime, and it must survive.
    const invoicesReopened: Array<{ invoiceId: string; month: string | null; status: InvoiceStatus }> = []
    for (const invoiceId of touchedInvoiceIds) {
      const touched = await tx.findInvoiceById(invoiceId, organizationId)
      if (!touched) continue

      // VOID is terminal: never resurrect a voided charge.
      if (touched.status === 'VOID') {
        invoicesReopened.push({ invoiceId, month: touched.month, status: 'VOID' })
        continue
      }

      const remaining = await tx.findAllocationsByInvoice(invoiceId, organizationId)
      const remainingTotal: Money = sumMoney(remaining.map(a => a.amount))

      // Mirrors the projection in recordPayment, run backwards. PENDING, never
      // OVERDUE: overdue is derived from the due date at read time.
      const newStatus: InvoiceStatus =
        remainingTotal >= touched.amount
          ? 'PAID'
          : remainingTotal > 0
            ? 'PARTIALLY_PAID'
            : 'PENDING'

      if (newStatus !== touched.status) {
        await tx.updateInvoice(invoiceId, { status: newStatus }, organizationId)
      }
      invoicesReopened.push({ invoiceId, month: touched.month, status: newStatus })
    }

    // Step 3: Void the payments themselves. Deliberately AFTER the allocations,
    // so a partial failure leaves the charge looking paid (recoverable) rather
    // than the money looking vanished (silent loss).
    for (const { payment } of perPayment) {
      await tx.voidTransaction(payment.id, { voidedBy: actorId, voidReason: reason }, organizationId)
    }

    // Step 4: Void the matching cash rows. computeLedgerTotals skips voided
    // rows, so the cash drops out of the month it was booked in, not the
    // current month. Undoing a January payment in March corrects January.
    for (const entry of allLedgerEntries) {
      await tx.voidLedgerEntry(entry.id, { voidedBy: actorId, voidReason: reason }, organizationId)
    }

    return { perPayment, allAllocations, allLedgerEntries, invoicesReopened }
  }

  /** The event payload shape shared by both reversal entry points. */
  private reversalSnapshot(
    perPayment: ReadonlyArray<{ payment: FinancialTransaction; allocations: readonly Allocation[] }>
  ) {
    return perPayment.map(({ payment, allocations }) => ({
      transactionId: payment.id,
      amount:        payment.amount,
      allocations:   allocations.map(a => ({
        id:        a.id,
        invoiceId: a.invoiceId,
        amount:    a.amount,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
      })),
    }))
  }

  // ───────────────────────────────────────────────────────────────────────────
  // reversePayment
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Reverses one payment: the money is asserted never to have arrived. A
   * bounced transfer, a card payment charged back, an amount typed wrong and
   * re-recorded correctly.
   *
   * This is the primitive. `voidInvoicePayments` is the same operation applied
   * to every payment that landed on one charge, for the operator who found the
   * problem from the charge's side.
   *
   * Reversed whole or not at all. A payment that covered three charges reopens
   * all three: un-receiving part of a payment would leave the other charges
   * propped up by money declared never to have arrived, and would break the
   * invariant that a payment equals its allocations plus its credit.
   *
   * This is not a refund and not a correction to a charge. Cash actually
   * handed back is an OUT row on the cash ledger. A charge that should not
   * have been raised is `voidInvoice`, which leaves the payment alone.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if the payment is not in this organization
   * @throws {ValidationError}  if the payment is already reversed
   */
  async reversePayment(params: ReversePaymentParams): Promise<ReversePaymentResult> {
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    const existingEvent = await this.db.findEventLogByKey(params.idempotencyKey, params.organizationId)
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // Fail fast, and learn which account to lock.
    const preflight = await this.db.findTransactionById(params.transactionId, params.organizationId)
    if (!preflight) {
      throw new NotFoundError('FinancialTransaction', params.transactionId)
    }

    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<ReversePaymentResult> => {
        const locked = await tx.lockAccount(preflight.accountId, params.organizationId)
        if (!locked) {
          throw new NotFoundError('Account', preflight.accountId)
        }

        // Re-read under the lock: it may have been reversed in the meantime.
        const payment = await tx.findTransactionById(params.transactionId, params.organizationId)
        if (!payment) {
          throw new NotFoundError('FinancialTransaction', params.transactionId)
        }
        if (payment.voidedAt) {
          throw new ValidationError('Payment is already reversed', 'transactionId')
        }

        const reason = params.reason ?? null
        const { perPayment, allAllocations, allLedgerEntries, invoicesReopened } =
          await this.reversePaymentsInTx(tx, [payment], params.actorId, reason, params.organizationId)

        await tx.createEventLog(
          {
            type:    EVENT_TYPES.TRANSACTION_VOIDED,
            payload: {
              transactionId:  payment.id,
              invoiceId:      null,
              accountId:      payment.accountId,
              amount:         payment.amount,
              currency:       payment.currency,
              reason,
              payments:       this.reversalSnapshot(perPayment),
              invoicesReopened,
              ledgerEntryIds: allLedgerEntries.map(e => e.id),
            },
            actorId:        params.actorId,
            actorType:      'HUMAN',
            idempotencyKey: params.idempotencyKey,
          },
          params.organizationId
        )

        return {
          transactionId:       payment.id,
          amountReversed:      payment.amount,
          allocationsRemoved:  allAllocations.length,
          invoicesReopened,
          ledgerEntriesVoided: allLedgerEntries.length,
        }
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // voidInvoice
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Voids a charge: it should never have been raised, or is no longer owed.
   * The payments that had landed on it are untouched. Their money did arrive;
   * it simply has nothing to cover any more, so it becomes standing credit on
   * the account, spendable with `applyCredit` or returnable as a cash OUT row.
   *
   * This is the other half of reversal. "This charge was wrong" and "this
   * payment never arrived" are different accounting events, and collapsing
   * them, which Lumo did, meant that clearing a wrong charge
   * declared a real payment nonexistent and reopened every other charge it
   * had covered.
   *
   * VOID is terminal. Money landing on a voided charge never resurrects it,
   * and voiding a charge twice is an error rather than a no-op, so a replayed
   * request cannot mask a real one.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if the charge is not in this organization
   * @throws {ValidationError}  if the charge is already void
   */
  async voidInvoice(params: VoidInvoiceParams): Promise<VoidInvoiceResult> {
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    const existingEvent = await this.db.findEventLogByKey(params.idempotencyKey, params.organizationId)
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    const preflight = await this.db.findInvoiceById(params.invoiceId, params.organizationId)
    if (!preflight) {
      throw new NotFoundError('Invoice', params.invoiceId)
    }

    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<VoidInvoiceResult> => {
        // Releasing allocations changes what the account's payments have left
        // to spend, so this serialises with everything else that allocates.
        const locked = await tx.lockAccount(preflight.accountId, params.organizationId)
        if (!locked) {
          throw new NotFoundError('Account', preflight.accountId)
        }

        const invoice = await tx.findInvoiceById(params.invoiceId, params.organizationId)
        if (!invoice) {
          throw new NotFoundError('Invoice', params.invoiceId)
        }
        if (invoice.status === 'VOID') {
          throw new ValidationError('Invoice is already void', 'invoiceId')
        }

        // Release what had landed on it. The payments stay; the joins go.
        const released = await tx.findAllocationsByInvoice(params.invoiceId, params.organizationId)
        for (const allocation of released) {
          await tx.deleteAllocation(allocation.id, params.organizationId)
        }
        const amountReleased: Money = sumMoney(released.map(a => a.amount))

        await tx.updateInvoice(params.invoiceId, { status: 'VOID' }, params.organizationId)

        const reason = params.reason ?? null
        await tx.createEventLog(
          {
            type:    EVENT_TYPES.INVOICE_VOIDED,
            payload: {
              invoiceId:   invoice.id,
              accountId:   invoice.accountId,
              amount:      invoice.amount,
              currency:    invoice.currency,
              month:       invoice.month,
              reason,
              // Snapshot of the joins removed: which payment had covered what.
              allocationsReleased: released.map(a => ({
                id:            a.id,
                transactionId: a.transactionId,
                amount:        a.amount,
                createdBy:     a.createdBy,
                createdAt:     a.createdAt.toISOString(),
              })),
              amountReleased,
            },
            actorId:        params.actorId,
            actorType:      'HUMAN',
            idempotencyKey: params.idempotencyKey,
          },
          params.organizationId
        )

        return {
          invoiceId:           invoice.id,
          status:              'VOID',
          amountReleased,
          allocationsReleased: released.length,
        }
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // voidInvoicePayments
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Reverses EVERY payment that landed on one charge: the money is asserted
   * never to have arrived. `reversePayment` is the primitive; this is the
   * same operation for the operator who found the problem from the charge's
   * side, for instance a charge settled by two transfers that both bounced.
   *
   * This is the reverse of recordPayment and recordPaymentForInvoice, and the
   * way to correct a mistyped amount, because a payment's amount is never
   * mutated. To fix "2000 recorded, 1000 actually paid": reverse, then record
   * 1000.
   *
   * NOT FOR A WRONG CHARGE
   * ──────────────────────
   * If the charge itself should not exist, the payments that covered it did
   * arrive and must not be reversed. That is `voidInvoice`, which releases
   * their allocations to standing credit and leaves the payments alone.
   *
   * WHAT IT TOUCHES
   * ───────────────
   *   1. Deletes every allocation belonging to every payment being reversed.
   *   2. Re-projects each touched charge's status from its REMAINING allocations.
   *   3. Sets void metadata on each payment. The rows survive; this is history.
   *   4. Voids the matching cash-ledger IN rows, so the cash leaves the totals.
   *   5. Writes ONE event row snapshotting everything removed.
   *
   * WHY THE ALLOCATIONS ARE DELETED RATHER THAN FLAGGED
   * ───────────────────────────────────────────────────
   * An allocation is a derived join; the money facts are the payment and the
   * charge. Every read path computes "is this charge paid?" by summing
   * allocations for an invoiceId, without joining back to the payment, so
   * deleting the rows makes every view self-heal with no filtering. A flag
   * would need every one of those call sites to remember to exclude it. The
   * event-log snapshot in step 5 is what preserves the audit trail.
   *
   * ALL OR NOTHING PER PAYMENT
   * ──────────────────────────
   * A payment is reversed in full, so one that waterfalled across three charges
   * reopens all three, not just the one being cleared. You cannot un-receive
   * part of a payment: trimming a single allocation would break the invariant
   * `payment amount = sum(allocations) + credit`, and would leave the other
   * charges propped up by money we just declared never arrived.
   *
   * This is not a refund. Cash actually handed back is an OUT row on the cash
   * ledger.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if the charge is not in this organization
   * @throws {ValidationError}  if the charge has no live payments to undo
   */
  async voidInvoicePayments(
    params: VoidInvoicePaymentsParams
  ): Promise<VoidInvoicePaymentsResult> {
    // ── Guard: permission ─────────────────────────────────────────────────────
    // MANAGE_FINANCES, not RECORD_PAYMENT: taking money in and reversing it are
    // deliberately different capabilities.
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    // One key covers the whole operation, however many payments it reverses.
    const existingEvent = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load the charge, to fail fast and to know which account to lock ─────
    const preflight = await this.db.findInvoiceById(
      params.invoiceId,
      params.organizationId
    )
    if (!preflight) {
      throw new NotFoundError('Invoice', params.invoiceId)
    }

    // ── Atomic transaction ───────────────────────────────────────────────────
    // Which payments settled this charge, and how much each of them has
    // allocated, are read under the lock. Read outside it, a payment recorded
    // in the meantime would be missed and would keep the charge looking paid
    // after the reversal claimed to clear it.
    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(
      async (tx: LedgerStore): Promise<VoidInvoicePaymentsResult> => {
        // Step 0: Lock the account this charge belongs to.
        const locked = await tx.lockAccount(preflight.accountId, params.organizationId)
        if (!locked) {
          throw new NotFoundError('Account', preflight.accountId)
        }

        const invoice = await tx.findInvoiceById(params.invoiceId, params.organizationId)
        if (!invoice) {
          throw new NotFoundError('Invoice', params.invoiceId)
        }

        // ── Resolve which payments settled it ─────────────────────────────
        const invoiceAllocations = await tx.findAllocationsByInvoice(
          params.invoiceId,
          params.organizationId
        )
        const transactionIds = [...new Set(invoiceAllocations.map(a => a.transactionId))]

        const candidates = await Promise.all(
          transactionIds.map(id => tx.findTransactionById(id, params.organizationId))
        )
        // Drop already-voided rows defensively: their allocations should have
        // been deleted, so they should not appear here at all.
        const payments = candidates.filter(
          (t): t is NonNullable<typeof t> => t != null && t.voidedAt == null
        )

        if (payments.length === 0) {
          throw new ValidationError('No payments to undo on this invoice', 'invoiceId')
        }

        const reversed = await this.reversePaymentsInTx(tx, payments, params.actorId, null, params.organizationId)
        const { perPayment, allAllocations, allLedgerEntries, invoicesReopened } = reversed

        const amountReversed: Money = sumMoney(perPayment.map(p => p.payment.amount))

        // Step 5: ONE event row for the operation. It is the idempotency anchor and
        // the audit trail that justifies deleting the allocations in step 1.
        await tx.createEventLog(
          {
            type:    EVENT_TYPES.TRANSACTION_VOIDED,
            payload: {
              invoiceId:  params.invoiceId,
              accountId:  invoice.accountId,
              amount:     amountReversed,
              currency:   invoice.currency,
              // Full snapshot of what was removed, so the reversal is
              // replayable from the log alone.
              payments: this.reversalSnapshot(perPayment),
              invoicesReopened,
              ledgerEntryIds: allLedgerEntries.map(e => e.id),
            },
            actorId:        params.actorId,
            actorType:      'HUMAN',
            idempotencyKey: params.idempotencyKey,
          },
          params.organizationId
        )

        return {
          invoiceId:           params.invoiceId,
          amountReversed,
          paymentsReversed:    perPayment.length,
          allocationsRemoved:  allAllocations.length,
          invoicesReopened,
          ledgerEntriesVoided: allLedgerEntries.length,
        }
      }
      )
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // previewAllocation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Dry run of the waterfall. Returns an allocation plan showing exactly where
   * a given payment would land across the account's open charges, without
   * writing anything.
   *
   * INVARIANT: the steps returned here MUST match what recordPayment would
   * commit for the same (accountId, amount). These two code paths have to be
   * kept in sync: if you change the waterfall ordering or filtering in
   * recordPayment, change it here too. The parity invariant has its own test.
   *
   * No permission check: a preview is a pure read and writes nothing.
   *
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   */
  async previewAllocation(
    params: PreviewAllocationParams
  ): Promise<PreviewAllocationResult> {
    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isSafeInteger(params.amount)) {
      throw new ValidationError(
        'Amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }

    // Same loader and same planner as `recordPayment`. Not a copy of the
    // waterfall: literally the same function, which is why the two cannot
    // disagree about where money would land.
    const open = await this.loadOpenCharges(
      this.db,
      params.accountId,
      params.organizationId
    )
    this.assertSameCurrency(params.currency, open)
    const plan = planWaterfall(open, params.amount)

    return {
      steps:          plan.steps,
      totalAllocated: plan.allocated,
      credit:         plan.credit,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // applyCredit
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Applies an account's standing (unallocated) credit to its open charges.
   *
   * Credit exists whenever money was recorded with nothing to cover: a payment
   * taken before any charge existed, or an overpayment that spilled over. The
   * payment rows then carry more money than the allocation rows spend. Until
   * this method runs, that money is real but unusable, because the waterfall
   * inside `recordPayment` only ever allocates the payment it was just handed.
   *
   * MECHANICS
   * ─────────
   * An allocation requires a transactionId and is unique per
   * (transaction, charge), so credit cannot be written as a floating row. This
   * is therefore a second waterfall: source payments that still have unspent
   * amount are consumed oldest-first into target charges oldest-first.
   *
   * No cash-ledger row is written here. The cash already hit the cash ledger
   * when the original payment was recorded. Applying credit only re-allocates
   * inside the receivables ledger; writing another IN row would double-count
   * the income.
   *
   * WORKED EXAMPLE
   * ──────────────
   *   Payments:     [1000 unspent, 1000 unspent]  -> spendable credit = 2000
   *   Open charge:  3200 outstanding
   *   -> two allocations (1000 + 1000) against the charge
   *   -> charge PARTIALLY_PAID, applied = 2000, remainingCredit = 0
   *
   * @throws {ForbiddenError}   if the actor lacks RECORD_PAYMENT
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if invoiceId is given but not found in this tenant
   * @throws {ValidationError}  if the targeted charge is PAID or VOID
   */
  async applyCredit(params: ApplyCreditParams): Promise<ApplyCreditResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    const existingEvent = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Fail fast on an account that is not here at all ─────────────────────
    const account = await this.db.findAccountById(params.accountId, params.organizationId)
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Atomic transaction ───────────────────────────────────────────────────
    // Unlike the payment paths there is nothing useful to compute before the
    // lock: every figure here is an unspent balance that this call is about to
    // spend, so reading it outside the lock would only give a stale answer.
    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<ApplyCreditResult> => {
      const locked = await tx.lockAccount(params.accountId, params.organizationId)
      if (!locked) {
        throw new NotFoundError('Account', params.accountId)
      }

      // ── Compute spendable credit per source payment ───────────────────────
      // A payment's unspent amount is its own amount minus everything already
      // allocated out of it. Two queries, grouped in memory, so no N+1.
      const [transactions, accountAllocations] = await Promise.all([
        tx.findTransactionsByAccount(params.accountId, params.organizationId),
        tx.findAllocationsByAccount(params.accountId, params.organizationId),
      ])

      const spentByTransaction = new Map<string, Money>()
      for (const allocation of accountAllocations) {
        spentByTransaction.set(
          allocation.transactionId,
          sumMoney([spentByTransaction.get(allocation.transactionId) ?? 0, allocation.amount])
        )
      }

      // Oldest money first: mirrors the oldest-charge-first waterfall.
      const sources = transactions
        .map((t) => ({
          id:        t.id,
          currency:  t.currency,
          createdAt: t.createdAt,
          unspent:   t.amount - (spentByTransaction.get(t.id) ?? 0),
        }))
        .filter((s) => s.unspent > 0)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

      const creditBefore: Money = sumMoney(sources.map(s => s.unspent))

      // ── Resolve target charges ────────────────────────────────────────────
      let targets: Invoice[]
      if (params.invoiceId) {
        const invoice = await tx.findInvoiceById(params.invoiceId, params.organizationId)
        if (!invoice) {
          throw new NotFoundError('Invoice', params.invoiceId)
        }
        if (invoice.status === 'VOID') {
          throw new ValidationError('Invoice is not payable', 'invoiceId')
        }
        // Covered means covered by allocations, whatever the column says.
        const already = sumMoney(
          (await tx.findAllocationsByInvoice(invoice.id, params.organizationId)).map(a => a.amount)
        )
        if (invoice.amount - already <= 0) {
          throw new ValidationError('Invoice is not payable', 'invoiceId')
        }
        targets = [invoice]
      } else {
        // The same open-charge filter and oldest-first order as the waterfall.
        targets = selectOpenInvoices(
          await tx.findInvoicesByAccount(params.accountId, params.organizationId)
        )
      }

      // Nothing to do. Return before writing the event row, so a no-op does
      // not consume the caller's idempotency key.
      if (creditBefore <= 0 || targets.length === 0) {
        return { applied: 0, remainingCredit: creditBefore, invoicesTouched: [] }
      }

      // Credit is spent in the currency it arrived in. Every unspent payment
      // has to match every target, or the plan below would move money across
      // a currency boundary at face value.
      for (const source of sources) {
        this.assertSameCurrency(source.currency, targets)
      }

      let applied: Money = 0
      const invoicesTouched: string[] = []

      for (const invoice of targets) {
        const priorAllocations = await tx.findAllocationsByInvoice(
          invoice.id,
          params.organizationId
        )
        const priorAllocated: Money = sumMoney(priorAllocations.map(a => a.amount))
        let outstanding: Money = invoice.amount - priorAllocated
        if (outstanding <= 0) continue

        // A payment may hold only ONE allocation per charge. Skip any source
        // that already touched this charge: there is no updateAllocation on the
        // port, so a second insert would hit the store's unique constraint.
        const alreadyUsedHere = new Set(priorAllocations.map((a) => a.transactionId))

        let touched = false
        for (const source of sources) {
          if (outstanding <= 0) break
          if (source.unspent <= 0) continue
          if (alreadyUsedHere.has(source.id)) continue

          const toAllocate: Money = Math.min(source.unspent, outstanding)

          await tx.createAllocation(
            {
              amount:        toAllocate,
              createdBy:     params.actorId,
              transactionId: source.id,
              invoiceId:     invoice.id,
            },
            params.organizationId
          )

          source.unspent -= toAllocate
          outstanding    -= toAllocate
          applied        += toAllocate
          touched = true
        }

        if (!touched) continue
        invoicesTouched.push(invoice.id)

        // Project the new status onto the charge (same rule as recordPayment).
        const newStatus: InvoiceStatus = outstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID'
        if (newStatus !== invoice.status) {
          await tx.updateInvoice(invoice.id, { status: newStatus }, params.organizationId)
        }
      }

      const remainingCredit: Money = creditBefore - applied

      // Invariant: we can never spend more than was available.
      if (applied > creditBefore || remainingCredit < 0) {
        throw new Error(
          `BillingService invariant violation: applied(${applied}) exceeds available credit(${creditBefore})`
        )
      }

      // ── Event row: the idempotency anchor. No cash row (see doc block). ───
      await tx.createEventLog(
        {
          type:    EVENT_TYPES.ALLOCATION_APPLIED,
          payload: {
            accountId:       params.accountId,
            applied,
            remainingCredit,
            invoicesTouched,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return { applied, remainingCredit, invoicesTouched }
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // calculateStandingCredit
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * An account's standing credit: money received that no charge has claimed.
   *
   * FORMULA:
   *   standing credit = sum(payments) - sum(allocations) - sum(credit notes)
   *
   * Positive means the account has money sitting on it, from an overpayment or
   * from a payment taken before the charge existed. `applyCredit` is what
   * spends it. Zero is the normal state.
   *
   * Negative is a data fault, not a debt: it means more has been allocated or
   * credited out than was ever received. It is reported rather than clamped,
   * because hiding it would hide the fault.
   *
   * This is deliberately NOT "what the account owes". Open charges are not in
   * the formula. What is owed is a property of the charges, and it is read per
   * charge with `computeBalance` and `computeEffectiveStatus`, or summed over
   * them by a read model.
   *
   * Nothing is stored. This is recomputed on every call, which is the point:
   * there is no balance column to drift.
   *
   * WORKED EXAMPLE
   * ──────────────
   * Payments:      [10000, 5000]  -> sum = 15000
   * Allocations:   [10000, 3000]  -> sum = 13000
   * Credit notes:  [1000]         -> sum = 1000
   * Standing credit = 15000 - 13000 - 1000 = 1000  (10.00 sitting on account)
   */
  async calculateStandingCredit(
    accountId: string,
    organizationId: string
  ): Promise<Money> {
    // Load all three components in parallel
    const [transactions, allocations, creditNotes] = await Promise.all([
      this.db.findTransactionsByAccount(accountId, organizationId),
      this.db.findAllocationsByAccount(accountId, organizationId),
      this.db.findCreditNotesByAccount(accountId, organizationId),
    ])

    // Integer addition and subtraction only, never floats.
    const totalTransactions: Money = sumMoney(transactions.map(t => t.amount))
    const totalAllocations: Money = sumMoney(allocations.map(a => a.amount))
    const totalCreditNotes: Money = sumMoney(creditNotes.map(cn => cn.amount))

    return totalTransactions - totalAllocations - totalCreditNotes
  }

  // ───────────────────────────────────────────────────────────────────────────
  // applyCreditNote
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issues a credit note against an account: what it owes goes down, and no
   * money moved. It reduces the credit computed by `calculateStandingCredit` and
   * writes no cash-ledger row, because nothing arrived.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   * @throws {NotFoundError}    if the account is not in this organization
   */
  async applyCreditNote(params: ApplyCreditNoteParams): Promise<CreditNote> {
    // ── Guard: permission ─────────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    // ── Guard: amount validation ──────────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Credit note amount must be positive', 'amount')
    }
    if (!Number.isSafeInteger(params.amount)) {
      throw new ValidationError(
        'Credit note amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }

    // ── Idempotency check (outside transaction, cheap read) ───────────────
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load account ──────────────────────────────────────────────────────
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Create the credit note and its event row in one transaction ───────
    // No account lock: a credit note allocates nothing and reads no balance,
    // so there is no read-then-write to serialise.
    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<CreditNote> => {
      const creditNote = await tx.createCreditNote(
        {
          amount:    params.amount,
          currency:  params.currency,
          reason:    params.reason,
          notes:     params.notes,
          createdBy: params.actorId,
          accountId: params.accountId,
        },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.CREDIT_NOTE_ISSUED,
          payload: {
            creditNoteId: creditNote.id,
            accountId:    params.accountId,
            amount:       params.amount,
            currency:     params.currency,
            reason:       params.reason,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return creditNote
      })
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // createManualInvoice
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Creates a charge with an explicit amount. No pricing logic lives here: the
   * caller is responsible for passing the correct amount in minor units.
   *
   * There is no past-due guard. There used to be one, rejecting any dueDate
   * before today. It existed to catch a typo in a free-text date field, and
   * that field is gone: due dates are now derived from a billing period. With
   * derivation the guard only ever fired on something legitimate, namely
   * billing for a period that has already closed, which is an ordinary
   * correction.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   * @throws {NotFoundError}    if the account is not in this organization
   */
  async createManualInvoice(
    params: CreateManualInvoiceParams
  ): Promise<Invoice> {
    // ── Guard: permission ────────────────────────────────────────────────────
    // Creating a charge is deciding that somebody owes money. That is the
    // same capability as reversing a payment or issuing a credit note, not the
    // same as taking money in, so it is MANAGE_FINANCES and not RECORD_PAYMENT.
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    // ── Guard: amount must be a positive integer ─────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Invoice amount must be positive', 'amount')
    }
    if (!Number.isSafeInteger(params.amount)) {
      throw new ValidationError(
        'Invoice amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }

    // ── Guard: account must exist in this organization ───────────────────────
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Create the charge and its event row in one transaction ───────────────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<Invoice> => {
      const invoice = await tx.createInvoice(
        {
          amount:    params.amount,
          currency:  params.currency,
          status:    'PENDING',
          dueDate:   params.dueDate,
          // Billing period ("YYYY-MM") when the caller supplies one. Omitted
          // leaves it null.
          month:     params.month,
          reference: params.reference,
          notes:     [params.description, params.notes].filter(Boolean).join('\n\n'),
          createdBy: params.createdBy,
          accountId: params.accountId,
        },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.INVOICE_CREATED,
          payload: {
            invoiceId:   invoice.id,
            accountId:   params.accountId,
            reference:   params.reference ?? null,
            amount:      params.amount,
            currency:    params.currency,
            dueDate:     params.dueDate.toISOString(),
            description: params.description,
            manual:      true,
          },
          actorId:        params.createdBy,
          actorType:      'HUMAN',
          // Manual charges do not take a caller idempotency key: they are
          // intentionally created fresh each time, and submitting twice gives
          // two charges, the same as any accounting system. The key is derived
          // from the new row's id so the event row still has a unique anchor.
          idempotencyKey: `manual_invoice_${invoice.id}`,
        },
        params.organizationId
      )

      return invoice
    })
  }
}
