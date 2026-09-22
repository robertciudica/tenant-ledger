/**
 * Testing tools, imported as `tenant-ledger/testing`.
 *
 * Three things: a complete in-memory store, fixture factories for its rows,
 * and the contract suite that any store implementation should be able to pass.
 * They ship in the package rather than staying in its test folder because
 * anyone writing a store against `LedgerStore` needs a reference
 * implementation and a way to check their own.
 */

export { InMemoryLedgerStore } from './InMemoryLedgerStore'

export {
  accountFactory,
  invoiceFactory,
  transactionFactory,
  allocationFactory,
  creditNoteFactory,
  ledgerEntryFactory,
  recurringExpenseTemplateFactory,
  eventLogFactory,
} from './factories'

export { runLedgerStoreContractTests } from './store-contract'
export type { LedgerStoreContractOptions } from './store-contract'
