# tenant-ledger

[![CI](https://github.com/robertciudica/tenant-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/robertciudica/tenant-ledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tenant-ledger.svg)](https://www.npmjs.com/package/tenant-ledger)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Two ledgers, one append-only event log, every write idempotent and
tenant-scoped. `BillingService` is the receivables side: charges, payments,
allocations, standing credit, reversal. `LedgerService` is the cash side: money
in, money out, recurring expenses. A payment writes to both in one transaction,
and every mutating call also writes one event row keyed by an idempotency key
the caller supplies.

This is the accounting core of [Lumo](https://lumo.dance), the SaaS I built for
dance studios. It has been running in production behind paying customers, and
I pulled it out as a package because the accounting part is the part I would
want to reuse, and the part I think is worth reading. It is the production
code with the studio names replaced by generic ones, plus the account lock
described under Concurrency, which I found while reviewing the extraction and
have since ported back into Lumo, where it runs in production.

No runtime dependencies. No framework, no ORM, no HTTP layer, no clock of its
own.

## Who this is for

- **You are putting billing into a multi-tenant app** and want the accounting
  part without adopting a billing platform. Bring your own database and your
  own idea of who a customer is.
- **You are writing your own storage layer** and want a port that has been
  through production, plus a contract suite that tells you when your
  implementation is wrong.
- **You want to read a real ledger.** Most public examples are toys. The
  comments in this one say which incident produced each rule.

A note on how it was made: I had a coding agent do the extraction against a
brief I wrote, and I reviewed the result line by line. The design decisions
below are mine, most of them years older than the agent.
[`docs/extraction.md`](docs/extraction.md) has the survey, the estimate before
the work and the result after.

## Install

```sh
npm install tenant-ledger
```

Node 20.11 or newer. Ships ES modules and CommonJS, with types for both.

```ts
import { BillingService } from 'tenant-ledger'
import { InMemoryLedgerStore } from 'tenant-ledger/testing'
import { PostgresLedgerStore } from 'tenant-ledger/postgres'
```

## The rules it enforces

1. **A posting balances.** `allocated + credit === amount received`, checked at
   runtime. If it fails, money has gone missing inside one function.
2. **Money is integer minor units.** Every entry point rejects anything that is
   not a safe integer, and every sum inside the ledger refuses to leave the
   safe range, because 0.1 + 0.2 has no business near somebody's balance and
   neither does 2^53.
3. **Entries are immutable.** Correcting a cash row is void plus re-add;
   correcting a payment is reverse plus re-record. Voided rows stay, flagged, and
   drop out of the totals.
4. **Balances are derived, never stored.** What is owed on a charge is its
   amount minus its allocations, recomputed on every read. The stored status
   column is consulted for one value only, VOID; everything else is computed.
   There is no balance column to drift.
5. **VOID is terminal.** Money landing on a voided charge never resurrects it.
6. **Every write is idempotent through the event log.** The key is checked before
   the transaction and written inside it, so a rollback releases it.
7. **A tenant cannot reach another tenant's rows.** Every storage call takes a
   tenant id; rows without a tenant column are reached through a parent.
8. **Allocation is oldest first**, for payments and for standing credit.
9. **Reversal is all or nothing per payment, and a wrong charge is a different
   event.** Reversing a payment declares the money never arrived: every charge
   it covered reopens, because un-receiving part of one would break rule 1.
   Voiding a charge declares the charge should not exist: the payments that
   covered it stay, and their money becomes standing credit.
10. **Allocation is serialised per account.** Every operation that spends an
    outstanding balance takes a row lock on the account first, so two of them
    cannot read the same balance and both spend it.
11. **Money settles a charge in the charge's own currency.** There is no
    exchange rate in a ledger, so a payment never lands on a charge in another
    currency, and credit is spent in the currency it arrived in.

Each rule has a test whose name says which rule it covers.

## Usage

```ts
import { BillingService } from 'tenant-ledger'
import { InMemoryLedgerStore } from 'tenant-ledger/testing'

const store = new InMemoryLedgerStore()
const billing = new BillingService(store, { paymentCategory: 'SALES' })

const actor = {
  actorId: 'user_7',
  actorPermissions: ['MANAGE_FINANCES', 'RECORD_PAYMENT'] as const,
  organizationId: 'tenant_a',
}

// An account is an id inside a tenant. Everything else about the party lives
// in your system, not here.
store.seed.accounts.push({ id: 'acc_1', organizationId: 'tenant_a' })

await billing.createManualInvoice({
  accountId: 'acc_1',
  amount: 5000,          // 50.00, in minor units
  currency: 'EUR',
  dueDate: new Date('2026-01-31'),
  description: 'January',
  month: '2026-01',
  createdBy: actor.actorId,
  actorPermissions: actor.actorPermissions,
  organizationId: actor.organizationId,
})
// ...and the same again for February.

// 70.00 arrives: it covers January in full and 20.00 of February.
const result = await billing.recordPayment({
  ...actor,
  idempotencyKey: 'payment-2026-02-03-a1b2',
  accountId: 'acc_1',
  payerId: 'person_9',
  amount: 7000,
  currency: 'EUR',
  paymentMethod: 'BANK_TRANSFER',
})
// result.allocated === 7000, result.credit === 0
// Replaying that key throws IdempotencyError instead of taking the money twice.
```

The runnable version, with the cash ledger and assertions, is
[`test/readme-example.test.ts`](test/readme-example.test.ts).

Want to show someone where their money would go before taking it?
`previewAllocation` runs the same planner and writes nothing.

Creating the charges above needs `MANAGE_FINANCES` and taking the payment needs
`RECORD_PAYMENT`, which is why the actor holds both.

## Storage

The ledger never imports a database driver. Everything goes through one port,
`LedgerStore`, and you have three ways to satisfy it.

**In memory,** for tests and for seeing how it behaves:

```ts
import { InMemoryLedgerStore } from 'tenant-ledger/testing'
const store = new InMemoryLedgerStore()
```

**On Postgres,** with the schema this package ships:

```ts
import { Pool } from 'pg'
import { PostgresLedgerStore, pgPoolClient } from 'tenant-ledger/postgres'

const store = new PostgresLedgerStore(pgPoolClient(new Pool()))
```

The schema is at [`src/postgres/schema.sql`](src/postgres/schema.sql), and in
the published package at `tenant-ledger/schema.sql`. Every constraint in it is
annotated with what breaks without it. Apply it as-is or fold it into your
migrations; `pg` is not a dependency of this package, it is one of yours.

PGlite works with no adapter at all, which is how the test suite runs Postgres
without a server:

```ts
import { PGlite } from '@electric-sql/pglite'
const store = new PostgresLedgerStore(new PGlite())
```

**Your own.** The port is 30 methods and every one takes `organizationId`. Two
of its rules can be broken silently, so do not take my word for it:

```ts
import { runLedgerStoreContractTests } from 'tenant-ledger/testing'

runLedgerStoreContractTests('MyPrismaStore', async () => {
  await resetDatabase()
  return new MyPrismaStore(prisma)
}, {
  supportsRollback: true,
  seedAccount: (id, organizationId) => insertAccountRow(id, organizationId),
})
```

It is runner-agnostic: jest, vitest and `node:test` all work. The two rules it
exists for:

- **`findTransactionsByAccount` must exclude voided payments.** A reversed
  payment that comes back here reads as standing credit and can be spent again.
- **`createEventLog` must reject a duplicate `(organizationId,
  idempotencyKey)`,** reporting it as `DuplicateIdempotencyKeyError`. The store
  knows which of its constraints means that; the ledger does not. The pre-flight
  read is a fast path; the constraint is the guarantee.

Running that suite against the in-memory store as it came out of the extraction
found that its allocation reads ignored the tenant. The reference implementation
had the bug its own documentation warned about, which is the argument for the
suite in one sentence.

## Concurrency

Two payments for the same account can arrive at the same moment. Both read the
same charge as open, both allocate their full amount to it, and the charge ends
up holding more money than it is worth. Nothing raises an error. Somebody finds
out weeks later.

`lockAccount` is what prevents that. It is the first call inside every
transaction that allocates, and a store must implement it as a row lock held
until that transaction commits:

```sql
SELECT id, organization_id FROM accounts
 WHERE id = $1 AND organization_id = $2
   FOR UPDATE
```

With the lock, the second payment waits, then reads the balances the first one
left behind and becomes credit instead of a double allocation. READ COMMITTED is
enough; the lock is doing the work, not the isolation level.

This is tested rather than asserted.
[`test/postgres-concurrency.test.ts`](test/postgres-concurrency.test.ts) runs
two connections against a real Postgres and includes the counter-example: the
same race, with `lockAccount` degraded to a plain read, overpays the charge by
100%. It skips unless `DATABASE_URL` is set, and CI runs it against Postgres 16
and 18.

The idempotency race is handled the same way and in two layers. The event log is
read before the transaction opens, which catches the ordinary repeat cheaply,
and the unique constraint inside the transaction catches the race the read
loses. Both reach the caller as `IdempotencyError`, so a retried webhook cannot
tell the difference and neither should your error handling.

The in-memory store cannot demonstrate the lock. It is single-threaded, so
there is never a second caller to wait. It does roll back, and it passes the
same contract suite as the Postgres store.

## Cost per operation

`npm run bench` counts the queries each operation issues, against Postgres in
WebAssembly on one thread. The first column is the one to read: it is a
property of the code and does not depend on the machine.

| Operation | Queries | Grows with |
| --- | ---: | --- |
| `recordPayment`, small payment, 1 to 100 open charges | 9 | nothing |
| `recordPayment`, covering N charges | 8 + 2N | one insert and one status update per charge it settles |
| `previewAllocation`, 1 to 100 open charges | 2 | nothing |
| `calculateStandingCredit` | 3 | nothing |

The waterfall loads an account's charges and its allocations in two queries
and plans in memory, so an account with a hundred open charges costs the same
to pay as one with a single charge. It used to be one query per charge. The
second row grows because writing an allocation per settled charge is the work
the operation exists to do.

The throughput column that script also prints is a floor from a single-threaded
WebAssembly build, kept to catch regressions rather than to quote.

## Design decisions

**Allocations are deleted on reversal, not flagged.** An allocation is a derived
join; the money facts are the payment and the charge. Every read path answers "is
this charge paid?" by summing allocations for one charge id, so deleting them
makes every view self-heal. A flag would need each of those paths to remember to
exclude it, and one that forgot would show a charge as paid by money that never
arrived. I counted the call sites before deciding: about twenty. The event row
keeps a full snapshot, which is what makes the delete acceptable.

**"The payment never arrived" and "the charge was wrong" are two operations.**
`reversePayment` is the first: the payment is voided in place, every allocation
it funded is removed, every charge it covered is re-projected from what remains,
and its cash row leaves the totals. A payment is reversed whole or not at all,
because un-receiving part of one would leave the other charges propped up by
money declared never to have arrived. `voidInvoicePayments` is the same
operation for every payment on one charge, for the operator who found the
problem from the charge's side. `voidInvoice` is the second: the charge becomes
VOID, its allocations are released, and the payments are untouched, so their
money becomes standing credit. Lumo had only the first, entered through a
charge, which meant clearing a wrong charge declared a real payment nonexistent
and reopened everything else it had covered. `Invoice` here means a
charge somebody owes; it carries no document, numbering or tax.

**The stored status is a projection, and the allocations are the truth.** Writing
a status and then ignoring it on read sounds redundant until the column drifts:
it is written by one path and read by five. I added `computeEffectiveStatus`
after four screens disagreed about the same charge. Overdue is part of that:
nothing writes it, it falls out of the due date at read time, and before that an
account three weeks late looked identical to one due at month end.

**Preview and commit are one function.** `previewAllocation` shows where a
payment would land and `recordPayment` puts it there. They used to be two
implementations of the same waterfall kept in step by a parity test, which is a
comment enforced by CI rather than a design. Both now call `planWaterfall`,
which is pure, takes the open charges and an amount, and returns the plan. The
parity test stayed as a regression guard.

**Tenant id is an argument, never ambient.** No request context, no
async-local storage. Every call site has to say which tenant it means, which is
the point: a tenant cannot be inherited by accident. I once leaked across
tenants through a table that had no tenant column of its own, and being explicit
is what made that findable.

**The clock is injected.** `config.clock` defaults to `() => new Date()`.
Reaching for the process clock inside a ledger makes every test that involves a
date reach for a global timer mock, and it makes "now" something the caller
cannot control. Purity where it is cheap: `computeEffectiveStatus` takes `now` as
a parameter for the same reason.

**Storage errors have types.** A store reports `StoreError`,
`UniqueViolationError`, or `DuplicateIdempotencyKeyError` for the one violation
the ledger has to recognise, and never lets a driver's error escape. Which
physical constraint means "duplicate key" is the store's knowledge, not the
ledger's. That is what lets the services tell a lost idempotency race from any
other failed write, and it means a caller catching `DomainError` catches
everything this package can throw.

**`Money` is `number`, not a branded type.** The obvious suggestion, and I tried
it and reverted. It would force a wrap at 200-odd call sites to enforce a rule
that is already enforced at run time at every entry point, by guards that
produce a better error than a type would. `money()` is there for callers who
want the check at their own boundary. The full argument is in
[`src/money.ts`](src/money.ts).

**Currency is checked where money lands, and nowhere else.** Every row carries
its currency, and the only comparison is the one that matters: a payment
against the charges it is about to settle, and unspent credit against the
charges it is about to cover. That comparison was missing in the extracted
code, which meant a payment in one currency settled a charge in another at face
value. Lumo runs one currency per studio so it never came up, but it was the one
place the ledger did less than a reader would expect, and it is gone.

## Decisions a reader might disagree with

- **Standing credit is not "the balance".** `calculateStandingCredit` is
  payments minus allocations minus credit notes: money on the account that no
  charge has claimed. What an account owes is a property of its charges, read
  per charge with `computeEffectiveStatus` or summed by a read model, and the
  ledger deliberately has no single number that mixes the two. In Lumo the
  method is called `calculateBalance`, and the name misled people.
- **Creating a charge needs `MANAGE_FINANCES`, not `RECORD_PAYMENT`.** Deciding
  that somebody owes money is the same capability as reversing a payment or
  issuing a credit note, and a different one from taking money in.
- **The in-memory store rolls back but cannot contend.** The outermost
  `runTransaction` snapshots every table and restores it on a throw, so it
  passes the same contract suite as the Postgres store, rollback cases
  included. What it cannot show is two callers at once: there is one, so
  `lockAccount` has nothing to lock. That is what the real-server test is for.
- **One currency per allocation, not per tenant.** An account may carry charges
  in two currencies; it has to be paid in each. The rule is enforced at the
  point money lands, not at the point a charge is created, so a host that runs
  one currency never sees it and a host that runs several gets a
  `ValidationError` naming the field rather than a silent face-value
  conversion.

## What is not here

- **The domain.** Nothing that prices a charge. Pricing decides an amount; this
  takes the amount.
- **Read models.** The ledger writes events; reporting is built on top.
- **An HTTP layer.** The package throws typed errors and lets the caller
  translate them.
- **Roles.** You pass a permission set; the ledger checks membership. Your org
  chart is yours.

## Seeing it work

```sh
npm install
npm run demo
```

`npm run demo` builds the package and runs
[`examples/walkthrough.mjs`](examples/walkthrough.mjs) against a real Postgres
compiled to WebAssembly, with no server to start. It bills a customer, previews
where a payment would land, takes it, replays the webhook, overpays, spends the
credit, bounces the payment, pays the rent, and prints the event log. Every
figure it shows is read back out of the database after the step that produced
it, and it imports the built package rather than the source, so what you are
watching is what npm would give you.

Point it at your own server to poke at the tables yourself:

```sh
DATABASE_URL=postgres://localhost/scratch npm run demo
psql postgres://localhost/scratch -c "select type, jsonb_pretty(payload) from event_log"
```

## Running the tests

```sh
npm test          # no database, no network, no env vars
npm run typecheck
npm run lint
npm run build
```

The Postgres store is covered by `npm test` alone, through PGlite. The
concurrency tests need two connections and so need a real server:

```sh
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Without `DATABASE_URL` those five tests skip and say so.

## More

- [`docs/extraction.md`](docs/extraction.md): what was taken out of Lumo, what
  was left, every decision, and what the extraction missed.
- [`BOUNDARY.md`](BOUNDARY.md): the public API, one line each.
- [`AGENTS.md`](AGENTS.md): the short version for a coding agent, including the
  rules a change must not break.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md),
  [`SECURITY.md`](SECURITY.md).

MIT.
