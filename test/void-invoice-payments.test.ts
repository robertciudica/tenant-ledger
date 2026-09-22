/**
 * BillingService.voidInvoicePayments()
 *
 * Ported from Lumo's src/core/billing/BillingService.voidInvoicePayments.test.ts.
 *
 * Clearing a charge back to unpaid by reversing EVERY payment on it. This is
 * the only way to correct a mistyped amount, because a payment's amount is
 * never mutated.
 *
 * State is set up by actually recording payments through the service rather
 * than hand-seeding rows, so each test exercises the real record-then-undo
 * round trip, including the cash rows written alongside each payment.
 *
 * Key behaviours asserted:
 *   - The unit is the CHARGE: two partial payments are cleared by one call.
 *   - Allocations are deleted, the charge re-projects to PENDING, each payment
 *     keeps void metadata, and the cash rows are voided.
 *   - A payment that also covered other charges is reversed in full, so those
 *     charges reopen too.
 *   - A voided payment's money does not become standing credit: the whole
 *     amount leaves the balance, unallocated portion included.
 *   - VOID charges stay VOID. An unpaid charge, a missing permission, and a
 *     replayed key all throw.
 */

import { BillingService, InMemoryLedgerStore } from '../src'
import type { VoidInvoicePaymentsParams } from '../src'
import {
  IdempotencyError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from '../src'
import { accountFactory, invoiceFactory } from '../src/testing/factories'
import { MANAGER, OPERATOR, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_1'
const ACCOUNT = 'acc_1'

const baseParams: Omit<VoidInvoicePaymentsParams, 'idempotencyKey' | 'invoiceId'> = {
  actorId:          'operator_1',
  actorPermissions: MANAGER,
  organizationId:   ORG,
}

function makeService() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  db.seed.accounts.push(accountFactory({ id: ACCOUNT, organizationId: ORG }))
  return { db, service }
}

/** Seeds an open charge of `amount`, created `daysAgo` (controls waterfall order). */
function seedInvoice(db: InMemoryLedgerStore, id: string, amount: number, daysAgo = 0): void {
  db.seed.invoices.push(
    invoiceFactory({
      id,
      amount,
      status:         'PENDING',
      accountId:      ACCOUNT,
      organizationId: ORG,
      createdAt:      new Date(Date.now() - daysAgo * 86_400_000),
    })
  )
}

const payTargeted = (
  service: BillingService,
  key: string,
  invoiceId: string,
  amount: number,
) =>
  service.recordPaymentForInvoice({
    idempotencyKey:   key,
    invoiceId,
    amount,
    currency:         'USD',
    paymentMethod:    'CASH',
    payerId:          'payer_1',
    actorId:          'operator_1',
    actorPermissions: MANAGER,
    organizationId:   ORG,
  })

const payWaterfall = (service: BillingService, key: string, amount: number) =>
  service.recordPayment({
    idempotencyKey:   key,
    accountId:        ACCOUNT,
    amount,
    currency:         'USD',
    paymentMethod:    'CASH',
    payerId:          'payer_1',
    actorId:          'operator_1',
    actorPermissions: MANAGER,
    organizationId:   ORG,
  })

const invoiceOf = (db: InMemoryLedgerStore, id: string) =>
  db.seed.invoices.find(i => i.id === id)

const allocationsOn = (db: InMemoryLedgerStore, invoiceId: string) =>
  db.seed.allocations.filter(a => a.invoiceId === invoiceId)

describe('BillingService.voidInvoicePayments()', () => {
  // ── The case that drove the design ────────────────────────────────────────

  it('clears a charge settled by TWO partial payments in one call', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)

    await payTargeted(service, 'pay_a', 'invoice_1', 1000)
    await payTargeted(service, 'pay_b', 'invoice_1', 1000)
    expect(invoiceOf(db, 'invoice_1')?.status).toBe('PAID')

    const result = await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    // One call, both payments gone. Nobody has to pick between them.
    expect(result.paymentsReversed).toBe(2)
    expect(result.amountReversed).toBe(2000)
    expect(result.allocationsRemoved).toBe(2)
    expect(result.ledgerEntriesVoided).toBe(2)
    expect(result.invoicesReopened).toEqual([
      { invoiceId: 'invoice_1', month: '2026-02', status: 'PENDING' },
    ])

    expect(invoiceOf(db, 'invoice_1')?.status).toBe('PENDING')
    expect(allocationsOn(db, 'invoice_1')).toHaveLength(0)
    expect(db.seed.transactions.every(t => t.voidedAt instanceof Date)).toBe(true)
    expect(db.seed.ledgerEntries.every(e => e.voidedAt instanceof Date)).toBe(true)
  })

  it('reverses a single full payment and leaves the charge payable again', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)

    // The full 2000 was recorded when only 1000 was handed over.
    await payTargeted(service, 'pay_1', 'invoice_1', 2000)

    const result = await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    expect(result.paymentsReversed).toBe(1)
    expect(result.amountReversed).toBe(2000)
    expect(invoiceOf(db, 'invoice_1')?.status).toBe('PENDING')

    const txn = db.seed.transactions[0]
    expect(txn.voidedBy).toBe('operator_1')
    // No reason is collected. The column stays, unset.
    expect(txn.voidReason).toBeNull()

    // recordPaymentForInvoice rejects PAID and VOID charges, so re-recording
    // only works because the status projection was reset.
    await payTargeted(service, 'pay_right', 'invoice_1', 1000)
    expect(invoiceOf(db, 'invoice_1')?.status).toBe('PARTIALLY_PAID')
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(0)
  })

  // ── Cross-charge reach ────────────────────────────────────────────────────

  it('reverses a payment in full, reopening the other charges it covered', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_old', 1000, 30)
    seedInvoice(db, 'invoice_new', 1000, 1)

    // One payment waterfalls across both.
    const paid = await payWaterfall(service, 'pay_1', 2000)
    expect(paid.allocated).toBe(2000)

    // Clearing the older one reverses the whole payment, so the newer one
    // reopens as well: its allocation came from money we just un-received.
    const result = await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_old',
    })

    expect(result.paymentsReversed).toBe(1)
    expect(result.allocationsRemoved).toBe(2)
    expect(result.invoicesReopened).toHaveLength(2)
    expect(invoiceOf(db, 'invoice_old')?.status).toBe('PENDING')
    expect(invoiceOf(db, 'invoice_new')?.status).toBe('PENDING')
  })

  // ── Balance and credit ────────────────────────────────────────────────────

  it('removes the WHOLE payment from the balance, unallocated credit included', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)

    // 5000 received against a 2000 charge: 2000 allocated, 3000 standing credit.
    const paid = await payWaterfall(service, 'pay_1', 5000)
    expect(paid.credit).toBe(3000)
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(3000)

    await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    // Not 3000, and not 2000. The payment never happened, so there is no
    // credit. This holds only because the store excludes voided payments.
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(0)
    expect(invoiceOf(db, 'invoice_1')?.status).toBe('PENDING')
  })

  it('will not let applyCredit spend a voided payment', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)
    await payWaterfall(service, 'pay_1', 5000)

    await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    seedInvoice(db, 'invoice_later', 1000)
    const applied = await service.applyCredit({
      idempotencyKey:   'credit_1',
      accountId:        ACCOUNT,
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(applied.applied).toBe(0)
    expect(invoiceOf(db, 'invoice_later')?.status).toBe('PENDING')
  })

  // ── Audit trail ───────────────────────────────────────────────────────────

  it('writes ONE event snapshotting every payment and allocation removed', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)
    await payTargeted(service, 'pay_a', 'invoice_1', 1000)
    await payTargeted(service, 'pay_b', 'invoice_1', 1000)

    await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    const events = db.seed.eventLogs.filter(e => e.type === 'TRANSACTION_VOIDED')
    // One per operation, not one per payment: a single idempotency anchor.
    expect(events).toHaveLength(1)

    const payload = events[0].payload as {
      invoiceId: string
      amount: number
      payments: Array<{ transactionId: string; allocations: Array<{ invoiceId: string }> }>
    }
    expect(payload.invoiceId).toBe('invoice_1')
    expect(payload.amount).toBe(2000)
    // The allocation rows no longer exist anywhere else. This is the only
    // record of them.
    expect(payload.payments).toHaveLength(2)
    expect(payload.payments.flatMap(p => p.allocations)).toHaveLength(2)
  })

  // ── Guards ────────────────────────────────────────────────────────────────

  it('rejects a charge with nothing to undo', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)

    await expect(
      service.voidInvoicePayments({
        ...baseParams,
        idempotencyKey: 'undo_1',
        invoiceId:      'invoice_1',
      })
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a second undo of the same charge', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)
    await payTargeted(service, 'pay_1', 'invoice_1', 2000)

    await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_1',
    })

    // The allocations are gone, so there is nothing left to reverse.
    await expect(
      service.voidInvoicePayments({
        ...baseParams,
        idempotencyKey: 'undo_2',
        invoiceId:      'invoice_1',
      })
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a replayed idempotency key', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)
    seedInvoice(db, 'invoice_2', 2000)
    await payTargeted(service, 'pay_1', 'invoice_1', 2000)
    await payTargeted(service, 'pay_2', 'invoice_2', 2000)

    await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_shared',
      invoiceId:      'invoice_1',
    })

    await expect(
      service.voidInvoicePayments({
        ...baseParams,
        idempotencyKey: 'undo_shared',
        invoiceId:      'invoice_2',
      })
    ).rejects.toThrow(IdempotencyError)
  })

  it('rejects an unknown charge', async () => {
    const { service } = makeService()

    await expect(
      service.voidInvoicePayments({
        ...baseParams,
        idempotencyKey: 'undo_1',
        invoiceId:      'invoice_missing',
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('forbids an actor who can record money from reversing it', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_1', 2000)

    // RECORD_PAYMENT is enough to take the money in...
    await service.recordPaymentForInvoice({
      idempotencyKey:   'pay_1',
      invoiceId:        'invoice_1',
      amount:           2000,
      currency:         'USD',
      paymentMethod:    'CASH',
      payerId:          'payer_1',
      actorId:          'operator_2',
      actorPermissions: OPERATOR,
      organizationId:   ORG,
    })

    // ...but reversing it needs MANAGE_FINANCES.
    await expect(
      service.voidInvoicePayments({
        ...baseParams,
        actorPermissions: OPERATOR,
        idempotencyKey:   'undo_1',
        invoiceId:        'invoice_1',
      })
    ).rejects.toThrow(ForbiddenError)
  })

  it('leaves a VOID charge voided rather than resurrecting it', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'invoice_old', 1000, 30)
    seedInvoice(db, 'invoice_new', 1000, 1)
    await payWaterfall(service, 'pay_1', 2000)

    // VOID is terminal, and an undo must not undo it.
    invoiceOf(db, 'invoice_new')!.status = 'VOID'

    const result = await service.voidInvoicePayments({
      ...baseParams,
      idempotencyKey: 'undo_1',
      invoiceId:      'invoice_old',
    })

    expect(result.invoicesReopened).toContainEqual(
      { invoiceId: 'invoice_new', month: '2026-02', status: 'VOID' },
    )
    expect(invoiceOf(db, 'invoice_new')?.status).toBe('VOID')
    // The money is still reversed even though that charge stays void.
    expect(invoiceOf(db, 'invoice_old')?.status).toBe('PENDING')
    expect(db.seed.allocations).toHaveLength(0)
  })
})
