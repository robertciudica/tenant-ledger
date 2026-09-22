# AGENTS.md

## What this package is

An append-only, event-sourced, multi-tenant accounting core: charges, payments,
allocations, standing credit, reversal, and a cash in/out ledger. Extracted from
a production SaaS. No framework, no ORM, no HTTP, no runtime dependencies.

## Layout

- `src/receivables/BillingService.ts`: charges, payments, allocations, credit.
- `src/receivables/waterfall.ts`: the allocation algorithm, pure.
- `src/receivables/invoice-status.ts`: pure derivation of balance and status.
- `src/cash/LedgerService.ts`: cash rows, voiding, recurring templates.
- `src/store.ts`: the `LedgerStore` port and every entity type.
- `src/testing/InMemoryLedgerStore.ts`: the reference store implementation.
- `src/testing/store-contract.ts`: the port's rules as a runnable suite.
- `src/postgres/`: the Postgres store, its driver interface, and `schema.sql`.
- `test/`: jest suites. `test/helpers.ts` holds the permission sets used there.

Entry points: `.` (the ledger), `./testing` (in-memory store, factories,
contract suite), `./postgres` (the SQL store). Nothing in `src/` imports a
driver: `PostgresLedgerStore` takes anything with `query` and `transaction`.

## Public API

```ts
new BillingService(store: LedgerStore, config: { paymentCategory: string, clock?: () => Date })
  recordPayment(params): Promise<{ transactionId, allocated, credit }>
  recordPaymentForInvoice(params): Promise<{ transactionId, allocated, credit }>
  previewAllocation(params): Promise<{ steps, totalAllocated, credit }>
  applyCredit(params): Promise<{ applied, remainingCredit, invoicesTouched }>
  calculateStandingCredit(accountId: string, organizationId: string): Promise<number>
  reversePayment(params): Promise<ReversePaymentResult>          // money never arrived
  voidInvoicePayments(params): Promise<VoidInvoicePaymentsResult> // reversePayment for every payment on a charge
  voidInvoice(params): Promise<VoidInvoiceResult>                 // charge should not exist; allocations released
  applyCreditNote(params): Promise<CreditNote>
  createManualInvoice(params): Promise<Invoice>

new LedgerService(store, taxonomy: { in: string[], out: string[] }, options?: { clock?: () => Date })
  addEntry(params): Promise<LedgerEntry>
  voidEntry(params): Promise<LedgerEntry>
  createTemplate(params): Promise<RecurringExpenseTemplate>
  updateTemplate(params): Promise<RecurringExpenseTemplate>
  deleteTemplate(params): Promise<void>
  materializeTemplatesForMonth(params): Promise<number>

planWaterfall(open, amount): { steps, allocated, credit }   // pure
selectOpenInvoices(invoices): Invoice[]                     // pure
sumAllocationsByInvoice(allocations): Map<string, number>   // pure
sumAllocations(allocations): number
computeBalance(amount, paidAmount): number
computeEffectiveStatus(dbStatus, amount, paidAmount, dueDate, now): InvoiceStatus
computeLedgerTotals(entries): { inn, out, net }
categoryMatchesDirection(taxonomy, direction, category): boolean
monthKey(date): string
hasPermission(held, needed): boolean
requirePermission(held, needed): void   // throws ForbiddenError
money(amount, field?): Money            // validating constructor
isMoney(value): boolean
```

From `tenant-ledger/postgres`:

```ts
new PostgresLedgerStore(db: SqlClient | SqlQueryable, inTx?: boolean)
pgPoolClient(pool: PgPoolLike): SqlClient
```

From `tenant-ledger/testing`:

```ts
new InMemoryLedgerStore()
runLedgerStoreContractTests(name, makeStore, { supportsRollback, seedAccount? })
// plus the entity factories
```

Errors: `DomainError` and `NotFoundError`, `ForbiddenError`, `ValidationError`,
`ConflictError`, `IdempotencyError`, `StoreError`, `UniqueViolationError`,
`DuplicateIdempotencyKeyError`. A store throws the last one from
`createEventLog` on a duplicate key; the ledger never learns which physical
constraint that was.

## Rules you must not break

1. Amounts are safe integers in minor units. Never introduce floating-point
   arithmetic on money, never divide without deciding where the remainder goes,
   and sum with `sumMoney`, which refuses to leave the safe range.
2. Never mutate a recorded amount. Corrections are void plus re-add, or reverse
   plus re-record.
3. `allocated + credit` must equal the amount received. The runtime check in
   `recordPayment` throws a plain `Error`, not a `DomainError`, on purpose: it is
   a bug, not user input. Do not convert it.
4. Balances and effective status are derived on read. Do not add a stored balance
   column, and do not trust `Invoice.status` for anything but VOID: the
   waterfall, the targeted payment and `computeEffectiveStatus` all decide
   "still owed" from the allocations.
5. Every mutating method takes an `idempotencyKey`, checks the event log before
   the transaction, and writes the event row inside it. Keep that order.
6. Every storage call passes `organizationId`. Never add a method that omits it,
   and never take a tenant id from anything the end user controls.
7. VOID is terminal in both directions, and only `voidInvoice` sets it. Do not
   conflate it with reversal: a voided charge keeps its payments, a reversed
   payment reopens its charges.
8. `previewAllocation` and `recordPayment` both call `planWaterfall`. Do not
   reimplement the algorithm in either; `test/preview-allocation.test.ts` still
   asserts they agree.
9. Every operation that allocates calls `tx.lockAccount` as its first statement
   inside the transaction. Reads whose result the operation then spends belong
   inside the lock, not before it.
10. A store reports failures as `StoreError` or `UniqueViolationError`, and a
    duplicate idempotency key as `DuplicateIdempotencyKeyError`. The services
    turn that one into `IdempotencyError`; keep the translation in `anchored()`
    and keep constraint names out of `src/receivables` and `src/cash`.
11. The services take their clock from config. Do not call `new Date()` in
    `src/`, and do not use fake timers in tests.
12. A payment, a targeted payment, a preview and a credit application all
    refuse to cross a currency. The check lives in `assertSameCurrency` and
    runs inside the lock, on the rows it is about to spend.

## Easy mistakes

- **`findTransactionsByAccount` must exclude voided payments.** Any store that
  returns them makes a reversed payment reappear as standing credit that can be
  spent again. There is no guard in the service for this.
- **`createEventLog` must throw on a duplicate `(organizationId, idempotencyKey)`.**
  The pre-flight read is a fast path, not the guarantee. A store without the
  unique constraint makes every idempotency test in this repo meaningless.
- **A change to `LedgerStore` belongs in `src/testing/store-contract.ts`.** A
  rule only one implementation is held to is not a rule about the port. Run
  `npm test` and both shipped stores are checked against it.
- **`PostgresLedgerStore.runTransaction` uses `this.constructor`,** through
  `bindTo`. Constructing the class by name drops a subclass's overrides inside
  transactions, which is where the writes are.
- `createManualInvoice` requires `MANAGE_FINANCES`, not `RECORD_PAYMENT`.
  Deciding that somebody owes money is the reversing-and-crediting capability,
  not the taking-money-in one.
- Money settles a charge in the charge's own currency only. `assertSameCurrency`
  runs in every path that allocates, preview included. Do not add a conversion.
- `applyCredit` writes no cash row. The cash was booked when the payment was
  recorded; adding one double-counts income.
- A payment holds at most one allocation per charge. `applyCredit` skips a source
  that already touched the target charge for that reason.

## Running

```
npm install
npm test          # jest, no database, no network, no env vars
npm run lint      # biome
npm run typecheck # tsc --noEmit over src and test
npm run build     # tsup, dual ESM/CJS with declarations
```

The Postgres store is covered by `npm test` through PGlite. The concurrency
tests need two connections and skip unless `DATABASE_URL` is set.

Releases are cut with `npm version` and a tag push; see Releasing in
`CONTRIBUTING.md`. Never run `npm publish` by hand.
