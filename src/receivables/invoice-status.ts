/**
 * Invoice status and balance: the single definition.
 *
 * In Lumo this function was written out twice, private in two places, and the
 * balance sum was open-coded in nine more files. That is how four screens came
 * to disagree about the same invoice. Anything that needs to know what a charge
 * is worth, or what state it is in, imports from here.
 *
 * Pure by construction: no storage, no I/O, no clock. Callers pass what they
 * already loaded.
 */

import type { InvoiceStatus } from '../store'
import { sumMoney } from '../money'

/** Anything with an `amount` in minor units. Allocation rows, in practice. */
export interface HasAmount {
  amount: number
}

/**
 * Total money that has landed on a charge, in minor units.
 *
 * Allocations are the truth about what has been paid; `Invoice.status` is a
 * projection that can lag behind them.
 */
export function sumAllocations(allocations: readonly HasAmount[]): number {
  return sumMoney(allocations.map(a => a.amount))
}

/**
 * What is still owed, in minor units. Never negative: an overpayment leaves a
 * zero balance, and the excess is credit on the account, not a negative debt.
 */
export function computeBalance(amount: number, paidAmount: number): number {
  return Math.max(0, amount - paidAmount)
}

/**
 * The status to show a human, derived from the money facts. The stored
 * column is consulted for exactly one thing: VOID.
 *
 * Order matters:
 *   1. VOID is terminal. It is the one state a person sets and the facts
 *      cannot undo: money landing on a voided charge never resurrects it.
 *   2. Fully covered, overpayment included, is PAID.
 *   3. Partially covered is PARTIALLY_PAID.
 *   4. Nothing landed and the due date has passed is OVERDUE.
 *   5. Otherwise PENDING.
 *
 * Nothing else about the stored status is trusted. As extracted, the last step
 * returned the stored value, which meant a stale PAID on a charge with no
 * allocations still read as PAID: the drift this function exists to end,
 * preserved in its final line. A row that says PAID and has nothing landed
 * on it now reads as what it is.
 *
 * `now` is a parameter rather than a `new Date()` call so this stays pure and
 * testable. The ledger takes no clock.
 *
 * PARTIALLY_PAID keeps precedence over OVERDUE: a part-paid charge already
 * surfaces in its own filter, and demoting it to OVERDUE would silently move
 * rows between views. Overdue answers "nobody has paid and the date has passed".
 */
export function computeEffectiveStatus(
  dbStatus: InvoiceStatus,
  amount: number,
  paidAmount: number,
  dueDate: Date,
  now: Date,
): InvoiceStatus {
  if (dbStatus === 'VOID') return 'VOID'
  const balance = computeBalance(amount, paidAmount)
  if (balance <= 0) return 'PAID'
  if (paidAmount > 0) return 'PARTIALLY_PAID'
  if (dueDate.getTime() < now.getTime()) return 'OVERDUE'
  return 'PENDING'
}
