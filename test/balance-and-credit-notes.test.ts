/**
 * BillingService.calculateStandingCredit() and applyCreditNote()
 *
 * Ported from the calculateBalance and applyCreditNote blocks of Lumo's
 * src/core/billing/BillingService.generateInvoice.test.ts. The generateInvoice
 * block itself is out of scope, so only these two blocks came across.
 *
 * All monetary assertions are exact integers in minor units.
 */

import { BillingService, InMemoryLedgerStore } from '../src'
import { NotFoundError, ValidationError, ForbiddenError } from '../src'
import {
  accountFactory,
  invoiceFactory,
  transactionFactory,
  allocationFactory,
  creditNoteFactory,
} from '../src/testing/factories'
import { MANAGER, OPERATOR, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_1'

function makeService() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  return { db, service }
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateStandingCredit
// ─────────────────────────────────────────────────────────────────────────────

describe('BillingService.calculateStandingCredit', () => {
  it('returns 0 when an account has no payments, allocations or credit notes', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(invoiceFactory({ accountId: 'acc_1', organizationId: ORG }))

    expect(await service.calculateStandingCredit('acc_1', ORG)).toBe(0)
  })

  it('returns a positive balance when payments exceed allocations and credit notes', async () => {
    // Paid 15000, allocated 13000, credit note 1000 -> 1000 of credit.
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 10000, accountId: 'acc_1', organizationId: ORG }),
      transactionFactory({ id: 'txn_2', amount: 5000, accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_1', amount: 10000, invoiceId: 'inv_1', transactionId: 'txn_1' }),
      allocationFactory({ id: 'alloc_2', amount: 3000, invoiceId: 'inv_1', transactionId: 'txn_2' })
    )
    db.seed.creditNotes.push(
      creditNoteFactory({ id: 'cn_1', amount: 1000, accountId: 'acc_1', organizationId: ORG })
    )

    expect(await service.calculateStandingCredit('acc_1', ORG)).toBe(1000)
  })

  it('returns a negative balance when more is allocated than was received', async () => {
    // 5000 received, 8000 allocated. That is a data inconsistency, and the
    // balance reports what the ledger actually says rather than hiding it.
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', accountId: 'acc_1', organizationId: ORG, amount: 10000 })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 5000, accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_1', amount: 5000, invoiceId: 'inv_1', transactionId: 'txn_1' }),
      allocationFactory({ id: 'alloc_2', amount: 3000, invoiceId: 'inv_1', transactionId: 'txn_1' })
    )

    expect(await service.calculateStandingCredit('acc_1', ORG)).toBe(-3000)
  })

  it('only counts rows belonging to this tenant', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(
      accountFactory({ id: 'acc_1', organizationId: 'org_1' }),
      accountFactory({ id: 'acc_1', organizationId: 'org_2' }) // same id, other tenant
    )
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_org1', accountId: 'acc_1', organizationId: 'org_1', amount: 10000 }),
      invoiceFactory({ id: 'inv_org2', accountId: 'acc_1', organizationId: 'org_2', amount: 50000 })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_org1', amount: 10000, accountId: 'acc_1', organizationId: 'org_1' }),
      transactionFactory({ id: 'txn_org2', amount: 50000, accountId: 'acc_1', organizationId: 'org_2' })
    )
    db.seed.allocations.push(
      allocationFactory({ amount: 10000, invoiceId: 'inv_org1', transactionId: 'txn_org1' }),
      allocationFactory({ amount: 50000, invoiceId: 'inv_org2', transactionId: 'txn_org2' })
    )

    // Only org_1: 10000 - 10000 - 0
    expect(await service.calculateStandingCredit('acc_1', 'org_1')).toBe(0)
  })

  it('sums credit notes into the balance', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.creditNotes.push(
      creditNoteFactory({ amount: 2000, accountId: 'acc_1', organizationId: ORG })
    )

    // A credit note consumes standing credit: 0 - 0 - 2000. Negative here
    // means more has been credited out than was ever received.
    expect(await service.calculateStandingCredit('acc_1', ORG)).toBe(-2000)
  })

  it('excludes voided payments', async () => {
    // added during extraction, not from Lumo
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_live', amount: 3000, accountId: 'acc_1', organizationId: ORG }),
      transactionFactory({
        id: 'txn_dead', amount: 9000, accountId: 'acc_1', organizationId: ORG,
        voidedAt: new Date(), voidedBy: 'operator_1',
      })
    )

    expect(await service.calculateStandingCredit('acc_1', ORG)).toBe(3000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyCreditNote
// ─────────────────────────────────────────────────────────────────────────────

describe('BillingService.applyCreditNote', () => {
  it('creates a credit note and writes an event', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const creditNote = await service.applyCreditNote({
      idempotencyKey:   'credit-note-key-1',
      accountId:        'acc_1',
      amount:           2500,
      currency:         'USD',
      reason:           'GOODWILL',
      notes:            'Agreed with the customer',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(creditNote.amount).toBe(2500)
    expect(creditNote.reason).toBe('GOODWILL')
    expect(creditNote.accountId).toBe('acc_1')
    expect(creditNote.notes).toBe('Agreed with the customer')

    const eventLog = db.seed.eventLogs.find(e => e.idempotencyKey === 'credit-note-key-1')
    expect(eventLog).toBeDefined()
    expect(eventLog?.type).toBe('CREDIT_NOTE_ISSUED')
  })

  it('writes no cash row: no money moved', async () => {
    // added during extraction, not from Lumo
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await service.applyCreditNote({
      idempotencyKey:   'credit-note-no-cash',
      accountId:        'acc_1',
      amount:           2500,
      currency:         'USD',
      reason:           'DISCOUNT',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(db.seed.ledgerEntries).toHaveLength(0)
  })

  it('throws ForbiddenError without MANAGE_FINANCES', async () => {
    const { service } = makeService()

    await expect(service.applyCreditNote({
      idempotencyKey:   'credit-note-key-2',
      accountId:        'acc_1',
      amount:           1000,
      currency:         'USD',
      reason:           'GOODWILL',
      actorId:          'operator_2',
      actorPermissions: OPERATOR,
      organizationId:   ORG,
    })).rejects.toThrow(ForbiddenError)
  })

  it('throws ValidationError when the amount is zero or negative', async () => {
    const { service } = makeService()

    await expect(service.applyCreditNote({
      idempotencyKey:   'credit-note-key-3',
      accountId:        'acc_1',
      amount:           0,
      currency:         'USD',
      reason:           'CORRECTION',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })).rejects.toThrow(ValidationError)

    await expect(service.applyCreditNote({
      idempotencyKey:   'credit-note-key-4',
      accountId:        'acc_1',
      amount:           -100,
      currency:         'USD',
      reason:           'CORRECTION',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })).rejects.toThrow(ValidationError)
  })

  it('throws ValidationError when the amount is a float', async () => {
    const { service } = makeService()

    await expect(service.applyCreditNote({
      idempotencyKey:   'credit-note-key-5',
      accountId:        'acc_1',
      amount:           10.50,
      currency:         'USD',
      reason:           'DISCOUNT',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })).rejects.toThrow(ValidationError)
  })

  it('throws NotFoundError when the account is not in this tenant', async () => {
    const { service } = makeService()

    await expect(service.applyCreditNote({
      idempotencyKey:   'credit-note-key-6',
      accountId:        'nonexistent_account',
      amount:           500,
      currency:         'USD',
      reason:           'REFUND',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })).rejects.toThrow(NotFoundError)
  })
})
