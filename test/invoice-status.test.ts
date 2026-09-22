/**
 * invoice-status: derived balance and status.
 *
 * Every test in this file is: added during extraction, not from Lumo.
 *
 * Lumo covers these three functions through
 * src/tests/actions/invoice-status.characterization.test.ts, which drives two
 * Next.js server actions with the ORM mocked. That file cannot travel, so the
 * behaviour it locks in is asserted here directly instead.
 */

import {
  sumAllocations,
  computeBalance,
  computeEffectiveStatus,
} from '../src'

const JAN = new Date('2026-01-15T00:00:00Z')
const FEB = new Date('2026-02-15T00:00:00Z')

describe('sumAllocations()', () => {
  it('sums the amounts', () => {
    expect(sumAllocations([{ amount: 1000 }, { amount: 250 }])).toBe(1250)
  })

  it('is zero for no allocations', () => {
    expect(sumAllocations([])).toBe(0)
  })
})

describe('computeBalance()', () => {
  it('returns what is still owed', () => {
    expect(computeBalance(10000, 4000)).toBe(6000)
  })

  it('never goes negative: an overpayment leaves a zero balance', () => {
    // The excess is credit on the account, not a negative debt.
    expect(computeBalance(10000, 12000)).toBe(0)
  })

  it('is zero when the charge is covered exactly', () => {
    expect(computeBalance(10000, 10000)).toBe(0)
  })
})

describe('computeEffectiveStatus()', () => {
  it('keeps VOID terminal even when money has landed on it', () => {
    // Money arriving on a voided charge must never un-cancel it.
    expect(computeEffectiveStatus('VOID', 10000, 10000, JAN, FEB)).toBe('VOID')
    expect(computeEffectiveStatus('VOID', 10000, 0, JAN, FEB)).toBe('VOID')
  })

  it('reads PAID when fully covered, whatever the stored status says', () => {
    expect(computeEffectiveStatus('PENDING', 10000, 10000, FEB, JAN)).toBe('PAID')
    expect(computeEffectiveStatus('OVERDUE', 10000, 10000, JAN, FEB)).toBe('PAID')
  })

  it('reads PAID on an overpayment', () => {
    expect(computeEffectiveStatus('PENDING', 10000, 12000, FEB, JAN)).toBe('PAID')
  })

  it('reads PARTIALLY_PAID when partly covered', () => {
    expect(computeEffectiveStatus('PENDING', 10000, 4000, FEB, JAN)).toBe('PARTIALLY_PAID')
  })

  it('keeps PARTIALLY_PAID ahead of OVERDUE for a part-paid charge past its date', () => {
    // Overdue answers "nobody has paid and the date has passed". Demoting a
    // part-paid charge would silently move it between views.
    expect(computeEffectiveStatus('PENDING', 10000, 4000, JAN, FEB)).toBe('PARTIALLY_PAID')
  })

  it('derives OVERDUE from the due date when nothing has been paid', () => {
    // Nothing ever writes OVERDUE to the stored column. It is computed here.
    expect(computeEffectiveStatus('PENDING', 10000, 0, JAN, FEB)).toBe('OVERDUE')
  })

  it('leaves the stored status alone when unpaid and not yet due', () => {
    expect(computeEffectiveStatus('PENDING', 10000, 0, FEB, JAN)).toBe('PENDING')
  })

  it('takes now as an argument rather than reading a clock', () => {
    // The same inputs with a different `now` give a different answer, which is
    // what makes this function testable without freezing time.
    expect(computeEffectiveStatus('PENDING', 10000, 0, JAN, JAN)).toBe('PENDING')
    expect(computeEffectiveStatus('PENDING', 10000, 0, JAN, FEB)).toBe('OVERDUE')
  })

  it('does not trust a stored PAID that the allocations contradict', () => {
    // added during extraction, not from Lumo
    //
    // The column is a cache. A row that says PAID with nothing landed on it
    // reads as what the facts say: owed, and overdue if the date has passed.
    // Until 1.1 the last line of this function returned the stored value.
    expect(computeEffectiveStatus('PAID', 10000, 0, FEB, JAN)).toBe('PENDING')
    expect(computeEffectiveStatus('PAID', 10000, 0, JAN, FEB)).toBe('OVERDUE')
    expect(computeEffectiveStatus('PARTIALLY_PAID', 10000, 0, FEB, JAN)).toBe('PENDING')
  })

  it('honours VOID and nothing else from storage', () => {
    // added during extraction, not from Lumo
    expect(computeEffectiveStatus('VOID', 10000, 10000, FEB, JAN)).toBe('VOID')
    expect(computeEffectiveStatus('OVERDUE', 10000, 10000, JAN, FEB)).toBe('PAID')
  })
})
