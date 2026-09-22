/**
 * LedgerService: the cash ledger.
 *
 * Ported from Lumo's src/core/ledger/LedgerService.test.ts. The category names
 * are generic here; the taxonomy is supplied by the caller.
 */

import {
  LedgerService,
  InMemoryLedgerStore,
  computeLedgerTotals,
  categoryMatchesDirection,
  monthKey,
  ValidationError,
  ForbiddenError,
  IdempotencyError,
  NotFoundError,
} from '../src'
import type { LedgerEntry } from '../src'
import { ledgerEntryFactory } from '../src/testing/factories'
import { MANAGER, OPERATOR, READER, TAXONOMY } from './helpers'

/**
 * A frozen clock on the 15th, injected into the services under test. Fixing
 * "now" this way rather than with fake timers is only possible because the
 * ledger takes its clock as a constructor argument.
 */
const FIXED_CLOCK = () => new Date('2026-06-15T12:00:00Z')

const base = {
  currency:       'RON',
  organizationId: 'org_1',
} as const

const manager  = { actorId: 'manager_1',  actorPermissions: MANAGER }
const operator = { actorId: 'operator_1', actorPermissions: OPERATOR }
const reader   = { actorId: 'reader_1',   actorPermissions: READER }

const entry = (partial: Partial<LedgerEntry>): LedgerEntry =>
  ledgerEntryFactory({
    id:         'led_x',
    amount:     100,
    currency:   'RON',
    occurredAt: new Date('2025-04-23T10:00:00Z'),
    month:      '2025-04',
    createdBy:  'u',
    createdAt:  new Date('2025-04-23T10:00:00Z'),
    ...partial,
  })

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('computeLedgerTotals()', () => {
  it('sums signed in/out/net and ignores voided rows', () => {
    const rows = [
      entry({ direction: 'IN', amount: 300 }),
      entry({ direction: 'IN', amount: 200 }),
      entry({ direction: 'OUT', amount: 140 }),
      entry({ direction: 'OUT', amount: 500, voidedAt: new Date() }), // voided, excluded
    ]
    expect(computeLedgerTotals(rows)).toEqual({ inn: 500, out: 140, net: 360 })
  })

  it('returns zeroes for an empty ledger', () => {
    expect(computeLedgerTotals([])).toEqual({ inn: 0, out: 0, net: 0 })
  })
})

describe('categoryMatchesDirection()', () => {
  it('accepts income categories for IN', () => {
    expect(categoryMatchesDirection(TAXONOMY, 'IN', 'SERVICES')).toBe(true)
    expect(categoryMatchesDirection(TAXONOMY, 'IN', 'OTHER_INCOME')).toBe(true)
    expect(categoryMatchesDirection(TAXONOMY, 'IN', 'RENT')).toBe(false)
  })
  it('accepts expense categories for OUT', () => {
    expect(categoryMatchesDirection(TAXONOMY, 'OUT', 'PAYROLL')).toBe(true)
    expect(categoryMatchesDirection(TAXONOMY, 'OUT', 'SALES')).toBe(false)
  })
  it('rejects a category that is in neither list', () => {
    // added during extraction, not from Lumo
    expect(categoryMatchesDirection(TAXONOMY, 'IN', 'NOT_A_CATEGORY')).toBe(false)
    expect(categoryMatchesDirection(TAXONOMY, 'OUT', 'NOT_A_CATEGORY')).toBe(false)
  })
})

describe('monthKey()', () => {
  it('formats YYYY-MM in UTC', () => {
    expect(monthKey(new Date('2025-04-23T23:30:00Z'))).toBe('2025-04')
    expect(monthKey(new Date('2025-12-01T00:00:00Z'))).toBe('2025-12')
  })
})

// ── addEntry ─────────────────────────────────────────────────────────────────

describe('LedgerService.addEntry()', () => {
  let db: InMemoryLedgerStore
  let service: LedgerService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new LedgerService(db, TAXONOMY)
  })

  it('writes a MANUAL row and an event anchor', async () => {
    const e = await service.addEntry({
      ...base,
      ...manager,
      idempotencyKey: 'k1',
      direction:      'OUT',
      category:       'SUPPLIES',
      amount:         140,
      note:           'Cleaning supplies',
    })
    expect(e.source).toBe('MANUAL')
    expect(e.amount).toBe(140)
    expect(db.seed.ledgerEntries).toHaveLength(1)
    expect(db.seed.eventLogs.some(l => l.type === 'LEDGER_ENTRY_ADDED')).toBe(true)
  })

  it('lets an actor with only ADD_CASHBOOK add a row', async () => {
    await expect(
      service.addEntry({ ...base, ...operator, idempotencyKey: 'k2', direction: 'IN', category: 'SALES', amount: 80 })
    ).resolves.toBeDefined()
  })

  it('forbids an actor without ADD_CASHBOOK', async () => {
    await expect(
      service.addEntry({ ...base, ...reader, idempotencyKey: 'k3', direction: 'IN', category: 'SALES', amount: 80 })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('rejects a category that does not match the direction', async () => {
    await expect(
      service.addEntry({ ...base, ...manager, idempotencyKey: 'k4', direction: 'IN', category: 'RENT', amount: 80 })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects non-positive and non-integer amounts', async () => {
    await expect(
      service.addEntry({ ...base, ...manager, idempotencyKey: 'k5', direction: 'IN', category: 'SALES', amount: 0 })
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      service.addEntry({ ...base, ...manager, idempotencyKey: 'k6', direction: 'IN', category: 'SALES', amount: 12.5 })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is idempotent: a repeated key throws IdempotencyError', async () => {
    await service.addEntry({ ...base, ...manager, idempotencyKey: 'dup', direction: 'IN', category: 'SALES', amount: 80 })
    await expect(
      service.addEntry({ ...base, ...manager, idempotencyKey: 'dup', direction: 'IN', category: 'SALES', amount: 80 })
    ).rejects.toBeInstanceOf(IdempotencyError)
  })

  it('does not see an idempotency key from another tenant', async () => {
    // added during extraction, not from Lumo
    await service.addEntry({ ...base, ...manager, idempotencyKey: 'shared', direction: 'IN', category: 'SALES', amount: 80 })
    await expect(
      service.addEntry({
        ...base, ...manager,
        organizationId: 'org_2',
        idempotencyKey: 'shared',
        direction:      'IN',
        category:       'SALES',
        amount:         80,
      })
    ).resolves.toBeDefined()
  })
})

// ── voidEntry ────────────────────────────────────────────────────────────────

describe('LedgerService.voidEntry()', () => {
  let db: InMemoryLedgerStore
  let service: LedgerService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new LedgerService(db, TAXONOMY)
  })

  it('voids a manual row and drops it from the totals', async () => {
    const added = await service.addEntry({ ...base, ...manager, idempotencyKey: 'a', direction: 'OUT', category: 'SUPPLIES', amount: 140 })
    const voided = await service.voidEntry({ ...base, ...manager, idempotencyKey: 'v', entryId: added.id, voidReason: 'MISTAKE' })
    expect(voided.voidedAt).not.toBeNull()
    expect(computeLedgerTotals(db.seed.ledgerEntries)).toEqual({ inn: 0, out: 0, net: 0 })
  })

  it('refuses to void a row written alongside a payment', async () => {
    const auto = await db.createLedgerEntry(
      {
        direction: 'IN', category: 'SALES', amount: 320, currency: 'RON',
        occurredAt: new Date(), month: '2025-04', source: 'PAYMENT',
        createdBy: 'operator_1', transactionId: 'tx_1',
      },
      'org_1'
    )
    await expect(
      service.voidEntry({ ...base, ...manager, idempotencyKey: 'v2', entryId: auto.id })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('forbids an actor with only ADD_CASHBOOK from voiding', async () => {
    const added = await service.addEntry({ ...base, ...manager, idempotencyKey: 'a3', direction: 'OUT', category: 'SUPPLIES', amount: 50 })
    await expect(
      service.voidEntry({ ...base, ...operator, idempotencyKey: 'v3', entryId: added.id })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('rejects a double void', async () => {
    const added = await service.addEntry({ ...base, ...manager, idempotencyKey: 'a4', direction: 'OUT', category: 'SUPPLIES', amount: 50 })
    await service.voidEntry({ ...base, ...manager, idempotencyKey: 'v4', entryId: added.id })
    await expect(
      service.voidEntry({ ...base, ...manager, idempotencyKey: 'v5', entryId: added.id })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('cannot void a row belonging to another tenant', async () => {
    // added during extraction, not from Lumo
    const added = await service.addEntry({ ...base, ...manager, idempotencyKey: 'a5', direction: 'OUT', category: 'SUPPLIES', amount: 50 })
    await expect(
      service.voidEntry({
        ...base, ...manager,
        organizationId: 'org_2',
        idempotencyKey: 'v6',
        entryId:        added.id,
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ── Recurring templates and materialization ──────────────────────────────────

describe('LedgerService recurring templates', () => {
  let db: InMemoryLedgerStore
  let service: LedgerService

  beforeEach(() => {
    // Fixed clock (the 15th) so create-time immediate materialization is
    // deterministic regardless of the real date the suite runs on. Injected,
    // not faked globally: the ledger takes its clock as an argument.
    db = new InMemoryLedgerStore()
    db.reset()
    service = new LedgerService(db, TAXONOMY, { clock: FIXED_CLOCK })
  })
  const recurringFor = (month: string) =>
    db.seed.ledgerEntries.filter(e => e.source === 'RECURRING' && e.month === month)

  it('posts the current month immediately when its day has already passed', async () => {
    // Day 1 is on or before today (the 15th), so June posts now.
    await service.createTemplate({ ...base, ...manager, name: 'Office rent', category: 'RENT', amount: 4200, dayOfMonth: 1 })
    const june = recurringFor('2026-06')
    expect(june).toHaveLength(1)
    expect(june[0]).toMatchObject({ amount: 4200, direction: 'OUT', category: 'RENT' })

    // Day 28 is after today, so it is left for the scheduled job: nothing
    // posts before the money is due.
    await service.createTemplate({ ...base, ...manager, name: 'Late fee', category: 'OTHER_EXPENSE', amount: 100, dayOfMonth: 28 })
    expect(recurringFor('2026-06')).toHaveLength(1)
  })

  it('materializes active templates once per month (idempotent)', async () => {
    await service.createTemplate({ ...base, ...manager, name: 'Office rent', category: 'RENT', amount: 4200, dayOfMonth: 1 })
    await service.createTemplate({ ...base, ...manager, name: 'Utilities', category: 'UTILITIES', amount: 540, dayOfMonth: 5 })

    // A future month the create-time posting did not touch.
    const created1 = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_1' })
    expect(created1).toBe(2)
    expect(recurringFor('2026-09')).toHaveLength(2)

    // A second run for the same month must NOT double-post.
    const created2 = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_1' })
    expect(created2).toBe(0)
    expect(recurringFor('2026-09')).toHaveLength(2)
  })

  it('never posts a template before its day of month (catch-up guard)', async () => {
    await service.createTemplate({ ...base, ...manager, name: 'Rent', category: 'RENT', amount: 4200, dayOfMonth: 1 })
    await service.createTemplate({ ...base, ...manager, name: 'Utilities', category: 'UTILITIES', amount: 540, dayOfMonth: 5 })

    // On the 3rd only the 1st-of-month template is due.
    const created = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_1', asOfDayOfMonth: 3 })
    expect(created).toBe(1)

    // On the 5th the utilities template posts (catch-up); rent is skipped.
    const created2 = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_1', asOfDayOfMonth: 5 })
    expect(created2).toBe(1)
    expect(recurringFor('2026-09')).toHaveLength(2)
  })

  it('rejects an income category for a recurring template', async () => {
    await expect(
      service.createTemplate({ ...base, ...manager, name: 'Bad', category: 'SALES', amount: 100, dayOfMonth: 1 })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a month that is not "YYYY-MM"', async () => {
    // added during extraction, not from Lumo
    await expect(
      service.materializeTemplatesForMonth({ month: '2026-9', organizationId: 'org_1' })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('posts the row as the SYSTEM actor, whatever triggered it', async () => {
    // added during extraction, not from Lumo
    await service.createTemplate({ ...base, ...manager, name: 'Rent', category: 'RENT', amount: 4200, dayOfMonth: 1 })
    const row = recurringFor('2026-06')[0]
    expect(row.createdBy).toBe('system')
    const event = db.seed.eventLogs.find(e => e.type === 'RECURRING_EXPENSE_MATERIALIZED')
    expect(event?.actorType).toBe('SYSTEM')
  })

  it('does not materialize another tenant templates', async () => {
    // added during extraction, not from Lumo
    await service.createTemplate({ ...base, ...manager, name: 'Rent', category: 'RENT', amount: 4200, dayOfMonth: 1 })
    const created = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_2' })
    expect(created).toBe(0)
  })
})

describe('LedgerService.updateTemplate()', () => {
  let db: InMemoryLedgerStore
  let service: LedgerService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new LedgerService(db, TAXONOMY, { clock: FIXED_CLOCK })
  })
  async function seedTemplate() {
    return service.createTemplate({
      ...base, ...manager, name: 'Office rent', category: 'RENT', amount: 4200, dayOfMonth: 1,
    })
  }

  it('edits the template fields', async () => {
    const tpl = await seedTemplate()
    const updated = await service.updateTemplate({
      ...base, ...manager, templateId: tpl.id,
      name: 'New rent', category: 'UTILITIES', amount: 5000, dayOfMonth: 10,
    })
    expect(updated).toMatchObject({ name: 'New rent', category: 'UTILITIES', amount: 5000, dayOfMonth: 10 })
  })

  it('does NOT touch already-posted rows', async () => {
    const tpl = await seedTemplate()
    const before = db.seed.ledgerEntries.filter(e => e.source === 'RECURRING' && e.month === '2026-06')
    expect(before).toHaveLength(1)
    expect(before[0].amount).toBe(4200)

    await service.updateTemplate({
      ...base, ...manager, templateId: tpl.id,
      name: 'Office rent', category: 'RENT', amount: 9999, dayOfMonth: 1,
    })

    // The posted June row keeps its original amount. The edit only affects
    // future materializations.
    const after = db.seed.ledgerEntries.filter(e => e.source === 'RECURRING' && e.month === '2026-06')
    expect(after).toHaveLength(1)
    expect(after[0].amount).toBe(4200)
  })

  it('throws NotFound for a missing template', async () => {
    await expect(
      service.updateTemplate({
        ...base, ...manager, templateId: 'nope',
        name: 'X', category: 'RENT', amount: 100, dayOfMonth: 1,
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects an income category', async () => {
    const tpl = await seedTemplate()
    await expect(
      service.updateTemplate({
        ...base, ...manager, templateId: tpl.id,
        name: 'Bad', category: 'SALES', amount: 100, dayOfMonth: 1,
      })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a non-positive amount or an out-of-range day', async () => {
    const tpl = await seedTemplate()
    await expect(
      service.updateTemplate({ ...base, ...manager, templateId: tpl.id, name: 'X', category: 'RENT', amount: 0, dayOfMonth: 1 })
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      service.updateTemplate({ ...base, ...manager, templateId: tpl.id, name: 'X', category: 'RENT', amount: 100, dayOfMonth: 31 })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('forbids an actor without MANAGE_CASHBOOK', async () => {
    const tpl = await seedTemplate()
    await expect(
      service.updateTemplate({ ...base, ...operator, templateId: tpl.id, name: 'X', category: 'RENT', amount: 100, dayOfMonth: 1 })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('LedgerService.deleteTemplate()', () => {
  let db: InMemoryLedgerStore
  let service: LedgerService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new LedgerService(db, TAXONOMY, { clock: FIXED_CLOCK })
  })
  it('soft-deletes so future months skip it', async () => {
    const tpl = await service.createTemplate({
      ...base, ...manager, name: 'Utilities', category: 'UTILITIES', amount: 540, dayOfMonth: 5,
    })

    await service.deleteTemplate({ ...base, ...manager, templateId: tpl.id })

    const created = await service.materializeTemplatesForMonth({ month: '2026-09', organizationId: 'org_1' })
    expect(created).toBe(0)
    const stored = await db.findRecurringExpenseTemplateById(tpl.id, 'org_1')
    expect(stored?.active).toBe(false)
  })

  it('leaves already-posted rows alone', async () => {
    // added during extraction, not from Lumo
    const tpl = await service.createTemplate({
      ...base, ...manager, name: 'Rent', category: 'RENT', amount: 4200, dayOfMonth: 1,
    })
    expect(db.seed.ledgerEntries).toHaveLength(1)

    await service.deleteTemplate({ ...base, ...manager, templateId: tpl.id })

    expect(db.seed.ledgerEntries).toHaveLength(1)
    expect(db.seed.ledgerEntries[0].voidedAt).toBeNull()
  })

  it('throws NotFound for a missing template', async () => {
    await expect(
      service.deleteTemplate({ ...base, ...manager, templateId: 'nope' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('forbids an actor without MANAGE_CASHBOOK', async () => {
    const tpl = await service.createTemplate({
      ...base, ...manager, name: 'Rent', category: 'RENT', amount: 4200, dayOfMonth: 1,
    })
    await expect(
      service.deleteTemplate({ ...base, ...reader, templateId: tpl.id })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
