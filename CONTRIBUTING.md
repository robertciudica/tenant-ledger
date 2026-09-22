# Contributing

Issues and pull requests are welcome. This is a small package with a narrow
scope, so the most useful thing to know is what belongs in it.

## Running it

```sh
npm ci
npm run demo    # the whole ledger end to end, on Postgres in WebAssembly
npm run bench   # queries per operation; the number to keep flat
npm test        # no database, no network, no environment variables
npm run lint
npm run typecheck
npm run build
```

The Postgres tests run on PGlite, which is Postgres compiled to WebAssembly,
so `npm test` covers the SQL store with nothing installed. The concurrency
tests need two connections and therefore a real server:

```sh
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Without `DATABASE_URL` those tests skip and say so. CI runs them against
Postgres 16 and 18.

## What belongs here

The ledger records what is owed, what was paid, what covers what, and what
moved. It does not decide amounts. If a change would make the package need to
know what a charge is *for*, it belongs in the caller.

Nothing in `src/` may import a database driver, an HTTP library, or the file
system. Storage goes through `LedgerStore`. That rule is why this package
could be extracted from an application in the first place, and it is worth
more than any single feature.

There are no runtime dependencies, and adding one needs a good argument.

## The rules a change must not break

They are listed in the README under "The rules it enforces" and again in
`AGENTS.md`, and each has a test whose name says which rule it covers. The
short version:

1. Money is integer minor units. No floating point, ever.
2. Recorded amounts are never mutated. Corrections are void plus re-add.
3. Balances and statuses are derived on read. Do not add a stored balance.
4. Every mutating method takes an idempotency key, checks the event log first,
   and writes the event row inside the transaction.
5. Every storage call passes `organizationId`.
6. Every operation that allocates takes `lockAccount` first.

## Tests

New behaviour needs a test whose name says what rule or case it covers. If you
touch `LedgerStore`, add the case to `src/testing/store-contract.ts` rather
than to one store's own tests: a rule that only one implementation is held to
is not a rule about the port.

Tests written for this package, as opposed to ported from the original
application, carry the comment `// added during extraction, not from Lumo`.
Keep that convention: it is how a reader tells what has been running in
production from what has not.

## Style

`npm run lint` is the arbiter. Beyond it: no semicolons, single quotes, and
comments that say why rather than what. A comment explaining an unusual
decision, especially one that looks wrong at first glance, is the most
valuable thing in a diff.

## Releasing

Publishing is done by `.github/workflows/publish.yml` on a version tag,
through npm trusted publishing. There is no npm token anywhere: the workflow
authenticates with an OIDC token that npm has been told to accept from this
repository and this workflow file, and npm attaches provenance to the release.

```sh
# Add the entry to CHANGELOG.md, then stage it so the bump commits it.
git add CHANGELOG.md
npm version patch        # or minor, or major. Bumps package.json, commits, tags.
git push --follow-tags
```

The workflow refuses if the tag and `package.json` disagree, then runs
`npm publish`, whose `prepublishOnly` runs lint, typecheck, tests and the
build. A failure anywhere leaves the registry untouched.

If the trusted publisher on npmjs.com is ever recreated, it must name
`robertciudica/tenant-ledger`, workflow `publish.yml`, with `npm publish`
allowed, and package publishing access should stay on "require two-factor
authentication and disallow tokens".

## Reporting something

A bug in a ledger can be a money bug. If you think you have found one that
lets money be double-counted, lost, or read across tenants, see
[SECURITY.md](SECURITY.md) before opening a public issue.
