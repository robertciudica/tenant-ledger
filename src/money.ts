/**
 * Money: the core financial value object.
 *
 * Always an integer, representing minor currency units (cents, kopiyky, bani).
 *
 * Never use raw `number` for currency amounts. Use `Money` everywhere.
 * Floating-point arithmetic on money is forbidden: all financial calculations
 * operate on integers.
 *
 * Examples:
 *   1 USD = 100  (cents)
 *   1 UAH = 100  (kopiyky)
 *   1 RON = 100  (bani)
 *
 * Conversion from user input (say "42.50") happens at the edge of the system,
 * in the HTTP or form layer, never inside the ledger.
 *
 * WHY THIS IS AN ALIAS AND NOT A BRANDED TYPE
 * ───────────────────────────────────────────
 * `type Money = number & { readonly __brand: 'Money' }` would stop a caller
 * passing a raw number where money is expected, and it is the first thing a
 * reviewer suggests. It was tried and reverted.
 *
 * What it buys is one thing: the wrap is mandatory at the boundary. It does
 * not make arithmetic safer, because TypeScript happily adds a branded number
 * to an unbranded one and gives back a plain number, so every sum inside the
 * ledger would need casting back. And the check it enforces at compile time,
 * "this is an integer number of minor units", is already enforced at run time
 * at every entry point, by guards that have their own tests: a float is
 * rejected with a `ValidationError` naming the field.
 *
 * The cost is paid by every caller, on every literal, forever. That trade is
 * worth it when the runtime check does not exist or cannot exist. Here it
 * exists, it is tested, and it produces a better error than a type would.
 *
 * `money()` below is the middle ground: callers who want the boundary to be
 * explicit can use it, and get the same validation one step earlier.
 */

import { ValidationError } from './errors'

export type Money = number

/**
 * The largest amount the ledger will hold: Number.MAX_SAFE_INTEGER, which is
 * 9,007,199,254,740,991 minor units. Above it, JavaScript integers stop being
 * exact and two different amounts can compare equal. Every entry point
 * rejects an amount beyond it, and every sum inside the ledger checks that it
 * has not crossed it, so an overflow is an error rather than a rounding.
 */
export const MAX_MONEY: Money = Number.MAX_SAFE_INTEGER

/**
 * Adds amounts, refusing to return a total that is not an exact integer.
 * The only way the ledger sums money.
 *
 * @throws {Error} a plain Error, not a domain error: a sum leaving the safe
 *   range is a fault in the data or the code, never in the caller's input.
 */
export function sumMoney(amounts: Iterable<Money>): Money {
  let total = 0
  for (const amount of amounts) {
    total += amount
    if (!Number.isSafeInteger(total)) {
      throw new Error(`Money overflow: a sum left the safe integer range at ${total}`)
    }
  }
  return total
}

/**
 * Asserts that a number is a usable amount of minor units and returns it.
 *
 * For the edge of a system, where a number arrives from a form, a webhook or
 * a spreadsheet and nobody is sure yet whether it is 42.5 dollars or 4250
 * cents. Inside the ledger the same check runs again at every entry point;
 * this is for catching it one layer earlier, with your own field name.
 *
 * Zero is rejected: no ledger operation takes an amount of nothing.
 *
 * @throws {ValidationError}
 */
export function money(amount: number, field = 'amount'): Money {
  if (!Number.isFinite(amount)) {
    throw new ValidationError('Amount must be a finite number', field)
  }
  if (!Number.isSafeInteger(amount)) {
    throw new ValidationError(
      'Amount must be a safe integer (minor currency units, no decimals, at most 2^53 - 1)',
      field
    )
  }
  if (amount <= 0) {
    throw new ValidationError('Amount must be positive', field)
  }
  return amount
}

/** True when `value` is a usable amount of minor units. No side effects. */
export function isMoney(value: unknown): value is Money {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
