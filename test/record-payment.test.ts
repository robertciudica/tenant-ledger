/**
 * BillingService.recordPayment()
 *
 * Ported from Lumo's src/core/billing/BillingService.test.ts. Runs against
 * InMemoryLedgerStore, so there is no database.
 *
 * Notes carried over from the original:
 * - Invoice.status is PENDING | PARTIALLY_PAID | PAID | OVERDUE | VOID.
 *   The waterfall allocates to PENDING, PARTIALLY_PAID and OVERDUE.
 * - Event rows use the `type` field.
 * - The waterfall sorts by `createdAt` ascending (oldest first).
 */

import {
  BillingService,
  InMemoryLedgerStore,
  NotFoundError,
  ValidationError,
  IdempotencyError,
  ForbiddenError,
} from '../src'
import {
  accountFactory,
  invoiceFactory,
  eventLogFactory,
  transactionFactory,
  allocationFactory,
} from '../src/testing/factories'
import { MANAGER, OPERATOR, READER, PAYMENT_CATEGORY } from './helpers'

// ─────────────────────────────────────────────────────────────────────────────
// Base params: always valid unless overridden
// ─────────────────────────────────────────────────────────────────────────────

const baseParams = {
  currency:         'USD',
  paymentMethod:    'CASH',
  payerId:          'payer_1',
  actorId:          'operator_1',
  actorPermissions: MANAGER,
  organizationId:   'org_1',
} as const

describe('BillingService.recordPayment()', () => {
  let db: InMemoryLedgerStore
  let service: BillingService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  })

  // ── Happy paths ───────────────────────────────────────────────────────────

  it('should create a payment and allocate fully to a single PENDING charge', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(invoiceFactory({ id: 'inv_1', amount: 10000, status: 'PENDING' }))

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_1',
      accountId:      'acc_1',
      amount:         10000,
    })

    expect(result.allocated).toBe(10000)
    expect(result.credit).toBe(0)
    expect(db.seed.transactions).toHaveLength(1)
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_1')
    expect(db.seed.allocations[0].amount).toBe(10000)
    expect(db.seed.eventLogs).toHaveLength(1)
    expect(db.seed.eventLogs[0].type).toBe('TRANSACTION_RECORDED')
  })

  it('should allocate across multiple charges oldest-first (waterfall)', async () => {
    const olderDate = new Date('2026-01-01T00:00:00Z')
    const newerDate = new Date('2026-02-01T00:00:00Z')
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_old', amount: 6000, createdAt: olderDate, status: 'PENDING' }),
      invoiceFactory({ id: 'inv_new', amount: 6000, createdAt: newerDate, status: 'PENDING' }),
    )

    // 8000 covers the old charge (6000) in full plus 2000 of the newer one.
    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_2',
      accountId:      'acc_1',
      amount:         8000,
    })

    expect(result.allocated).toBe(8000)
    expect(result.credit).toBe(0)

    const oldAlloc = db.seed.allocations.find(a => a.invoiceId === 'inv_old')
    const newAlloc = db.seed.allocations.find(a => a.invoiceId === 'inv_new')
    expect(oldAlloc?.amount).toBe(6000)
    expect(newAlloc?.amount).toBe(2000)
  })

  it('should record overpayment as unallocated credit', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(invoiceFactory({ amount: 5000, status: 'PENDING' }))

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_3',
      accountId:      'acc_1',
      amount:         8000,
      paymentMethod:  'BANK_TRANSFER',
    })

    expect(result.allocated).toBe(5000)
    expect(result.credit).toBe(3000)
    expect(result.allocated + result.credit).toBe(8000) // invariant
  })

  it('should record a payment with no open charges as full credit', async () => {
    db.seed.accounts.push(accountFactory())

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey:   'pay_4',
      accountId:        'acc_1',
      amount:           5000,
      actorPermissions: OPERATOR, // taking money in is enough
    })

    expect(result.credit).toBe(5000)
    expect(result.allocated).toBe(0)
    expect(db.seed.allocations).toHaveLength(0)
    expect(db.seed.transactions).toHaveLength(1)
  })

  it('should also allocate to PARTIALLY_PAID charges', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_partial', amount: 8000, status: 'PARTIALLY_PAID' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_partial',
      accountId:      'acc_1',
      amount:         4000,
    })

    expect(result.allocated).toBe(4000)
    expect(result.credit).toBe(0)
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_partial')
  })

  it('should write the correct payment fields to the store', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(invoiceFactory({ amount: 5000, status: 'PENDING', currency: 'UAH' }))

    await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_fields',
      accountId:      'acc_1',
      amount:         5000,
      currency:       'UAH',
      notes:          'Taken at the counter',
    })

    const txn = db.seed.transactions[0]
    expect(txn.amount).toBe(5000)
    expect(txn.currency).toBe('UAH')
    expect(txn.paymentMethod).toBe('CASH')
    expect(txn.recordedBy).toBe('operator_1')
    expect(txn.payerId).toBe('payer_1')
    expect(txn.accountId).toBe('acc_1')
    expect(txn.organizationId).toBe('org_1')
    expect(txn.idempotencyKey).toBe('pay_fields')
    expect(txn.notes).toBe('Taken at the counter')
  })

  it('should return the id of the created payment', async () => {
    db.seed.accounts.push(accountFactory())

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_id_check',
      accountId:      'acc_1',
      amount:         3000,
    })

    expect(result.transactionId).toBe(db.seed.transactions[0].id)
    expect(typeof result.transactionId).toBe('string')
    expect(result.transactionId.length).toBeGreaterThan(0)
  })

  // ── Error paths ───────────────────────────────────────────────────────────

  it('should throw NotFoundError if the account does not exist', async () => {
    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_5',
        accountId:      'nonexistent',
        amount:         5000,
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('NotFoundError message should contain the missing account id', async () => {
    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_5b',
        accountId:      'ghost_account',
        amount:         5000,
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('ghost_account'),
    })
  })

  it('should throw ValidationError if amount is zero', async () => {
    db.seed.accounts.push(accountFactory())

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_6',
        accountId:      'acc_1',
        amount:         0,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError if amount is negative', async () => {
    db.seed.accounts.push(accountFactory())

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_7',
        accountId:      'acc_1',
        amount:         -100,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('ValidationError for an invalid amount should target the amount field', async () => {
    db.seed.accounts.push(accountFactory())

    let caught: unknown
    try {
      await service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_7b',
        accountId:      'acc_1',
        amount:         -1,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as ValidationError).field).toBe('amount')
  })

  it('should throw ValidationError if amount is a non-integer', async () => {
    db.seed.accounts.push(accountFactory())

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'pay_float',
        accountId:      'acc_1',
        amount:         99.99,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw IdempotencyError on a duplicate idempotency key', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.eventLogs.push(
      eventLogFactory({ idempotencyKey: 'dup_key', organizationId: 'org_1' })
    )

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'dup_key',
        accountId:      'acc_1',
        amount:         5000,
      })
    ).rejects.toThrow(IdempotencyError)
  })

  it('IdempotencyError should carry code ALREADY_PROCESSED and the key', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.eventLogs.push(
      eventLogFactory({ idempotencyKey: 'exactly_this_key', organizationId: 'org_1' })
    )

    let caught: unknown
    try {
      await service.recordPayment({
        ...baseParams,
        idempotencyKey: 'exactly_this_key',
        accountId:      'acc_1',
        amount:         5000,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(IdempotencyError)
    expect((caught as IdempotencyError).code).toBe('ALREADY_PROCESSED')
    expect((caught as IdempotencyError).message).toContain('exactly_this_key')
  })

  it('should throw ForbiddenError without RECORD_PAYMENT', async () => {
    db.seed.accounts.push(accountFactory())

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey:   'pay_8',
        accountId:        'acc_1',
        amount:           5000,
        actorPermissions: READER,
      })
    ).rejects.toThrow(ForbiddenError)
  })

  it('should throw ForbiddenError when only cash-ledger permissions are held', async () => {
    // added during extraction, not from Lumo
    db.seed.accounts.push(accountFactory())

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey:   'pay_cashbook_only',
        accountId:        'acc_1',
        amount:           5000,
        actorPermissions: ['ADD_CASHBOOK', 'MANAGE_CASHBOOK'],
      })
    ).rejects.toThrow(ForbiddenError)
  })

  it('should NOT allocate to a charge its allocations already cover', async () => {
    // "Paid" is decided by the allocations, not by the status column. This
    // charge is covered in fact, so the waterfall skips it.
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({
        id:        'inv_paid',
        amount:    5000,
        status:    'PAID',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      invoiceFactory({
        id:        'inv_open',
        amount:    5000,
        status:    'PENDING',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
    )
    db.seed.transactions.push(transactionFactory({ id: 'txn_prior', amount: 5000 }))
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_prior', amount: 5000, transactionId: 'txn_prior', invoiceId: 'inv_paid' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_9',
      accountId:      'acc_1',
      amount:         5000,
    })

    expect(db.seed.allocations.filter(a => a.transactionId !== 'txn_prior')).toHaveLength(1)
    expect(db.seed.allocations.find(a => a.transactionId !== 'txn_prior')?.invoiceId).toBe('inv_open')
    expect(result.allocated).toBe(5000)
    expect(result.credit).toBe(0)
  })

  it('allocates to a charge whose column says PAID but which has nothing landed on it', async () => {
    // added during extraction, not from Lumo
    //
    // A stale status column is exactly the drift the derived reads exist to
    // survive. Until 1.1 the waterfall trusted the column here, so a charge
    // marked PAID by mistake could never be paid at all.
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_stale', amount: 5000, status: 'PAID' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_stale',
      accountId:      'acc_1',
      amount:         5000,
    })

    expect(result.allocated).toBe(5000)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_stale')
  })

  it('should NOT allocate to VOID charges', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_void', amount: 5000, status: 'VOID' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_void',
      accountId:      'acc_1',
      amount:         3000,
    })

    expect(db.seed.allocations).toHaveLength(0)
    expect(result.allocated).toBe(0)
    expect(result.credit).toBe(3000)
  })

  it('should allocate to OVERDUE charges: overdue money is still owed', async () => {
    // Excluding OVERDUE would record the payment as credit while leaving the
    // overdue charge outstanding, which only shows up at reconciliation time.
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_overdue', amount: 5000, status: 'OVERDUE' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_overdue',
      accountId:      'acc_1',
      amount:         3000,
    })

    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_overdue')
    expect(db.seed.allocations[0].amount).toBe(3000)
    expect(result.allocated).toBe(3000)
    expect(result.credit).toBe(0)
  })

  // ── Status projection ─────────────────────────────────────────────────────

  it('should update status to PAID when fully allocated', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_full', amount: 10000, status: 'PENDING' })
    )

    await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_status_paid',
      accountId:      'acc_1',
      amount:         10000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_full')?.status).toBe('PAID')
  })

  it('should update status to PARTIALLY_PAID when partially allocated', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_part', amount: 10000, status: 'PENDING' })
    )

    await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_status_partial',
      accountId:      'acc_1',
      amount:         6000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_part')?.status).toBe('PARTIALLY_PAID')
  })

  it('should update an OVERDUE charge to PAID when fully covered', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_od', amount: 5000, status: 'OVERDUE' })
    )

    await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_overdue_full',
      accountId:      'acc_1',
      amount:         5000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_od')?.status).toBe('PAID')
  })

  it('should update multiple statuses across the waterfall', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_a', amount: 3000, status: 'PENDING', createdAt: new Date('2026-01-01') }),
      invoiceFactory({ id: 'inv_b', amount: 5000, status: 'OVERDUE', createdAt: new Date('2026-02-01') }),
    )

    // 5000 covers inv_a (3000) in full and 2000 of inv_b.
    await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_multi_status',
      accountId:      'acc_1',
      amount:         5000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_a')?.status).toBe('PAID')
    expect(db.seed.invoices.find(i => i.id === 'inv_b')?.status).toBe('PARTIALLY_PAID')
  })

  // ── Invariants ────────────────────────────────────────────────────────────

  it('allocated + credit must always equal the payment amount', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'i1', amount: 3000, status: 'PENDING', createdAt: new Date('2026-01-01') }),
      invoiceFactory({ id: 'i2', amount: 3000, status: 'PENDING', createdAt: new Date('2026-02-01') }),
    )

    const amount = 8500
    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'invariant_test',
      accountId:      'acc_1',
      amount,
    })

    expect(result.allocated + result.credit).toBe(amount)
    expect(result.allocated).toBe(6000)
    expect(result.credit).toBe(2500)
  })

  it('the invariant holds for an exact payment (no credit)', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_exact', amount: 7500, status: 'PENDING' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'exact_pay',
      accountId:      'acc_1',
      amount:         7500,
    })

    expect(result.allocated + result.credit).toBe(7500)
    expect(result.credit).toBe(0)
    expect(result.allocated).toBe(7500)
  })

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it('should not allocate across tenants: an org_2 account is invisible under org_1', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_2', organizationId: 'org_2' }))

    await expect(
      service.recordPayment({
        ...baseParams,
        idempotencyKey: 'cross_tenant_test',
        accountId:      'acc_2',
        amount:         5000,
        organizationId: 'org_1', // wrong tenant
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('should not reuse an idempotency key from a different tenant', async () => {
    // The key exists under org_2. Under org_1 it must be invisible, so the
    // payment goes through.
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.eventLogs.push(
      eventLogFactory({ idempotencyKey: 'shared_key', organizationId: 'org_2' })
    )

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'shared_key',
      accountId:      'acc_1',
      amount:         3000,
      organizationId: 'org_1',
    })

    expect(result.transactionId).toBeDefined()
    expect(db.seed.transactions).toHaveLength(1)
  })

  // ── The bridge to the cash ledger ─────────────────────────────────────────

  it('writes one cash-ledger IN row for the full amount received', async () => {
    db.seed.accounts.push(accountFactory())
    db.seed.invoices.push(invoiceFactory({ id: 'inv_1', amount: 32000, status: 'PENDING' }))

    const result = await service.recordPayment({
      ...baseParams,
      idempotencyKey: 'pay_cash_row',
      accountId:      'acc_1',
      amount:         50000, // more than owed, 18000 becomes credit
    })

    expect(db.seed.ledgerEntries).toHaveLength(1)
    const row = db.seed.ledgerEntries[0]
    expect(row.source).toBe('PAYMENT')
    expect(row.direction).toBe('IN')
    expect(row.category).toBe(PAYMENT_CATEGORY)
    // The full amount received (50000), not just the allocated 32000.
    expect(row.amount).toBe(50000)
    expect(row.transactionId).toBe(result.transactionId)
    expect(result.allocated).toBe(32000)
    expect(result.credit).toBe(18000)
  })
})
