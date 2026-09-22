/**
 * Shared test setup.
 *
 * A caller of this package brings its own roles. These two permission sets
 * stand in for the two that matter in the extracted logic: someone who can take
 * money in, and someone who can also reverse it.
 */

import type { Permission, CategoryTaxonomy } from '../src'

/** Can take money in and add cash rows, but cannot reverse or void anything. */
export const OPERATOR: readonly Permission[] = ['RECORD_PAYMENT', 'ADD_CASHBOOK']

/** Everything. */
export const MANAGER: readonly Permission[] = [
  'RECORD_PAYMENT',
  'MANAGE_FINANCES',
  'ADD_CASHBOOK',
  'MANAGE_CASHBOOK',
]

/** Can do nothing to the ledger. */
export const READER: readonly Permission[] = []

/** A small synthetic chart of accounts. */
export const TAXONOMY: CategoryTaxonomy = {
  in:  ['SALES', 'SERVICES', 'OTHER_INCOME'],
  out: ['RENT', 'UTILITIES', 'PAYROLL', 'SUPPLIES', 'OTHER_EXPENSE'],
}

/** The income category the receivables ledger books payments under. */
export const PAYMENT_CATEGORY = 'SALES'
