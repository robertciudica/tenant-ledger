/**
 * Authorization: the four permissions the ledger itself checks.
 *
 * The ledger does not know about roles. A caller resolves its own roles to a
 * permission set and passes that set in; the ledger only asks whether the
 * required permission is in it. That keeps role modelling, per-tenant overrides
 * and org charts entirely outside this package.
 */

import { ForbiddenError } from './errors'

export const PERMISSIONS = {
  /** Take money in: record a payment, spend standing credit. */
  RECORD_PAYMENT: 'RECORD_PAYMENT',
  /** Reverse money and issue credit notes. Deliberately separate from taking it in. */
  MANAGE_FINANCES: 'MANAGE_FINANCES',
  /** Add a row to the cash ledger. */
  ADD_CASHBOOK: 'ADD_CASHBOOK',
  /** Void cash rows and manage recurring expense templates. */
  MANAGE_CASHBOOK: 'MANAGE_CASHBOOK',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

/**
 * Returns true if the held permission set covers `needed`.
 * No side effects; safe to call from a read path or a UI guard.
 */
export const hasPermission = (
  held: readonly Permission[],
  needed: Permission
): boolean => held.includes(needed)

/**
 * Guard: throws ForbiddenError when the held set does not cover `needed`.
 * Used at the top of every ledger method that requires authorization.
 *
 * @throws {ForbiddenError}
 */
export const requirePermission = (
  held: readonly Permission[],
  needed: Permission
): void => {
  if (!hasPermission(held, needed)) {
    throw new ForbiddenError(`Missing permission: ${needed}`)
  }
}
