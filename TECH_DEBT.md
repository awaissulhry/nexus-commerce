# Tech debt

Outstanding issues identified but deferred for later. Each entry should explain the symptom, where it surfaced, what we worked around, and the suggested proper fix.

## 1. `@fastify/compress` empty-body bug on `/api/orders` list

**Symptom:** `GET /api/orders?page=...&limit=...` returns `200` with `content-encoding: gzip` and `content-length: 0` (empty body) when the client requests gzip. The same payload returns 6+ KB of JSON when `Accept-Encoding: identity` is sent.

**Surfaced at:** Vercel SSR of `/orders` 500'd because `await listRes.json()` saw an empty string.

**Other endpoints affected:** Just this one as far as we've verified. `/api/orders/stats`, `/api/categories/schema`, `/api/products/bulk-fetch`, `/api/pim/fields` all compress correctly. The orders list is also the only route that hands a Prisma result with nested `items` + Decimal `totalPrice` straight into `reply.send()`.

**Workaround:** `apps/web/src/app/orders/page.tsx` requests `Accept-Encoding: identity` on the list call and parses defensively.

**Proper fix:** Reproduce locally with `curl --compressed`, then either:
- Disable global compression and opt-in per route, or
- Change the orders route to `return { … }` instead of `reply.status(200).send(…)` and verify, or
- Pin or upgrade `@fastify/compress` and add a regression test.

## 2. Prisma direct calls from Next.js server components 500 on Vercel

**Symptom:** `/settings/account` returned 500 from Vercel SSR. Page component calls `prisma.accountSettings.findFirst()` directly inside `async function AccountSettingsPage()`. Same shape as several other pages.

**Workaround:** `apps/web/src/app/settings/account/page.tsx` wraps the call in `try/catch` and renders an empty form on failure.

**Proper fix (pattern):** Web app should not import `@nexus/database` from server components. Move the query behind an API endpoint (`GET /api/settings/account`) and have the page `fetch(getBackendUrl() + '/api/settings/account')`. This is a project-wide pattern fix — sweep `apps/web/src/app` for `import { prisma } from '@nexus/database'` in `page.tsx` files and route them through the API.

## 3. Out-of-scope orphan routes (not in sidebar)

Found during the sidebar audit but not linked from `AppSidebar.tsx`. They show up in `pathname.startsWith()` matchers and external links elsewhere — leaving them broken creates confusion later.

| Route | Status | Note |
|---|---|---|
| `/logs` | 500 | Old activity log page; sidebar uses `/sync-logs` now. Either delete or fix and 301 → `/sync-logs`. |
| `/monitoring/sync` | 404 | Mentioned in user spec as a planned home for Sync Health; sidebar still links to `/dashboard/health`. Decide which is canonical, redirect the other. |
| `/settings` (root) | 404 | No index page under `/settings/`. Add a `page.tsx` that redirects to `/settings/channels` or to a real settings landing. |

## 4. `CategorySchema` rows with `schemaVersion: "unknown"`

**Symptom:** First D.3f deployment used the wrong path (`meta.version`) when reading the SP-API envelope. Each fetched type wrote one row with `schemaVersion = "unknown"`. After the path fix, those rows are still in the DB; they sit at the bottom of the per-`(channel, marketplace, productType)` ordering and never get returned (the real-version row always wins on `fetchedAt desc`), but they take up a unique-constraint slot.

**Workaround:** None — just orphans. They expire 24h after creation and don't break anything.

**Proper fix:** Either let them age out and run a one-shot `DELETE FROM "CategorySchema" WHERE "schemaVersion" = 'unknown'` at any point, or accept and ignore. Worth a single cleanup migration if we touch this area again.

## 5. Bulk-ops paste: scrolled-out cells don't show the yellow tint

**Symptom:** When a paste operation targets cells that are currently virtualised out of view (rowVirtualizer hasn't rendered them), only the changes Map gets the entry — the EditableCell's local `draftValue` doesn't get updated because the cell isn't mounted, so its `applyValue` handler isn't in the registry. When the user scrolls back to those cells, they re-mount with `initialValue` from the unsaved products array and `isDirty` evaluates false — no yellow tint, even though a save would still flush them.

**Surfaced at:** Step 4 (paste with preview).

**Workaround:** None for now. The user sees yellow on visible cells immediately and the save still applies all changes (visible + scrolled-out). The mismatch is purely cosmetic and disappears after a save.

**Proper fix:** Pass a `pendingValue` prop down to EditableCell when there's an entry in the changes Map for it. EditableCell's `useState(() => …)` initialiser seeds `draftValue` from `pendingValue ?? initialValue` so the yellow tint shows on first mount. Memo comparator already includes the relevant fields; one extra prop keyed on cellKey is enough.

## 6. SheetJS (`xlsx`) CVE-2023-30533 + maintenance posture

**Symptom / risk:** `xlsx` is used in D.4 (bulk CSV/XLSX upload) to parse user-provided spreadsheets. CVE-2023-30533 is a prototype-pollution issue in older versions; the package's maintenance moved to a CDN/commercial track and the npm tarball is no longer the maintainer's preferred distribution.

**Surfaced at:** D.4 dependency install (`npm audit` flagged it).

**Workaround / current mitigations:**
- Parse-only path on authenticated user input (no `eval`, no dynamic property assignment).
- 50 MB / 50,000 row caps enforced by `@fastify/multipart` config + the upload service.
- The parse result is normalised through the same field-registry validation as the rest of the bulk API, so a malicious cell can't slip through to Prisma as an attacker-controlled key.

**Proper fix:** Replace with `exceljs` (MIT, actively maintained) when we have time to swap. `exceljs` has a slightly different API but supports CSV + XLSX with the same row-shape we need.
