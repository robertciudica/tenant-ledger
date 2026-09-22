/**
 * The invariants, asserted directly.
 *
 * Every test in this file is: added during extraction, not from Lumo.
 *
 * The behaviour each one covers is exercised somewhere in the ported suites as
 * a side effect of a feature test. This file states the rules on their own, so
 * that breaking one fails a test whose name says which rule broke. It also
 * characterizes the one place the ledger does less than you would expect.
 */

import {
  BillingService,
  LedgerService,
  InMemoryLedgerStore,
  computeLedgerTotals,
  IdempotencyError,
  NotFoundError,
  UniqueViolationError,
  DuplicateIdempotencyKeyError,
} from '../src'
import type { LedgerStore } from '../src'
import {
  accountFactory,
  invoiceFactory,
  transactionFactory,
  allocationFactory,
} from '../src/testing/factories'
import { MANAGER, TAXONOMY, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_1'

function setup() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const billing = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  const cash = new LedgerService(db, TAXONOMY)
  db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
  return { db, billing, cash }
}

const pay = (billing: BillingService, key: string, amount: number, accountId = 'acc_1') =>
  billing.recordPayment({
    idempotencyKey:   key,
    accountId,
    payerId:          'payer_1',
    amount,
    currency:         'USD',
    paymentMethod:    'CASH',
    actorId:          'operator_1',
    actorPermissions: MANAGER,
    organizationId:   ORG,
  })

// ─────────────────────────────────────────────────────────────────────────────
// A payment can never have allocated more than it received
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: allocations never exceed the payment they came from', () => {
  it('refuses to reverse a payment whose allocations exceed its amount', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 5000, status: 'PAID', accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 1000, accountId: 'acc_1', organizationId: ORG })
    )
    // Corrupt state: 2000 allocated out of a 1000 payment.
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_1', amount: 2000, transactionId: 'txn_1', invoiceId: 'inv_1' })
    )

    // A plain Error, not a DomainError: this is a programming or data fault and
    // must not be caught and shown to somebody as a validation message.
    await expect(
      billing.voidInvoicePayments({
        idempotencyKey:   'undo_corrupt',
        invoiceId:        'inv_1',
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      })
    ).rejects.toThrow(/invariant violation/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entries are immutable
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: recorded amounts are never mutated', () => {
  it('keeps the original amount on a reversed payment', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    await pay(billing, 'pay_1', 2000)

    await billing.voidInvoicePayments({
      idempotencyKey:   'undo_1',
      invoiceId:        'inv_1',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    const txn = db.seed.transactions[0]
    expect(txn.amount).toBe(2000) // unchanged
    expect(txn.voidedAt).toBeInstanceOf(Date)
  })

  it('keeps the original amount on a voided cash row', async () => {
    const { db, cash } = setup()
    const added = await cash.addEntry({
      idempotencyKey:   'cash_1',
      direction:        'OUT',
      category:         'SUPPLIES',
      amount:           140,
      currency:         'USD',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    await cash.voidEntry({
      idempotencyKey:   'cash_void_1',
      entryId:          added.id,
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    const row = db.seed.ledgerEntries[0]
    expect(row.amount).toBe(140) // unchanged
    expect(row.voidedAt).toBeInstanceOf(Date)
    expect(computeLedgerTotals(db.seed.ledgerEntries).out).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The event log is the idempotency anchor
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: one event row per mutating operation, keyed for idempotency', () => {
  it('writes exactly one event row per operation', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await pay(billing, 'pay_1', 2000)

    expect(db.seed.eventLogs).toHaveLength(1)
    expect(db.seed.eventLogs[0].idempotencyKey).toBe('pay_1')
  })

  it('relies on a store-level unique constraint, not only on the pre-flight read', async () => {
    // The pre-flight check can lose a race; the constraint cannot. A store that
    // does not enforce this would make every idempotency test here worthless.
    const { db } = setup()
    const row = {
      type:           'TRANSACTION_RECORDED' as const,
      payload:        {},
      actorId:        'operator_1',
      actorType:      'HUMAN' as const,
      idempotencyKey: 'racing_key',
    }
    await db.createEventLog(row, ORG)
    await expect(db.createEventLog(row, ORG)).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: a tenant cannot reach another tenant rows', () => {
  it('computes a balance from this tenant rows only', async () => {
    const { db, billing } = setup()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_2' }))
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 1000, accountId: 'acc_1', organizationId: 'org_1' }),
      transactionFactory({ id: 'txn_2', amount: 9999, accountId: 'acc_1', organizationId: 'org_2' }),
    )

    expect(await billing.calculateStandingCredit('acc_1', 'org_1')).toBe(1000)
    expect(await billing.calculateStandingCredit('acc_1', 'org_2')).toBe(9999)
  })

  it('previews an allocation against this tenant charges only', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_mine', amount: 1000, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_1' }),
      invoiceFactory({ id: 'inv_theirs', amount: 9999, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_2' }),
    )

    const preview = await billing.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(preview.steps.map(s => s.invoiceId)).toEqual(['inv_mine'])
    expect(preview.credit).toBe(4000)
  })

  it('reaches allocations through their charge, which is what scopes them', async () => {
    // An Allocation carries no tenant column. If a store filtered these by id
    // alone, the ledger could not catch it, so this asserts the contract the
    // port documents.
    const { db } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_theirs', amount: 9999, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_2' })
    )
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_theirs', amount: 9999, invoiceId: 'inv_theirs', transactionId: 'txn_theirs' })
    )

    const mine = await db.findAllocationsByAccount('acc_1', 'org_1')
    expect(mine).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Money settles a charge in the charge's own currency
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: a payment settles charges in its own currency only', () => {
  // added during extraction, not from Lumo
  //
  // Until 1.1 this was the one place the ledger did less than a reader would
  // expect: the currency travelled on every row and nothing compared them, so
  // a payment in one currency settled a charge in another at face value. There
  // is no exchange rate in a ledger, so that is not a conversion, it is a
  // wrong number. Every path that allocates now refuses to cross a currency.

  it('refuses a payment in a different currency from the open charges', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_eur', amount: 5000, currency: 'EUR', status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await expect(
      billing.recordPayment({
        idempotencyKey:   'pay_usd',
        accountId:        'acc_1',
        payerId:          'payer_1',
        amount:           5000,
        currency:         'USD',
        paymentMethod:    'CASH',
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      })
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'currency' })

    // Nothing was written: no payment, no allocation, no cash row, no event.
    expect(db.seed.transactions).toHaveLength(0)
    expect(db.seed.allocations).toHaveLength(0)
    expect(db.seed.ledgerEntries).toHaveLength(0)
    expect(db.seed.eventLogs).toHaveLength(0)
    expect(db.seed.invoices[0].status).toBe('PENDING')
  })

  it('refuses a targeted payment in a different currency', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_eur', amount: 5000, currency: 'EUR', status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await expect(
      billing.recordPaymentForInvoice({
        idempotencyKey:   'pay_usd',
        invoiceId:        'inv_eur',
        payerId:          'payer_1',
        amount:           5000,
        currency:         'USD',
        paymentMethod:    'CASH',
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      })
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'currency' })
  })

  it('refuses to preview across a currency, the same as it refuses to commit', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_eur', amount: 5000, currency: 'EUR', status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await expect(
      billing.previewAllocation({ accountId: 'acc_1', amount: 5000, currency: 'USD', organizationId: ORG })
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'currency' })
  })

  it('refuses to spend credit that arrived in another currency', async () => {
    const { db, billing } = setup()
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_usd', amount: 3000, currency: 'USD', accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_eur', amount: 5000, currency: 'EUR', status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await expect(
      billing.applyCredit({
        idempotencyKey:   'credit_1',
        accountId:        'acc_1',
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      })
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'currency' })
    expect(db.seed.allocations).toHaveLength(0)
  })

  it('still pays an account whose charges match', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 5000, currency: 'EUR', status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    const result = await billing.recordPayment({
      idempotencyKey:   'pay_eur',
      accountId:        'acc_1',
      payerId:          'payer_1',
      amount:           5000,
      currency:         'EUR',
      paymentMethod:    'CASH',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })
    expect(result.allocated).toBe(5000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Allocation is serialised per account
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: every allocating operation locks the account first', () => {
  // added during extraction, not from Lumo
  //
  // The ledger reads an outstanding balance and then spends it. Under two
  // concurrent callers that is a lost update: both see the charge as open and
  // both allocate to it. The lock is what makes the read-then-write safe, so
  // these tests assert it is taken, and taken before anything is read.

  /** Records the order of store calls, and what the account lock returned. */
  function recordingStore() {
    const db = new InMemoryLedgerStore()
    db.reset()
    const calls: string[] = []
    const proxy = new Proxy(db, {
      get(target, prop: string, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'runTransaction') {
          return prop === 'runTransaction'
            ? (fn: (tx: LedgerStore) => Promise<unknown>) => {
                calls.push('runTransaction')
                return fn(proxy)
              }
            : value
        }
        return (...args: unknown[]) => {
          calls.push(prop)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as InMemoryLedgerStore
    return { db, proxy, calls }
  }

  const insideTransaction = (calls: string[]) =>
    calls.slice(calls.indexOf('runTransaction') + 1)

  it('locks the account before writing anything, when recording a payment', async () => {
    const { db, proxy, calls } = recordingStore()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    const billing = new BillingService(proxy, { paymentCategory: PAYMENT_CATEGORY })

    await pay(billing, 'pay_1', 2000)

    expect(insideTransaction(calls)[0]).toBe('lockAccount')
  })

  it('locks the account before reading balances, when applying credit', async () => {
    const { db, proxy, calls } = recordingStore()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 1000, accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    const billing = new BillingService(proxy, { paymentCategory: PAYMENT_CATEGORY })

    await billing.applyCredit({
      idempotencyKey:   'credit_1',
      accountId:        'acc_1',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(insideTransaction(calls)[0]).toBe('lockAccount')
  })

  it('locks the account before resolving payments, when reversing', async () => {
    const { db, proxy, calls } = recordingStore()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    const billing = new BillingService(proxy, { paymentCategory: PAYMENT_CATEGORY })
    await pay(billing, 'pay_1', 2000)
    calls.length = 0

    await billing.voidInvoicePayments({
      idempotencyKey:   'undo_1',
      invoiceId:        'inv_1',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(insideTransaction(calls)[0]).toBe('lockAccount')
  })

  it('refuses the payment when the account vanishes before the lock is taken', async () => {
    // The pre-flight found the account and the lock did not. A real store hits
    // this when the row was deleted while this caller waited for the lock.
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    db.lockAccount = async () => null

    await expect(pay(billing, 'pay_1', 2000)).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The idempotency race
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: a lost idempotency race looks like a repeated call', () => {
  // added during extraction, not from Lumo

  /** A store whose pre-flight idempotency read always misses. */
  function blindStore() {
    const db = new InMemoryLedgerStore()
    db.reset()
    db.findEventLogByKey = async () => null
    return db
  }

  it('reports IdempotencyError when the constraint catches what the read missed', async () => {
    const db = blindStore()
    const billing = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await pay(billing, 'pay_1', 1000)

    // The pre-flight check is blind, so this reaches the store, and only the
    // unique constraint stops it. The caller must not be able to tell the
    // difference between this and a plain repeat.
    await expect(pay(billing, 'pay_1', 1000)).rejects.toBeInstanceOf(IdempotencyError)
  })

  it('reports IdempotencyError on a raced cash row too', async () => {
    const db = blindStore()
    const cash = new LedgerService(db, TAXONOMY)
    const entry = {
      direction:        'OUT' as const,
      category:         'SUPPLIES',
      amount:           140,
      currency:         'USD',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    }

    await cash.addEntry({ ...entry, idempotencyKey: 'cash_1' })
    await expect(cash.addEntry({ ...entry, idempotencyKey: 'cash_1' })).rejects.toBeInstanceOf(
      IdempotencyError
    )
  })

  it('lets a recurring posting that lost the race report "nothing created"', async () => {
    // Two runs of the daily job for the same month. The constraint decides,
    // and the loser reports zero rather than failing the whole batch.
    const db = blindStore()
    const cash = new LedgerService(db, TAXONOMY, {
      clock: () => new Date('2026-06-15T12:00:00Z'),
    })

    await cash.createTemplate({
      name:             'Office rent',
      category:         'RENT',
      amount:           4200,
      currency:         'USD',
      dayOfMonth:       1,
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    const again = await cash.materializeTemplatesForMonth({
      month:          '2026-06',
      organizationId: ORG,
    })
    expect(again).toBe(0)
  })

  it('does not swallow a unique violation from any other constraint', async () => {
    const db = blindStore()
    const billing = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 5000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    db.createAllocation = async () => {
      throw new UniqueViolationError('unique constraint failed', 'some_other_uq')
    }

    const failure = pay(billing, 'pay_1', 1000)
    await expect(failure).rejects.toBeInstanceOf(UniqueViolationError)
    await expect(failure).rejects.not.toBeInstanceOf(IdempotencyError)
  })

  it('recognises the duplicate by its type, not by a constraint name', async () => {
    // The ledger never learns what the store's index is called. A store that
    // throws a generic unique violation here has not honoured the port, and
    // the contract suite catches that.
    const db = blindStore()
    const billing = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
    db.createEventLog = async () => {
      throw new DuplicateIdempotencyKeyError(ORG, 'pay_1')
    }
    await expect(pay(billing, 'pay_1', 1000)).rejects.toBeInstanceOf(IdempotencyError)
  })
})
