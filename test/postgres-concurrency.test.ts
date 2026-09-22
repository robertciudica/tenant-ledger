/**
 * The account lock, under real contention.
 *
 * added during extraction, not from Lumo
 *
 * Every other test in this package runs on one connection, so `lockAccount`
 * is exercised but never seen to do its job. This file is the only place the
 * central concurrency claim is actually tested: that two payments arriving at
 * the same time for the same account cannot both spend the same outstanding
 * balance.
 *
 * It needs a real Postgres server, because it needs two connections. Set
 * DATABASE_URL and it runs; without one it is skipped, so the default `npm
 * test` still needs nothing installed. CI runs it against a service container.
 *
 *   docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
 *
 * The failure this guards against is not theoretical. Without the lock, two
 * concurrent payments both read a charge as open, both allocate their full
 * amount to it, and the charge ends up carrying more money than it is worth,
 * with no error anywhere. The last test in this file removes the lock and
 * shows exactly that.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BillingService, sumAllocations } from '../src'
import type { Account, LedgerStore } from '../src'
import { PostgresLedgerStore, pgPoolClient } from '../src/postgres'
import { MANAGER, PAYMENT_CATEGORY } from './helpers'

const DATABASE_URL = process.env.DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

const SCHEMA = readFileSync(join(__dirname, '../src/postgres/schema.sql'), 'utf8')
const ORG = 'org_1'

describeWithPostgres('the account lock, on a real Postgres', () => {
  // Required lazily so a run without DATABASE_URL does not need `pg` at all.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as typeof import('pg')
  let pool: import('pg').Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
    await pool.query(`
      DROP TABLE IF EXISTS event_log, ledger_entries, allocations, credit_notes,
        recurring_expense_templates, financial_transactions, invoices, accounts CASCADE
    `)
    await pool.query(SCHEMA)
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE accounts, invoices, financial_transactions, allocations,
               credit_notes, recurring_expense_templates, ledger_entries, event_log
      RESTART IDENTITY CASCADE
    `)
    await pool.query('INSERT INTO accounts (id, organization_id) VALUES ($1, $2)', ['acc_1', ORG])
  })

  const billingFor = (store: LedgerStore) =>
    new BillingService(store, { paymentCategory: PAYMENT_CATEGORY })

  const newStore = () => new PostgresLedgerStore(pgPoolClient(pool))

  async function openCharge(amount: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO invoices (organization_id, account_id, amount, currency, status, due_date, month)
       VALUES ($1, 'acc_1', $2, 'EUR', 'PENDING', now() + interval '30 days', '2026-03')
       RETURNING id`,
      [ORG, amount]
    )
    return rows[0].id
  }

  const pay = (billing: BillingService, key: string, amount: number) =>
    billing.recordPayment({
      idempotencyKey:   key,
      accountId:        'acc_1',
      payerId:          'payer_1',
      amount,
      currency:         'EUR',
      paymentMethod:    'CASH',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

  it('never lets two concurrent payments allocate the same money twice', async () => {
    // One charge of 100.00, two payments of 100.00 arriving together. Exactly
    // one of them can cover it; the other has nothing left to land on and
    // becomes credit.
    const invoiceId = await openCharge(10000)

    const [first, second] = await Promise.all([
      pay(billingFor(newStore()), 'pay_a', 10000),
      pay(billingFor(newStore()), 'pay_b', 10000),
    ])

    const landed = sumAllocations(await newStore().findAllocationsByInvoice(invoiceId, ORG))
    expect(landed).toBe(10000)

    // One allocated everything, the other allocated nothing.
    const allocated = [first.allocated, second.allocated].sort((a, b) => a - b)
    expect(allocated).toEqual([0, 10000])
    // And the money did not disappear: what was not allocated is credit.
    expect(first.allocated + first.credit).toBe(10000)
    expect(second.allocated + second.credit).toBe(10000)
  })

  it('holds under a burst, with the charge covered exactly once', async () => {
    const invoiceId = await openCharge(10000)

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pay(billingFor(newStore()), `burst_${i}`, 2500)
      )
    )

    // Four of the six cover the charge; the last two become credit.
    const landed = sumAllocations(await newStore().findAllocationsByInvoice(invoiceId, ORG))
    expect(landed).toBe(10000)
    expect(results.reduce((sum, r) => sum + r.allocated, 0)).toBe(10000)
    expect(results.reduce((sum, r) => sum + r.credit, 0)).toBe(5000)
  })

  it('serialises a payment against a concurrent reversal', async () => {
    const invoiceId = await openCharge(10000)
    const paid = await pay(billingFor(newStore()), 'pay_1', 10000)

    const [, reversal] = await Promise.all([
      pay(billingFor(newStore()), 'pay_2', 10000),
      billingFor(newStore()).voidInvoicePayments({
        idempotencyKey:   'undo_1',
        invoiceId,
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      }),
    ])

    // Whichever order they landed in, the charge never holds more than it is
    // worth, and the reversed payment is gone from the live ones.
    const landed = sumAllocations(await newStore().findAllocationsByInvoice(invoiceId, ORG))
    expect(landed).toBeLessThanOrEqual(10000)
    expect(reversal.amountReversed).toBe(10000)
    const live = await newStore().findTransactionsByAccount('acc_1', ORG)
    expect(live.map(t => t.id)).not.toContain(paid.transactionId)
  })

  it('overpays the charge as soon as the lock is removed', async () => {
    // The counter-example, and the reason lockAccount exists.
    //
    // Two payments have to interleave for the bug to appear: both must read
    // the charge before either writes. On a laptop they usually do not, which
    // is exactly why this class of bug reaches production and then only
    // happens on the busy day. The latch below makes the interleaving a
    // certainty rather than a probability: neither transaction may write
    // until both have read.
    const invoiceId = await openCharge(10000)
    const bothHaveRead = new Latch(2)

    // Same store, lock replaced by a plain read: what an implementation that
    // treats lockAccount as "just another findAccountById" would do.
    class UnlockedStore extends PostgresLedgerStore {
      async lockAccount(accountId: string, organizationId: string): Promise<Account | null> {
        return this.findAccountById(accountId, organizationId)
      }
      async findAllocationsByAccount(accountId: string, organizationId: string) {
        const rows = await super.findAllocationsByAccount(accountId, organizationId)
        await bothHaveRead.arriveAndWait() // hold here until the other has read too
        return rows
      }
    }

    await Promise.all([
      pay(billingFor(new UnlockedStore(pgPoolClient(pool))), 'pay_a', 10000),
      pay(billingFor(new UnlockedStore(pgPoolClient(pool))), 'pay_b', 10000),
    ])

    // Both saw the charge as fully open, and both covered it. The charge holds
    // twice what it is worth, no error was raised anywhere, and the only way
    // anyone finds out is a customer asking why their balance is wrong.
    const landed = sumAllocations(await newStore().findAllocationsByInvoice(invoiceId, ORG))
    expect(landed).toBe(20000)
  })

  it('holds the same race correctly when the lock is there', async () => {
    // The identical interleaving attempt, with lockAccount doing its job. A
    // does not write until B has asked for the lock, so B is provably waiting
    // behind A's transaction rather than merely arriving later. When B is let
    // through it reads the charge already covered and its money becomes
    // credit.
    const invoiceId = await openCharge(10000)
    const bHasAskedForLock = new Latch(1)

    class FirstStore extends PostgresLedgerStore {
      async findAllocationsByAccount(accountId: string, organizationId: string) {
        const rows = await super.findAllocationsByAccount(accountId, organizationId)
        await bHasAskedForLock.wait() // hold A's write until B is queued on the lock
        return rows
      }
    }
    class SecondStore extends PostgresLedgerStore {
      async lockAccount(accountId: string, organizationId: string): Promise<Account | null> {
        bHasAskedForLock.arrive() // signal before the statement that will block
        return super.lockAccount(accountId, organizationId)
      }
    }

    const results = await Promise.all([
      pay(billingFor(new FirstStore(pgPoolClient(pool))), 'pay_a', 10000),
      pay(billingFor(new SecondStore(pgPoolClient(pool))), 'pay_b', 10000),
    ])

    const landed = sumAllocations(await newStore().findAllocationsByInvoice(invoiceId, ORG))
    expect(landed).toBe(10000)
    expect(results.map(r => r.allocated).sort((a, b) => a - b)).toEqual([0, 10000])
  })
})

/**
 * A counting latch: `arrive()` counts one party in, `wait()` resolves once
 * `parties` have arrived, and `arriveAndWait()` does both. Rejects rather than
 * hangs if the count is never reached, so a deadlock fails the test instead
 * of timing out the runner.
 */
class Latch {
  private arrived = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly parties: number, private readonly timeoutMs = 5000) {}

  arrive(): void {
    this.arrived += 1
    if (this.arrived >= this.parties) {
      for (const release of this.waiters.splice(0)) release()
    }
  }

  wait(): Promise<void> {
    if (this.arrived >= this.parties) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Latch: ${this.arrived} of ${this.parties} arrived within ${this.timeoutMs}ms`)),
        this.timeoutMs
      )
      this.waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }

  arriveAndWait(): Promise<void> {
    this.arrive()
    return this.wait()
  }
}
