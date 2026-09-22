-- tenant-ledger: the schema PostgresLedgerStore expects.
--
-- Apply this as-is, or fold it into your own migrations. What matters is not
-- the file, it is the constraints: the ledger's guarantees are only as good as
-- the ones the database enforces underneath it. Each one below says what
-- breaks without it.
--
-- Conventions:
--   * Money is `bigint`, in minor units. Never numeric, never float.
--   * Every instant is `timestamptz`. Never `date`: drivers disagree about
--     what timezone a bare date is in, and a due date that shifts by a day
--     depending on the driver is a bug you will find at month end.
--   * Enums are CHECK constraints on text, not Postgres ENUM types, so adding
--     a value is a constraint change and not a type migration.
--   * `organization_id` is on every table that can carry it, and is part of
--     every foreign key, so a child row cannot end up under a parent in
--     another tenant.

-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts: the party money is owed by and received from.
-- ─────────────────────────────────────────────────────────────────────────────
-- The ledger stores nothing about an account but its identity. Everything else
-- about the party lives in the host system. If you already have a customers or
-- users table, point the store at a view over it that exposes these two
-- columns; SELECT ... FOR UPDATE works through a simple updatable view.

CREATE TABLE IF NOT EXISTS accounts (
  id              text NOT NULL,
  organization_id text NOT NULL,
  -- Tenant first, and the id is only unique within a tenant. Host-supplied
  -- ids collide across tenants in practice: two customers of the same
  -- installation both have a "customer-1". A primary key on the id alone
  -- would make the second tenant's import fail, or worse, succeed and attach
  -- their charges to the first tenant's account.
  PRIMARY KEY (organization_id, id),
  -- What lets the child tables carry (account_id, organization_id) as a
  -- single foreign key, so a charge cannot point at an account in another
  -- tenant.
  UNIQUE (id, organization_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices: a charge somebody owes, by a date.
-- ─────────────────────────────────────────────────────────────────────────────
-- `status` is a projection of the allocations, and is allowed to lag them.
-- Nothing reads it as the truth; see computeEffectiveStatus.

CREATE TABLE IF NOT EXISTS invoices (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  account_id      text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  status          text NOT NULL
                  CHECK (status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID')),
  due_date        timestamptz NOT NULL,
  month           text CHECK (month IS NULL OR month ~ '^\d{4}-\d{2}$'),
  reference       text,
  notes           text,
  created_by      text,
  -- clock_timestamp(), not now(): now() is the transaction's start time, so
  -- two charges created in one transaction would carry the same instant and
  -- the waterfall's "oldest first" would have nothing to order by.
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The tiebreak. Two charges can still land on the same microsecond, and
  -- "oldest first" has to be a total order or the same payment allocates
  -- differently on two runs. Insertion order is the answer, and a sequence is
  -- the only thing that knows it.
  seq             bigserial NOT NULL,
  FOREIGN KEY (account_id, organization_id) REFERENCES accounts (id, organization_id)
);

-- The waterfall reads every open charge for one account, oldest first.
CREATE INDEX IF NOT EXISTS invoices_org_account_created_idx
  ON invoices (organization_id, account_id, created_at, seq);

-- ─────────────────────────────────────────────────────────────────────────────
-- Financial transactions: money received.
-- ─────────────────────────────────────────────────────────────────────────────
-- An amount here is never mutated. A payment that was wrong is voided, and the
-- row stays as history.

CREATE TABLE IF NOT EXISTS financial_transactions (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  account_id      text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  payment_method  text NOT NULL
                  CHECK (payment_method IN ('CASH', 'CARD', 'BANK_TRANSFER', 'CHECK', 'OTHER', 'IMPORTED')),
  payment_date    timestamptz NOT NULL,
  month           text,
  notes           text,
  idempotency_key text NOT NULL,
  recorded_by     text NOT NULL,
  payer_id        text NOT NULL,
  -- As on invoices: applyCredit spends the oldest payment first, so this has
  -- to be a total order too.
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq             bigserial NOT NULL,
  voided_by       text,
  voided_at       timestamptz,
  void_reason     text,
  -- Void metadata arrives together or not at all.
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  FOREIGN KEY (account_id, organization_id) REFERENCES accounts (id, organization_id)
);

-- findTransactionsByAccount returns live payments only. This index is that
-- query. A reversed payment that came back here would read as standing credit
-- on the account and could be spent a second time.
CREATE INDEX IF NOT EXISTS financial_transactions_org_account_live_idx
  ON financial_transactions (organization_id, account_id, created_at, seq)
  WHERE voided_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Allocations: which payment covers which charge.
-- ─────────────────────────────────────────────────────────────────────────────
-- Deliberately has no organization_id. An allocation joins a payment and a
-- charge that each carry the tenant, and both foreign keys point at rows the
-- tenant already owns, so the tenant of an allocation is fully determined by
-- its parents. A column here would be a second copy of that fact, and the
-- copies could disagree: an allocation stamped with one tenant pointing at a
-- charge in another. Owning the tenant in exactly one place means the
-- question "whose allocation is this" has one answer, and every read reaches
-- allocations through the parent that holds it. The cost is that a store
-- must join to scope them, and the contract suite checks that it does.
--
-- These rows are deleted on reversal rather than flagged. The event log keeps
-- the snapshot. See the README for why.

CREATE TABLE IF NOT EXISTS allocations (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  amount         bigint NOT NULL CHECK (amount >= 0),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_id text NOT NULL REFERENCES financial_transactions (id),
  invoice_id     text NOT NULL REFERENCES invoices (id),
  -- A payment holds at most one allocation per charge. applyCredit relies on
  -- this: there is no updateAllocation on the port, so a second row for the
  -- same pair would be a silent double-spend of the same money.
  CONSTRAINT allocations_txn_invoice_uq UNIQUE (transaction_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS allocations_invoice_idx ON allocations (invoice_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Credit notes: standing credit consumed without money moving.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credit_notes (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  account_id      text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  reason          text NOT NULL
                  CHECK (reason IN ('DISCOUNT', 'CORRECTION', 'REFUND', 'GOODWILL', 'OTHER')),
  notes           text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, organization_id) REFERENCES accounts (id, organization_id)
);

CREATE INDEX IF NOT EXISTS credit_notes_org_account_idx
  ON credit_notes (organization_id, account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Recurring expense templates.
-- ─────────────────────────────────────────────────────────────────────────────
-- day_of_month is capped at 28 by the service, so that every month has one.

CREATE TABLE IF NOT EXISTS recurring_expense_templates (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  name            text NOT NULL,
  category        text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  day_of_month    smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  counterparty_id text,
  note            text,
  active          boolean NOT NULL DEFAULT true,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recurring_expense_templates_org_active_idx
  ON recurring_expense_templates (organization_id, day_of_month)
  WHERE active;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ledger entries: the cash ledger. What moved, which way.
-- ─────────────────────────────────────────────────────────────────────────────
-- `amount` is always positive; the sign is carried by `direction`.

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  category        text NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  month           text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  note            text,
  source          text NOT NULL CHECK (source IN ('PAYMENT', 'MANUAL', 'RECURRING')),
  created_by      text NOT NULL,
  transaction_id  text REFERENCES financial_transactions (id),
  counterparty_id text,
  template_id     text REFERENCES recurring_expense_templates (id),
  voided_by       text,
  voided_at       timestamptz,
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  -- A template posts at most once per month. The service checks first; this is
  -- what holds when two runs of the job check at the same time. NULLs never
  -- collide, so manual and payment rows are unaffected.
  CONSTRAINT ledger_entries_template_month_uq UNIQUE (template_id, month)
);

CREATE INDEX IF NOT EXISTS ledger_entries_org_txn_live_idx
  ON ledger_entries (organization_id, transaction_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS ledger_entries_org_month_idx
  ON ledger_entries (organization_id, month);

-- ─────────────────────────────────────────────────────────────────────────────
-- Event log: one row per mutating operation. Append only.
-- ─────────────────────────────────────────────────────────────────────────────
-- Both the audit trail and the idempotency anchor. It is written inside the
-- same transaction as the data it describes, so a rollback releases the key.

CREATE TABLE IF NOT EXISTS event_log (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id        text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
  job_id          text,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The single most important constraint in this file. The service reads the
  -- event log before opening its transaction, and that read can lose a race.
  -- This cannot. Without it, every idempotency guarantee the package makes is
  -- decoration, and a retried webhook takes the money twice.
  --
  -- PostgresLedgerStore recognises this constraint by name and reports it as
  -- DuplicateIdempotencyKeyError; the ledger above it never sees the name.
  -- Rename it here without renaming it in the store and a lost race becomes
  -- an unhandled error.
  CONSTRAINT event_log_org_key_uq UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS event_log_org_created_idx
  ON event_log (organization_id, created_at);
