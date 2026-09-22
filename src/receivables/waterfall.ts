/**
 * The waterfall, as a pure function.
 *
 * `recordPayment` commits it and `previewAllocation` shows it. Both call this
 * one planner, so they cannot drift: the parity test in
 * `test/preview-allocation.test.ts` is a regression guard, not the only thing
 * holding them together.
 *
 * No storage, no clock. The caller loads the open charges and what has already
 * landed on each, and gets back exactly what a payment of `amount` would do.
 */

import type { Invoice, InvoiceStatus } from '../store'
import type { Money } from '../money'
import { sumMoney } from '../money'

/** One charge the waterfall may land on, with what has already been paid. */
export interface OpenCharge {
  readonly invoice: Invoice
  /** Sum of existing allocations on this charge, in minor units. */
  readonly priorAllocated: Money
}

/** One step of the plan: how much lands on which charge, and what it becomes. */
export interface AllocationStep {
  invoiceId: string
  month: string | null
  /** Outstanding balance before this step's allocation. */
  outstanding: Money
  /** Amount to allocate in this step. */
  toAllocate: Money
  /** Projected status after this step. */
  newStatus: InvoiceStatus
}

export interface WaterfallPlan {
  steps: AllocationStep[]
  /** Total matched to charges. */
  allocated: Money
  /** Unallocated remainder. Invariant: allocated + credit === amount. */
  credit: Money
}

/**
 * The charges a payment may land on, oldest first.
 *
 * Every charge that is not VOID is a candidate. Whether it is still owed is
 * decided by the planner from its allocations, not by the stored status:
 * a charge whose column says PAID but which has nothing landed on it is
 * owed, and a charge whose column lags behind its allocations is not. VOID
 * is the one stored state that is honoured, because it is the one state the
 * facts cannot derive: a person cancelled the charge.
 *
 * Sorted ascending by createdAt: the most overdue debt first, the standard
 * accounting waterfall. Does not mutate its input.
 */
export function selectOpenInvoices(invoices: readonly Invoice[]): Invoice[] {
  return invoices
    .filter(inv => inv.status !== 'VOID')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * Plans where `amount` lands across `open`, in the order given.
 *
 *   remaining = amount
 *   for each charge (in order):
 *     outstanding = charge.amount - priorAllocated
 *     toAllocate  = min(remaining, outstanding)
 *     remaining  -= toAllocate
 *     if remaining == 0: stop
 *   credit = remaining
 *
 * A charge whose outstanding is already zero (a stale status on a fully
 * covered charge) is skipped rather than allocated to.
 *
 * Integers throughout: no floating-point arithmetic. The caller validates
 * `amount`; this function trusts it.
 */
export function planWaterfall(open: readonly OpenCharge[], amount: Money): WaterfallPlan {
  let remaining: Money = amount
  const steps: AllocationStep[] = []

  for (const { invoice, priorAllocated } of open) {
    if (remaining <= 0) break

    const outstanding: Money = invoice.amount - priorAllocated
    if (outstanding <= 0) continue

    const toAllocate: Money = Math.min(remaining, outstanding)
    const newTotalAllocated: Money = priorAllocated + toAllocate
    const newStatus: InvoiceStatus =
      newTotalAllocated >= invoice.amount ? 'PAID' : 'PARTIALLY_PAID'

    steps.push({
      invoiceId:  invoice.id,
      month:      invoice.month,
      outstanding,
      toAllocate,
      newStatus,
    })

    remaining -= toAllocate
  }

  return { steps, allocated: amount - remaining, credit: remaining }
}

/** Groups allocation amounts by charge id, so one query serves every charge. */
export function sumAllocationsByInvoice(
  allocations: readonly { invoiceId: string; amount: Money }[]
): Map<string, Money> {
  const byInvoice = new Map<string, Money>()
  for (const a of allocations) {
    byInvoice.set(a.invoiceId, sumMoney([byInvoice.get(a.invoiceId) ?? 0, a.amount]))
  }
  return byInvoice
}
