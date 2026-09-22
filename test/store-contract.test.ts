/**
 * The contract suite, run against both stores that ship with the package.
 *
 * added during extraction, not from Lumo
 *
 * The point of running it twice is that the two stores are as different as
 * two implementations of this port get: arrays in a process, and Postgres.
 * A rule that holds for both is a rule about the port rather than about an
 * implementation, which is what makes it safe to hand this suite to somebody
 * writing a third one.
 *
 * The Postgres run is a real Postgres. PGlite is the actual database compiled
 * to WebAssembly, so the SQL, the constraints, the types and the transaction
 * semantics are the ones production gets, with no server to start. The one
 * thing it cannot show is contention: it has a single connection, so
 * `lockAccount` is exercised but never seen to block. That case needs a real
 * server and lives behind DATABASE_URL.
 */

import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { InMemoryLedgerStore, runLedgerStoreContractTests } from '../src/testing'
import { PostgresLedgerStore } from '../src/postgres'

runLedgerStoreContractTests(
  'InMemoryLedgerStore',
  async () => new InMemoryLedgerStore(),
  // The outermost runTransaction snapshots the tables and restores them on a
  // throw, so the rollback cases run here too.
  { supportsRollback: true }
)

// ── Postgres, through PGlite ─────────────────────────────────────────────────

const SCHEMA = readFileSync(join(__dirname, '../src/postgres/schema.sql'), 'utf8')

// One database for the file. Booting Postgres costs about half a second, and
// every test starts from empty tables instead of a fresh instance.
let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(SCHEMA)
})

afterAll(async () => {
  await pg?.close()
})

runLedgerStoreContractTests(
  'PostgresLedgerStore (PGlite)',
  async () => {
    await pg.exec(`
      TRUNCATE accounts, invoices, financial_transactions, allocations,
               credit_notes, recurring_expense_templates, ledger_entries, event_log
      RESTART IDENTITY CASCADE
    `)
    return new PostgresLedgerStore(pg)
  },
  {
    supportsRollback: true,
    seedAccount: async (id, organizationId) => {
      await pg.query(
        'INSERT INTO accounts (id, organization_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, organizationId]
      )
    },
  }
)
