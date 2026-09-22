/**
 * The narrow SQL interface `PostgresLedgerStore` runs on.
 *
 * The package has no runtime dependencies and this file is why: nothing here
 * imports `pg`, `postgres`, PGlite or anything else. The store asks for a
 * `query` and a `transaction`, and any driver that has them structurally
 * satisfies it.
 *
 *   import { PGlite } from '@electric-sql/pglite'
 *   new PostgresLedgerStore(new PGlite())          // satisfies SqlClient as-is
 *
 *   import { Pool } from 'pg'
 *   new PostgresLedgerStore(pgPoolClient(new Pool()))
 *
 * A pool needs the adapter below. `pool.query('BEGIN')` and the next
 * `pool.query` can land on different connections, which would leave the
 * transaction open on one connection and the work committed on another.
 * `pgPoolClient` pins a single connection for the life of the transaction,
 * which is the only correct way to do it.
 */

/** Anything that can run a parameterised statement and return rows. */
export interface SqlQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: R[] }>
}

/** A queryable that can also open a transaction. */
export interface SqlClient extends SqlQueryable {
  /**
   * Runs `fn` between BEGIN and COMMIT on one connection, rolling back and
   * rethrowing if it throws. Everything `fn` writes commits together.
   */
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>
}

/** One connection checked out of a pool. Structurally `pg.PoolClient`. */
export interface PgClientLike extends SqlQueryable {
  release(err?: Error | boolean): void
}

/** Structurally `pg.Pool`, without importing `pg`. */
export interface PgPoolLike extends SqlQueryable {
  connect(): Promise<PgClientLike>
}

/**
 * Wraps a `pg` pool so it satisfies `SqlClient`.
 *
 * Statements outside a transaction go straight to the pool. A transaction
 * checks out one connection, runs BEGIN, hands that connection to the body,
 * and always releases it, committing on success and rolling back on any
 * throw. A rollback that itself fails releases the connection as broken, so
 * the pool discards it rather than handing a half-open transaction to the
 * next caller.
 */
export function pgPoolClient(pool: PgPoolLike): SqlClient {
  return {
    query: (text, params) => pool.query(text, params),

    async transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      const connection = await pool.connect()
      try {
        await connection.query('BEGIN')
        const result = await fn(connection)
        await connection.query('COMMIT')
        connection.release()
        return result
      } catch (error) {
        try {
          await connection.query('ROLLBACK')
          connection.release()
        } catch (rollbackError) {
          // The connection is in an unknown state. Releasing it with an error
          // tells the pool to destroy it instead of reusing it.
          connection.release(rollbackError as Error)
        }
        throw error
      }
    },
  }
}

/** True when this queryable can open a transaction of its own. */
export function isSqlClient(db: SqlQueryable): db is SqlClient {
  return typeof (db as SqlClient).transaction === 'function'
}
