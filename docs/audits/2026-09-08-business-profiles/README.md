# Business profiles: implementation and release record

Date: 2026-09-08. Local implementation; production has not been migrated, enabled or deployed.
The working tree contained substantial unrelated work before this task. No reset, commit,
production write, live marketplace authorization or outbound email was performed.

## Behavior delivered

One Nexus login can own or join several business profiles. Xavia Racing can connect its
Amazon and eBay accounts in one profile; another profile can connect a different eBay account.
Several accounts on one channel are supported. Each business owns its catalog, stock,
settings, connections, team and custom roles. Existing records are retained in an initial
legacy business when the migration’s ownership preconditions are satisfied.

Creation atomically creates owner access, business defaults and an independent warehouse.
Profiles can be renamed, archived and restored. Invitations are email-bound, expiring,
single-use private links; the interface does not claim an email was sent. Last-owner and
stale-edit checks protect team administration. Business settings now use Nexus controls,
validate country/currency/timezone, save with an audit in a transaction and reject stale tabs.

Routes, database operations, jobs, inbound events, caches and account credentials carry a
business context. Switching drops old record/account selections and guards registered
unsaved forms and pending product-editor writes. Personal identity/security remain separate.
Disconnecting a seller preserves its owning business; ordinary reconnect cannot transfer it.

### Follow-up: choose the destination when connecting

New channel connections now open a Nexus dialog with an explicit business-profile choice,
prefilled from the current page. Both the Accounts and Connect tabs use it. Profiles are
offered according to their own live membership permissions (`channels.connect` or Owner);
roles from different businesses are never combined. The dialog links to profile creation.
Several eBay/Amazon accounts can be connected to the same business. Reconnect pins the
existing account and its current business.

The chosen profile is sent explicitly on the start request and is retained by the OAuth
session. A callback uses that initiating membership even if the operator switches profiles
while signing in; revoked access stops completion before credential exchange. The popup
bridge correlates workspace, channel and OAuth state, consumes the success once and clears
its close timer. Callback acknowledgements include the same state. Provider labels are
escaped before embedding the response in a script. Success names the destination and offers
a link when the new account belongs to a different profile from the current page.

Follow-up verification: API/Web TypeScript, Web tokens and raw-control ratchet passed.
PostgreSQL workspace tests: 31 passed; OAuth service tests: 40 passed; callback page: 1 passed.
Web channel data/detail/matcher tests: 53 passed; popup bridge: 3 passed. Browser checks passed
for the current-profile default, changing the choice by keyboard, fixed reconnect destination,
Escape/focus restoration, Tab/Shift-Tab containment, desktop light and 390px mobile dark
presentation (350px dialog, no internal horizontal overflow). The local fixture has no live
provider credentials; no real seller consent was performed.

The subsequent approved implementation retains one owning profile per seller account and
adds reviewed assignment for unused, disconnected accounts, described below. Simultaneous
ownership in several profiles is not enabled.

### Follow-up: scalable directory and reviewed assignment

The corrected business name is **Xavia Racing**. Current examples and fixtures use it;
earlier screenshots and historical test descriptions below retain their original captured text.

The header pins the active profile even beyond its 12-result shortlist. Search, Create and
Manage remain available. The manager and nested account destination picker use server-side
search and cursor pagination, retaining only the current page of results. Creation has no
hard count limit. Search checks live membership and requested connection/Owner permission;
archived profiles are available only to their owners. Changing filters hides stale results,
aborts obsolete requests and resets pagination. A revoked selected profile is cleared on error.

Channels includes disconnected accounts for administration. Connect counts and diagnostics
still use active accounts. The chosen profile is announced by the destination button, including
its selected name. Reconnect fixes the owning profile. Inactive accounts omit Test, Make primary
and Disconnect; recorded revoked status remains visible.

`Assign profile` reviews live Owner access to both profiles, verified seller ownership,
active/legacy credentials, refresh leases, pending sign-ins, recorded sync/inbound/outbound
activity and declared/scalar account references. The checks repeat at commit under database
locks. Database timestamps are compared in UTC. The destination gets a new inactive connection
ID and no credentials; it requires fresh marketplace authorization. The source retains its
connection/scopes/events as history and cannot reuse the retired connection. Old jobs keep
their old profile and inactive ID. Seller ownership and both profile audits change atomically.
Repeated commits with the same review are idempotent; a later move makes the old destination stale. Ordinary workspaceId edits remain forbidden.

This is not a migration of account business history: linked listings, orders, policies or
other records block self-service assignment. Reference probes cover declared foreign keys
and legacy connectionId/channelConnectionId/accountId columns; JSON references and external
queue payloads are not rewritten or exhaustively scanned. They retain the source ID, which
is never activated or reused. Requests already sent to a provider cannot be undone by assignment.

Current verification is recorded in `directory-assignment-verification.json`: 37 PostgreSQL
profile tests; 77 OAuth/identity/disconnect tests; 137 Web profile/channel/control tests;
61 mirrored Factory control tests using the Web Vitest configuration (Factory's default glob
does not collect these shared specs). API/Web/Factory types, both token checks and the raw
control ratchet passed. The shared changed component/helper files match between apps; wider
parity still reports 13 existing drifts, 141 upstream-only files and one Factory-only file.

The local migration rehearsal now includes migrations a–e, preserves products/accounts/audit
history, checks all 409 forced-RLS tables and retains scoped uniqueness. The function also
passed with an owner role that cannot bypass RLS, and restores the source scope within the
same transaction after its target insertion.

Browser checks used 27 profiles, including a current profile outside the header shortlist:
pagination, search from page two, header keyboard switching, nested destination search,
assignment success, inactive account visibility and fixed destination on reconnect passed.
An active account was refused. Mobile light/dark review dialogs fit within 390px; keyboard
Escape returned focus to Assign profile. See `assignment-mobile-light.png` and
`assignment-mobile-dark-blocked.png`. This fixture has no live grants and omitted unrelated
shell routes; its notification/Ads diagnostics 404s are outside this verification.

## Automated evidence

| Check | Result |
| --- | --- |
| API, Web and Factory TypeScript checks | Passed |
| Web and Factory token checks | Passed |
| Raw-control ratchet | Passed; business settings replaced existing raw controls with Nexus controls |
| PostgreSQL business/PIM boundary regression, 4 files | 86 passed |
| Redis leases and asynchronous cache isolation, 2 files | 6 passed, including 22-second lease renewal against local Redis |
| Profile timer, existing clustered cron and connection heartbeat, 3 files | 44 passed |
| Job authority, OAuth/auth/CSRF and batch-feed regression, 5 files | 72 passed |
| Latest focused Web settings, navigation, account-panel and studio-save checks, 4 files | 71 passed |
| API proxy credential forwarding and path traversal checks | 2 passed |
| Full Web suite | 262 files passed, 3,524 tests passed, 18 skipped; one socket-dependent suite could not bind inside the sandbox |
| Web socket-dependent suite rerun outside sandbox | 5 passed |
| Full API suite | 554 files passed, 7,028 tests passed, 29 skipped; 4 failing assertions in 2 pre-existing test files, plus 3 socket-dependent suite setup failures |
| API socket-dependent PostgreSQL suites rerun outside sandbox | Covered by the 86 passing PostgreSQL tests above |
| Shared design-system parity report | Reports existing wider drift: 13 files drifted, 142 upstream-only, 1 Factory-only. Changed AccountsPanel source and account-panel helper match in Web/Factory; corresponding documentation was appended to both. |

The full-suite counts are from their individual runs; subsequent targeted tests are not
added to those counts. A passing targeted run does not turn the unrelated full-suite
failures into a clean suite.

The remaining API assertions are:

- `services/__tests__/pim-mapping-revision.test.ts`: two assertions still expect “not found”;
  the existing rollback implementation now rejects direct restoration with `REVIEW_REQUIRED`.
- `services/amazon/flat-file-ufx6-feedops.vitest.test.ts`: two schema-download fixtures lack
  `Response.arrayBuffer()`, which the existing schema-document reader calls.

These behaviors were not reverted or patched merely to obtain green tests.

The database checks include identical SKUs in separate catalogs, unauthorized resource IDs,
nested cross-business relations, raw SQL scope mutation, transaction rollback and reawait,
revocation, last-owner races, invitations, archived access, durable seller ownership,
reactivation destinations, and country-specific default warehouses. Redis test keys use a
unique test namespace and are individually removed; no Redis database was flushed.

## Migration rehearsal

`packages/database/scripts/rehearse-workspace-migration.mjs` created a disposable database
from the pre-feature schema, populated linked products, settings, accounts, an owner and an
immutable audit entry, then applied:

1. `20260908a_business_workspaces`
2. `20260908b_workspace_data_isolation`
3. `20260908c_sync_log_result_columns`

The historical-index variant passed. All 409 inventoried business tables had forced row-level
security. Product IDs, SKUs, prices, parent relationships and the audit record were retained;
2 seeded accounts were retained. Partial/null uniqueness checks were preserved and a second
business could use the same SKU. This is a populated fixture rehearsal, not reconciliation
of production financial totals or inventory.

Baseline schema SHA-256:
`957d0dddae6540f1a333ab32f6329423ceffb90a0282e28100ea56515dad2ca7`.
The session snapshot is `/tmp/nexus-before-business-profiles.prisma`; retain an equivalent
baseline snapshot in the release evidence before running the rehearsal elsewhere.

## Browser evidence

The fixture in `browser-fixture.mts` uses disposable PostgreSQL-compatible storage and the
actual local authentication, profile, team and channel routes. The development Web app uses
the same-origin API proxy. Seeded connections have fake seller IDs and no live credentials.

Verified through the interface:

- Sign-in opens two business profiles. Zavia Racing shows only its Amazon and eBay accounts;
  Second Business shows only its own eBay account.
- Switching retains the current settings section. Creating Third Test Business opens its
  empty accounts page without copying connections or products.
- A Viewer invitation appears in the selected business’s team. No email is sent by this test.
- Archive requires the exact business name; the archived profile moves out of active choices.
  An owner can restore it using the confirmation dialog.
- Two tabs display different business settings. “Save and switch” saves London in Second
  Business; Zavia Racing remains unchanged. A newer Milan edit in another Zavia tab causes
  an older Turin edit to be rejected with a reload instruction.
- Personal profile and security pages open without selecting a business. The email displayed
  in the profile matches the signed-in fixture user.
- The picker and creation dialog were visually checked in light and dark themes. Widths of
  390 px and 320 px fit without horizontal document overflow. Escape closes the creation
  dialog and restores focus to Create profile. Desktop and mobile screenshots were inspected.
  The rebuilt business-settings form also fits at 390 px in both themes.

The fixture deliberately registers only the routes needed for these checks. Its shell’s
404s for unrelated dashboards/notifications are fixture omissions, not a claim that those
features were exercised. Development hot-reload interruptions were resolved by fresh page
loads; final successful flows were checked against the settled application.

## Production rollout conditions

1. Snapshot and reconcile the actual database before migration. Preflight requires a single
   unambiguous legacy settings owner and an active owner for existing data. It stops on
   nonempty legacy account restrictions (`UserRole.channelScope` or pending invitation
   restrictions), rather than broadening access. If such restrictions exist, their migration
   must be designed and verified before enabling this release.
2. Rehearse these migrations against a production-like snapshot and the real PostgreSQL role
   setup. The migration account must be allowed to establish the non-bypass runtime role and
   required grants. Check counts, account attribution, inventory, financial totals and audit
   retention. Do not infer account ownership from display labels.
3. Enable `NEXUS_WORKSPACES_ENABLED=1` consistently in API/workers and build Web with
   `NEXT_PUBLIC_WORKSPACES_ENABLED=1`. Set the server-only `NEXUS_API_PROXY_TARGET` to the API
   origin and verify secure same-origin session/CSRF cookies over HTTPS. Configure a strong
   `NEXUS_UNSUBSCRIBE_SECRET` for newly issued public email links.
4. Verify registered provider redirect URLs and perform controlled owner-authorized Amazon,
   eBay and Ads connection/reconnection checks. Confirm seller identity, permissions, market
   discovery, webhook signatures and account attribution without using production publishing
   as a diagnostic. Provider approval and real account consent were not simulated as success.
5. Resolve or explicitly triage the existing API suite failures and shared design-system drift.
   Exercise the complete deployment stack, search, storage, Redis and event delivery before
   opening it to additional operators. No load benchmark or WCAG AAA certification is claimed.
6. After several businesses contain data, retain the scoped schema/runtime for containment or
   forward fixes. Do not roll back to the former unscoped application or restore an old snapshot
   that discards subsequent business writes. Drain or invalidate old work deliberately.

## Explicit limits

- The current connector registry includes Amazon SP, Amazon Ads, eBay, Shopify and Etsy.
  This ownership layer applies to them and is channel-independent; it does not implement every
  marketplace API. WooCommerce has no registry adapter. Provider app configuration, approvals
  and live account consent are still required; server credentials cannot be borrowed by a new business.
- Cross-business catalog/inventory sharing, consolidated reporting, transfers with business history and
  account-level role restrictions are separate features. Isolation is the default.
- Redis leases prevent normal concurrent schedule execution; they cannot make a request
  already sent to a provider disappear after a network partition. External writes still need
  provider idempotency and reconciliation. Archiving likewise cannot undo an in-flight request.
- Queue monitoring filters jobs by business but some count/list operations scan the shared
  queue in bounded batches. Very large installations will need indexed metrics or queue
  partitioning and workload-based fairness; this work does not assert unmeasured scale.

## Reproduction commands

Run from the repository root with dependencies installed. Socket tests need permission to
bind/connect to loopback. Use test infrastructure and explicit test URLs, never production
credentials. The fixture runner prints its local ports and creates no live provider grants.

```sh
npm run typecheck --workspace=@nexus/api
npm run typecheck --workspace=@nexus/web
npm run typecheck --workspace=@nexus/factory
npm run tokens:check
npm run tokens:check:factory
node scripts/check-raw-primitives-ratchet.mjs
npm run check:ds-parity --workspace=@nexus/factory
REDIS_URL=redis://127.0.0.1:1 npm run test --workspace=@nexus/api
npm run test --workspace=@nexus/web
REDIS_URL=redis://127.0.0.1:1 npm run test --workspace=@nexus/api -- src/services/workspace.vitest.test.ts src/services/pim/product-relationship.vitest.test.ts src/services/pim/mapping/formula-database.vitest.test.ts src/services/pim/channel-value-write.vitest.test.ts
NEXUS_TEST_REDIS_URL=redis://127.0.0.1:6389 REDIS_URL=redis://127.0.0.1:1 npm run test --workspace=@nexus/api -- src/lib/cron/workspace-lease.vitest.test.ts src/lib/workspace-cache.vitest.test.ts
node packages/database/scripts/rehearse-workspace-migration.mjs /tmp/nexus-before-business-profiles.prisma --historical-indexes
node --import tsx docs/audits/2026-09-08-business-profiles/browser-fixture.mts
```

The two modified shared account component/helper sources were compared byte-for-byte.
The config was also evaluated with business mode enabled: 57 legacy redirects preserve their
workspace prefix. Wider parity differences remain independently visible in the parity report.
