# Local checkpoint and canonical Products route — 12 September 2026

The local checkpoint includes the saved catalog, product studio, workspace, channel, design-system, Shopify, audit and output work. It promotes `ProductsNextClient` and its shell to `/products`; `/products/next` permanently redirects to `/products`. Canonical navigation and family links use `/products`, and AppShell avoids a duplicate navigation rail there. Workspace-prefixed redirects follow the existing configuration flag.

## Commits and scope

- `f212c2348`: initial saved-work checkpoint and canonical route (4,735 files).
- `0d6710385`: merge of upstream `015e52b98`, preserving Amazon lifecycle protections alongside workspace isolation.
- The following release-fix commit resolves build/guard failures, centralizes new route database operations and connection lookups, adds the self-service password-change permission, and updates regression fixtures to the Marketplace language authority and frozen legacy localized writer.

Credential backups, local cache directories and Python bytecode are ignored. Source and audit edits that arrived in the shared checkout after the checkpoint remain separate; validation ran in the isolated `release/local-checkpoint-2026-09-12` worktree.

## Verification

- Production Next.js build and API build pass.
- 33 static pre-push guards pass; both generated-token checks pass.
- Account-resolution ratchet: zero ambient lookups. Route database ratchet: 3,431 direct calls, below baseline 3,491.
- RBAC coverage: all 2,675 registered routes mapped; zero unmapped routes.
- Full web suite: 3,834 tests pass; the updated connection-popup file passes all nine tests, including two additional private Amazon completion cases.
- API catalog, formula, security, OAuth, Amazon lifecycle, account and resolver regression run: 164 files pass, 1,911 tests pass, four skipped.
- Follow-up taxonomy/resolver tests: 67 pass. Connection projection/profile tests: seven pass.
- Grid chrome: all 12 density/theme/viewport combinations pass.
- Browser inspection: canonical Products data, one navigation rail, family links, keyboard dialog opening, Escape dismissal and focus restoration; light/dark inspection and mobile layout. Browser viewport and theme restored afterward.
- Production HTTP probe: `/products` returns 200; `/products/next?parent=family%2Fone&tag=a&tag=b` returns 308 with `Location: /products?parent=family%2Fone&tag=a&tag=b`.

## Remaining push prerequisite

The editor-open and studio control-census browser gates require a dedicated authenticated test session. `scripts/studio-browser-auth.mjs` accepts `STUDIO_STORAGE_STATE` or a normal test login through `STUDIO_TEST_EMAIL` and `STUDIO_TEST_PASSWORD`. The existing interactive browser login is not exported. The editor gate currently refuses to run without that input; the control census has not run. The pre-push hook must remain enabled.
