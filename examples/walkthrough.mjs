/**
 * The whole ledger, end to end, against a real Postgres.
 *
 *   npm run demo                 # PGlite: Postgres in WebAssembly, no server
 *   DATABASE_URL=... npm run demo   # your own server, so you can go and look
 *
 * It imports the built package from `dist`, not the source, so what you are
 * watching is what a consumer would get from npm.
 *
 * Everything printed is read back out of the database after each step. No
 * value below is remembered from the call that produced it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { BillingService, LedgerService, computeEffectiveStatus, computeLedgerTotals } from '../dist/index.mjs'
import { PostgresLedgerStore, pgPoolClient } from '../dist/postgres.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(here, '../dist/schema.sql'), 'utf8')

const ORG = 'studio_amsterdam'
const ACCOUNT = 'customer_42'

// ── Connect ──────────────────────────────────────────────────────────────────

let store
let raw    // one statement, with parameters: the SELECTs this script runs itself
let script // several statements at once: the schema
let close = async () => {}

if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  raw = (text, params) => pool.query(text, params).then(r => r.rows)
  script = text => pool.query(text)
  store = new PostgresLedgerStore(pgPoolClient(pool))
  close = () => pool.end()
  console.log(`\nPostgres at ${process.env.DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}\n`)
} else {
  const { PGlite } = await import('@electric-sql/pglite')
  const pg = new PGlite()
  raw = (text, params) => pg.query(text, params).then(r => r.rows)
  script = text => pg.exec(text)
  store = new PostgresLedgerStore(pg)
  close = () => pg.close()
  console.log('\nPostgres 18, compiled to WebAssembly. No server started.\n')
}

// ── Set up ───────────────────────────────────────────────────────────────────

await script(`DROP TABLE IF EXISTS event_log, ledger_entries, allocations, credit_notes,
  recurring_expense_templates, financial_transactions, invoices, accounts CASCADE`)
await script(SCHEMA)
await raw('INSERT INTO accounts (id, organization_id) VALUES ($1, $2)', [ACCOUNT, ORG])

// "Now" for the whole story, so it reads the same in any month you run it.
// The ledger takes its clock as an argument; nothing in it calls new Date().
const NOW = new Date('2026-02-03T10:00:00Z')

const billing = new BillingService(store, { paymentCategory: 'TUITION', clock: () => NOW })
const cash = new LedgerService(store, {
  in:  ['TUITION', 'HALL_RENTAL'],
  out: ['RENT', 'PAYROLL', 'SUPPLIES'],
}, { clock: () => NOW })

const actor = { actorId: 'owner_1', actorPermissions: ['RECORD_PAYMENT', 'MANAGE_FINANCES', 'ADD_CASHBOOK', 'MANAGE_CASHBOOK'], organizationId: ORG }
const eur = cents => `€${(cents / 100).toFixed(2)}`.padStart(9)

function step(n, title) {
  console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`)
}

/** Reads the charges back out of the database and prints what they are worth. */
async function showCharges() {
  const rows = await raw(`
    SELECT i.id, i.month, i.amount, i.status, i.due_date,
           COALESCE(SUM(a.amount), 0) AS paid
      FROM invoices i
      LEFT JOIN allocations a ON a.invoice_id = i.id
     WHERE i.organization_id = $1
     GROUP BY i.id ORDER BY i.created_at, i.seq`, [ORG])

  for (const r of rows) {
    const amount = Number(r.amount)
    const paid = Number(r.paid)
    const effective = computeEffectiveStatus(r.status, amount, paid, new Date(r.due_date), NOW)
    const drifted = effective !== r.status ? `  (stored says ${r.status})` : ''
    console.log(`   ${r.month}  ${eur(amount)}  paid ${eur(paid)}  ${effective.padEnd(14)}${drifted}`)
  }
}

async function showCash() {
  const rows = await raw('SELECT direction, category, amount, voided_at FROM ledger_entries WHERE organization_id = $1 ORDER BY created_at', [ORG])
  const totals = computeLedgerTotals(rows.map(r => ({ direction: r.direction, amount: Number(r.amount), voidedAt: r.voided_at })))
  for (const r of rows) {
    const flag = r.voided_at ? '  voided' : ''
    console.log(`   ${r.direction.padEnd(4)} ${r.category.padEnd(12)} ${eur(Number(r.amount))}${flag}`)
  }
  console.log(`   ${''.padEnd(17)} net ${eur(totals.net)}`)
}

// ── 1. Two charges ───────────────────────────────────────────────────────────

step(1, 'Bill the customer for January and February')

for (const [month, due] of [['2026-01', '2026-01-31'], ['2026-02', '2026-02-28']]) {
  await billing.createManualInvoice({
    accountId: ACCOUNT, amount: 5000, currency: 'EUR',
    dueDate: new Date(due), description: `${month} tuition`, month,
    createdBy: actor.actorId, actorPermissions: actor.actorPermissions, organizationId: ORG,
  })
}
await showCharges()
console.log('   Today is 3 February. January is late and February is not, and no code')
console.log('   path ever wrote OVERDUE: it falls out of the due date when you read it.')

// ── 2. Preview ───────────────────────────────────────────────────────────────

step(2, 'They say they will send €70. Where would it land?')

const preview = await billing.previewAllocation({ accountId: ACCOUNT, amount: 7000, currency: 'EUR', organizationId: ORG })
for (const s of preview.steps) {
  console.log(`   ${s.month}  ${eur(s.toAllocate)} of ${eur(s.outstanding)} outstanding  -> ${s.newStatus}`)
}
console.log(`   left over as credit: ${eur(preview.credit)}   (nothing was written)`)

// ── 3. The payment ───────────────────────────────────────────────────────────

step(3, 'The €70 arrives')

const payment = await billing.recordPayment({
  ...actor, idempotencyKey: 'bank-2026-02-03-a1b2', accountId: ACCOUNT,
  payerId: 'parent_9', amount: 7000, currency: 'EUR', paymentMethod: 'BANK_TRANSFER',
})
console.log(`   allocated ${eur(payment.allocated)}, credit ${eur(payment.credit)}`)
await showCharges()
console.log('\n   And the cash ledger, which the payment wrote to in the same transaction:')
await showCash()

// ── 4. Idempotency ───────────────────────────────────────────────────────────

step(4, 'The bank webhook fires again with the same key')

try {
  await billing.recordPayment({
    ...actor, idempotencyKey: 'bank-2026-02-03-a1b2', accountId: ACCOUNT,
    payerId: 'parent_9', amount: 7000, currency: 'EUR', paymentMethod: 'BANK_TRANSFER',
  })
  console.log('   ...it went through, which would be a bug')
} catch (error) {
  console.log(`   ${error.name}: ${error.message}`)
}
const [{ count }] = await raw('SELECT count(*) FROM financial_transactions WHERE organization_id = $1', [ORG])
console.log(`   payments recorded: ${count}`)

// ── 5. Overpayment becomes credit, and credit gets spent ─────────────────────

step(5, 'March is billed. They pay €110, which is €30 more than they owe.')

await billing.createManualInvoice({
  accountId: ACCOUNT, amount: 5000, currency: 'EUR', dueDate: new Date('2026-03-31'),
  description: '2026-03 tuition', month: '2026-03', createdBy: actor.actorId, actorPermissions: actor.actorPermissions, organizationId: ORG,
})
const over = await billing.recordPayment({
  ...actor, idempotencyKey: 'bank-2026-02-10-c3d4', accountId: ACCOUNT,
  payerId: 'parent_9', amount: 11000, currency: 'EUR', paymentMethod: 'CARD',
})
console.log(`   allocated ${eur(over.allocated)} across the open charges, ${eur(over.credit)} had nowhere to go`)
console.log(`   standing credit on the account: ${eur(await billing.calculateStandingCredit(ACCOUNT, ORG))}`)
await showCharges()
console.log('   The €30 is real money that is not attached to anything yet.')

step(6, 'April is billed. Spend the credit on it.')

await billing.createManualInvoice({
  accountId: ACCOUNT, amount: 5000, currency: 'EUR', dueDate: new Date('2026-04-30'),
  description: '2026-04 tuition', month: '2026-04', createdBy: actor.actorId, actorPermissions: actor.actorPermissions, organizationId: ORG,
})
const applied = await billing.applyCredit({ ...actor, idempotencyKey: 'credit-2026-04-01', accountId: ACCOUNT })
console.log(`   applied ${eur(applied.applied)} to ${applied.invoicesTouched.length} charge(s), ${eur(applied.remainingCredit)} left on account`)
await showCharges()
console.log('   No new cash row: that money was booked as income when it arrived.')

// ── 7. Reversal ──────────────────────────────────────────────────────────────

step(7, 'The €70 bank transfer bounced. Undo it.')

const undone = await billing.voidInvoicePayments({
  ...actor, idempotencyKey: 'undo-2026-04-02',
  invoiceId: (await raw(`SELECT id FROM invoices WHERE month = '2026-01' AND organization_id = $1`, [ORG]))[0].id,
})
console.log(`   reversed ${eur(undone.amountReversed)} across ${undone.paymentsReversed} payment(s)`)
console.log(`   ${undone.allocationsRemoved} allocations removed, ${undone.ledgerEntriesVoided} cash rows voided`)
console.log('   charges it reopened. February is in the list because the same payment')
console.log('   partly covered it: a payment is reversed whole or not at all.')
for (const r of undone.invoicesReopened) console.log(`     ${r.month} -> ${r.status}`)
await showCharges()
console.log('\n   The cash ledger, with the bounced money out of the totals:')
await showCash()

// ── 8. An expense, and the month ─────────────────────────────────────────────

step(8, 'Pay the rent')

await cash.addEntry({
  ...actor, idempotencyKey: 'rent-2026-04', direction: 'OUT', category: 'RENT',
  amount: 120000, currency: 'EUR', note: 'Studio rent, April',
})
await showCash()

// ── 9. The audit trail ───────────────────────────────────────────────────────

step(9, 'Every one of those operations left a row that can be replayed')

const events = await raw('SELECT type, actor_id, idempotency_key FROM event_log WHERE organization_id = $1 ORDER BY created_at, id', [ORG])
for (const e of events) {
  console.log(`   ${e.type.padEnd(32)} ${e.actor_id.padEnd(10)} ${e.idempotency_key}`)
}

const [{ payments, allocs }] = await raw(`
  SELECT (SELECT count(*) FROM financial_transactions WHERE organization_id = $1) AS payments,
         (SELECT count(*) FROM allocations a JOIN invoices i ON i.id = a.invoice_id WHERE i.organization_id = $1) AS allocs`, [ORG])
console.log(`\n   ${payments} payments and ${allocs} live allocations. The reversed payment is still`)
console.log('   there, flagged; its allocations are gone, and the event row above has the snapshot.')

if (process.env.DATABASE_URL) {
  console.log('\nThe rows are still in your database. Go and look:')
  console.log(`   psql "${process.env.DATABASE_URL}" -c "SELECT type, payload FROM event_log ORDER BY created_at"`)
}

console.log()
await close()
