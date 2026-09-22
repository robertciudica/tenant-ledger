/**
 * The README usage example, run as a test.
 *
 * added during extraction, not from Lumo
 *
 * If you edit the example in README.md, edit it here too. This file exists so
 * the example in the README cannot quietly stop compiling or stop being true.
 */

import {
  BillingService,
  LedgerService,
  InMemoryLedgerStore,
} from '../src'

it('README example', async () => {
  const store = new InMemoryLedgerStore()

  const billing = new BillingService(store, { paymentCategory: 'SALES' })
  const cash = new LedgerService(store, {
    in:  ['SALES'],
    out: ['RENT', 'SUPPLIES'],
  })

  const actor = {
    actorId: 'user_7',
    actorPermissions: ['MANAGE_FINANCES', 'RECORD_PAYMENT', 'ADD_CASHBOOK'] as const,
    organizationId: 'tenant_a',
  }

  // An account is just an id inside a tenant. Everything else about the party
  // lives in your system, not here.
  store.seed.accounts.push({ id: 'acc_1', organizationId: 'tenant_a' })

  // Two charges, the older one first.
  const january = await billing.createManualInvoice({
    accountId:   'acc_1',
    amount:      5000, // 50.00, in minor units
    currency:    'EUR',
    dueDate:     new Date('2026-01-31'),
    description: 'January',
    month:       '2026-01',
    createdBy:   actor.actorId,
    actorPermissions: actor.actorPermissions,
    organizationId: actor.organizationId,
  })
  const february = await billing.createManualInvoice({
    accountId:   'acc_1',
    amount:      5000,
    currency:    'EUR',
    dueDate:     new Date('2026-02-28'),
    description: 'February',
    month:       '2026-02',
    createdBy:   actor.actorId,
    actorPermissions: actor.actorPermissions,
    organizationId: actor.organizationId,
  })

  // 70.00 arrives. It covers January in full and 20.00 of February.
  const result = await billing.recordPayment({
    ...actor,
    idempotencyKey: 'payment-2026-02-03-a1b2',
    accountId:      'acc_1',
    payerId:        'person_9',
    amount:         7000,
    currency:       'EUR',
    paymentMethod:  'BANK_TRANSFER',
  })

  // result.allocated === 7000, result.credit === 0

  // Replaying the same key throws IdempotencyError rather than taking the
  // money twice.

  // Money going out is the other ledger.
  await cash.addEntry({
    ...actor,
    idempotencyKey: 'expense-2026-02-03-c3d4',
    direction:      'OUT',
    category:       'SUPPLIES',
    amount:         1250,
    currency:       'EUR',
    note:           'Printer paper',
  })

  // ── assertions, not part of the README snippet ──────────────────────────────
  expect(result.allocated).toBe(7000)
  expect(result.credit).toBe(0)
  expect(store.seed.invoices.find(i => i.id === january.id)?.status).toBe('PAID')
  expect(store.seed.invoices.find(i => i.id === february.id)?.status).toBe('PARTIALLY_PAID')
  // The payment wrote its own IN row; the expense is the OUT row.
  expect(store.seed.ledgerEntries).toHaveLength(2)
})
