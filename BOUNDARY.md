# Public API

Three entry points. `tenant-ledger` is the ledger, `tenant-ledger/testing` is the
in-memory store and the contract suite, `tenant-ledger/postgres` is the SQL
store. Nothing else is exported.

## Services

| Export | Signature | Purpose |
| --- | --- | --- |
| `BillingService` | `new BillingService(store: LedgerStore, config: BillingConfig)` | The receivables ledger: charges, payments, allocations, credit. `config` carries the cash category payments are booked under, and an optional `clock`. |
| `BillingService#recordPayment` | `(params: RecordPaymentParams) => Promise<RecordPaymentResult>` | Take money from an account and waterfall it across open charges, oldest first. The remainder stays as credit. |
| `BillingService#recordPaymentForInvoice` | `(params: RecordPaymentForInvoiceParams) => Promise<RecordPaymentResult>` | Take money against one named charge. Overpayment is rejected. |
| `BillingService#previewAllocation` | `(params: PreviewAllocationParams) => Promise<PreviewAllocationResult>` | Dry run of the waterfall. Writes nothing. Refuses a currency the open charges do not share, the same as `recordPayment`. |
| `BillingService#applyCredit` | `(params: ApplyCreditParams) => Promise<ApplyCreditResult>` | Spend an account's standing credit against its open charges. |
| `BillingService#calculateStandingCredit` | `(accountId: string, organizationId: string) => Promise<Money>` | Payments minus allocations minus credit notes: money on the account that no charge has claimed. Not what the account owes. |
| `BillingService#reversePayment` | `(params: ReversePaymentParams) => Promise<ReversePaymentResult>` | The money never arrived. Voids one payment in place, removes every allocation it funded, reopens every charge it covered, voids its cash row. Whole or not at all. |
| `BillingService#voidInvoicePayments` | `(params: VoidInvoicePaymentsParams) => Promise<VoidInvoicePaymentsResult>` | `reversePayment` for every live payment on one charge, entered from the charge's side. |
| `BillingService#voidInvoice` | `(params: VoidInvoiceParams) => Promise<VoidInvoiceResult>` | The charge should not exist. Marks it VOID and releases its allocations to standing credit. Payments untouched. |
| `BillingService#applyCreditNote` | `(params: ApplyCreditNoteParams) => Promise<CreditNote>` | Reduce what an account owes without money moving. |
| `BillingService#createManualInvoice` | `(params: CreateManualInvoiceParams) => Promise<Invoice>` | Create a charge with an explicit amount. No pricing logic. Needs `MANAGE_FINANCES`. |
| `LedgerService` | `new LedgerService(store: LedgerStore, taxonomy: CategoryTaxonomy, options?: LedgerServiceOptions)` | The cash ledger: what came in, what went out. |
| `LedgerService#addEntry` | `(params: AddLedgerEntryParams) => Promise<LedgerEntry>` | Record one manual cash row. |
| `LedgerService#voidEntry` | `(params: VoidLedgerEntryParams) => Promise<LedgerEntry>` | Void a manual row. Rows written by a payment are refused here. |
| `LedgerService#createTemplate` | `(params: CreateTemplateParams) => Promise<RecurringExpenseTemplate>` | Define a monthly recurring expense. |
| `LedgerService#updateTemplate` | `(params: UpdateTemplateParams) => Promise<RecurringExpenseTemplate>` | Edit a template. Future postings only. |
| `LedgerService#deleteTemplate` | `(params: DeleteTemplateParams) => Promise<void>` | Deactivate a template. Posted rows survive. |
| `LedgerService#materializeTemplatesForMonth` | `(params: MaterializeTemplatesParams) => Promise<number>` | Post every due template for a month. Idempotent. |

## Pure functions

| Export | Signature | Purpose |
| --- | --- | --- |
| `planWaterfall` | `(open: readonly OpenCharge[], amount: Money) => WaterfallPlan` | Where a payment would land. The one implementation of the algorithm; `recordPayment` commits it and `previewAllocation` displays it. |
| `selectOpenInvoices` | `(invoices: readonly Invoice[]) => Invoice[]` | The charges still owed, oldest first. |
| `sumAllocationsByInvoice` | `(allocations) => Map<string, Money>` | Groups allocation amounts by charge, so one query serves every charge. |
| `money` | `(amount: number, field?: string) => Money` | Validates an amount at your own boundary: a positive safe integer. Throws `ValidationError`. |
| `sumMoney` | `(amounts: Iterable<Money>) => Money` | The only way the ledger adds money. Throws if the total leaves the safe integer range. |
| `MAX_MONEY` | `Money` | `Number.MAX_SAFE_INTEGER`, the largest amount the ledger holds. |
| `isMoney` | `(value: unknown) => boolean` | The same question without throwing. |
| `sumAllocations` | `(allocations: readonly HasAmount[]) => number` | What has landed on a charge. |
| `computeBalance` | `(amount: number, paidAmount: number) => number` | What is still owed. Never negative. |
| `computeEffectiveStatus` | `(dbStatus, amount, paidAmount, dueDate, now) => InvoiceStatus` | The state to show a human, derived from allocations rather than trusted from the stored column. |
| `computeLedgerTotals` | `(entries: readonly LedgerEntry[]) => LedgerTotals` | Signed in / out / net over cash rows, voided rows excluded. |
| `categoryMatchesDirection` | `(taxonomy, direction, category) => boolean` | Is this category valid for this direction. |
| `monthKey` | `(date: Date) => string` | `"YYYY-MM"` in UTC. |
| `hasPermission` | `(held: readonly Permission[], needed: Permission) => boolean` | No side effects. |
| `requirePermission` | `(held: readonly Permission[], needed: Permission) => void` | Throws `ForbiddenError`. |

## Storage

| Export | Entry point | Kind | Purpose |
| --- | --- | --- | --- |
| `LedgerStore` | `.` | interface | The one port. 30 methods, every one takes `organizationId`. |
| `InMemoryLedgerStore` | `.`, `./testing` | class | A complete implementation with no dependencies. Rolls back on a throw; cannot model two callers at once. |
| `PostgresLedgerStore` | `./postgres` | class | Postgres, on any driver with `query` and `transaction`. Real transactions, real `SELECT ... FOR UPDATE`. |
| `pgPoolClient` | `./postgres` | function | Wraps a `pg` pool so a transaction pins one connection. |
| `SqlClient`, `SqlQueryable`, `PgPoolLike`, `PgClientLike` | `./postgres` | interfaces | The driver shape, so the package depends on no driver. |
| `runLedgerStoreContractTests` | `./testing` | function | The port's rules as a runnable suite. Point it at your own store. |
| Entity factories | `./testing` | functions | `accountFactory` and friends, for seeding the in-memory store. |
| `schema.sql` | `tenant-ledger/schema.sql` | file | The Postgres schema, every constraint annotated with what breaks without it. |

## Errors

`DomainError` (base, carries `code`), and `NotFoundError`, `ForbiddenError`,
`ValidationError`, `ConflictError`, `IdempotencyError`.

Thrown by a store rather than by the ledger: `StoreError` (carries `cause`),
`UniqueViolationError` (carries `constraint`), and `DuplicateIdempotencyKeyError`,
which a store must throw from `createEventLog` on a duplicate
`(organizationId, idempotencyKey)`. The services translate that one into
`IdempotencyError`; which constraint it came from stays inside the store.

## Types and constants

`Money`, `Permission`, `PERMISSIONS`, `CategoryTaxonomy`, `BillingConfig`,
`EVENT_TYPES`, `EventType`, `SYSTEM_ACTOR_ID`, `ActorType`.

Entities: `Account`, `Invoice`, `FinancialTransaction`, `Allocation`,
`CreditNote`, `LedgerEntry`, `RecurringExpenseTemplate`, `EventLog`.

Waterfall types: `OpenCharge`, `WaterfallPlan`, `AllocationStep`.

Enums: `InvoiceStatus`, `PaymentMethod`, `CreditNoteReason`, `LedgerDirection`,
`LedgerSource`.

Parameter and result types for every service method listed above, plus the
storage input types (`CreateInvoiceInput` and friends) that an implementer of
`LedgerStore` has to satisfy.

## Out of scope, deliberately

These exist in Lumo and are not here. Each one is a place where the ledger
stops and the product starts.

| What | Why it is not here |
| --- | --- |
| Generating a charge from an enrolment | Prices a charge from a class and a pricing type. All product, no ledger. |
| Deciding whether signing up bills someone | Product rule. |
| Repricing open charges after a price change | Depends on the pricing model. |
| Deriving billing periods and due dates | From a calendar the product owns. |
| Comparing a charge against the current price list | Product rule. |
| The monthly summary projector | A read model over the ledger, built from the event log. It belongs to whoever is reading. |
| Anything that reads the event log | The ledger writes events. Replaying them is the caller's job. |
