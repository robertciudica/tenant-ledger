/**
 * LedgerService: the cash ledger.
 *
 * Owns: manual income and expense rows, voiding, recurring-expense templates,
 * and their idempotent monthly materialization.
 *
 * Rows written automatically alongside a payment are the third way in, and they
 * are written by BillingService.recordPayment, atomically with the payment
 * itself. This service never touches those rows except to refuse to void them.
 *
 * No storage driver, no HTTP, no file I/O. All storage goes through the
 * LedgerStore port injected via the constructor. All monetary values are minor
 * currency units (integers).
 */

import type {
  LedgerStore,
  LedgerEntry,
  LedgerDirection,
  LedgerCategory,
  CategoryTaxonomy,
  RecurringExpenseTemplate,
} from '../store'
import {
  NotFoundError,
  ValidationError,
  IdempotencyError,
  ForbiddenError,
  DuplicateIdempotencyKeyError,
} from '../errors'
import { EVENT_TYPES, SYSTEM_ACTOR_ID } from '../events'
import type { Permission } from '../permissions'
import { requirePermission } from '../permissions'
import type { Money } from '../money'
import { sumMoney } from '../money'

// ─────────────────────────────────────────────────────────────────────────────
// Category guard: a category must be used in the direction its owner declared.
// ─────────────────────────────────────────────────────────────────────────────

/** True when `category` is valid for the given `direction` in this taxonomy. */
export function categoryMatchesDirection(
  taxonomy: CategoryTaxonomy,
  direction: LedgerDirection,
  category: LedgerCategory
): boolean {
  return direction === 'IN'
    ? taxonomy.in.includes(category)
    : taxonomy.out.includes(category)
}

/** Month key ("YYYY-MM") for a date, in UTC. */
export function monthKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

export interface AddLedgerEntryParams {
  /** Unique per add attempt, anchors the event-log idempotency check. */
  idempotencyKey: string
  direction: LedgerDirection
  category: LedgerCategory
  /** Minor currency units (integer > 0). */
  amount: Money
  currency: string
  note?: string | null
  /** Who the money went to or came from, when the host tracks that party. */
  counterpartyId?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface VoidLedgerEntryParams {
  idempotencyKey: string
  entryId: string
  voidReason?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface CreateTemplateParams {
  name: string
  category: LedgerCategory
  amount: Money
  currency: string
  /** 1 to 28, the day of each month this materializes. */
  dayOfMonth: number
  counterpartyId?: string | null
  note?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface UpdateTemplateParams {
  templateId: string
  name: string
  category: LedgerCategory
  amount: Money
  /** 1 to 28, the day of each month this materializes. */
  dayOfMonth: number
  counterpartyId?: string | null
  note?: string | null
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface DeleteTemplateParams {
  templateId: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface MaterializeTemplatesParams {
  /** Month to materialize, "YYYY-MM". */
  month: string
  organizationId: string
  /**
   * Catch-up guard: only materialize templates whose `dayOfMonth` is on or
   * before this day. A daily job passes today's day-of-month so a template
   * posts on (or after, if a run was missed) its day, never early.
   * Omit to materialize every active template (manual or full-month backfill).
   */
  asOfDayOfMonth?: number
  /** Background job run id, for the event-log audit row. */
  jobId?: string
}

export interface LedgerTotals {
  inn: Money
  out: Money
  net: Money
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-testable without a store)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sums signed totals over a set of rows. Voided rows (voidedAt set) are
 * excluded: they never count toward in, out or net.
 */
export function computeLedgerTotals(entries: readonly LedgerEntry[]): LedgerTotals {
  const live = entries.filter(e => !e.voidedAt)
  const inn = sumMoney(live.filter(e => e.direction === 'IN').map(e => e.amount))
  const out = sumMoney(live.filter(e => e.direction === 'OUT').map(e => e.amount))
  return { inn, out, net: inn - out }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

/** Optional wiring for the cash ledger. */
export interface LedgerServiceOptions {
  /**
   * Source of "now". Defaults to `() => new Date()`. Injected rather than
   * called directly so a caller can freeze time in a test, or hand the ledger
   * a clock that is not the process clock.
   */
  readonly clock?: () => Date
}

export class LedgerService {
  private readonly clock: () => Date

  constructor(
    private readonly db: LedgerStore,
    private readonly taxonomy: CategoryTaxonomy,
    options: LedgerServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
  }

  /**
   * Runs the body of a mutating operation and translates a lost idempotency
   * race into the same error a repeated call gets. See `BillingService` for
   * the full reasoning: the pre-flight read is the fast path, the store's
   * unique constraint is the guarantee.
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

  private assertAmount(amount: Money): void {
    if (amount <= 0) {
      throw new ValidationError('Amount must be positive', 'amount')
    }
    if (!Number.isSafeInteger(amount)) {
      throw new ValidationError(
        'Amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
        'amount'
      )
    }
  }

  /**
   * Records a manual income or expense row.
   * Writes the row and an event-log audit anchor in one transaction.
   */
  async addEntry(params: AddLedgerEntryParams): Promise<LedgerEntry> {
    requirePermission(params.actorPermissions, 'ADD_CASHBOOK')
    this.assertAmount(params.amount)

    if (!categoryMatchesDirection(this.taxonomy, params.direction, params.category)) {
      throw new ValidationError(
        `Category ${params.category} is not valid for direction ${params.direction}`,
        'category'
      )
    }

    // Idempotency: cheap read before opening the transaction.
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<LedgerEntry> => {
      const now = this.clock()
      const entry = await tx.createLedgerEntry(
        {
          direction:      params.direction,
          category:       params.category,
          amount:         params.amount,
          currency:       params.currency,
          occurredAt:     now,
          month:          monthKey(now),
          note:           params.note ?? null,
          source:         'MANUAL',
          createdBy:      params.actorId,
          counterpartyId: params.counterpartyId ?? null,
        },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.LEDGER_ENTRY_ADDED,
          payload: {
            ledgerEntryId: entry.id,
            direction:     entry.direction,
            category:      entry.category,
            amount:        entry.amount,
            currency:      entry.currency,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return entry
      })
    )
  }

  /**
   * Voids a manual row. The model is immutable, so editing is void plus re-add.
   * Rows written alongside a payment are NOT voidable here; they are corrected
   * by reversing the payment, which voids them as a side effect.
   */
  async voidEntry(params: VoidLedgerEntryParams): Promise<LedgerEntry> {
    requirePermission(params.actorPermissions, 'MANAGE_CASHBOOK')

    const entry = await this.db.findLedgerEntryById(
      params.entryId,
      params.organizationId
    )
    if (!entry) {
      throw new NotFoundError('LedgerEntry', params.entryId)
    }
    if (entry.source === 'PAYMENT') {
      throw new ForbiddenError(
        'Rows written alongside a payment are read-only here. Reverse the payment instead'
      )
    }
    if (entry.voidedAt) {
      throw new ValidationError('Entry is already voided', 'entryId')
    }

    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    return this.anchored(params.idempotencyKey, () =>
      this.db.runTransaction(async (tx: LedgerStore): Promise<LedgerEntry> => {
      const voided = await tx.voidLedgerEntry(
        params.entryId,
        { voidedBy: params.actorId, voidReason: params.voidReason ?? null },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.LEDGER_ENTRY_VOIDED,
          payload: {
            ledgerEntryId: voided.id,
            voidReason:    voided.voidReason,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return voided
      })
    )
  }

  /** Defines a recurring expense template (rent, utilities, monthly salary). */
  async createTemplate(params: CreateTemplateParams): Promise<RecurringExpenseTemplate> {
    requirePermission(params.actorPermissions, 'MANAGE_CASHBOOK')
    this.assertAmount(params.amount)

    if (!this.taxonomy.out.includes(params.category)) {
      throw new ValidationError(
        'Recurring templates must use an expense (OUT) category',
        'category'
      )
    }
    if (!Number.isInteger(params.dayOfMonth) || params.dayOfMonth < 1 || params.dayOfMonth > 28) {
      throw new ValidationError('dayOfMonth must be an integer between 1 and 28', 'dayOfMonth')
    }

    const template = await this.db.createRecurringExpenseTemplate(
      {
        name:           params.name,
        category:       params.category,
        amount:         params.amount,
        currency:       params.currency,
        dayOfMonth:     params.dayOfMonth,
        counterpartyId: params.counterpartyId ?? null,
        note:           params.note ?? null,
        createdBy:      params.actorId,
      },
      params.organizationId
    )

    // Post THIS month's occurrence immediately when its day has already
    // arrived, so the expense shows in this month's figures now instead of
    // waiting for the daily job. Future-dated days are left for the job: this
    // is a cash ledger, so nothing posts before the money is due. Idempotent,
    // so the job will not double-post the same (template, month).
    const now = this.clock()
    if (template.dayOfMonth <= now.getUTCDate()) {
      await this.materializeTemplate(template, monthKey(now), params.organizationId)
    }

    return template
  }

  /**
   * Edits a recurring expense template. Affects FUTURE materializations only.
   * Already-posted rows are immutable, consistent with the void-and-re-add
   * model. To change a posted amount, void that row.
   */
  async updateTemplate(params: UpdateTemplateParams): Promise<RecurringExpenseTemplate> {
    requirePermission(params.actorPermissions, 'MANAGE_CASHBOOK')
    this.assertAmount(params.amount)

    if (!this.taxonomy.out.includes(params.category)) {
      throw new ValidationError(
        'Recurring templates must use an expense (OUT) category',
        'category'
      )
    }
    if (!Number.isInteger(params.dayOfMonth) || params.dayOfMonth < 1 || params.dayOfMonth > 28) {
      throw new ValidationError('dayOfMonth must be an integer between 1 and 28', 'dayOfMonth')
    }

    const existing = await this.db.findRecurringExpenseTemplateById(
      params.templateId,
      params.organizationId
    )
    if (!existing) {
      throw new NotFoundError('RecurringExpenseTemplate', params.templateId)
    }

    return this.db.updateRecurringExpenseTemplate(
      params.templateId,
      {
        name:           params.name,
        category:       params.category,
        amount:         params.amount,
        dayOfMonth:     params.dayOfMonth,
        counterpartyId: params.counterpartyId ?? null,
        note:           params.note ?? null,
      },
      params.organizationId
    )
  }

  /**
   * Soft-deletes a recurring expense template (sets `active: false`). The job
   * stops materializing it from next month; already-posted rows are left
   * untouched, because they are real recorded expenses.
   */
  async deleteTemplate(params: DeleteTemplateParams): Promise<void> {
    requirePermission(params.actorPermissions, 'MANAGE_CASHBOOK')

    const existing = await this.db.findRecurringExpenseTemplateById(
      params.templateId,
      params.organizationId
    )
    if (!existing) {
      throw new NotFoundError('RecurringExpenseTemplate', params.templateId)
    }

    await this.db.deactivateRecurringExpenseTemplate(params.templateId, params.organizationId)
  }

  /**
   * Materializes every active template into an OUT row for `month`.
   * Idempotent: a (templateId, month) row that already exists is skipped, and
   * a unique constraint in the store is a second backstop against
   * double-posting. Called by a scheduled job, as the SYSTEM actor.
   *
   * @returns the number of new rows created this run.
   */
  async materializeTemplatesForMonth(params: MaterializeTemplatesParams): Promise<number> {
    if (!/^\d{4}-\d{2}$/.test(params.month)) {
      throw new ValidationError('month must be "YYYY-MM"', 'month')
    }
    const templates = await this.db.findActiveRecurringExpenseTemplates(params.organizationId)

    let created = 0
    for (const t of templates) {
      // Catch-up guard: never post a template before its day-of-month.
      if (params.asOfDayOfMonth != null && t.dayOfMonth > params.asOfDayOfMonth) {
        continue
      }
      if (await this.materializeTemplate(t, params.month, params.organizationId, params.jobId)) {
        created += 1
      }
    }

    return created
  }

  /**
   * Posts a single template's OUT row for `month`, dated to its day-of-month,
   * unless one already exists. Returns true when a new row was created.
   * The shared path for both the scheduled job and create-time immediate
   * posting, written by the SYSTEM actor: recurring rows are system-generated
   * regardless of what triggered them.
   */
  private async materializeTemplate(
    t: RecurringExpenseTemplate,
    month: string,
    organizationId: string,
    jobId?: string,
  ): Promise<boolean> {
    const already = await this.db.findLedgerEntryByTemplateMonth(t.id, month, organizationId)
    if (already) return false

    const [yearStr, monthStr] = month.split('-')
    const occurredAt = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, t.dayOfMonth, 9, 0, 0))
    const idempotencyKey = `recurring-expense:${t.id}:${month}`

    try {
      await this.db.runTransaction(async (tx: LedgerStore) => {
      await tx.createLedgerEntry(
        {
          direction:      'OUT',
          category:       t.category,
          amount:         t.amount,
          currency:       t.currency,
          occurredAt,
          month,
          note:           t.note ?? t.name,
          source:         'RECURRING',
          createdBy:      SYSTEM_ACTOR_ID,
          counterpartyId: t.counterpartyId,
          templateId:     t.id,
        },
        organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.RECURRING_EXPENSE_MATERIALIZED,
          payload: { templateId: t.id, month, amount: t.amount },
          actorId:        SYSTEM_ACTOR_ID,
          actorType:      'SYSTEM',
          jobId,
          idempotencyKey,
        },
        organizationId
      )
      })
    } catch (error) {
      // Two runs of the job raced for the same (template, month). The
      // constraint decided; the loser reports "nothing created" rather than
      // failing a batch that has already done the right thing.
      if (error instanceof DuplicateIdempotencyKeyError) {
        return false
      }
      throw error
    }
    return true
  }
}
