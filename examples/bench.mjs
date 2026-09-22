/**
 * How much work one ledger operation is.
 *
 *   npm run bench
 *
 * Two numbers per operation, and the first matters more than the second.
 *
 * Queries per operation is a property of the code. It is what decides whether
 * the ledger scales with the number of open charges on an account or stays
 * flat, and it does not depend on the machine. The waterfall used to issue one
 * query per open charge; it issues a fixed number now, whatever the account
 * looks like.
 *
 * Operations per second is a property of this machine and of PGlite, which is
 * Postgres compiled to WebAssembly on one thread. Treat it as a floor. A real
 * server on real hardware with a connection pool is faster, and the point of
 * printing it is to catch a regression, not to advertise a figure.
 *
 * Built package, real SQL, real constraints, no server.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

import { BillingService } from '../dist/index.mjs'
import { PostgresLedgerStore } from '../dist/postgres.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(here, '../dist/schema.sql'), 'utf8')
const ORG = 'org_bench'
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200)

// ── A client that counts what the store asks of it ───────────────────────────

const pg = new PGlite()
await pg.exec(SCHEMA)

let queries = 0
const counting = {
  query: (text, params) => { queries += 1; return pg.query(text, params) },
  transaction: fn => pg.transaction(tx => fn({
    query: (text, params) => { queries += 1; return tx.query(text, params) },
  })),
}

const store = new PostgresLedgerStore(counting)
const billing = new BillingService(store, { paymentCategory: 'SALES' })
const actor = { actorId: 'op', actorPermissions: ['RECORD_PAYMENT', 'MANAGE_FINANCES'], organizationId: ORG }

async function reset(openCharges) {
  await pg.exec(`TRUNCATE accounts, invoices, financial_transactions, allocations, credit_notes,
    recurring_expense_templates, ledger_entries, event_log RESTART IDENTITY CASCADE`)
  await pg.query('INSERT INTO accounts (id, organization_id) VALUES ($1, $2)', ['acc', ORG])
  for (let i = 0; i < openCharges; i++) {
    await pg.query(
      `INSERT INTO invoices (organization_id, account_id, amount, currency, status, due_date, month)
       VALUES ($1, 'acc', 100000, 'EUR', 'PENDING', now(), $2)`,
      [ORG, `2026-${String((i % 12) + 1).padStart(2, '0')}`]
    )
  }
}

let n = 0
const pay = amount => billing.recordPayment({
  ...actor, idempotencyKey: `k${n++}`, accountId: 'acc', payerId: 'p',
  amount, currency: 'EUR', paymentMethod: 'CASH',
})

/** Runs `op` ITERATIONS times and reports queries per call and calls per second. */
async function measure(label, setup, op) {
  await setup()
  await op() // warm the statement cache; not counted
  queries = 0
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < ITERATIONS; i++) await op()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const perOp = queries / ITERATIONS
  const perSec = ITERATIONS / (ms / 1000)
  console.log(`   ${label.padEnd(46)} ${perOp.toFixed(1).padStart(6)} queries/op ${perSec.toFixed(0).padStart(7)} ops/s`)
}

console.log(`\nPGlite, single thread, ${ITERATIONS} iterations each. Queries/op is the number to read.\n`)

console.log('recordPayment, small payment, account with N open charges')
for (const open of [1, 10, 100]) {
  await measure(`   ${String(open).padStart(3)} open charges`, () => reset(open), () => pay(100))
}

console.log('\nrecordPayment, payment that covers every open charge')
for (const open of [1, 10, 100]) {
  // Re-seed each time so there is always something to cover. The reseed goes
  // straight to PGlite, not through the counting client, so it is not counted;
  // its time is, which makes this block's ops/s a little pessimistic.
  await measure(`   ${String(open).padStart(3)} open charges`, () => reset(open), async () => {
    await reset(open)
    await pay(100000 * open)
  })
}

console.log('\npreviewAllocation, account with N open charges')
for (const open of [1, 10, 100]) {
  await measure(`   ${String(open).padStart(3)} open charges`, () => reset(open),
    () => billing.previewAllocation({ accountId: 'acc', amount: 100, currency: 'EUR', organizationId: ORG }))
}

console.log('\ncalculateStandingCredit')
await measure('   account with 100 payments', async () => {
  await reset(0)
  for (let i = 0; i < 100; i++) await pay(100)
}, () => billing.calculateStandingCredit('acc', ORG))

console.log(`
The queries/op column is flat in the number of open charges for recordPayment
and previewAllocation: the waterfall loads the charges and the allocations in
two queries and plans in memory. The second block grows because each covered
charge gets one allocation insert and one status update, which is the write
the operation exists to make.
`)
await pg.close()
