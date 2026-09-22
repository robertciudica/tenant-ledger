/**
 * BillingService.createManualInvoice()
 *
 * Ported from Lumo's src/core/billing/BillingService.createManualInvoice.test.ts.
 *
 * Covers:
 *   - Happy path: creates a charge and an event row in one transaction.
 *   - Rejects non-integer, zero and negative amounts.
 *   - Accepts a past due date: billing a period that has already closed.
 *   - Carries the optional caller reference.
 *   - Throws NotFoundError when the account is not in this tenant.
 */

import { BillingService, InMemoryLedgerStore } from '../src'
import type { CreateManualInvoiceParams } from '../src'
import { NotFoundError, ValidationError, ForbiddenError } from '../src'
import { accountFactory } from '../src/testing/factories'
import { MANAGER, OPERATOR, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_test_1'

/** Tomorrow, UTC midnight. */
function tomorrow(): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** `days` in the past, UTC midnight. */
function daysAgo(days: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

const baseParams: Omit<CreateManualInvoiceParams, 'accountId'> = {
  amount:         2500, // 25.00 in minor units
  currency:       'RON',
  dueDate:        tomorrow(),
  description:    'April pro-rata fee',
  createdBy:      'operator_1',
  actorPermissions: MANAGER,
  organizationId: ORG,
}

function makeService() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const service = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  return { db, service }
}

describe('BillingService.createManualInvoice()', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('creates a charge with PENDING status and the right fields', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
    })

    expect(invoice.status).toBe('PENDING')
    expect(invoice.amount).toBe(2500)
    expect(invoice.currency).toBe('RON')
    expect(invoice.accountId).toBe('acc_1')
    expect(invoice.organizationId).toBe(ORG)
    expect(invoice.month).toBeNull() // no billing period when the caller omits it
  })

  it('persists the billing period when provided', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
      month:     '2026-08', // billed in advance
    })

    expect(invoice.month).toBe('2026-08')
  })

  it('persists the description in the notes field', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId:   'acc_1',
      description: 'My charge description',
    })

    expect(invoice.notes).toContain('My charge description')
  })

  it('appends internal notes after the description', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId:   'acc_1',
      description: 'Pro-rata April',
      notes:       'Signed up on the 15th',
    })

    expect(invoice.notes).toBe('Pro-rata April\n\nSigned up on the 15th')
  })

  it('writes an INVOICE_CREATED event', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
    })

    const logs = db.seed.eventLogs.filter(
      (log) => log.type === 'INVOICE_CREATED' && log.organizationId === ORG
    )
    expect(logs).toHaveLength(1)
    expect(logs[0].payload).toMatchObject({
      accountId: 'acc_1',
      amount:    2500,
      manual:    true,
    })
    expect(logs[0].actorId).toBe('operator_1')
    expect(logs[0].actorType).toBe('HUMAN')
  })

  it('carries the caller reference when provided', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
      reference: 'order_abc123',
    })

    expect(invoice.reference).toBe('order_abc123')
  })

  it('leaves the reference null when it is omitted', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
    })

    expect(invoice.reference).toBeNull()
  })

  it('accepts today as the due date', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    await expect(
      service.createManualInvoice({
        ...baseParams,
        accountId: 'acc_1',
        dueDate:   today,
      })
    ).resolves.not.toThrow()
  })

  // ── Validation errors ─────────────────────────────────────────────────────

  it('throws ValidationError when the amount is zero', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_1', amount: 0 })
    ).rejects.toThrow(ValidationError)
  })

  it('throws ValidationError when the amount is negative', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_1', amount: -500 })
    ).rejects.toThrow(ValidationError)
  })

  it('throws ValidationError when the amount is a non-integer', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_1', amount: 25.5 })
    ).rejects.toThrow(ValidationError)
  })

  it('accepts a past due date: billing a period that has already closed', async () => {
    // This used to throw. The guard was there to catch a typo in a free-text
    // date field, and that field no longer exists: the due date is derived from
    // the billing period. Invoicing for a closed period is an ordinary
    // correction.
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    const invoice = await service.createManualInvoice({
      ...baseParams,
      accountId: 'acc_1',
      dueDate:   daysAgo(1),
    })

    expect(invoice.dueDate).toEqual(daysAgo(1))
  })

  // ── NotFoundError ─────────────────────────────────────────────────────────

  it('throws NotFoundError when the account does not exist in this tenant', async () => {
    const { service } = makeService()

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_ghost' })
    ).rejects.toThrow(NotFoundError)
  })

  it('throws NotFoundError when the account belongs to another tenant', async () => {
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_other' }))

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_1' })
    ).rejects.toThrow(NotFoundError)
  })

  // ── Permission ────────────────────────────────────────────────────────────

  it('refuses an actor without MANAGE_FINANCES', async () => {
    // added during extraction, not from Lumo. Creating a charge decides that
    // somebody owes money; taking money in is a different capability.
    const { db, service } = makeService()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))

    await expect(
      service.createManualInvoice({ ...baseParams, accountId: 'acc_1', actorPermissions: OPERATOR })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(db.seed.invoices).toHaveLength(0)
    expect(db.seed.eventLogs).toHaveLength(0)
  })
})
