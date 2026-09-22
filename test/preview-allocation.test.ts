/**
 * BillingService.previewAllocation()
 *
 * Ported from Lumo's src/core/billing/BillingService.test.ts, including the
 * parity invariant that locks the preview to the committed waterfall.
 */

import {
  BillingService,
  InMemoryLedgerStore,
  ValidationError,
} from '../src'
import type { RecordPaymentParams } from '../src'
import { accountFactory, invoiceFactory } from '../src/testing/factories'
import { MANAGER, PAYMENT_CATEGORY } from './helpers'

describe('BillingService.previewAllocation()', () => {
  let db: InMemoryLedgerStore
  let service: BillingService

  beforeEach(() => {
    db = new InMemoryLedgerStore()
    db.reset()
    service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  })

  // ── Happy paths ───────────────────────────────────────────────────────────

  it('should return one step when the amount exactly covers the oldest outstanding', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_p1', amount: 6000, status: 'PENDING', month: '2026-01', createdAt: new Date('2026-01-01') })
    )

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         6000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].invoiceId).toBe('inv_p1')
    expect(result.steps[0].outstanding).toBe(6000)
    expect(result.steps[0].toAllocate).toBe(6000)
    expect(result.steps[0].newStatus).toBe('PAID')
    expect(result.totalAllocated).toBe(6000)
    expect(result.credit).toBe(0)
  })

  it('should return two steps when the amount straddles two charges', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_p_a', amount: 3000, status: 'PENDING', month: '2026-01', createdAt: new Date('2026-01-01') }),
      invoiceFactory({ id: 'inv_p_b', amount: 5000, status: 'PENDING', month: '2026-02', createdAt: new Date('2026-02-01') }),
    )

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].invoiceId).toBe('inv_p_a')
    expect(result.steps[0].toAllocate).toBe(3000)
    expect(result.steps[0].newStatus).toBe('PAID')
    expect(result.steps[1].invoiceId).toBe('inv_p_b')
    expect(result.steps[1].toAllocate).toBe(2000)
    expect(result.steps[1].newStatus).toBe('PARTIALLY_PAID')
    expect(result.totalAllocated).toBe(5000)
    expect(result.credit).toBe(0)
  })

  it('should return credit when the amount exceeds every open charge', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_pa', amount: 3000, status: 'PENDING', createdAt: new Date('2026-01-01') }),
      invoiceFactory({ id: 'inv_pb', amount: 5000, status: 'PENDING', createdAt: new Date('2026-02-01') }),
    )

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         12000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].newStatus).toBe('PAID')
    expect(result.steps[1].newStatus).toBe('PAID')
    expect(result.totalAllocated).toBe(8000)
    expect(result.credit).toBe(4000)
  })

  it('should return no steps and full credit when there are no open charges', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps).toHaveLength(0)
    expect(result.totalAllocated).toBe(0)
    expect(result.credit).toBe(5000)
  })

  it('should reflect outstanding correctly for a PARTIALLY_PAID charge', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_partial_preview', amount: 8000, status: 'PARTIALLY_PAID' })
    )
    db.seed.allocations.push({
      id:            'alloc_preview',
      amount:        2000,
      createdBy:     'operator_1',
      createdAt:     new Date(),
      transactionId: 'tx_preview',
      invoiceId:     'inv_partial_preview',
    })

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         6000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].outstanding).toBe(6000)
    expect(result.steps[0].toAllocate).toBe(6000)
    expect(result.steps[0].newStatus).toBe('PAID')
    expect(result.credit).toBe(0)
  })

  it('should include the billing period in each step', async () => {
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_month', amount: 5000, status: 'PENDING', month: '2026-03' })
    )

    const result = await service.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(result.steps[0].month).toBe('2026-03')
  })

  it('writes nothing', async () => {
    // added during extraction, not from Lumo
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
    db.seed.invoices.push(invoiceFactory({ id: 'inv_dry', amount: 5000, status: 'PENDING' }))

    await service.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    expect(db.seed.transactions).toHaveLength(0)
    expect(db.seed.allocations).toHaveLength(0)
    expect(db.seed.eventLogs).toHaveLength(0)
    expect(db.seed.invoices.find(i => i.id === 'inv_dry')?.status).toBe('PENDING')
  })

  // ── Error paths ───────────────────────────────────────────────────────────

  it('should throw ValidationError for a zero amount', async () => {
    await expect(
      service.previewAllocation({ accountId: 'acc_1', amount: 0, currency: 'USD', organizationId: 'org_1' })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError for a negative amount', async () => {
    await expect(
      service.previewAllocation({ accountId: 'acc_1', amount: -100, currency: 'USD', organizationId: 'org_1' })
    ).rejects.toThrow(ValidationError)
  })

  it('should throw ValidationError for a non-integer amount', async () => {
    await expect(
      service.previewAllocation({ accountId: 'acc_1', amount: 49.99, currency: 'USD', organizationId: 'org_1' })
    ).rejects.toThrow(ValidationError)
  })

  // ── Parity invariant ──────────────────────────────────────────────────────

  it('parity: preview steps match the allocations recordPayment commits', async () => {
    // This locks previewAllocation and recordPayment together. If the waterfall
    // in recordPayment changes, this fails unless the preview changes
    // identically, which is what stops the two drifting apart in silence.

    const setupSeed = (store: InMemoryLedgerStore) => {
      store.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_1' }))
      store.seed.invoices.push(
        invoiceFactory({ id: 'parity_inv_a', amount: 4000, status: 'PENDING',        createdAt: new Date('2026-01-01'), month: '2026-01' }),
        invoiceFactory({ id: 'parity_inv_b', amount: 6000, status: 'PARTIALLY_PAID', createdAt: new Date('2026-02-01'), month: '2026-02' }),
        invoiceFactory({ id: 'parity_inv_c', amount: 8000, status: 'OVERDUE',        createdAt: new Date('2026-03-01'), month: '2026-03' }),
      )
      // parity_inv_b has 2000 already allocated, so outstanding is 4000.
      store.seed.allocations.push({
        id:            'parity_prior',
        amount:        2000,
        createdBy:     'operator_1',
        createdAt:     new Date(),
        transactionId: 'tx_prior',
        invoiceId:     'parity_inv_b',
      })
    }

    // ── Preview on a fresh store ────────────────────────────────────────────
    const previewDb = new InMemoryLedgerStore()
    previewDb.reset()
    const previewService = new BillingService(previewDb, { paymentCategory: PAYMENT_CATEGORY })
    setupSeed(previewDb)

    const preview = await previewService.previewAllocation({
      accountId:      'acc_1',
      amount:         11000,
      currency: 'USD',
      organizationId: 'org_1',
    })

    // ── Commit on a separate store with an identical seed ───────────────────
    const commitDb = new InMemoryLedgerStore()
    commitDb.reset()
    const commitService = new BillingService(commitDb, { paymentCategory: PAYMENT_CATEGORY })
    setupSeed(commitDb)

    const recordParams: RecordPaymentParams = {
      idempotencyKey:   'parity_pay',
      accountId:        'acc_1',
      payerId:          'payer_1',
      amount:           11000,
      currency:         'USD',
      paymentMethod:    'CASH',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   'org_1',
    }
    const commitResult = await commitService.recordPayment(recordParams)

    // ── Assert parity ────────────────────────────────────────────────────────
    // Join by (invoiceId, amount): parity_inv_b already carries a seeded
    // allocation, and the one we want is the row whose amount equals
    // step.toAllocate.
    for (const step of preview.steps) {
      const committed = commitDb.seed.allocations.find(
        a => a.invoiceId === step.invoiceId && a.amount === step.toAllocate
      )
      expect(committed).toBeDefined()
    }

    expect(preview.totalAllocated).toBe(commitResult.allocated)
    expect(preview.credit).toBe(commitResult.credit)
  })
})
