/**
 * BillingService.reversePayment() and voidInvoice(): the two halves of
 * correction, kept apart.
 *
 * added during extraction, not from Lumo
 *
 * "This payment never arrived" and "this charge should not exist" are
 * different accounting events. Until 1.1 the ledger had only the first, and
 * only entered through a charge, so clearing a wrong charge declared a real
 * payment nonexistent and reopened everything else it had covered. These
 * tests pin the two apart.
 */

import { BillingService, InMemoryLedgerStore, computeEffectiveStatus } from '../src'
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
const actor = { actorId: 'operator_1', actorPermissions: MANAGER, organizationId: ORG }

function makeService() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  db.seed.accounts.push(accountFactory({ id: ACCOUNT, organizationId: ORG }))
  return { db, service }
}

function seedInvoice(db: InMemoryLedgerStore, id: string, amount: number, daysAgo = 0): void {
  db.seed.invoices.push(
    invoiceFactory({
      id, amount, status: 'PENDING', accountId: ACCOUNT, organizationId: ORG,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    })
  )
}

const pay = (service: BillingService, key: string, amount: number) =>
  service.recordPayment({
    ...actor, idempotencyKey: key, accountId: ACCOUNT, payerId: 'payer_1',
    amount, currency: 'USD', paymentMethod: 'CASH',
  })

const status = (db: InMemoryLedgerStore, id: string) =>
  db.seed.invoices.find(i => i.id === id)?.status

// ─────────────────────────────────────────────────────────────────────────────
// reversePayment: the money never arrived
// ─────────────────────────────────────────────────────────────────────────────

describe('BillingService.reversePayment()', () => {
  it('reverses one payment whole and reopens every charge it covered', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000, 30)
    seedInvoice(db, 'feb', 5000, 0)
    const paid = await pay(service, 'pay_1', 7000)

    const result = await service.reversePayment({
      ...actor, idempotencyKey: 'rev_1', transactionId: paid.transactionId, reason: 'Transfer bounced',
    })

    expect(result.amountReversed).toBe(7000)
    expect(result.allocationsRemoved).toBe(2)
    expect(result.invoicesReopened.map(i => i.invoiceId).sort()).toEqual(['feb', 'jan'])
    expect(status(db, 'jan')).toBe('PENDING')
    expect(status(db, 'feb')).toBe('PENDING')
    expect(db.seed.allocations).toHaveLength(0)

    // The payment row survives, flagged, with the reason.
    const txn = db.seed.transactions[0]
    expect(txn.amount).toBe(7000)
    expect(txn.voidedAt).toBeInstanceOf(Date)
    expect(txn.voidReason).toBe('Transfer bounced')
    // Its cash row leaves the totals.
    expect(db.seed.ledgerEntries[0].voidedAt).toBeInstanceOf(Date)
    // And no standing credit comes back from money that never arrived.
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(0)
  })

  it('leaves other payments on the same charge alone', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 6000)
    const first = await pay(service, 'pay_1', 4000)
    await pay(service, 'pay_2', 2000)

    await service.reversePayment({ ...actor, idempotencyKey: 'rev_1', transactionId: first.transactionId })

    // Only the first payment's allocation is gone; the charge re-projects from
    // what remains rather than to PENDING.
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].amount).toBe(2000)
    expect(status(db, 'jan')).toBe('PARTIALLY_PAID')
  })

  it('writes one event with a snapshot of the allocations it removed', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    const paid = await pay(service, 'pay_1', 5000)

    await service.reversePayment({ ...actor, idempotencyKey: 'rev_1', transactionId: paid.transactionId })

    const event = db.seed.eventLogs.find(e => e.type === 'TRANSACTION_VOIDED')
    expect(event?.idempotencyKey).toBe('rev_1')
    const payload = event?.payload as { transactionId: string; payments: Array<{ allocations: unknown[] }> }
    expect(payload.transactionId).toBe(paid.transactionId)
    expect(payload.payments[0].allocations).toHaveLength(1)
  })

  it('refuses a payment that is already reversed', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    const paid = await pay(service, 'pay_1', 5000)
    await service.reversePayment({ ...actor, idempotencyKey: 'rev_1', transactionId: paid.transactionId })

    await expect(
      service.reversePayment({ ...actor, idempotencyKey: 'rev_2', transactionId: paid.transactionId })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a replayed key, a missing payment, another tenant, and an operator', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    const paid = await pay(service, 'pay_1', 5000)
    const params = { ...actor, idempotencyKey: 'rev_1', transactionId: paid.transactionId }

    await service.reversePayment(params)
    await expect(service.reversePayment(params)).rejects.toBeInstanceOf(IdempotencyError)
    await expect(
      service.reversePayment({ ...params, idempotencyKey: 'rev_x', transactionId: 'txn_missing' })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.reversePayment({ ...params, idempotencyKey: 'rev_y', organizationId: 'org_2' })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.reversePayment({ ...params, idempotencyKey: 'rev_z', actorPermissions: OPERATOR })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// voidInvoice: the charge should not exist
// ─────────────────────────────────────────────────────────────────────────────

describe('BillingService.voidInvoice()', () => {
  it('voids an unpaid charge and touches no money', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)

    const result = await service.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: 'jan', reason: 'Raised in error' })

    expect(result).toEqual({ invoiceId: 'jan', status: 'VOID', amountReleased: 0, allocationsReleased: 0 })
    expect(status(db, 'jan')).toBe('VOID')
    expect(db.seed.transactions).toHaveLength(0)
    expect(db.seed.ledgerEntries).toHaveLength(0)
    expect(db.seed.eventLogs.map(e => e.type)).toEqual(['INVOICE_VOIDED'])
  })

  it('voids a paid charge: the payment stays and its money becomes standing credit', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    const paid = await pay(service, 'pay_1', 5000)
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(0)

    const result = await service.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: 'jan' })

    expect(result.amountReleased).toBe(5000)
    expect(result.allocationsReleased).toBe(1)
    expect(status(db, 'jan')).toBe('VOID')
    // The payment did arrive. It is not reversed, and its cash row stands.
    const txn = db.seed.transactions.find(t => t.id === paid.transactionId)
    expect(txn?.voidedAt).toBeNull()
    expect(db.seed.ledgerEntries[0].voidedAt).toBeNull()
    // The money now has nothing to cover.
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(5000)
  })

  it('leaves a payment that also covered another charge attached to that charge', async () => {
    // The opposite of reversal: voiding January does not reopen February.
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000, 30)
    seedInvoice(db, 'feb', 5000, 0)
    await pay(service, 'pay_1', 7000)

    await service.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: 'jan' })

    expect(status(db, 'jan')).toBe('VOID')
    expect(status(db, 'feb')).toBe('PARTIALLY_PAID')
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('feb')
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(5000)
  })

  it('released money can then be spent on the next charge', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000, 30)
    await pay(service, 'pay_1', 5000)
    await service.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: 'jan' })
    seedInvoice(db, 'feb', 5000, 0)

    const applied = await service.applyCredit({ ...actor, idempotencyKey: 'credit_1', accountId: ACCOUNT })

    expect(applied.applied).toBe(5000)
    expect(status(db, 'feb')).toBe('PAID')
    expect(await service.calculateStandingCredit(ACCOUNT, ORG)).toBe(0)
  })

  it('is terminal: money landing later never resurrects it, and a second void is an error', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    await service.voidInvoice({ ...actor, idempotencyKey: 'void_1', invoiceId: 'jan' })

    const paid = await pay(service, 'pay_1', 5000)
    expect(paid.allocated).toBe(0)
    expect(paid.credit).toBe(5000)
    expect(status(db, 'jan')).toBe('VOID')
    const row = db.seed.invoices[0]
    expect(computeEffectiveStatus(row.status, row.amount, 0, row.dueDate, new Date())).toBe('VOID')

    await expect(
      service.voidInvoice({ ...actor, idempotencyKey: 'void_2', invoiceId: 'jan' })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a replayed key, a missing charge, another tenant, and an operator', async () => {
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)
    const params = { ...actor, idempotencyKey: 'void_1', invoiceId: 'jan' }

    await service.voidInvoice(params)
    await expect(service.voidInvoice(params)).rejects.toBeInstanceOf(IdempotencyError)
    await expect(
      service.voidInvoice({ ...params, idempotencyKey: 'v_x', invoiceId: 'missing' })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.voidInvoice({ ...params, idempotencyKey: 'v_y', organizationId: 'org_2' })
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.voidInvoice({ ...params, idempotencyKey: 'v_z', actorPermissions: OPERATOR })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('cannot be reached from the payment side by mistake', async () => {
    // voidInvoicePayments on a charge with no live payments is still an error,
    // and voidInvoice is the operation for a charge that is wrong.
    const { db, service } = makeService()
    seedInvoice(db, 'jan', 5000)

    await expect(
      service.voidInvoicePayments({ ...actor, idempotencyKey: 'undo_1', invoiceId: 'jan' })
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
