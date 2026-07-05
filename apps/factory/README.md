# Nexus Factory OS (`@nexus/factory`) — F1 foundation

Local-first platform for the leather/moto-apparel factory: Gmail-born orders → party-scoped
quoting → production → shipping → review. This workspace is fully separate from the commerce
platform: **own SQLite database, own auth, zero imports from `apps/web`/`apps/api`**
(enforced by `scripts/no-touch-check.mjs`). Canonical docs: `docs/factory/` (F0 gate set +
F1 report).

## Run it (from the repo root)

```bash
npm install                                   # once — links the workspace
npm run setup      -w @nexus/factory          # creates .env + generates the encryption key
npm run db:migrate -w @nexus/factory          # creates data/factory.db
npm run db:seed    -w @nexus/factory          # roles, default price list, stage pipeline
FACTORY_OWNER_EMAIL=you@example.com FACTORY_OWNER_INITIAL_PASSWORD='choose one' \
  npm run bootstrap:owner -w @nexus/factory   # first owner (password never printed)
npm run dev        -w @nexus/factory          # web on http://localhost:3100 + worker
```

## What is live in F1

- Shell with the H10 rail (design-system copy — see `src/design-system/PROVENANCE.md`), the
  11 approved pages as designed empty states, login/sessions/RBAC (shadow mode by default).
- Settings › **Integrations**: Gmail OAuth (Desktop client, label-scoped sync, worker polls
  every 10s), Drive folder + quota, Sendcloud connect with a plan-capability probe.
- Settings › **Import/Export**: Party CSV with dry-run diff; export round-trip.
- Settings › **Health**: worker heartbeat, DB, RBAC mode.
- Primitives: append-only audit log, movement-ledger core, comments + @mentions with real
  notification delivery, SSE events (`/api/events`), ⌘K search palette.

## Guard scripts

```bash
npm run test            -w @nexus/factory   # vitest (ledger, registry, csv, vault, guardrails, field-strip)
npm run check:rbac      -w @nexus/factory   # every API route exports permission + guarded()
npm run check:no-touch  -w @nexus/factory   # zero imports from apps/web|apps/api
npm run check:ds-parity -w @nexus/factory   # DS copy vs canonical drift report
```

## Rules

No page is built ahead of its approved FP-cycle spec (`docs/factory/F0-IA.md`). Never print
secrets. Movement ledger and audit log are append-only. `FACTORY_RBAC_MODE=enforce` before a
second human gets a login.
