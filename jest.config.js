/**
 * Jest configuration.
 *
 * Plain CommonJS rather than TypeScript: with `--experimental-vm-modules` on
 * (which PGlite needs, see below) Node tries to load a `.ts` config as an ES
 * module and fails on `export default`, and the alternative is a `ts-node`
 * dependency that exists only to read this eleven-line file.
 *
 * The `--experimental-vm-modules` flag is set in the npm scripts. PGlite,
 * which is Postgres compiled to WebAssembly, loads its runtime with a dynamic
 * import, and Jest's sandbox refuses those without the flag. Nothing else in
 * the suite needs it.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Booting a Postgres in WebAssembly takes about half a second, and CI
  // machines are slower than that.
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/*.d.ts',
  ],
}
