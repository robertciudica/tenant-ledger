/**
 * The Postgres store, and the driver-shaped interface it runs on.
 *
 * Imported as `tenant-ledger/postgres`, so a caller who only wants the ledger
 * never pulls this in. The schema this expects ships alongside it as
 * `schema.sql`.
 */

export { PostgresLedgerStore } from './PostgresLedgerStore'
export { pgPoolClient, isSqlClient } from './sql-client'
export type { SqlClient, SqlQueryable, PgPoolLike, PgClientLike } from './sql-client'
