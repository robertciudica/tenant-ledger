/**
 * BillingService.recordPaymentForInvoice()
 *
 * Ported from Lumo's src/core/billing/BillingService.test.ts. Two tests in the
 * original are dropped with the feature they cover: they asserted that paying
 * does not advance a subscription cycle, and subscriptions are not part of the
 * ledger.
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
import { MANAGER, READER, PAYMENT_CATEGORY } from './helpers'

const targetedBaseParams = {
  currency:         'USD',
  paymentMethod:    'CASH',
  payerId:          'payer_1',
  actorId:          'operator_1',
  actorPermissions: MANAGER,
  organizationId:   'org_1',
} as const

describe('BillingService.recordPaymentForInvoice()', () => {
  let db: InMemoryLedgerStore
  let service: BillingService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
  })

  // ── Happy paths ───────────────────────────────────────────────────────────

  it('should pay a full-balance charge and flip its status to PAID', async () => {
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_target', amount: 8000, status: 'PENDING' })
    )

    const result = await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_1',
      invoiceId:      'inv_target',
      amount:         8000,
    })

    expect(result.allocated).toBe(8000)
    expect(result.credit).toBe(0)
    expect(db.seed.transactions).toHaveLength(1)
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_target')
    expect(db.seed.allocations[0].amount).toBe(8000)
    expect(db.seed.invoices.find(i => i.id === 'inv_target')?.status).toBe('PAID')
    expect(db.seed.eventLogs).toHaveLength(1)
    expect(db.seed.eventLogs[0].type).toBe('TRANSACTION_RECORDED')
  })

  it('should write targeted:true into the event payload', async () => {
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_tgt', amount: 5000, status: 'PENDING' })
    )

    await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_targeted_flag',
      invoiceId:      'inv_tgt',
      amount:         5000,
    })

    // The flag supports auditing without joining back through allocations.
    const log = db.seed.eventLogs[0]
    expect((log.payload as Record<string, unknown>).targeted).toBe(true)
    expect((log.payload as Record<string, unknown>).invoiceId).toBe('inv_tgt')
  })

  it('should partially pay a charge and flip its status to PARTIALLY_PAID', async () => {
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_partial_tgt', amount: 10000, status: 'PENDING' })
    )

    const result = await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_partial',
      invoiceId:      'inv_partial_tgt',
      amount:         4000,
    })

    expect(result.allocated).toBe(4000)
    expect(result.credit).toBe(0)
    expect(db.seed.invoices.find(i => i.id === 'inv_partial_tgt')?.status).toBe('PARTIALLY_PAID')
    expect(db.seed.allocations[0].amount).toBe(4000)
  })

  it('should flip a PARTIALLY_PAID charge to PAID when the rest is covered exactly', async () => {
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_finishing', amount: 8000, status: 'PARTIALLY_PAID' })
    )
    // A prior partial payment, seeded directly.
    db.seed.allocations.push({
      id:            'alloc_prior',
      amount:        3000,
      createdBy:     'operator_1',
      createdAt:     new Date(),
      transactionId: 'tx_prior',
      invoiceId:     'inv_finishing',
    })

    // Pay the exact remaining outstanding: 8000 - 3000 = 5000
    await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_finish',
      invoiceId:      'inv_finishing',
      amount:         5000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_finishing')?.status).toBe('PAID')
    expect(db.seed.allocations).toHaveLength(2)
    expect(
      db.seed.allocations.find(a => a.invoiceId === 'inv_finishing' && a.amount === 5000)
    ).toBeDefined()
  })

  it('should return the id of the created payment', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_id_chk', amount: 3000, status: 'PENDING' }))

    const result = await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_id',
      invoiceId:      'inv_id_chk',
      amount:         3000,
    })

    expect(result.transactionId).toBe(db.seed.transactions[0].id)
    expect(typeof result.transactionId).toBe('string')
  })

  it('should NOT touch any other charge on the same account', async () => {
    const oldDate = new Date('2026-01-01T00:00:00Z')
    const midDate = new Date('2026-02-01T00:00:00Z')
    const newDate = new Date('2026-03-01T00:00:00Z')
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_jan', amount: 5000, status: 'PENDING', createdAt: oldDate, month: '2026-01' }),
      invoiceFactory({ id: 'inv_feb', amount: 5000, status: 'PENDING', createdAt: midDate, month: '2026-02' }),
      invoiceFactory({ id: 'inv_mar', amount: 5000, status: 'PENDING', createdAt: newDate, month: '2026-03' }),
    )

    await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_pay_feb_only',
      invoiceId:      'inv_feb',
      amount:         5000,
    })

    expect(db.seed.invoices.find(i => i.id === 'inv_jan')?.status).toBe('PENDING')
    expect(db.seed.invoices.find(i => i.id === 'inv_feb')?.status).toBe('PAID')
    expect(db.seed.invoices.find(i => i.id === 'inv_mar')?.status).toBe('PENDING')
    expect(db.seed.allocations).toHaveLength(1)
    expect(db.seed.allocations[0].invoiceId).toBe('inv_feb')
  })

  it('takes the account from the charge, not from the caller', async () => {
    // added during extraction, not from Lumo
    db.seed.accounts.push(accountFactory({ id: 'acc_other', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_owned', amount: 4000, status: 'PENDING', accountId: 'acc_other' })
    )

    await service.recordPaymentForInvoice({
      ...targetedBaseParams,
      idempotencyKey: 'target_account_from_invoice',
      invoiceId:      'inv_owned',
      amount:         4000,
    })

    expect(db.seed.transactions[0].accountId).toBe('acc_other')
  })

  // ── Error paths ───────────────────────────────────────────────────────────

  it('should throw ValidationError when the amount exceeds outstanding', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_cap', amount: 5000, status: 'PARTIALLY_PAID' }))
    db.seed.allocations.push({
      id:            'alloc_cap',
      amount:        2000,
      createdBy:     'operator_1',
      createdAt:     new Date(),
      transactionId: 'tx_cap',
      invoiceId:     'inv_cap',
    })

    // 4000 against 3000 outstanding
    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_cap_test',
        invoiceId:      'inv_cap',
        amount:         4000,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('ValidationError for overpayment should reference the amount field', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_cap2', amount: 3000, status: 'PENDING' }))

    let caught: unknown
    try {
      await service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_cap_field',
        invoiceId:      'inv_cap2',
        amount:         9999,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as ValidationError).field).toBe('amount')
  })

  it('should throw ValidationError when paying a charge its allocations already cover', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_paid_tgt', amount: 5000, status: 'PAID' }))
    db.seed.transactions.push(transactionFactory({ id: 'txn_prior', amount: 5000 }))
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_prior', amount: 5000, transactionId: 'txn_prior', invoiceId: 'inv_paid_tgt' })
    )

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_pay_paid_inv',
        invoiceId:      'inv_paid_tgt',
        amount:         5000,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError when paying a VOID charge', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_void_tgt', amount: 5000, status: 'VOID' }))

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_pay_void_inv',
        invoiceId:      'inv_void_tgt',
        amount:         5000,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError for a non-integer amount', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_float', amount: 5000, status: 'PENDING' }))

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_float',
        invoiceId:      'inv_float',
        amount:         49.99,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError for a zero amount', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_zero', amount: 5000, status: 'PENDING' }))

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_zero',
        invoiceId:      'inv_zero',
        amount:         0,
      })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw IdempotencyError on a duplicate idempotency key', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_idem', amount: 5000, status: 'PENDING' }))
    db.seed.eventLogs.push(
      eventLogFactory({ idempotencyKey: 'dup_targeted_key', organizationId: 'org_1' })
    )

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'dup_targeted_key',
        invoiceId:      'inv_idem',
        amount:         5000,
      })
    ).rejects.toThrow(IdempotencyError)
  })

  it('should throw NotFoundError when the charge does not exist', async () => {
    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_notfound',
        invoiceId:      'ghost_invoice',
        amount:         5000,
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('should throw NotFoundError for a charge in another tenant', async () => {
    // added during extraction, not from Lumo
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_other_org', amount: 5000, status: 'PENDING', organizationId: 'org_2' })
    )

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey: 'target_cross_tenant',
        invoiceId:      'inv_other_org',
        amount:         5000,
      })
    ).rejects.toThrow(NotFoundError)
  })

  it('should throw ForbiddenError without RECORD_PAYMENT', async () => {
    db.seed.invoices.push(invoiceFactory({ id: 'inv_forbidden', amount: 5000, status: 'PENDING' }))

    await expect(
      service.recordPaymentForInvoice({
        ...targetedBaseParams,
        idempotencyKey:   'target_forbidden',
        invoiceId:        'inv_forbidden',
        amount:           5000,
        actorPermissions: READER,
      })
    ).rejects.toThrow(ForbiddenError)
  })
})
