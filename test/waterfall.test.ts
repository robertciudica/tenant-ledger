/**
 * The waterfall planner, on its own.
 *
 * Every test in this file is: added during extraction, not from Lumo.
 *
 * `recordPayment` commits this plan and `previewAllocation` displays it, so
 * these cases hold for both by construction. The parity test in
 * `preview-allocation.test.ts` remains as a guard against the two paths
 * drifting apart again.
 */

import {
  planWaterfall,
  selectOpenInvoices,
  sumAllocationsByInvoice,
  money,
  isMoney,
  ValidationError,
} from '../src'
import type { Invoice, OpenCharge } from '../src'
import { invoiceFactory } from '../src/testing/factories'

const charge = (
  id: string,
  amount: number,
  priorAllocated = 0,
  overrides: Partial<Invoice> = {}
): OpenCharge => ({
  invoice: invoiceFactory({ id, amount, ...overrides }),
  priorAllocated,
})

describe('planWaterfall', () => {
  it('plans nothing when there are no open charges', () => {
    const plan = planWaterfall([], 7000)
    expect(plan.steps).toEqual([])
    expect(plan.allocated).toBe(0)
    expect(plan.credit).toBe(7000)
  })

  it('covers the oldest charge in full before touching the next', () => {
    const plan = planWaterfall([charge('a', 5000), charge('b', 5000, 2000)], 7000)

    expect(plan.steps).toEqual([
      { invoiceId: 'a', month: '2026-02', outstanding: 5000, toAllocate: 5000, newStatus: 'PAID' },
      { invoiceId: 'b', month: '2026-02', outstanding: 3000, toAllocate: 2000, newStatus: 'PARTIALLY_PAID' },
    ])
    expect(plan.allocated).toBe(7000)
    expect(plan.credit).toBe(0)
  })

  it('leaves the remainder as credit when the charges run out', () => {
    const plan = planWaterfall([charge('a', 1000)], 2500)
    expect(plan.allocated).toBe(1000)
    expect(plan.credit).toBe(1500)
  })

  it('stops as soon as the money is spent', () => {
    const plan = planWaterfall([charge('a', 1000), charge('b', 1000)], 1000)
    expect(plan.steps.map(s => s.invoiceId)).toEqual(['a'])
  })

  it('skips a charge that is already covered but still carries an open status', () => {
    // The status column is a projection and is allowed to lag. The allocations
    // are the truth, and they say this charge owes nothing.
    const plan = planWaterfall([charge('stale', 5000, 5000), charge('real', 1000)], 1000)
    expect(plan.steps.map(s => s.invoiceId)).toEqual(['real'])
    expect(plan.credit).toBe(0)
  })

  it('always balances: allocated plus credit is the amount received', () => {
    for (const amount of [1, 999, 5000, 12345, 1_000_000]) {
      const plan = planWaterfall([charge('a', 5000), charge('b', 3000, 1000)], amount)
      expect(plan.allocated + plan.credit).toBe(amount)
    }
  })

  it('never allocates more to a charge than it has outstanding', () => {
    const plan = planWaterfall([charge('a', 5000, 4900)], 1_000_000)
    expect(plan.steps[0].toAllocate).toBe(100)
  })
})

describe('selectOpenInvoices', () => {
  const at = (iso: string) => new Date(iso)

  it('keeps every charge except a voided one; the planner decides what is owed', () => {
    // The stored status is not trusted here. A charge whose column says PAID
    // is still a candidate; the planner skips it only if its allocations
    // cover it. VOID is the one stored state that is honoured.
    const invoices = [
      invoiceFactory({ id: 'pending', status: 'PENDING' }),
      invoiceFactory({ id: 'partial', status: 'PARTIALLY_PAID' }),
      invoiceFactory({ id: 'overdue', status: 'OVERDUE' }),
      invoiceFactory({ id: 'paid', status: 'PAID' }),
      invoiceFactory({ id: 'void', status: 'VOID' }),
    ]
    expect(selectOpenInvoices(invoices).map(i => i.id)).toEqual([
      'pending',
      'partial',
      'overdue',
      'paid',
    ])
  })

  it('orders oldest first, whatever order the store returned them in', () => {
    const invoices = [
      invoiceFactory({ id: 'march',   createdAt: at('2026-03-01T00:00:00Z') }),
      invoiceFactory({ id: 'january', createdAt: at('2026-01-01T00:00:00Z') }),
      invoiceFactory({ id: 'february',createdAt: at('2026-02-01T00:00:00Z') }),
    ]
    expect(selectOpenInvoices(invoices).map(i => i.id)).toEqual([
      'january',
      'february',
      'march',
    ])
  })

  it('does not mutate the array it was given', () => {
    const invoices = [
      invoiceFactory({ id: 'b', createdAt: at('2026-03-01T00:00:00Z') }),
      invoiceFactory({ id: 'a', createdAt: at('2026-01-01T00:00:00Z') }),
    ]
    selectOpenInvoices(invoices)
    expect(invoices.map(i => i.id)).toEqual(['b', 'a'])
  })
})

describe('sumAllocationsByInvoice', () => {
  it('adds up every allocation per charge', () => {
    const byInvoice = sumAllocationsByInvoice([
      { invoiceId: 'a', amount: 1000 },
      { invoiceId: 'a', amount: 250 },
      { invoiceId: 'b', amount: 400 },
    ])
    expect(byInvoice.get('a')).toBe(1250)
    expect(byInvoice.get('b')).toBe(400)
    expect(byInvoice.get('missing')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The money constructor
// ─────────────────────────────────────────────────────────────────────────────

describe('money', () => {
  // added during extraction, not from Lumo

  it('returns the amount it was given', () => {
    expect(money(4250)).toBe(4250)
  })

  it('rejects a decimal, naming the field', () => {
    expect(() => money(42.5, 'total')).toThrow(ValidationError)
    try {
      money(42.5, 'total')
    } catch (error) {
      expect((error as ValidationError).field).toBe('total')
    }
  })

  it('rejects zero, a negative, and the things a spreadsheet produces', () => {
    for (const bad of [0, -100, NaN, Infinity]) {
      expect(() => money(bad)).toThrow(ValidationError)
    }
  })

  it('isMoney answers the same question without throwing', () => {
    expect(isMoney(4250)).toBe(true)
    expect(isMoney(42.5)).toBe(false)
    expect(isMoney(0)).toBe(false)
    expect(isMoney('4250')).toBe(false)
  })
})
