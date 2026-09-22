import { defineConfig } from 'tsup'

/**
 * Three entry points, two module formats.
 *
 * `tenant-ledger` is the ledger. `tenant-ledger/testing` is the in-memory store,
 * the fixture factories and the store contract suite. `tenant-ledger/postgres`
 * is the Postgres store. Splitting them means a production bundle never pulls
 * in the test tooling, and a caller who is not on Postgres never sees its SQL.
 */
export default defineConfig({
  entry: {
    index:    'src/index.ts',
    testing:  'src/testing/index.ts',
    postgres: 'src/postgres/index.ts',
  },
  format:    ['esm', 'cjs'],
  dts:       true,
  sourcemap: true,
  clean:     true,
  target:    'es2020',
  outDir:    'dist',
  // Shared code (the in-memory store is reachable from two entries) becomes one
  // chunk instead of being duplicated into both.
  splitting: true,
  treeshake: true,
})
