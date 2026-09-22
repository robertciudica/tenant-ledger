/**
 * The LedgerStore contract, as runnable tests.
 *
 * The port has 29 methods and two rules that a store can break without
 * anything failing to compile and without any test in this package noticing:
 * voided payments must not come back from `findTransactionsByAccount`, and the
 * event log must reject a duplicate (organizationId, idempotencyKey). A store
 * that gets either wrong turns a reversed payment into spendable credit, or
 * turns every idempotency guarantee in the package into decoration.
 *
 * So the contract is not prose. Point this at your own store and run it:
 *
 *   import { runLedgerStoreContractTests } from 'tenant-ledger/testing'
 *
 *   runLedgerStoreContractTests('MyPrismaStore', async () => {
 *     await resetDatabase()
 *     return new MyPrismaStore(prisma)
 *   }, { supportsRollback: true })
 *
 * `makeStore` is called before each test and must return an empty store.
 * `supportsRollback` says whether `runTransaction` really rolls back; an
 * in-memory store usually cannot, and the cases that need it are skipped.
 *
 * Accounts are the one thing the contract has to put in place and the ledger
 * never writes: it only ever reads them, so in most systems they live in a
 * table the host owns. `seedAccount` is how the contract creates them. It is
 * optional for a store that exposes a `seed.accounts` array, and required for
 * anything else.
 *
 * Runner-agnostic on purpose: it uses whatever `describe` and `it` are in
 * scope (jest, vitest, node:test with globals) and asserts with
 * `node:assert/strict`, so the published types do not drag in @types/jest.
 */

import assert from 'node:assert/strict'
import type { LedgerStore, Invoice, FinancialTransaction } from '../store'
import { UniqueViolationError, DuplicateIdempotencyKeyError } from '../errors'

// The host runner supplies these. Declared rather than imported so this file
// compiles and ships without a dependency on any particular test framework.
declare const describe: (name: string, fn: () => void) => void
declare const it: (name: string, fn: () => Promise<void> | void) => void
declare const beforeEach: (fn: () => Promise<void> | void) => void

export interface LedgerStoreContractOptions {
  /**
   * True when `runTransaction` is atomic: a throw inside it must leave no
   * rows behind. False for stores that run the callback against themselves,
   * which is normal for an in-memory implementation.
   */
  supportsRollback: boolean

  /**
   * Creates an account row, or does nothing if it is already there. Required
   * unless the store exposes a `seed.accounts` array to push onto.
   */
  seedAccount?: (id: string, organizationId: string) => Promise<void>
}

const ORG = 'contract_org_1'
const OTHER = 'contract_org_2'

/**
 * Runs the full contract against `makeStore`.
 *
 * @param name        what to call this store in the test output.
 * @param makeStore   returns a fresh, empty store. Called before each test.
 * @param options     see `LedgerStoreContractOptions`.
 */
export function runLedgerStoreContractTests(
  name: string,
  makeStore: () => Promise<LedgerStore>,
  options: LedgerStoreContractOptions
): void {
  describe(`LedgerStore contract: ${name}`, () => {
    let db: LedgerStore

    beforeEach(async () => {
      db = await makeStore()
    })

    const seedAccount = (id: string, organizationId: string) =>
      (options.seedAccount ?? defaultSeedAccount(() => db))(id, organizationId)

    /** Seeds one account per tenant and returns the shared id. */
    async function seedAccounts(id = 'acc_1'): Promise<string> {
      await seedAccount(id, ORG)
      await seedAccount(id, OTHER)
      return id
    }

    async function anInvoice(organizationId: string, accountId = 'acc_1'): Promise<Invoice> {
      return db.createInvoice(
        {
          amount:    10000,
          currency:  'USD',
          status:    'PENDING',
          dueDate:   new Date('2026-02-28T00:00:00Z'),
          month:     '2026-02',
          createdBy: 'operator_1',
          accountId,
        },
        organizationId
      )
    }

    async function aPayment(
      organizationId: string,
      key: string,
      amount = 10000,
      accountId = 'acc_1'
    ): Promise<FinancialTransaction> {
      return db.createTransaction(
        {
          amount,
          currency:       'USD',
          paymentMethod:  'CASH',
          paymentDate:    new Date('2026-02-01T00:00:00Z'),
          idempotencyKey: key,
          recordedBy:     'operator_1',
          payerId:        'payer_1',
          accountId,
        },
        organizationId
      )
    }

    // ── Tenant isolation ────────────────────────────────────────────────────

    describe('a tenant cannot reach another tenant rows', () => {
      it('hides an account that belongs to another tenant', async () => {
        await seedAccount('acc_only_other', OTHER)
        assert.equal(await db.findAccountById('acc_only_other', ORG), null)
        assert.notEqual(await db.findAccountById('acc_only_other', OTHER), null)
      })

      it('hides a charge, and returns none for the account', async () => {
        await seedAccounts()
        const theirs = await anInvoice(OTHER)

        assert.equal(await db.findInvoiceById(theirs.id, ORG), null)
        assert.deepEqual(await db.findInvoicesByAccount('acc_1', ORG), [])
        assert.equal((await db.findInvoicesByAccount('acc_1', OTHER)).length, 1)
      })

      it('hides a payment, and returns none for the account', async () => {
        await seedAccounts()
        const theirs = await aPayment(OTHER, 'key_other')

        assert.equal(await db.findTransactionById(theirs.id, ORG), null)
        assert.deepEqual(await db.findTransactionsByAccount('acc_1', ORG), [])
      })

      it('hides a credit note', async () => {
        await seedAccounts()
        await db.createCreditNote(
          { amount: 2500, currency: 'USD', reason: 'GOODWILL', createdBy: 'operator_1', accountId: 'acc_1' },
          OTHER
        )
        assert.deepEqual(await db.findCreditNotesByAccount('acc_1', ORG), [])
        assert.equal((await db.findCreditNotesByAccount('acc_1', OTHER)).length, 1)
      })

      it('hides a cash row', async () => {
        const theirs = await aLedgerEntry(db, OTHER)
        assert.equal(await db.findLedgerEntryById(theirs.id, ORG), null)
        assert.equal(
          await db.findLedgerEntryByTemplateMonth('tpl_missing', '2026-02', ORG),
          null
        )
      })

      it('hides a recurring template', async () => {
        const theirs = await db.createRecurringExpenseTemplate(
          { name: 'Rent', category: 'RENT', amount: 420000, currency: 'USD', dayOfMonth: 1, createdBy: 'operator_1' },
          OTHER
        )
        assert.equal(await db.findRecurringExpenseTemplateById(theirs.id, ORG), null)
        assert.deepEqual(await db.findActiveRecurringExpenseTemplates(ORG), [])
      })

      it('hides an event row', async () => {
        await db.createEventLog(
          { type: 'INVOICE_CREATED', payload: {}, actorId: 'operator_1', actorType: 'HUMAN', idempotencyKey: 'shared_key' },
          OTHER
        )
        assert.equal(await db.findEventLogByKey('shared_key', ORG), null)
        assert.notEqual(await db.findEventLogByKey('shared_key', OTHER), null)
      })

      it('lets the same idempotency key be used once per tenant', async () => {
        // Keys are scoped to a tenant. Two customers of the same host must not
        // be able to collide with each other's keys.
        const row = {
          type:           'INVOICE_CREATED' as const,
          payload:        {},
          actorId:        'operator_1',
          actorType:      'HUMAN' as const,
          idempotencyKey: 'same_key',
        }
        await db.createEventLog(row, ORG)
        await db.createEventLog(row, OTHER)
        assert.notEqual(await db.findEventLogByKey('same_key', ORG), null)
        assert.notEqual(await db.findEventLogByKey('same_key', OTHER), null)
      })
    })

    // ── Allocations: the rows with no tenant column ─────────────────────────

    describe('allocations are reached through a parent that carries the tenant', () => {
      it('does not return another tenant allocations for an account', async () => {
        await seedAccounts()
        const invoice = await anInvoice(OTHER)
        const payment = await aPayment(OTHER, 'key_other')
        await db.createAllocation(
          { amount: 10000, createdBy: 'operator_1', transactionId: payment.id, invoiceId: invoice.id },
          OTHER
        )

        assert.deepEqual(await db.findAllocationsByAccount('acc_1', ORG), [])
        assert.deepEqual(await db.findAllocationsByInvoice(invoice.id, ORG), [])
        assert.deepEqual(await db.findAllocationsByTransaction(payment.id, ORG), [])
        assert.equal((await db.findAllocationsByAccount('acc_1', OTHER)).length, 1)
      })

      it('does not let one tenant delete another tenant allocation', async () => {
        await seedAccounts()
        const invoice = await anInvoice(OTHER)
        const payment = await aPayment(OTHER, 'key_other')
        const allocation = await db.createAllocation(
          { amount: 10000, createdBy: 'operator_1', transactionId: payment.id, invoiceId: invoice.id },
          OTHER
        )

        await db.deleteAllocation(allocation.id, ORG)

        assert.equal((await db.findAllocationsByInvoice(invoice.id, OTHER)).length, 1)
      })

      it('treats deleting a row that is not there as a no-op', async () => {
        await db.deleteAllocation('alloc_that_never_existed', ORG)
      })

      it('refuses a second allocation from one payment to one charge', async () => {
        // applyCredit depends on this: there is no updateAllocation on the
        // port, so a second row for the same pair would double-spend.
        await seedAccounts()
        const invoice = await anInvoice(ORG)
        const payment = await aPayment(ORG, 'key_1')
        const input = {
          amount:        1000,
          createdBy:     'operator_1',
          transactionId: payment.id,
          invoiceId:     invoice.id,
        }
        await db.createAllocation(input, ORG)
        await assert.rejects(() => db.createAllocation(input, ORG), UniqueViolationError)
      })
    })

    // ── Voided rows leave the reads ─────────────────────────────────────────

    describe('voided rows drop out of the reads that spend them', () => {
      it('excludes a voided payment from the account payments', async () => {
        // The rule with the widest blast radius in the whole port. A voided
        // payment that still appears here reads as standing credit, and the
        // money that was reversed can be spent a second time.
        await seedAccounts()
        const payment = await aPayment(ORG, 'key_1')
        assert.equal((await db.findTransactionsByAccount('acc_1', ORG)).length, 1)

        await db.voidTransaction(payment.id, { voidedBy: 'operator_1' }, ORG)

        assert.deepEqual(await db.findTransactionsByAccount('acc_1', ORG), [])
        // Still readable by id: voiding is history, not deletion.
        const voided = await db.findTransactionById(payment.id, ORG)
        assert.notEqual(voided, null)
        assert.equal(voided?.amount, 10000)
        assert.ok(voided?.voidedAt instanceof Date)
      })

      it('excludes a voided cash row from the rows of its payment', async () => {
        await seedAccounts()
        const payment = await aPayment(ORG, 'key_1')
        const entry = await db.createLedgerEntry(
          {
            direction:     'IN',
            category:      'SALES',
            amount:        10000,
            currency:      'USD',
            occurredAt:    new Date('2026-02-01T00:00:00Z'),
            month:         '2026-02',
            source:        'PAYMENT',
            createdBy:     'operator_1',
            transactionId: payment.id,
          },
          ORG
        )
        assert.equal((await db.findLedgerEntriesByTransaction(payment.id, ORG)).length, 1)

        await db.voidLedgerEntry(entry.id, { voidedBy: 'operator_1' }, ORG)

        assert.deepEqual(await db.findLedgerEntriesByTransaction(payment.id, ORG), [])
      })

      it('excludes a deactivated template from the active ones', async () => {
        const template = await db.createRecurringExpenseTemplate(
          { name: 'Rent', category: 'RENT', amount: 420000, currency: 'USD', dayOfMonth: 1, createdBy: 'operator_1' },
          ORG
        )
        assert.equal((await db.findActiveRecurringExpenseTemplates(ORG)).length, 1)

        await db.deactivateRecurringExpenseTemplate(template.id, ORG)

        assert.deepEqual(await db.findActiveRecurringExpenseTemplates(ORG), [])
        // Still readable by id: posted rows point at it.
        assert.notEqual(await db.findRecurringExpenseTemplateById(template.id, ORG), null)
      })
    })

    // ── The idempotency anchor ──────────────────────────────────────────────

    describe('the event log is the idempotency anchor', () => {
      it('rejects a duplicate key in the same tenant', async () => {
        // The service reads the log before opening its transaction, and that
        // read can lose a race. This constraint is what cannot.
        const row = {
          type:           'TRANSACTION_RECORDED' as const,
          payload:        { amount: 1000 },
          actorId:        'operator_1',
          actorType:      'HUMAN' as const,
          idempotencyKey: 'racing_key',
        }
        await db.createEventLog(row, ORG)

        // Not a generic unique violation: the store knows which of its
        // constraints means "duplicate key" and says so. The services key off
        // this type to turn a lost race into IdempotencyError; which physical
        // constraint it was is the store's business.
        await assert.rejects(() => db.createEventLog(row, ORG), DuplicateIdempotencyKeyError)
      })

      it('round-trips the payload', async () => {
        const payload = { amount: 1000, nested: { ids: ['a', 'b'] }, flag: true, nothing: null }
        await db.createEventLog(
          { type: 'TRANSACTION_RECORDED', payload, actorId: 'operator_1', actorType: 'HUMAN', idempotencyKey: 'payload_key' },
          ORG
        )
        const found = await db.findEventLogByKey('payload_key', ORG)
        assert.deepEqual(found?.payload, payload)
      })

      it('keeps the system actor and the job id', async () => {
        await db.createEventLog(
          {
            type:           'RECURRING_EXPENSE_MATERIALIZED',
            payload:        {},
            actorId:        'system',
            actorType:      'SYSTEM',
            jobId:          'job_42',
            idempotencyKey: 'system_key',
          },
          ORG
        )
        const found = await db.findEventLogByKey('system_key', ORG)
        assert.equal(found?.actorType, 'SYSTEM')
        assert.equal(found?.jobId, 'job_42')
      })
    })

    // ── Locking and transactions ────────────────────────────────────────────

    describe('locking and transactions', () => {
      it('returns the account from lockAccount, and null across tenants', async () => {
        await seedAccount('acc_1', ORG)
        const locked = await db.lockAccount('acc_1', ORG)
        assert.equal(locked?.id, 'acc_1')
        assert.equal(await db.lockAccount('acc_1', OTHER), null)
        assert.equal(await db.lockAccount('acc_missing', ORG), null)
      })

      it('makes writes inside a transaction visible after it commits', async () => {
        await seedAccount('acc_1', ORG)
        const id = await db.runTransaction(async tx => {
          const invoice = await tx.createInvoice(
            { amount: 5000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), accountId: 'acc_1' },
            ORG
          )
          return invoice.id
        })
        assert.notEqual(await db.findInvoiceById(id, ORG), null)
      })

      it('joins the open transaction rather than opening a second one', async () => {
        // A service may call runTransaction on a store it was handed inside
        // another transaction. Re-entering would either deadlock or open an
        // independent transaction that could commit while the outer one rolls
        // back.
        await seedAccount('acc_1', ORG)
        const id = await db.runTransaction(async tx =>
          tx.runTransaction(async inner => {
            const invoice = await inner.createInvoice(
              { amount: 5000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), accountId: 'acc_1' },
              ORG
            )
            return invoice.id
          })
        )
        assert.notEqual(await db.findInvoiceById(id, ORG), null)
      })

      if (options.supportsRollback) {
        it('leaves nothing behind when the body throws', async () => {
          await seedAccount('acc_1', ORG)

          await assert.rejects(() =>
            db.runTransaction(async tx => {
              await tx.createInvoice(
                { amount: 5000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), accountId: 'acc_1' },
                ORG
              )
              throw new Error('something went wrong after the write')
            })
          )

          assert.deepEqual(await db.findInvoicesByAccount('acc_1', ORG), [])
        })

        it('releases the idempotency key when the transaction rolls back', async () => {
          // This is the reason the event row is written inside the same
          // transaction as the data. If the key survived a rollback, a failed
          // operation could never be retried.
          await assert.rejects(() =>
            db.runTransaction(async tx => {
              await tx.createEventLog(
                { type: 'INVOICE_CREATED', payload: {}, actorId: 'operator_1', actorType: 'HUMAN', idempotencyKey: 'rolled_back_key' },
                ORG
              )
              throw new Error('failed after the event row')
            })
          )

          assert.equal(await db.findEventLogByKey('rolled_back_key', ORG), null)

          // And the same key works afterwards.
          await db.createEventLog(
            { type: 'INVOICE_CREATED', payload: {}, actorId: 'operator_1', actorType: 'HUMAN', idempotencyKey: 'rolled_back_key' },
            ORG
          )
          assert.notEqual(await db.findEventLogByKey('rolled_back_key', ORG), null)
        })
      }
    })

    // ── Round trips ─────────────────────────────────────────────────────────

    describe('what goes in comes back', () => {
      it('keeps amounts as exact integers in minor units', async () => {
        await seedAccount('acc_1', ORG)
        // A number that a float would round, and one near the safe ceiling.
        for (const amount of [1, 4999999, 90071992547409]) {
          const invoice = await db.createInvoice(
            { amount, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), accountId: 'acc_1' },
            ORG
          )
          const found = await db.findInvoiceById(invoice.id, ORG)
          assert.equal(found?.amount, amount)
          assert.ok(Number.isInteger(found?.amount))
        }
      })

      it('keeps instants as Dates, to the millisecond', async () => {
        await seedAccount('acc_1', ORG)
        const dueDate = new Date('2026-03-31T23:59:58.123Z')
        const invoice = await db.createInvoice(
          { amount: 1000, currency: 'USD', status: 'PENDING', dueDate, accountId: 'acc_1' },
          ORG
        )
        const found = await db.findInvoiceById(invoice.id, ORG)
        assert.ok(found?.dueDate instanceof Date)
        assert.equal(found?.dueDate.getTime(), dueDate.getTime())
      })

      it('keeps an absent optional as null, never as undefined', async () => {
        await seedAccount('acc_1', ORG)
        const invoice = await db.createInvoice(
          { amount: 1000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), accountId: 'acc_1' },
          ORG
        )
        const found = await db.findInvoiceById(invoice.id, ORG)
        assert.equal(found?.month, null)
        assert.equal(found?.reference, null)
        assert.equal(found?.notes, null)
        assert.equal(found?.createdBy, null)
      })

      it('updates a charge status and leaves the rest alone', async () => {
        await seedAccount('acc_1', ORG)
        const invoice = await db.createInvoice(
          { amount: 1000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-03-31T00:00:00Z'), notes: 'keep me', accountId: 'acc_1' },
          ORG
        )
        const updated = await db.updateInvoice(invoice.id, { status: 'PAID' }, ORG)
        assert.equal(updated.status, 'PAID')
        assert.equal(updated.notes, 'keep me')
        assert.equal(updated.amount, 1000)
      })

      it('orders charges oldest first', async () => {
        // The waterfall depends on this order for its "oldest debt first" rule.
        await seedAccount('acc_1', ORG)
        const first = await db.createInvoice(
          { amount: 1000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-01-31T00:00:00Z'), month: '2026-01', accountId: 'acc_1' },
          ORG
        )
        const second = await db.createInvoice(
          { amount: 1000, currency: 'USD', status: 'PENDING', dueDate: new Date('2026-02-28T00:00:00Z'), month: '2026-02', accountId: 'acc_1' },
          ORG
        )
        const found = await db.findInvoicesByAccount('acc_1', ORG)
        assert.deepEqual(found.map(i => i.id), [first.id, second.id])
      })

      it('finds a posted template row by template and month, and only that month', async () => {
        const template = await db.createRecurringExpenseTemplate(
          { name: 'Rent', category: 'RENT', amount: 420000, currency: 'USD', dayOfMonth: 1, createdBy: 'operator_1' },
          ORG
        )
        await db.createLedgerEntry(
          {
            direction:  'OUT',
            category:   'RENT',
            amount:     420000,
            currency:   'USD',
            occurredAt: new Date('2026-02-01T09:00:00Z'),
            month:      '2026-02',
            source:     'RECURRING',
            createdBy:  'system',
            templateId: template.id,
          },
          ORG
        )

        assert.notEqual(await db.findLedgerEntryByTemplateMonth(template.id, '2026-02', ORG), null)
        assert.equal(await db.findLedgerEntryByTemplateMonth(template.id, '2026-03', ORG), null)
        assert.equal(await db.findLedgerEntryByTemplateMonth(template.id, '2026-02', OTHER), null)
      })
    })
  })
}

/**
 * The fallback for a store that keeps its rows in a `seed` object, which is
 * how `InMemoryLedgerStore` works. Any other store passes `seedAccount`.
 */
function defaultSeedAccount(currentStore: () => LedgerStore) {
  return async (id: string, organizationId: string): Promise<void> => {
    const seedable = currentStore() as {
      seed?: { accounts: { id: string; organizationId: string }[] }
    }
    if (!seedable.seed?.accounts) {
      throw new Error(
        'runLedgerStoreContractTests: this store has no `seed.accounts` to push onto, ' +
          'so it needs a `seedAccount` in the options: ' +
          '{ seedAccount: (id, organizationId) => insertAccountRow(id, organizationId) }'
      )
    }
    const already = seedable.seed.accounts.some(
      a => a.id === id && a.organizationId === organizationId
    )
    if (!already) {
      seedable.seed.accounts.push({ id, organizationId })
    }
  }
}

/** A standalone cash row, for the isolation cases. */
async function aLedgerEntry(db: LedgerStore, organizationId: string) {
  return db.createLedgerEntry(
    {
      direction:  'OUT',
      category:   'SUPPLIES',
      amount:     1400,
      currency:   'USD',
      occurredAt: new Date('2026-02-01T00:00:00Z'),
      month:      '2026-02',
      source:     'MANUAL',
      createdBy:  'operator_1',
    },
    organizationId
  )
}
