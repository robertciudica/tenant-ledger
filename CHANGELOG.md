# Changelog

Notable changes, newest first. This project follows [semantic
versioning](https://semver.org/), and the format is loosely [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/).

## 1.0.0

First public release. The accounting core of [Lumo](https://lumo.dance),
extracted as a standalone package and reviewed as one. See
`docs/extraction.md` for what was taken, what was left, and why.

- **Two ledgers, one event log.** `BillingService` is the receivables side:
  charges, payments, allocation, standing credit, credit notes, reversal and
  void. `LedgerService` is the cash side: money in, money out, recurring
  expenses. Every mutating call is idempotent, tenant-scoped, and writes one
  event row in the same transaction.
- **One storage port,** `LedgerStore`, thirty methods, every one taking
  `organizationId`. `lockAccount` serialises allocation per account so two
  concurrent payments cannot both spend the same outstanding balance.
- **Two stores.** `InMemoryLedgerStore`, with rollback, from
  `tenant-ledger/testing`. `PostgresLedgerStore`, with `schema.sql`, from
  `tenant-ledger/postgres`. It runs on `pg` through `pgPoolClient` or on PGlite
  directly; the package has no runtime dependencies.
- **The port's rules as a runnable suite.** `runLedgerStoreContractTests`
  from `tenant-ledger/testing` runs against any store and any test runner.
- **The allocation waterfall as pure functions,** `planWaterfall` and
  `selectOpenInvoices`, shared by `recordPayment` and `previewAllocation`.
- **Money is a safe integer in minor units.** Every entry point checks it, and
  `sumMoney` throws rather than round. Every path that allocates refuses to
  cross a currency.
- **Status is derived.** `computeEffectiveStatus` reads the allocations, not
  the stored column, for every state but VOID.
- **An injected clock** on both services, as `config.clock`.
- **ESM and CommonJS builds,** three entry points, Node 20.11 or later.
