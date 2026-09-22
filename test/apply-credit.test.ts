/**
 * BillingService.applyCredit()
 *
 * Ported from Lumo's src/core/billing/BillingService.applyCredit.test.ts.
 *
 * Covers spending standing credit: money recorded with no charge to cover it,
 * later applied to open charges.
 *
 * Key behaviours asserted:
 *   - Applies oldest-charge-first, capped at each charge's outstanding.
 *   - Projects PAID against PARTIALLY_PAID correctly.
 *   - Reports applied and remainingCredit accurately.
 *   - No-ops without burning the idempotency key when there is no credit or no
 *     open charge.
 *   - Writes an ALLOCATION_APPLIED event and NEVER a cash row: the cash was
 *     already booked when the original payment was recorded.
 *   - Skips a source payment that already has an allocation against the target
 *     charge, because a payment holds at most one allocation per charge.
 */

import { BillingService, InMemoryLedgerStore } from '../src'
import type { ApplyCreditParams } from '../src'
import { IdempotencyError, NotFoundError, ValidationError } from '../src'
import {
  accountFactory,
  invoiceFactory,
  transactionFactory,
  allocationFactory,
} from '../src/testing/factories'
import { MANAGER, READER, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_1'

const baseParams: Omit<ApplyCreditParams, 'idempotencyKey'> = {
  accountId:        'acc_1',
  actorId:          'operator_1',
  actorPermissions: MANAGER,
  organizationId:   ORG,
}

function makeService() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
  return { db, service }
}

/** Seeds an unallocated payment (pure credit) of `amount`, created `daysAgo`. */
function seedCredit(
  db: InMemoryLedgerStore,
  id: string,
  amount: number,
  daysAgo = 0
): void {
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000)
  db.seed.transactions.push(
    transactionFactory({
      id,
      amount,
      accountId:      'acc_1',
      organizationId: ORG,
      createdAt,
      idempotencyKey: `seed_${id}`,
    })
  )
}

/** Seeds an open charge of `amount`, created `daysAgo`. */
function seedInvoice(
  db: InMemoryLedgerStore,
  id: string,
  amount: number,
  daysAgo = 0
): void {
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000)
  db.seed.invoices.push(
    invoiceFactory({
      id,
      amount,
      status:         'PENDING',
      accountId:      'acc_1',
      organizationId: ORG,
      createdAt,
    })
  )
}

describe('BillingService.applyCredit()', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('applies standing credit to an open charge and marks it PARTIALLY_PAID', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)
    seedInvoice(db, 'invoice_big', 3200)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_1',
    })

    expect(result.applied).toBe(2000)
    expect(result.remainingCredit).toBe(0)
    expect(result.invoicesTouched).toEqual(['invoice_big'])
    expect(db.seed.invoices.find((i) => i.id === 'invoice_big')?.status).toBe('PARTIALLY_PAID')
  })

  it('marks the charge PAID when credit covers it exactly', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 3200)
    seedInvoice(db, 'invoice_exact', 3200)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_2',
    })

    expect(result.applied).toBe(3200)
    expect(result.remainingCredit).toBe(0)
    expect(db.seed.invoices.find((i) => i.id === 'invoice_exact')?.status).toBe('PAID')
  })

  it('caps at the charge outstanding and leaves the rest as credit', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 5000)
    seedInvoice(db, 'invoice_small', 1200)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_3',
    })

    expect(result.applied).toBe(1200)
    expect(result.remainingCredit).toBe(3800)
    expect(db.seed.invoices.find((i) => i.id === 'invoice_small')?.status).toBe('PAID')
  })

  it('waterfalls across charges oldest-first', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2500)
    seedInvoice(db, 'invoice_new', 2000, 1)  // newer
    seedInvoice(db, 'invoice_old', 2000, 10) // older, must be covered first

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_4',
    })

    expect(result.applied).toBe(2500)
    expect(result.invoicesTouched).toEqual(['invoice_old', 'invoice_new'])
    expect(db.seed.invoices.find((i) => i.id === 'invoice_old')?.status).toBe('PAID')
    expect(db.seed.invoices.find((i) => i.id === 'invoice_new')?.status).toBe('PARTIALLY_PAID')
  })

  it('consumes multiple source payments oldest-first', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_old', 1000, 10)
    seedCredit(db, 'txn_new', 1000, 1)
    seedInvoice(db, 'invoice_big', 3200)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_5',
    })

    expect(result.applied).toBe(2000)
    const allocations = db.seed.allocations.filter((a) => a.invoiceId === 'invoice_big')
    expect(allocations).toHaveLength(2)
    expect(allocations.map((a) => a.transactionId)).toEqual(['txn_old', 'txn_new'])
  })

  it('only counts the UNSPENT portion of a partly-allocated payment', async () => {
    const { db, service } = makeService()
    // 5000 received, 3000 already spent on an earlier charge, so 2000 of credit.
    seedCredit(db, 'txn_partial', 5000)
    db.seed.invoices.push(
      invoiceFactory({
        id:             'invoice_settled',
        amount:         3000,
        status:         'PAID',
        accountId:      'acc_1',
        organizationId: ORG,
      })
    )
    db.seed.allocations.push(
      allocationFactory({
        id:            'alloc_prior',
        amount:        3000,
        transactionId: 'txn_partial',
        invoiceId:     'invoice_settled',
      })
    )
    seedInvoice(db, 'invoice_open', 4000)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_6',
    })

    expect(result.applied).toBe(2000)
    expect(result.remainingCredit).toBe(0)
  })

  // ── Targeted mode ─────────────────────────────────────────────────────────

  it('applies to a single charge when invoiceId is given', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 5000)
    seedInvoice(db, 'invoice_old', 2000, 10)
    seedInvoice(db, 'invoice_target', 2000, 1)

    const result = await service.applyCredit({
      ...baseParams,
      invoiceId:      'invoice_target',
      idempotencyKey: 'key_7',
    })

    expect(result.invoicesTouched).toEqual(['invoice_target'])
    expect(db.seed.invoices.find((i) => i.id === 'invoice_old')?.status).toBe('PENDING')
  })

  it('throws NotFoundError for an unknown invoiceId', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 1000)

    await expect(
      service.applyCredit({
        ...baseParams,
        invoiceId:      'invoice_missing',
        idempotencyKey: 'key_8',
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('throws ValidationError when the targeted charge is already covered', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 1000)
    db.seed.invoices.push(
      invoiceFactory({
        id:             'invoice_paid',
        amount:         5000,
        status:         'PAID',
        accountId:      'acc_1',
        organizationId: ORG,
      })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_prior', amount: 5000, accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_prior', amount: 5000, transactionId: 'txn_prior', invoiceId: 'invoice_paid' })
    )

    await expect(
      service.applyCredit({
        ...baseParams,
        invoiceId:      'invoice_paid',
        idempotencyKey: 'key_9',
      })
    ).rejects.toThrow(ValidationError)
  })

  // ── No-ops ────────────────────────────────────────────────────────────────

  it('no-ops when the account has no credit', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_open', 3200)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_10',
    })

    expect(result.applied).toBe(0)
    expect(result.invoicesTouched).toEqual([])
    expect(db.seed.allocations).toHaveLength(0)
    // The idempotency key must NOT be burned on a no-op.
    expect(db.seed.eventLogs).toHaveLength(0)
  })

  it('no-ops when there is credit but no open charge', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_11',
    })

    expect(result.applied).toBe(0)
    expect(result.remainingCredit).toBe(2000)
    expect(db.seed.allocations).toHaveLength(0)
  })

  // ── Unique-constraint guard ───────────────────────────────────────────────

  it('skips a source payment already allocated to the target charge', async () => {
    const { db, service } = makeService()
    // txn_used has 1000 unspent but already touched invoice_open.
    seedCredit(db, 'txn_used', 3000)
    seedInvoice(db, 'invoice_open', 5000)
    db.seed.allocations.push(
      allocationFactory({
        id:            'alloc_existing',
        amount:        2000,
        transactionId: 'txn_used',
        invoiceId:     'invoice_open',
      })
    )

    const result = await service.applyCredit({
      ...baseParams,
      idempotencyKey: 'key_12',
    })

    // The 1000 unspent cannot go to this charge: one allocation per pair.
    expect(result.applied).toBe(0)
    expect(result.remainingCredit).toBe(1000)
    expect(
      db.seed.allocations.filter((a) => a.invoiceId === 'invoice_open')
    ).toHaveLength(1)
  })

  // ── Audit trail and ledger isolation ──────────────────────────────────────

  it('writes an ALLOCATION_APPLIED event', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)
    seedInvoice(db, 'invoice_big', 3200)

    await service.applyCredit({ ...baseParams, idempotencyKey: 'key_13' })

    const logs = db.seed.eventLogs.filter((l) => l.type === 'ALLOCATION_APPLIED')
    expect(logs).toHaveLength(1)
    expect(logs[0].payload).toMatchObject({
      accountId: 'acc_1',
      applied:   2000,
    })
    expect(logs[0].actorId).toBe('operator_1')
    expect(logs[0].actorType).toBe('HUMAN')
  })

  it('does NOT write a cash row: the cash was already booked', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)
    seedInvoice(db, 'invoice_big', 3200)

    await service.applyCredit({ ...baseParams, idempotencyKey: 'key_14' })

    // Writing one here would double-count the income.
    expect(db.seed.ledgerEntries).toHaveLength(0)
  })

  it('throws IdempotencyError when the key was already processed', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)
    seedInvoice(db, 'invoice_big', 3200)

    await service.applyCredit({ ...baseParams, idempotencyKey: 'key_dupe' })

    await expect(
      service.applyCredit({ ...baseParams, idempotencyKey: 'key_dupe' })
    ).rejects.toThrow(IdempotencyError)
  })

  // ── Permissions ───────────────────────────────────────────────────────────

  it('rejects an actor without RECORD_PAYMENT', async () => {
    const { db, service } = makeService()
    seedCredit(db, 'txn_credit', 2000)
    seedInvoice(db, 'invoice_big', 3200)

    await expect(
      service.applyCredit({
        ...baseParams,
        actorPermissions: READER,
        idempotencyKey:   'key_15',
      })
    ).rejects.toThrow()
  })
})
