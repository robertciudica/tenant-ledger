/**
 * Fixture factories: entities with defaults, for seeding InMemoryLedgerStore.
 *
 * Usage:
 *   store.seed.accounts.push(accountFactory({ organizationId: 'org_2' }))
 *   store.seed.invoices.push(invoiceFactory({ amount: 5000, status: 'PENDING' }))
 *
 * Every value here is synthetic. Ids are `acc_1`-style placeholders, amounts are
 * round numbers, and the clock is frozen at a date in the future so a fixture
 * never accidentally reads as "today".
 */

import type {
  Account,
  Invoice,
  FinancialTransaction,
  Allocation,
  CreditNote,
  LedgerEntry,
  RecurringExpenseTemplate,
  EventLog,
} from '../store'

/** Merges defaults with caller-supplied overrides. */
function factory<T>(defaults: T) {
  return (overrides: Partial<T> = {}): T => ({ ...defaults, ...overrides })
}

const now = new Date('2026-02-01T00:00:00Z')
const dueDate = new Date('2026-02-28T00:00:00Z')

export const accountFactory = factory<Account>({
  id:             'acc_1',
  organizationId: 'org_1',
})

export const invoiceFactory = factory<Invoice>({
  id:        'inv_1',
  amount:    10000, // 100.00 in minor units
  currency:  'USD',
  status:    'PENDING',
  dueDate,
  month:     '2026-02',
  reference: null,
  notes:     null,
  createdBy: null,
  createdAt: now,
  updatedAt: now,
  accountId: 'acc_1',
  organizationId: 'org_1',
})

export const transactionFactory = factory<FinancialTransaction>({
  id:             'txn_1',
  amount:         10000,
  currency:       'USD',
  paymentMethod:  'CASH',
  paymentDate:    now,
  month:          null,
  notes:          null,
  idempotencyKey: 'test-key-1',
  recordedBy:     'operator_1',
  payerId:        'payer_1',
  accountId:      'acc_1',
  organizationId: 'org_1',
  createdAt:      now,
  voidedBy:       null,
  voidedAt:       null,
  voidReason:     null,
})

export const allocationFactory = factory<Allocation>({
  id:            'alloc_1',
  amount:        10000,
  createdBy:     'operator_1',
  createdAt:     now,
  transactionId: 'txn_1',
  invoiceId:     'inv_1',
})

export const creditNoteFactory = factory<CreditNote>({
  id:        'cn_1',
  amount:    5000,
  currency:  'USD',
  reason:    'GOODWILL',
  notes:     null,
  createdBy: 'operator_1',
  createdAt: now,
  accountId: 'acc_1',
  organizationId: 'org_1',
})

export const ledgerEntryFactory = factory<LedgerEntry>({
  id:             'led_1',
  direction:      'IN',
  category:       'SALES',
  amount:         10000,
  currency:       'USD',
  occurredAt:     now,
  month:          '2026-02',
  note:           null,
  source:         'MANUAL',
  createdBy:      'operator_1',
  transactionId:  null,
  counterpartyId: null,
  templateId:     null,
  voidedBy:       null,
  voidedAt:       null,
  voidReason:     null,
  createdAt:      now,
  organizationId: 'org_1',
})

export const recurringExpenseTemplateFactory = factory<RecurringExpenseTemplate>({
  id:             'tpl_1',
  name:           'Office rent',
  category:       'RENT',
  amount:         420000,
  currency:       'USD',
  dayOfMonth:     1,
  counterpartyId: null,
  note:           null,
  active:         true,
  createdBy:      'operator_1',
  organizationId: 'org_1',
})

export const eventLogFactory = factory<EventLog>({
  id:             'evt_1',
  type:           'TRANSACTION_RECORDED',
  payload:        {},
  actorId:        'operator_1',
  actorType:      'HUMAN',
  jobId:          null,
  idempotencyKey: 'test-key-1',
  createdAt:      now,
  organizationId: 'org_1',
})
