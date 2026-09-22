/**
 * The services, on Postgres.
 *
 * added during extraction, not from Lumo
 *
 * The rest of the suite runs against the in-memory store, which is fast and
 * proves the logic. It cannot prove that the logic still holds when
 * `runTransaction` really rolls back, when a constraint really fires, and when
 * the numbers make a round trip through bigint columns. This file is the same
 * ledger over PGlite, which is Postgres compiled to WebAssembly: real SQL,
 * real constraints, real transactions, no server.
 *
 * It is a lifecycle rather than a second copy of every case: create charges,
 * waterfall a payment across them, overpay into credit, spend the credit,
 * reverse, and check the cash ledger agrees at every step.
 */

import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BillingService,
  LedgerService,
  computeLedgerTotals,
  computeEffectiveStatus,
  sumAllocations,
  IdempotencyError,
} from '../src'
import { PostgresLedgerStore } from '../src/postgres'
import { MANAGER, TAXONOMY, PAYMENT_CATEGORY } from './helpers'

const SCHEMA = readFileSync(join(__dirname, '../src/postgres/schema.sql'), 'utf8')
const ORG = 'org_1'
const CLOCK = () => new Date('2026-03-10T12:00:00Z')

let pg: PGlite
let store: PostgresLedgerStore
let billing: BillingService
let cash: LedgerService

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(SCHEMA)
})

afterAll(async () => {
  await pg?.close()
})

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE accounts, invoices, financial_transactions, allocations,
             credit_notes, recurring_expense_templates, ledger_entries, event_log
    RESTART IDENTITY CASCADE
  `)
  await pg.query('INSERT INTO accounts (id, organization_id) VALUES ($1, $2)', ['acc_1', ORG])
  store = new PostgresLedgerStore(pg)
  billing = new BillingService(store, { paymentCategory: PAYMENT_CATEGORY, clock: CLOCK })
  cash = new LedgerService(store, TAXONOMY, { clock: CLOCK })
})

const actor = {
  actorId:          'operator_1',
  actorPermissions: MANAGER,
  organizationId:   ORG,
}

async function charge(month: string, amount: number, dueDate: string) {
  return billing.createManualInvoice({
    accountId:      'acc_1',
    amount,
    currency:       'EUR',
    dueDate:        new Date(dueDate),
    description:    month,
    month,
    createdBy:      'operator_1',
    actorPermissions: MANAGER,
    organizationId: ORG,
  })
}

describe('the ledger on Postgres', () => {
  it('waterfalls a payment across charges, oldest first', async () => {
    const january  = await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    const february = await charge('2026-02', 5000, '2026-02-28T00:00:00Z')

    const result = await billing.recordPayment({
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         7000,
      currency:       'EUR',
      paymentMethod:  'BANK_TRANSFER',
    })

    expect(result.allocated).toBe(7000)
    expect(result.credit).toBe(0)
    expect((await store.findInvoiceById(january.id, ORG))?.status).toBe('PAID')
    expect((await store.findInvoiceById(february.id, ORG))?.status).toBe('PARTIALLY_PAID')
    // The payment booked its own income row.
    const entries = await store.findLedgerEntriesByTransaction(result.transactionId, ORG)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ direction: 'IN', amount: 7000, source: 'PAYMENT' })
  })

  it('matches what previewAllocation promised', async () => {
    await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    await charge('2026-02', 5000, '2026-02-28T00:00:00Z')

    const preview = await billing.previewAllocation({
      accountId: 'acc_1', amount: 7000, currency: 'EUR', organizationId: ORG,
    })
    const result = await billing.recordPayment({
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         7000,
      currency:       'EUR',
      paymentMethod:  'CASH',
    })

    expect(preview.totalAllocated).toBe(result.allocated)
    expect(preview.credit).toBe(result.credit)
    for (const step of preview.steps) {
      const landed = sumAllocations(await store.findAllocationsByInvoice(step.invoiceId, ORG))
      expect(landed).toBe(step.toAllocate)
    }
  })

  it('leaves an overpayment as standing credit, then spends it on a later charge', async () => {
    await charge('2026-01', 5000, '2026-01-31T00:00:00Z')

    const paid = await billing.recordPayment({
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         8000,
      currency:       'EUR',
      paymentMethod:  'CASH',
    })
    expect(paid.credit).toBe(3000)
    expect(await billing.calculateStandingCredit('acc_1', ORG)).toBe(3000)

    const february = await charge('2026-02', 5000, '2026-02-28T00:00:00Z')
    const applied = await billing.applyCredit({ ...actor, idempotencyKey: 'credit_1', accountId: 'acc_1' })

    expect(applied.applied).toBe(3000)
    expect(applied.remainingCredit).toBe(0)
    expect(applied.invoicesTouched).toEqual([february.id])
    expect(await billing.calculateStandingCredit('acc_1', ORG)).toBe(0)
  })

  it('reverses a payment and reopens every charge it covered', async () => {
    const january  = await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    const february = await charge('2026-02', 5000, '2026-02-28T00:00:00Z')
    const paid = await billing.recordPayment({
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         7000,
      currency:       'EUR',
      paymentMethod:  'CASH',
    })

    const undone = await billing.voidInvoicePayments({
      ...actor,
      idempotencyKey: 'undo_1',
      invoiceId:      january.id,
    })

    expect(undone.amountReversed).toBe(7000)
    expect(undone.paymentsReversed).toBe(1)
    expect(undone.allocationsRemoved).toBe(2)
    // February was propped up by the same payment, so it reopens too.
    expect(undone.invoicesReopened.map(i => i.invoiceId).sort()).toEqual(
      [january.id, february.id].sort()
    )
    expect((await store.findInvoiceById(february.id, ORG))?.status).toBe('PENDING')

    // The payment row survives, flagged, and the cash leaves the totals.
    const payment = await store.findTransactionById(paid.transactionId, ORG)
    expect(payment?.amount).toBe(7000)
    expect(payment?.voidedAt).toBeInstanceOf(Date)
    expect(await store.findTransactionsByAccount('acc_1', ORG)).toEqual([])
    expect(await store.findLedgerEntriesByTransaction(paid.transactionId, ORG)).toEqual([])
  })

  it('voids a paid charge, keeps the payment, and lets the credit be spent', async () => {
    const january = await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    const paid = await billing.recordPayment({
      ...actor, idempotencyKey: 'pay_1', accountId: 'acc_1', payerId: 'payer_1',
      amount: 5000, currency: 'EUR', paymentMethod: 'CARD',
    })

    const voided = await billing.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: january.id, reason: 'Duplicate' })

    expect(voided.amountReleased).toBe(5000)
    expect((await store.findInvoiceById(january.id, ORG))?.status).toBe('VOID')
    expect((await store.findTransactionById(paid.transactionId, ORG))?.voidedAt).toBeNull()
    expect(await billing.calculateStandingCredit('acc_1', ORG)).toBe(5000)

    const february = await charge('2026-02', 5000, '2026-02-28T00:00:00Z')
    const applied = await billing.applyCredit({ ...actor, idempotencyKey: 'credit_1', accountId: 'acc_1' })
    expect(applied.applied).toBe(5000)
    expect((await store.findInvoiceById(february.id, ORG))?.status).toBe('PAID')
  })

  it('refuses a replayed idempotency key', async () => {
    await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    const payment = {
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         5000,
      currency:       'EUR',
      paymentMethod:  'CASH' as const,
    }

    await billing.recordPayment(payment)
    await expect(billing.recordPayment(payment)).rejects.toBeInstanceOf(IdempotencyError)

    // Exactly one payment, and one event row, however many times it was sent.
    expect(await store.findTransactionsByAccount('acc_1', ORG)).toHaveLength(1)
  })

  it('rolls the whole operation back when a write inside it fails', async () => {
    // A real transaction, unlike the in-memory store. The payment, its
    // allocation and its cash row are all written before the event row
    // collides, and none of them survive.
    await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    await pg.query(
      `INSERT INTO event_log (organization_id, type, payload, actor_id, actor_type, idempotency_key)
       VALUES ($1, 'TRANSACTION_RECORDED', '{}'::jsonb, 'operator_1', 'HUMAN', $2)`,
      [ORG, 'raced_key']
    )

    // Blind the pre-flight read, so the unique constraint is the only thing
    // standing between this call and taking the money twice. That is the race
    // a busy system actually hits.
    const blind = new PostgresLedgerStore(pg)
    blind.findEventLogByKey = async () => null
    const racing = new BillingService(blind, { paymentCategory: PAYMENT_CATEGORY, clock: CLOCK })

    await expect(
      racing.recordPayment({
        ...actor,
        idempotencyKey: 'raced_key',
        accountId:      'acc_1',
        payerId:        'payer_1',
        amount:         5000,
        currency:       'EUR',
        paymentMethod:  'CASH',
      })
    ).rejects.toBeInstanceOf(IdempotencyError)

    expect(await store.findTransactionsByAccount('acc_1', ORG)).toEqual([])
    expect(await store.findAllocationsByAccount('acc_1', ORG)).toEqual([])
    const cashRows = await pg.query<{ count: string }>('SELECT count(*) AS count FROM ledger_entries')
    expect(Number(cashRows.rows[0].count)).toBe(0)
  })

  it('keeps a subclass overriding a query inside the transaction too', async () => {
    // runTransaction builds the store the body runs against. If it named this
    // class instead of asking `this` what it is, a subclass would find its
    // override honoured outside transactions and ignored inside them, which is
    // where nearly every write happens.
    const seen: string[] = []
    class TracingStore extends PostgresLedgerStore {
      async createInvoice(...args: Parameters<PostgresLedgerStore['createInvoice']>) {
        seen.push('createInvoice')
        return super.createInvoice(...args)
      }
    }
    const tracing = new BillingService(new TracingStore(pg), {
      paymentCategory: PAYMENT_CATEGORY,
      clock: CLOCK,
    })

    await tracing.createManualInvoice({
      accountId:      'acc_1',
      amount:         5000,
      currency:       'EUR',
      dueDate:        new Date('2026-04-30T00:00:00Z'),
      description:    'April',
      createdBy:      'operator_1',
      actorPermissions: MANAGER,
      organizationId: ORG,
    })

    expect(seen).toEqual(['createInvoice'])
  })

  it('keeps the two ledgers agreeing about a month', async () => {
    await charge('2026-03', 5000, '2026-03-31T00:00:00Z')
    await billing.recordPayment({
      ...actor,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      payerId:        'payer_1',
      amount:         5000,
      currency:       'EUR',
      paymentMethod:  'CASH',
    })
    await cash.addEntry({
      ...actor,
      idempotencyKey: 'rent_1',
      direction:      'OUT',
      category:       'RENT',
      amount:         1200,
      currency:       'EUR',
    })

    const rows = await pg.query<Record<string, unknown>>(
      'SELECT * FROM ledger_entries WHERE organization_id = $1',
      [ORG]
    )
    const entries = rows.rows.map(r => ({
      direction: r.direction as 'IN' | 'OUT',
      amount:    Number(r.amount),
      voidedAt:  r.voided_at as Date | null,
    }))
    // computeLedgerTotals only needs direction, amount and voidedAt.
    const totals = computeLedgerTotals(entries as never)
    expect(totals).toEqual({ inn: 5000, out: 1200, net: 3800 })
  })

  it('derives overdue from the due date, with nothing stored', async () => {
    const january = await charge('2026-01', 5000, '2026-01-31T00:00:00Z')
    const stored = await store.findInvoiceById(january.id, ORG)

    // Nothing ever writes OVERDUE.
    expect(stored?.status).toBe('PENDING')
    expect(
      computeEffectiveStatus(stored!.status, stored!.amount, 0, stored!.dueDate, CLOCK())
    ).toBe('OVERDUE')
  })

  it('posts a recurring expense once per month, whatever the job does', async () => {
    await cash.createTemplate({
      ...actor,
      name:       'Office rent',
      category:   'RENT',
      amount:     420000,
      currency:   'EUR',
      dayOfMonth: 1,
    })

    // Created on the 10th with a day-of-month of 1, so this month posted
    // immediately. The job then runs twice.
    const first  = await cash.materializeTemplatesForMonth({ month: '2026-03', organizationId: ORG })
    const second = await cash.materializeTemplatesForMonth({ month: '2026-03', organizationId: ORG })

    expect(first).toBe(0)
    expect(second).toBe(0)
    const posted = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM ledger_entries WHERE source = 'RECURRING' AND month = '2026-03'"
    )
    expect(Number(posted.rows[0].count)).toBe(1)
  })
})
