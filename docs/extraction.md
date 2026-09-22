# Extracting the ledger

How the accounting core of [Lumo](https://lumo.dance) became this package:
what was taken, what was left behind, and every judgement call in between.

## About this document

Lumo is mine. I built it, it runs in production behind paying customers, and
the ledger described here is the part of it I trust most.

The extraction itself was done by a coding agent, in one session, against a
written brief: survey the ledger, decide whether it could come out cleanly,
take it if it could, rename the domain out of it, port the tests, and record
every decision. I reviewed the result line by line, and everything since,
including the concurrency work, is mine. This document is the agent's
survey and reasoning, edited by me and kept because it is more useful than a
tidier summary written afterwards: it records the estimate before the work and
the outcome after, which is the only honest way to say whether an architectural
rule paid off.

I am saying this plainly because the interesting result is not that an agent
wrote a package. It is *why* one night was enough, which section 5 gets to.

## The verdict

**Extractable, and extracted.** The ledger came out whole. Nothing was stubbed,
no behaviour was lost, and no secret or customer datum came with it.

The reason it went smoothly is the finding worth keeping. Lumo's core was
built under a rule the codebase calls the golden rule: no ORM imports, no HTTP,
no file I/O, all storage through one injected port, and the tenant id passed
explicitly on every call. That rule turned a rewrite into a rename job. A layer
written any other way would have been "too coupled", and the honest answer
would have been to leave it where it was.

---

## 1. What the ledger is, and what it touches

Lumo keeps two money ledgers that share one event log, both in a
framework-free core: no ORM, no HTTP, no file I/O. Every database call goes
through one port interface injected into the constructor, and every method
takes `organizationId` as an explicit argument.

The receivables side records charges, payments, which payment covers which
charge, standing credit, and reversal. The cash side records money in, money
out, and recurring expenses. They touch in one place: a payment writes its own
cash row, in the same transaction.

The survey classified everything the two services reach into four kinds:

| Kind | What it was | Verdict |
| --- | --- | --- |
| The storage port | An interface, with no driver types leaking into it | Take the ledger slice of it. A type-level cut, not a rewrite. |
| Utilities | Errors, the money type, event names, the permission guard | Take whole. Zero dependencies of their own. |
| Domain | Pricing, billing periods, enrolment rules, a fixed role matrix | Leave. The ledger takes an amount and does not ask where it came from. |
| Framework, ORM, third-party | Nothing | Not imported by the core at all. |

The only real coupling was the storage port, and it was already an interface.
What had to change was naming, not structure: the party that owes money was a
student and became an account, the expense categories were a dance studio's
chart of accounts and became an argument, and authorization arrived as a role
from a fixed matrix and became a permission set the caller supplies. About 135
identifier references in the two services, nearly all a single rename.

## 2. What was left behind

Everything that decides an amount: generating a charge from an enrolment,
repricing open charges after a price change, deriving billing periods from a
calendar, comparing a charge against the current price list. Each of those
reads the product's pricing model. The ledger is the thing they hand the
amount to.

Also left: the read models. Lumo builds monthly summaries by replaying the
event log. That is a consumer of the ledger, not part of it.

One genuine loss: a charge carried five foreign keys into product tables
(class, membership, session, cycle start and end). Nothing in the extracted
logic read them, so they were dropped and one optional `reference` string
stands in.

---

## 3. The invariants

Each is stated as the code states it, with the file that holds it. These
became the test list, and later the review checklist in `AGENTS.md`. Two of
them, numbers 11 and 12, turned out to need more than a test; see section 6.

1. **A posting balances.** `allocated + credit === payment.amount`. Checked at
   runtime inside `recordPayment` with a hard `throw new Error` rather than a
   domain error, because a failure is a programming error, not a user error.
   (`BillingService.ts`, end of `recordPayment`.)
2. **A payment can never have allocated more than it received.** Asserted before
   any reversal work starts. (`BillingService.voidInvoicePayments`.)
3. **Credit cannot be overspent.** `applied <= creditBefore`, checked with a hard
   throw. (`BillingService.applyCredit`.)
4. **Money is integer minor units.** Every amount entry point rejects
   non-integers and non-positives with `ValidationError`. There is no
   floating-point arithmetic anywhere in the ledger. (`BillingService`,
   `LedgerService.assertAmount`.)
5. **Entries are immutable.** A recorded amount is never mutated. Correcting a
   cash row is void plus re-add; correcting a payment is reverse plus re-record.
   Voiding sets metadata and leaves the row. (`LedgerService.voidEntry`,
   `BillingService.voidInvoicePayments`.)
6. **Balances are derived, never stored as truth.** `calculateStandingCredit` (then `calculateBalance`) sums
   payments minus allocations minus credit notes on every call.
   `computeEffectiveStatus` recomputes an invoice's state from its allocations
   and ignores the stored status column unless the allocations say nothing.
   `computeLedgerTotals` sums the rows. The stored `Invoice.status` is a
   projection that is allowed to lag. (`invoice-status.ts`, `BillingService`,
   `LedgerService`.)
7. **VOID is terminal.** Money landing on a voided invoice never resurrects it,
   in either direction: `computeEffectiveStatus` returns VOID first, and the
   reversal re-projection skips VOID invoices. (`invoice-status.ts`,
   `voidInvoicePayments` step 2.)
8. **Voided rows leave the totals.** `computeLedgerTotals` skips rows with
   `voidedAt`; `findTransactionsByStudent` excludes voided payments so a reversed
   payment cannot come back as standing credit. (`LedgerService`, storage port
   contract.)
9. **Every write is idempotent through the event log.** Each mutating method
   takes a caller-supplied `idempotencyKey`, checks the event log before opening
   the transaction, and writes the event log row inside it. The event row is the
   anchor: if the transaction rolls back, so does the key. The storage layer
   enforces uniqueness on `(organizationId, idempotencyKey)`. (Both services.)
10. **A tenant cannot see another tenant's rows.** Every port method takes
    `organizationId` and filters on it. Rows without their own tenant column
    (`Allocation`) are reached only through a parent that has one. The tenant
    comes from the session in the calling app, never from an argument the user
    controls.
11. **Allocation order is oldest first.** The waterfall allocates to the oldest
    open charge before newer ones, and applying credit consumes the oldest
    unspent payment first.
12. **Preview matches commit.** `previewAllocation` must produce exactly the
    steps `recordPayment` would commit for the same inputs. Lumo tests this
    explicitly as the "parity invariant".
13. **Reversal is all or nothing per payment.** A payment that waterfalled
    across three charges reopens all three. There is no way to un-receive part
    of a payment, because that would break invariant 1.
14. **A recurring template never posts before its day of month**, and never
    twice for the same `(template, month)`.
15. **Editing a template does not touch already-posted rows.** Templates affect
    future materializations only.

Two things that look like invariants but are not, and are reported as found:

- **Currency is not checked.** Amounts carry a currency string, and nothing
  compares the currency of a payment with the currency of the charge it settles.
  A ledger is multi-currency in the sense that the currency travels with every
  row and is never assumed, but there is no guard against mixing. This is
  extracted as-is and documented, not fixed. Adding a guard would be inventing a
  feature.
- **`OVERDUE` is never written.** Nothing in Lumo stores `OVERDUE` on an invoice;
  it is derived from the due date at read time. The waterfall still accepts it as
  an input status, because rows imported from elsewhere might carry it.

---

## 4. The estimate, written before the work

- 8 source files to write (5 of them mostly mechanical: errors, money, event
  types, permissions, the storage port).
- About 135 domain identifier references to rename in the services, plus the
  same names again in the port and the test fixtures.
- 131 existing tests over the surface. Of those, roughly 110 port with renames
  only; 6 assert membership behaviour and are dropped with the feature; the rest
  need small rewrites where they seeded a domain field.
- 1 file (`invoice-status.ts`) has no portable test and needs new tests written.
- No adapter shims, no stubs, no behaviour changes expected.

It held. Eight source files, no adapters, no stubs, and the renames were the
bulk of the diff. The estimate being right is the point of recording it: it is
what turns "the architecture is good" from an opinion into a measurement.

---

## 5. The decisions

Every judgement call, what was chosen, what was rejected, and why.

### 5.1. Scope: two ledgers, not one

Lumo has two money ledgers that share one event log:

- the receivables ledger in `BillingService` (what is owed, what was paid, and
  which payment covers which charge),
- the cash ledger in `LedgerService` (what money actually moved, in and out).

Taking only the cash ledger was tempting: it is 482 lines, self-contained, and
would have been done in an hour. It was rejected because most of what makes this
code worth reading lives on the other side: the waterfall, standing credit, the
reversal, the balance that is recomputed rather than stored. The two also touch
each other in exactly one place (a payment writes its own cash row), and that
seam is one of the more interesting things in the package. Splitting them would
have hidden it.

Everything that prices a charge is out: generating a charge from an enrolment,
repricing, billing periods, price drift. Those read a product's pricing model.
The ledger takes an amount and does not ask where it came from.

### 5.2. Class names kept, directories renamed

`BillingService` and `LedgerService` keep their Lumo names even though
"LedgerService" naming only half of a package called tenant-ledger is confusing at
first glance. Renaming them to `ReceivablesLedger` and `CashLedger` would have
read better and would have made the diff against Lumo harder to follow, which is
the opposite of what an extraction should do. The compromise: the files live in
`src/receivables/` and `src/cash/`, so the directory says the role and the class
still says where it came from.

### 5.3. Authorization: permissions in, roles out

Lumo passes `actorRole: UserRole` into every method and looks the role up in a
fixed six-role matrix. Three of those roles are domain (teacher, student,
parent), and the matrix is a product decision, not a ledger one.

Chosen: the caller passes `actorPermissions: readonly Permission[]` and the
ledger checks membership. The four permissions it actually checks
(`RECORD_PAYMENT`, `MANAGE_FINANCES`, `ADD_CASHBOOK`, `MANAGE_CASHBOOK`) are
generic accounting capabilities and came across unchanged.

Rejected: inventing a neutral role matrix (owner, manager, clerk). That would
have been a design decision the ledger has no business making, and every caller
would have had to map its real roles onto ours anyway.

Consequence for the tests: the ported permission tests now say "an actor without
RECORD_PAYMENT" where Lumo said "a TEACHER". The assertion is identical.

### 5.4. Categories: a taxonomy the caller supplies

Lumo's cash categories are a dance studio's chart of accounts, hardcoded as two
arrays: TUITION, PRIVATE_LESSON, HALL_RENTAL, COMPETITIONS, CAMP on the way in;
RENT, UTILITIES, PAYROLL, SUPPLIES, MARKETING on the way out.

Chosen: `LedgerCategory` is a plain string, and `LedgerService` takes a
`CategoryTaxonomy` (`{ in: string[], out: string[] }`) in its constructor. The
guard that made the original interesting is preserved exactly: a category must
be used in the direction its owner declared, and a recurring template must use
an OUT category.

Rejected: shipping a generic default taxonomy. Any list I invented would be
wrong for the next user and would have been a feature nobody in Lumo wrote.

Follow-on: `BillingService` writes a cash row alongside every payment, and in
Lumo that row is hardcoded to the TUITION category. It now takes the category
from a required `BillingConfig.paymentCategory`. No default, because a silently
wrong default would put income in the wrong place, and the failure would be a
quiet one in a monthly report.

### 5.5. The domain renames

| Lumo | Here | Why |
| --- | --- | --- |
| `studentId` | `accountId` | The party that owes money. |
| `Student` entity | `Account` (`{ id, organizationId }`) | Only the existence check survives; everything else about the party belongs to the host. |
| `payerUserId` | `payerId` | Who handed the money over, which is not always the account holder. |
| `staffUserId` | `counterpartyId` | On a payroll row this is who was paid; the generic name covers the vendor case too. |
| `"Dancer"` in errors | `"Account"` | Error message text only. |
| `classId`, `studentMembershipId`, `sessionId`, `cycleStart`, `cycleEnd` | one optional `reference: string` | Five foreign keys into Lumo tables. Nothing in the extracted logic reads them. |

`Invoice`, `FinancialTransaction`, `Allocation`, `CreditNote`, `LedgerEntry` and
`EventLog` kept their names: those are accounting words, not domain ones. It is
worth saying out loud that `Invoice` here means "a charge somebody owes" and
carries no document, no numbering, no tax handling.

### 5.6. The storage port narrowed to `LedgerStore`

Lumo's storage port covers the whole product: attendance, scheduling,
memberships, classes. Only the ledger slice came across, renamed to
`LedgerStore`: 30 methods, every one taking `organizationId`. `lockAccount` was
added in the review, see section 6.

Two contract notes that were comments in Lumo are now part of the interface
documentation, because an implementer who misses them gets a silent bug rather
than a compile error:

- `findTransactionsByAccount` must exclude voided payments. If it does not, a
  reversed payment comes back as standing credit and can be spent again.
- `createEventLog` must enforce uniqueness on `(organizationId, idempotencyKey)`
  and throw on a duplicate. The pre-flight idempotency read can lose a race; the
  constraint cannot.

There is a test that asserts the second one against the shipped store, because
if a store does not do it, every idempotency test in the suite is theatre.

### 5.7. In-memory store ships in `src`, not in `test`

Lumo's in-memory test double lives with its test helpers. Here the equivalent
is `src/testing/InMemoryLedgerStore.ts`, and it is exported rather than kept in
the test folder. Two reasons: the brief asked for a shipped in-memory
implementation, and anyone writing their own store needs a reference more than
they need a test fixture. It has since moved to its own entry point,
`tenant-ledger/testing`, alongside the factories and the contract suite, so a
production bundle does not carry it.

At extraction time rollback was not emulated, exactly as in Lumo:
`runTransaction` called the callback with `this`. Now the outermost call
snapshots the tables and restores them on a throw, so the store passes the
contract suite's rollback cases too. What it still cannot model is two callers
at once.

### 5.8. What was deliberately not fixed

**Currency was never compared.** Every row carries a currency string and, at
extraction time, nothing checked that a payment's currency matched the charge it
settled. A payment in USD would settle a charge in EUR at face value. It was
characterized rather than fixed during the extraction, because the extraction's
job was to preserve behaviour. The review fixed it: every path that allocates
refuses to cross a currency, and the characterization test became the test for
the rule. Lumo runs one currency per studio, so nothing there ever hit either
behaviour.

**`OVERDUE` is never written to the stored status.** It is derived from the due
date at read time in `computeEffectiveStatus`. The waterfall still accepts
OVERDUE as an input status, because rows imported from another system can carry
it. Kept as-is.

**`createManualInvoice` had no permission check.** In Lumo the authorization
for that path lives in the calling layer. Preserved during the extraction; it now
requires `MANAGE_FINANCES`, so the ledger's own guard is consistent across every
method that decides money is owed or not owed.

### 5.9. Test porting

131 `it()` blocks cover this surface in Lumo. What happened to them:

- Ported with renames only: the large majority.
- Dropped: 6 tests asserting that paying does not advance a subscription cycle.
  The feature is not here, so the assertion has nothing to hold.
- Rewritten: the ones that seeded a domain field (a class id, a membership) now
  seed the generic equivalent or nothing.
- Written new, all marked `// added during extraction, not from Lumo`: the
  `invoice-status` suite (Lumo covers it only through a test that drives two
  server actions with the ORM mocked, which cannot travel), the
  invariants suite, the README example, and a handful of tenant-isolation cases.

The parity test between `previewAllocation` and `recordPayment` came across
as-is. It was the single most valuable test in the package, because two code
paths implemented the same waterfall and it was the only thing stopping them
drifting. There is now one code path and the test is a regression guard,
which is a better place for it to be.

### 5.10. Tooling matches Lumo

jest with `ts-jest`, `testEnvironment: 'node'`, `testMatch: ['**/*.test.ts']`,
and strict TypeScript, because that is what Lumo uses. The build kept `src` and
`test` apart so that `dist` contains only shipped code.

No runtime dependencies. The ledger imports nothing outside its own `src`.

(Both details have since changed, for reasons that have nothing to do with Lumo:
the build is tsup, because a published package needs ESM as well as CommonJS,
and the jest config is plain JavaScript, because the flag PGlite needs makes
Node read a `.ts` config as an ES module.)

### 5.11. Tests live in `test/`, not beside the source

Lumo keeps `*.test.ts` next to the file under test. Here they are in `test/`, so
the build can include `src` wholesale and `dist` contains only shipped code. It
is the one structural break from the original.


---

## 6. What the extraction missed

Written after the review that followed the extraction: the first time the code
was read as a public package rather than as an extraction. Everything below was
already true in Lumo. The extraction preserved it faithfully, which is exactly
what an extraction should do, and is also why an extraction is not a review.

**Nothing serialised the allocation.** Invariant 11 says allocation is oldest
first, and it is. What neither the code nor this document said is what happens
when two payments for one account arrive at the same time: both read the same
outstanding balance, both allocate against the same charge, and the charge ends
up holding more money than it is worth, with no error anywhere. The fix is
`lockAccount`, a row lock taken first inside every transaction that allocates,
and `test/postgres-concurrency.test.ts` demonstrates both halves against a real
server: the same race overpays by 100% with the lock removed, and settles
exactly once with it in place.

That is the honest cost of the extraction brief. It asked whether behaviour was
preserved, and the answer was yes. It did not ask whether the behaviour was
right under concurrency, and nobody had.

**Two documented rules were not enforced anywhere.** Section 5.6 records that
`findTransactionsByAccount` must exclude voided payments and that
`createEventLog` must reject a duplicate key, and calls them contract notes an
implementer can miss. They were exactly that: prose. Turning them into a
runnable contract suite and pointing it at the store that ships with this
package found that its allocation reads ignored the tenant entirely, which is
the other failure the same section warns about. The reference implementation
had the bug its own documentation described.

**`calculateBalance` and `CreditNote` said opposite things.** The function
computes standing credit: payments minus allocations minus credit notes. The
entity doc called a credit note "a reduction in what an account owes". Both
were carried across verbatim from Lumo, where they had contradicted each other
for as long as they had existed, and reading them side by side in a fresh
repository is what made it visible.

The pattern in all three is the same, and it is the most useful thing I know
about extracting code: an extraction preserves behaviour, and preserving
behaviour preserves bugs. The value is not in the moving. It is in reading the
result somewhere the original context does not come along to explain it.

---

## Appendix: every rule, and the test that holds it

The point of the table is that a rule with no named test is a rule nobody is
keeping. Rules 1 to 15 are the invariants from section 3; the last two came out
of that review.

| Rule | Held by |
| --- | --- |
| A posting balances (`allocated + credit === amount`) | `record-payment.test.ts`, plus a property-style case in `waterfall.test.ts` over several amounts |
| Allocations never exceed the payment they came from | `invariants.test.ts`, which feeds it corrupt state and expects the hard throw |
| Credit cannot be overspent | the guard in `applyCredit`; the accounting is covered by `apply-credit.test.ts` |
| Money is integer minor units | every service entry point, in `record-payment`, `create-manual-invoice`, `cash-ledger`, `balance-and-credit-notes`, and `money()` in `waterfall.test.ts` |
| Entries are immutable | `invariants.test.ts`, both ledgers |
| Balances are derived, never stored | `balance-and-credit-notes.test.ts`, `invoice-status.test.ts`, `cash-ledger.test.ts` |
| VOID is terminal | `invoice-status.test.ts`, `void-invoice-payments.test.ts` |
| Voided rows leave the totals | `cash-ledger.test.ts`, `void-invoice-payments.test.ts`, and the contract suite for both stores |
| Money settles a charge in its own currency | `invariants.test.ts`, every allocating path including preview |
| Idempotency anchored in the event log | every mutating suite; the constraint itself in the contract suite; the lost race in `invariants.test.ts` and `postgres-integration.test.ts` |
| Tenant isolation | the contract suite, method by method, against both stores; plus cases in `record-payment`, `create-manual-invoice`, `cash-ledger` |
| Allocation is oldest first | `waterfall.test.ts` directly, `record-payment.test.ts` and `apply-credit.test.ts` through the services, and the ordering case in the contract suite |
| Preview matches commit | one function, `planWaterfall`; `preview-allocation.test.ts` still asserts the two agree |
| Reversal is all or nothing per payment | `void-invoice-payments.test.ts`, `postgres-integration.test.ts` |
| A template never posts early or twice | `cash-ledger.test.ts`, `postgres-integration.test.ts` |
| Editing a template does not touch posted rows | `cash-ledger.test.ts` |
| Allocation is serialised per account | `invariants.test.ts` for the call order, `postgres-concurrency.test.ts` for the contention, including the counter-example with the lock removed |
| A store reports failures in the ledger's types | the contract suite, and `invariants.test.ts` for the translation into `IdempotencyError` |

Tests written for this package rather than ported from Lumo carry the comment
`// added during extraction, not from Lumo`. It is how a reader tells what has
been running in production from what has not.
