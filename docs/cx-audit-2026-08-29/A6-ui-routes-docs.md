# Audit A6 — Channel-connection UI, route ↔ caller cross-reference, docs

Read-only audit, 2026-08-29. Repo `/Users/awais/nexus-commerce`. Every claim carries `path:line`; anything I could not prove from the code is marked **unverified**.

---

## 0. Headline findings

1. **Only eBay has a connect flow in the UI.** `ChannelsClient.tsx:578-586` calls `handleConnectEbay()` for EBAY and shows an info banner `"{name} connector is deferred."` for every other channel; `AccountsPanel` is given `onConnect={{ EBAY: handleConnectEbay }}` only (`ChannelsClient.tsx:383`). Amazon SP-API is env-only (`apps/api/src/index.ts:331-410` synthesises the row at boot). Shopify/WooCommerce/Etsy are env-only via `ConfigManager` (`apps/api/src/utils/config.ts:35-45, 70-82, 107-119`) and render as **"Coming soon"** / **"Connector deferred"** (`ChannelsClient.tsx:424-427, 532-540`). Amazon **Ads** is a manual credentials form (`settings/advertising/page.tsx:368-490`); the LWA OAuth route `GET /api/amazon-ads/auth/connect` (`amazon-ads-auth.routes.ts:271`) has **no caller anywhere in `apps/web`** (grep, §2).
2. **"Connected" = `ChannelConnection.isActive`; "Env-managed"/"Coming soon" = `ChannelConnection.managedBy`** (`connections.routes.ts:58-77` → `packages/database/prisma/schema.prisma` model `ChannelConnection` fields `isActive`, `managedBy`). For Amazon, `isActive` is literally "all six env vars were set at last API boot" (`index.ts:333-340, 380`). For eBay, `lastSyncStatus`/`lastSyncAt` are written mostly by **token refresh** (`ebay-auth.service.ts:280-291`), so the card's "Last sync" is usually the last token refresh, not a sync.
3. **"Healthy" in AccountsPanel = `lastSyncStatus === 'SUCCESS'` and nothing else** (`accounts.routes.ts:127-142`); `null` → "Not yet reported". Token expiry is deliberately ignored (`accounts.routes.ts:20-27`).
4. **Two different "disconnect" semantics**: card **Disconnect** → `POST /api/ebay/auth/revoke` → revokes at eBay, nulls tokens, `isActive=false`, `lastSyncStatus="SUCCESS"` (`ebay-auth.service.ts:380-427`); AccountsPanel **Disconnect** → `POST /api/accounts/:id/disconnect` → `isActive=false`, `lastSyncStatus="FAILED"`, `lastSyncError="Disconnected by operator"`, **tokens left in place, nothing revoked at eBay** (`accounts.routes.ts:358-390`).
5. **The ScopesCard promises something no code does**: "The OAuth callback writes them to connectionMetadata.scopes" (`ChannelDetailClient.tsx:395`); the only writer of `connectionMetadata` in `apps/api/src` is `connections.routes.ts:291` and it writes only `activeMarketplaces`. The card always says "No scopes captured".
6. **The inventory "Sync" button lies.** `SyncTriggerButton` (`ManageInventoryClient.tsx:220`) POSTs to the **Next.js** route `apps/web/src/app/api/sync/amazon/catalog/route.ts`, which just GETs `/api/amazon/products/list` and fabricates `syncId = Date.now()` (`:8, :15`); the status route returns a hard-coded `status: 'success', progress: 100` (`[syncId]/route.ts:13-20`). The API's real `sync.routes.ts` catalog endpoints have **no caller**.
7. **Route ↔ caller**: of **157 routes** across the 25 files + `accounts.routes.ts`, **77 have an in-app caller; 80 do not.** Of the 80, 25 are inbound webhook receivers (external callers by design) and 7 are touched only by `scripts/verify-*.mjs`; **48 routes have no caller anywhere in the repo** (§2.3). All 25 files are registered exactly once (§2.1); none is registered twice.
8. **Two routes can never exist**: `GET /marketplaces/health` and `POST /marketplaces/products/:productId/sync` are declared *inside* the `POST /marketplaces/sync-all` handler, nested in a per-listing `if` (`apps/api/src/routes/marketplaces.ts:485-577`). They are registered only when `sync-all` runs and finds a listing — after `listen()`, which Fastify refuses (exact runtime error message **unverified**; the handler's `try` at `:399` would turn it into a 500). `docs/MARKETPLACE-API-DOCUMENTATION.md` documents both as "Production Ready".
9. **Docs**: of 22 documents, 4 are current, 6 partially stale, 12 dead/superseded (§3).

---

## 1. (a) Channel-connection UI

### 1.1 Design-system usage (summary)

| Screen | DS? | Evidence |
|---|---|---|
| `/settings/channels` cards | Mixed | `AccountsPanel` from `@/design-system/components` (`ChannelsClient.tsx:12`; DS css at `AccountsPanel.tsx:21-22`); `Card` from `@/components/ui/Card` is a DS adapter (`components/ui/Card.tsx:16-29`); `Button`/`Badge` from `@/components/ui` have **no** `design-system` import (grep of both files: none) — hand-rolled; layout is Tailwind utilities (`ChannelsClient.tsx:339-356, 365-367, 403-410`) |
| `/settings/channels/[type]` | No | imports only lucide/`cn`/`useSettingsForm` (`ChannelDetailClient.tsx:25-44`); local `Card`/`Stat`/`Pill` (`:577-646`); Tailwind |
| `/settings/channels/ebay-callback` | No | Tailwind `gray-*`/`blue-*` (`EbayCallbackContent.tsx:128-190`) |
| `/settings/webhooks` | No | Tailwind, native `window.confirm` (`WebhooksClient.tsx:476`) |
| `/settings/mappings` (+`_shared`, `canvas`) | Mixed | DS `Listbox` + DS css (`MappingsClient.tsx:37-43`, `TransformsEditor.tsx:22-24`); rest Tailwind |
| `/settings/api-keys` | Mixed | DS `Listbox` + DS css (`ApiKeysClient.tsx:39-41`); rest Tailwind |
| `/settings/advertising` | Mixed | DS `Listbox` + DS css (`page.tsx:10-12`); `Card` adapter; native `confirm`/`alert` (`:152,158,168,182,201,207,214,221`) |

### 1.2 Settings tabs (`apps/web/src/app/settings/_shell/settings-nav.ts:76-335`)

Account → Profile (`:82`), Notifications (`:91`) · Team & access → Team & Access (`:114`) · Workspace → Business (`:129`), Company & fiscal (`:145`), Terminology (`:166`) · Catalog → Product families (`:181`), PIM attributes (`:189`), Workflows (`:197`), DAM library (`:206`) · **Integrations → Channels (`:222`), Advertising (`:239`), AI providers (`:248`)** · Developer → API keys (`:263`), Webhooks (`:280`) · Compliance & audit → Audit log (`:296`), Data & privacy (`:305`), Security (`:325`). All `status: 'live'`. **`/settings/mappings` is not in the nav** — reachable only by URL/link. The Channels description says "Amazon, eBay, Shopify OAuth connections" (`:226`); only eBay is OAuth.

### 1.3 `/settings/channels` — `page.tsx` + `ChannelsClient.tsx`

**Channel list**: hard-coded `CHANNELS` = AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, ETSY (`ChannelsClient.tsx:92-98`). Data: `GET {backend}/api/connections` (`:160-163`) → `connections.routes.ts:100-139`, which returns **one row per channel** (first active/most-recent wins, `:112-119`) and pads missing channels with `pending:` placeholder rows (`:81-97, :121-125`).

**Field → DB trace** (`connections.routes.ts:58-77`, model `ChannelConnection` in `packages/database/prisma/schema.prisma`):
- `isActive` ← `ChannelConnection.isActive` (`:64`)
- `isManagedBy` ← `ChannelConnection.managedBy ?? "oauth"` (`:60,65`)
- `sellerName` ← `displayName ?? ebaySignInName` (`:66`); `storeName` ← `ebayStoreName` (`:67`)
- `tokenExpiresAt` ← `tokenExpiresAt ?? ebayTokenExpiresAt` (`:69-70`)
- `lastSyncAt/lastSyncStatus/lastSyncError` ← same-named columns (`:71-73`)

**Who writes those columns**:
- Amazon (env row): `seedEnvManagedConnections` at boot — `isActive = amazonConfigured` (six env vars present, `index.ts:333-340, 380`), `displayName = AMAZON_SELLER_ID` (`:341-344, 381`), `lastSyncStatus = "SUCCESS"|"FAILED"` (`:382`), `lastSyncError = "Amazon credentials not configured (…)"` (`:383-385`). `lastSyncAt` is never written for this row → the card never shows a "Last sync" line for Amazon.
- eBay: callback success `isActive=true, lastSyncStatus="SUCCESS", lastSyncAt=now` (`ebay-auth.service.ts:352-366`); **token refresh** `lastSyncAt=now, SUCCESS` (`:280-291`); token failure `FAILED` + message (`:305-310`); revoke `isActive=false, SUCCESS` (`:415-427`); inventory sync result (`ebay.routes.ts:65-71`); orders sync result (`ebay-orders.routes.ts:75-81`); operator disconnect via accounts `FAILED / "Disconnected by operator"` (`accounts.routes.ts:384-386`).

**Badges** (`ChannelsClient.tsx:416-436`): `isConnected = !!connection?.isActive` (`:396`). `isConnected && env` → **Env-managed** (info); `isConnected` → **Connected** (success); `pending` → **Coming soon**; `env && !active` → **Misconfigured** (danger); else **Not connected**. "Details" link → `/settings/channels/{type}` for non-pending (`:441-450`).

**Card body** (only when connected, `:454-488`): Seller, Store, Token expires (relative ≤24h, colour-toned by `formatRelative` `:42-84`), Last sync (`formatRelative(lastSyncAt).text`).

**Buttons** (`:521-593`):
- env + active → italic text `"Managed via API server env vars. Disconnect by removing creds in Railway."` (`:524-526`); env + inactive → red `lastSyncError ?? "Credentials missing — set env vars in Railway."` (`:528-530`).
- pending → disabled secondary **"Connector deferred"** (`:533-540`).
- connected (oauth) → **Test** (`GET /api/ebay/auth/test?connectionId=` `:316-318` → `ebay-auth.ts:572-614`; success banner `"Connection OK. Seller: {signInName ?? '(unknown)'}"` `:325-328`); **Diagnose** (EBAY only, `GET /api/ebay/diagnostics?marketplaceId=EBAY_IT` `:267-270` → `ebay.routes.ts:454-456`; result panel `:493-514` with `recommendation` + three detail lines `:280-296`, fallback `"Diagnostics endpoint unreachable."` `:305`); **Disconnect** (confirm dialog "Disconnect this channel?" / "Existing listings stay live but new syncs will fail until you reconnect." `:236` → `POST /api/ebay/auth/revoke {connectionId}` `:239-243` → `ebay-auth.ts:497-528` → `ebayAuthService.revokeTokens` `ebay-auth.service.ts:380-427`; then refetch; success `"Connection revoked."` `:256`).
  - Latent defect: the Test button is rendered for *any* connected non-env channel but always calls the **eBay** test endpoint (`:313-317`). Harmless today only because eBay is the only oauth channel.
- not connected → **Connect** (`:573-591`): EBAY → `handleConnectEbay()`; others → info banner `"{name} connector is deferred."` (`:582-585`).

**Connect flow (eBay)** (`:185-233`): `window.open('', '_blank', 'width=1000,height=800')` synchronously (`:188`) → `POST /api/ebay/auth/initiate {redirectUri, adoptConnectionId}` (`:193-202` → `ebay-auth.ts:100-142`; body `redirectUri` is ignored, RuName from env `:104-108`; signed state carries `adoptConnectionId` `:112-115`; `promptLogin` default on `:120`) → popup navigated to `authUrl` (`:220-222`), or same-tab fallback if popup blocked (`:225`). Errors: `"Failed to initiate eBay connection"` (`:205`), `data.error || "Failed to generate authorization URL"` (`:211`), `"Connection failed"` (`:229`).

**Return from popup**: `EbayCallbackContent` posts `{type:'nexus:channel-connected', channel:'EBAY', sellerName}` to opener with origin check (`EbayCallbackContent.tsx:91-98`); `ChannelsClient` listens (`:125-145`), bumps `accountsReload`, refetches, and shows `"eBay account connected: {sellerName}."` (`:136-139`).

**Other error strings**: `"Failed to load connections (HTTP n)"` (`:165`), `"Failed to load connections"` (`:178`), `"Failed to revoke connection"` (`:246`), `"Revocation failed"` (`:258`), `"Connection test failed"` / `"Connection test failed: …"` / `"Test failed"` (`:321,331`).

**About card** (`:599-606`) claims "OAuth tokens are refreshed automatically every 30 minutes before expiry" and "Disconnecting revokes the token and stops all syncs" — the second is true only for the card's Disconnect, not the AccountsPanel one (§0.4). Refresh cadence **unverified** in this audit (job `ebay-token-refresh.job.ts` exists, `index.ts:212`).

### 1.4 `AccountsPanel` (`apps/web/src/design-system/components/AccountsPanel.tsx`) — rendered at `ChannelsClient.tsx:381-391`

- Data: `GET /api/accounts` (`AccountsPanel.tsx:108` → `accounts.routes.ts:186-227`; ACTIVE rows only, `:193`). Channels shown = channels present in the payload plus any channel in `onConnect` (`:216-220`) — so a fresh install shows **eBay only** (Amazon appears once the env row is active).
- Row: health dot + label (`deriveLabel` `accounts.routes.ts:92-124`; placeholders "eBay seller (verified)" / raw Amazon merchant id flagged `labelIsPlaceholder`), `Primary` badge, `env-managed` tag, text `HEALTH_TEXT` (`:66-71`: ok→"Healthy", warn→"Degraded", error→"Failing", unknown→"Not yet reported") + `healthReason`, plus `" · no name from the channel — rename it"` (`:275`) and `"identity unavailable — reconnect to enable multi-account"` when `externalAccountId` is null (`:276-283`).
- **Health source**: `deriveHealth` (`accounts.routes.ts:127-142`): `!isActive`→error "Connection is not active"; `SUCCESS`→ok; `PARTIAL`→warn; `FAILED`→error (`lastSyncError` or default); null→unknown "No sync has been reported yet".
- Buttons: colour swatches → `PATCH /api/accounts/:id {accountColor}` (`:153-159` → `accounts.routes.ts:306-330`, 400 `"accountColor must be #rrggbb"` `:132`); **Rename** → `PATCH {accountLabel}` (`:164-174`); **Make primary** → `POST /api/accounts/:id/primary` (`:161-162` → `:332-356`; 409 `"A disconnected account cannot be primary"` `:150-151`); **Reconnect** (non-env) → `onReconnect(a)` → `handleConnectEbay(a.id)` (`ChannelsClient.tsx:388`); **Disconnect** (non-env) → `GET /api/accounts/:id/blast-radius` (`:180` → `:291-304`) → confirm with counts (`describeBlastRadius` `:79-95`) → `POST /api/accounts/:id/disconnect` (`:202` → `:358-390`; 409 `PRIMARY_ACCOUNT` `:184-190`). Env rows get the note `"Set by environment — no grant to revoke"` (`:348`). `"+ Connect (another) {channel} account"` only for channels in `onConnect` (`:363-368`).
- Error strings: `"Accounts unavailable — {err}"` (`:210`), `"HTTP n"`/`"Accounts unavailable"` (`:109-111`), server `error` text verbatim (`:139-145`), `"Could not read what references this account; disconnecting anyway keeps every row."` (`:192`).

### 1.5 `/settings/channels/[type]` — `page.tsx` + `ChannelDetailClient.tsx`

- `page.tsx`: `KNOWN` = amazon/ebay/shopify/woocommerce/etsy (`:15`) → `notFound()` otherwise (`:53`); `GET /api/settings/channels/{type}/detail` (`:34-37` → `connections.routes.ts:146-235`); error `"Failed to load channel detail (HTTP n)"` (`:39`). Pending channels get a `pendingRow` back (`connections.routes.ts:165`) so the page renders "Inactive"/"—".
- Header: **Active/Inactive** pill from `connection.isActive` (`ChannelDetailClient.tsx:247-275`); subtitle `sellerName ?? storeName ?? ('Env-managed' | '—')` (`:261-264`).
- **Token & sync health** (`:315-385`): token expiry pill via `relativeTime` (`:280-307`) or "Env-managed (no token rotation)"; last sync pill toned by `lastSyncStatus` (SUCCESS ok / PARTIAL warn / FAILED danger / else warn `:323-330`) or "never"; "Connected since" = `createdAt` (for the Amazon env row this is the first boot that created it); "Managed by"; `lastSyncError` box (`:377-382`).
- **OAuth scopes** (`:387-412`): always empty — see §0.5.
- **Marketplaces** (`:414-474`): toggle grid from `ALLOWED_MARKETPLACES_BY_CHANNEL` (`:98-104`, duplicated from `connections.routes.ts:327-333`), saved via SaveBar → `PATCH /api/settings/channels/{type}/marketplaces {marketplaces}` (`:157-172` → `connections.routes.ts:246-320`; writes `connectionMetadata.activeMarketplaces` `:288-296` + settings audit `:300-306`). Server errors surfaced verbatim: `"Unsupported marketplaces for X: … Allowed: …"` (`:266-268`), 404 `"No active connection for X. Connect the channel before scoping marketplaces."` (`:278-282`). Note the 404 fires when there is no row at all, but a **revoked** row still matches (`:271-277` does not filter `isActive`), so scoping "succeeds" on a disconnected channel.
- **Recent webhook events** (`:476-557`): last 50 `WebhookEvent` rows for the channel (`connections.routes.ts:182-195`) + ok/failed/pending counts (`:199-207`). Empty text `"No inbound webhook events yet."` (`:499`).
- **Advanced** (`:559-573`): raw `connectionMetadata` JSON.
- The file header promises a "Reconnect / advanced — link back to the … OAuth start URL" card (`:16-17`); no reconnect control exists on the page (grep "Reconnect": only the comment line 16). **No connect/disconnect/sync-now on the detail page.**
- Error strings: `error ?? 'Unable to load channel detail.'` (`:191`), `"HTTP n"` (`:150`), `body?.error ?? "HTTP n"` (`:168`).
- Permission mismatch: `/api/settings/channels/*` resolves to `settingsView`/`settingsWorkspaceEdit` (`permissions-manifest.ts:119`), while `/api/connections` needs `settingsIntegrationsManage` (`:133`).

### 1.6 `/settings/channels/ebay-callback` — `page.tsx` + `EbayCallbackContent.tsx`

- Runs in the popup (or same tab). Reads `code/state/error/error_description` (`:15-18`). Errors shown: `"eBay authorization failed: {desc|error}"` (`:24`), `"Missing authorization code or state parameter"` (`:30`), `"Failed to create channel connection"` (`:55`), server `error.error || "Failed to exchange authorization code"` (`:74`), `"Error: {message|Unknown error occurred}"` (`:118-120`). Error screen has **Back to Channels** → `/settings/channels` (`:184-189`).
- Calls: `POST /api/ebay/auth/create-connection {channelType:'EBAY'}` (`:46-52` → `ebay-auth.ts:54-93`, creates an `isActive:false` row **before** the token exchange `:68-73`; no cleanup of that row on a failed exchange found — **unverified** whether anything sweeps orphans), then `POST /api/ebay/auth/callback {code,state,connectionId,redirectUri}` (`:61-70` → `ebay-auth.ts:149-410`; server verifies the signed state `:194-199`; adopt-intent from state `:206-211`; 409 when unidentified accounts exist and no adopt id `:309-313`; 409 duplicate identity `:359-361`).
- Success: `"✓ eBay connection successful!\n\nSeller: {sellerName|Unknown}"` (`:79-81`), "Redirecting..." (`:161`), `postMessage` to opener then `window.close()` after 1.2 s with `router.push('/settings/channels')` fallback (`:91-115`).

### 1.7 `/settings/webhooks` (outbound subscriptions — not channel connections)

`page.tsx:25` `GET /api/settings/webhooks` → `settings-webhooks.routes.ts:68` (`NotificationWebhook` table `:70`). `WebhooksClient.tsx`: create `POST /api/settings/webhooks` (`:240` → `:95-97`; one-time secret panel `:358-416`), **Pause/Resume** `PATCH /api/settings/webhooks/:id {isActive}` (`:459` → `:195-203`), **Delete** `DELETE …/:id` (`:480` → `:274-276`, native `window.confirm` `:476`), **Test** `POST …/:id/test` (`:442` → `:310-312`; result `"Test → {status|ERR} · {ms}ms · {error}"` `:568-571`). Events list hard-coded (`:51-57`). Note (`:207-217`): "only the Test button fires" — real event delivery not wired. Errors: `"HTTP n"`, `body?.error`. Guard: `settingsWebhooksManage` (`permissions-manifest.ts:112`).

### 1.8 `/settings/mappings`, `_shared`, `canvas` (PIM field mapping — not channel connections)

`MappingsClient.tsx:1-15`: marketplace picker + per-field rule editor; `GET /api/pim/mappings/marketplaces` (`:120`), `GET/PUT/DELETE /api/pim/mappings/:channel/:code[/:fieldKey]` (`:150,174,209`), `POST /api/feed-transform/seed-schemas` (`:235`), `…/sync-schema` (`:267`), `…/validate/:pid` (`:306`), `…/preview/:pid` (`:333`). `_shared/FieldRuleRow.tsx` (one field row, `:1-11`), `TransformsEditor.tsx` (transform DSL builder, `:1-16`), `PayloadPreviewModal.tsx` (dry-run payload, `:1-17`), `ValueMapManagerModal.tsx` (value maps + size scales via `/api/pim/value-maps`, `/api/pim/size-scales`, `:69-152`). `canvas/[channel]/[code]/CanvasClient.tsx:1-20`: two-column click-to-bind canvas using the same PUT/DELETE (`:83,115,141`); `_shared/internalVariables.ts` is the right-hand variable registry. Guard: `pimManage` (`permissions-manifest.ts:351`).

### 1.9 `/settings/api-keys`

Server component reads `prisma.apiKey` directly (`page.tsx:9-11`); mutations are Next server actions (`actions.ts:3-8`, bcrypt). No API routes, no channel relevance.

### 1.10 `/settings/advertising` — Amazon Ads connect UI (`page.tsx`)

- List: `GET /api/advertising/connections` (`:91` → `advertising.routes.ts:12211`; selects `mode`, `writesEnabledAt`, `isActive`, `lastErrorAt`, `lastError` `:12220-12226`) → `AmazonAdsConnection` columns `mode` (default `'sandbox'`), `writesEnabledAt`, `isActive`, `lastError` (schema model `AmazonAdsConnection` lines 10-16).
- **StatusBadge** (`:44-64`): `mode==='production' && writesEnabledAt` → "Live + writes enabled"; `production` → "Live (read-only)"; else "Sandbox". "Server mode: {adsMode}" pill (`:240-243`) from `data.adsMode`; sandbox banner (`:246-252`).
- Card shows `accountLabel ?? profileId`, profile/region/marketplace, `lastError`, test result, and a next-step hint (`:288-294`).
- Buttons: **Test** `POST /api/advertising/ads-connection/test {profileId}` (`:134`; `"Connected — N profile(s) visible"` / `data.error ?? 'Test failed'` `:140-145`); **Promote to production / Back to sandbox** `POST /api/advertising/connection/set-mode` (`:204`, native `confirm` `:198-201`, `alert("Set mode failed: …")` `:207`); **Enable writes** two-step `POST …/connection/preview-writes` then `…/enable-writes {confirmationToken}` (`:161-183`, alerts `:168,182`); **Disable writes** (`:187`); **Allowlist {marketplace} campaigns** `POST /api/advertising/campaigns/live-writes/bulk` (`:217`, alert `:221-222`); **Delete** `DELETE /api/advertising/connections/:profileId` (`:153`, `confirm` `:152`).
- **Connect** = form with Profile ID, label, marketplace/region `Listbox`, Client ID, Client Secret, Refresh Token (`:368-490`) → `POST /api/advertising/connections` (`:110`); success `"Connection saved. Use \"Test\" to verify credentials."` (`:119`); errors `data.error ?? 'Save failed'` (`:117`), `'Network error'` (`:124`). Setup guide (`:494-505`) tells the operator to obtain the refresh token themselves — the server-side OAuth route `GET /api/amazon-ads/auth/connect` is never linked.

### 1.11 Other surfaces that read connection state or offer sync/connect

| Surface | Call | Meaning |
|---|---|---|
| `app/_shared/AppNavRail.tsx:47-59` | `GET /api/connections` | `amazon`/`ebay` booleans from `isActive` |
| `app/products/next/ProductsNextClient.tsx:252-257` | `GET /api/connections` | `activeChannels` roster |
| `components/GlobalAccountChip.tsx:29` | `AccountSwitcher` → `GET /api/accounts` | header chip; worst-health rollup (`AccountSwitcher.tsx:215-232`) |
| `products/[id]/list-wizard/steps/Step1Channels.tsx:233` | `GET /api/listing-wizard/connection-status` | `listing-wizard.routes.ts:278-300`: Amazon = `amazonService.isConfigured()` (env), eBay = active connections > 0, Shopify/Woo `not_implemented` (`:277`) |
| `inventory/manage/ManageInventoryClient.tsx:220` `SyncTriggerButton` | Next route `/api/sync/amazon/catalog` | fabricated sync (§0.6) |
| `components/inventory/ChannelResolverClient.tsx:97-98` (used by `products/resolve/page.tsx`) | relative `POST /api/sync/ebay/listings/:id/link` | no Next route exists for it (`find apps/web/src/app/api`), and `next.config` rewrites only under `NEXT_DEV_STUB_PROXY` (`apps/web/next.config.*:29-33`) → 404 in prod **unless** something else proxies it (**unverified**) |
| `components/dashboard/RealTimeStockMonitor.tsx:29` | relative `/api/webhooks/recent-adjustments` | no such Next route; component has **no importer** (grep) — dead |
| `marketing/content/publish/PublishDashboardClient.tsx:45-72`, `page.tsx:26` | `/api/channel-publish/{amazon,ebay,shopify,woo}`, `_meta/mode` | content publish, not connection |
| `fulfillment/carriers/CarrierConfigDrawer.tsx:2024` | displays `/api/webhooks/sendcloud` URL | copy-to-clipboard only |
| `sync-logs/*`, `inbox/InboxClient.tsx:131-134,172` | `/api/sync-logs/*` | observability; `cron/:job/trigger` is the only "run now" button (`SyncLogsHubClient.tsx:356`, `LeverDrawer.tsx:143`) |
| `fulfillment/stock/sync-control/*` | `/api/stock/sync-control/*` | inventory policy, not connection |

No `/integrations`, `/sync` or `/marketplaces` page with connect/disconnect exists (`grep -rln … apps/web/src/app`, §output).

---

## 2. (b) Route ↔ caller cross-reference

### 2.1 Registration (`apps/api/src/index.ts`) and prefix

| File | `index.ts` line | Prefix | Effective base |
|---|---|---|---|
| connections.routes.ts | 770 | `/api` | `/api/connections`, `/api/settings/channels/…` |
| accounts.routes.ts (added: it backs the panel) | 771 | `/api` | `/api/accounts` |
| ebay-auth.ts | 627 | none | declares literal `/api/ebay/auth/…` |
| amazon-ads-auth.routes.ts | 679 | `/api` | `/api/amazon-ads/…` |
| amazon-auth-probe.routes.ts | 786 | `/api` | `/api/admin/amazon-auth-probe` |
| amazon-notifications.routes.ts | 775 | `/api` | `/api/admin/…` |
| shopify.ts | 620 | none | `/shopify/…` (no `/api`) |
| shopify-setup.routes.ts | 794 | `/api` | `/api/admin/…` |
| shopify-webhooks.ts | 621 | none | `/webhooks/shopify/…` |
| ebay-notification.routes.ts | 776 | `/api` | `/api/admin/…`, `/api/webhooks/ebay-notification` |
| etsy.ts | 624 | none | `/etsy/…` |
| etsy-webhooks.ts | 625 | none | `/webhooks/etsy/…` |
| woocommerce.ts | 622 | none | `/woocommerce/…` |
| woocommerce-webhooks.ts | 623 | none | `/webhooks/woocommerce/…` |
| webhooks.routes.ts | 642 | none | **mixed**: `/api/webhooks/order-created` and `/webhooks/stock-adjustment` in one file |
| settings-webhooks.routes.ts | 668 | `/api` | `/api/settings/webhooks` |
| sync.routes.ts | 626 | `/api` | `/api/sync/…` |
| sync-control.routes.ts | 787 | `/api` | `/api/stock/sync-control/…` |
| sync-logs.routes.ts | 733 | `/api` | `/api/sync-logs/…` |
| inventory-sync-diagnostics.routes.ts | 785 | `/api` | `/api/admin/inventory-sync/diagnostics` |
| marketplaces.routes.ts | 661 | `/api` | `/api/marketplaces`, `/api/sidebar/counts`, `/api/listings/all`, `/api/products/:id/…` |
| marketplaces.ts | 617 | none | `/marketplaces/…` — **second `marketplaces` namespace, no `/api`** |
| channel-publish.routes.ts | 701 | `/api` | `/api/channel-publish/…` |
| product-channel-data.routes.ts | 695 | `/api` | `/api/products/:id/…` |
| sendcloud-webhooks.routes.ts | 643 | none | literal `/api/webhooks/sendcloud` |
| cloudinary-webhook.routes.ts | 702 | `/api` | `/api/assets/_webhooks/cloudinary` |

No file is registered twice. Same-path/different-file duplicates in scope: none (a repo-wide `uniq -d` of declared paths flagged only `/advertising/connections`, `/stock/channel-events`, `/webhooks/ebay-notification` — each is GET+POST of one path in one file, not a duplicate).

### 2.2 Guard

There are **no per-route guards** in any of the 26 files (grep `preHandler|onRequest|requireAuth|…` → only `config:{rawBody:true}` at `ebay-notification.routes.ts:346`). Everything is gated by the single global `preHandler` `rbacHook` (`index.ts:595`, `lib/auth/rbac-hook.ts:34-97`) against `permissions-manifest.ts` (first match wins, `:412-419`). Mode is `shadow` unless `NEXUS_RBAC_MODE=enforce` (`rbac-hook.ts:31-33`) — in shadow, unauthenticated requests are **allowed** (`:81-96`). "Guard" below = manifest rule line → permission (read/write).

### 2.3 Routes, guards, callers

Caller search: exact path fragments over `apps/web/src/**/*.{ts,tsx}` (excluding `apps/web/src/app/api`) and `apps/api/src/**/*.ts` (excluding the declaring file and the manifest, filtered to lines that look like a request/URL), plus `scripts/`, `packages/`, `apps/api/scripts`. Method mismatches were checked by eye. "none" = no caller found.

**connections.routes.ts** (all called)
- `GET /api/connections` `:100` — `:133` settingsIntegrationsManage — `ChannelsClient.tsx:161`, `AppNavRail.tsx:47`, `ProductsNextClient.tsx:252`
- `GET /api/settings/channels/:type/detail` `:146-147` — `:119` settingsView — `channels/[type]/page.tsx:35`, `ChannelDetailClient.tsx:147`
- `PATCH /api/settings/channels/:type/marketplaces` `:246-249` — `:119` settingsWorkspaceEdit — `ChannelDetailClient.tsx:159`

**accounts.routes.ts** (all called by `AccountsPanel.tsx`/`AccountSwitcher.tsx` except diagnostics)
- `GET /api/accounts` `:186` — `:132` dashboard — `AccountsPanel.tsx:108`, `GlobalAccountChip.tsx:29`
- `GET /api/accounts/diagnostics` `:233` — `:125` settingsIntegrationsManage — **none**
- `GET /api/accounts/:id/blast-radius` `:291` — `:132` dashboard — `AccountsPanel.tsx:180`
- `PATCH /api/accounts/:id` `:306-309` — `:132` settingsIntegrationsManage — `AccountsPanel.tsx:133-137`
- `POST /api/accounts/:id/primary` `:332` — `:132` — `AccountsPanel.tsx:162`
- `POST /api/accounts/:id/disconnect` `:358` — `:132` — `AccountsPanel.tsx:202`

**ebay-auth.ts** (registered without prefix; literal `/api/…`)
- `POST /api/ebay/auth/create-connection` `:54-55` — `:137` channelsConnect — `EbayCallbackContent.tsx:46`
- `POST /api/ebay/auth/initiate` `:100-101` — `:137` — `ChannelsClient.tsx:193`
- `POST /api/ebay/auth/callback` `:149-155` — `:83` **PUBLIC** — `EbayCallbackContent.tsx:61`
- `GET /api/ebay/auth/connections` `:413` — `:137` — **none** (superseded by `/api/connections` and `/api/accounts`)
- `GET /api/ebay/auth/connection/:connectionId` `:450-451` — `:137` — **none**
- `POST /api/ebay/auth/revoke` `:497-498` — `:137` — `ChannelsClient.tsx:239`
- `POST /api/ebay/auth/refresh` `:534-535` — `:137` — **none**
- `GET /api/ebay/auth/test` `:572-573` — `:137` — `ChannelsClient.tsx:317`

**amazon-ads-auth.routes.ts** — **no caller for any route**
- `GET /api/amazon-ads/debug/test-auth` `:82` — `:234` adsView — none
- `GET /api/amazon-ads/auth/connect` `:271` — `:82` **PUBLIC** — none (no link/button in `apps/web`)
- `GET /api/amazon-ads/auth/callback` `:302` — `:82` PUBLIC — none in repo (Amazon redirects here; `REDIRECT_URI` from env `:35-36`)
- `POST /api/amazon-ads/backfill` `:480-486` — `:234` adsCampaignsManage (precedes `:401` has('/backfill')) — none

**amazon-auth-probe.routes.ts**
- `GET /api/admin/amazon-auth-probe` `:50` — `:56` **PUBLIC** (self-gated by key, `:51-53`) — **none**

**amazon-notifications.routes.ts** — no in-app caller
- `GET /api/admin/sqs-diagnostic` `:55` — `:404` adminView — scripts only (`scripts/audit-live-sync.mjs`)
- `POST /api/admin/setup-amazon-notifications` `:178` — `:404` adminRepair — **none**
- `GET /api/admin/amazon-notification-status` `:231` — `:404` adminView — scripts only (`scripts/verify-rt5-order-status-coverage.mjs`)

**shopify.ts** (no prefix) — **no caller for any of 7**: `POST /shopify/sync/products` `:40`; `POST /shopify/sync/inventory/to-shopify` `:81-82`; `POST /shopify/sync/inventory/from-shopify` `:134-135`; `POST /shopify/sync/orders` `:182`; `POST /shopify/fulfillments/create` `:221-222`; `GET /shopify/products/:productId` `:266-267`; `GET /shopify/orders/:orderId` `:306-307` — all `:336` listingsView/channelsSync.

**shopify-setup.routes.ts** — no caller: `POST /api/admin/setup-shopify-webhooks` `:82` (`:404` adminRepair; note the manifest's dedicated rule `:134` requires `p.startsWith('/api/shopify')` so it never matches this `/api/admin/…` path); `GET /api/admin/shopify-webhook-status` `:152` (`:404` adminView).

**shopify-webhooks.ts** (no prefix; `:61` PUBLIC; HMAC via `WebhookValidator.validateShopifySignature` `:940`) — inbound receivers, external caller by design: `/webhooks/shopify/products/update` `:926`, `products/delete` `:993`, `inventory/update` `:1060`, `orders/create` `:1127`, `orders/update` `:1194`, `fulfillments/create` `:1261`, `refunds/create` `:1335` (scripts: `smoke-returns-end-to-end.mjs`, `verify-r41-…`), `refunds/create-test` `:1402` (404 in production `:1403-1404`). No in-app caller.

**ebay-notification.routes.ts** (`/api` prefix)
- `GET /api/admin/ebay-token-status` `:115` — `:404` adminView — **none**
- `POST /api/admin/refresh-ebay-tokens` `:154` — `:404` adminRepair — `apps/api/scripts/refresh-ebay-tokens.ts` only
- `POST /api/admin/setup-ebay-notifications` `:199` — adminRepair — `scripts/verify-rt7-ebay-coverage.mjs` only
- `GET /api/admin/ebay-notification-status` `:292` — adminView — scripts only
- `GET /api/webhooks/ebay-notification` `:326` (challenge) and `POST` `:345` — `:62` PUBLIC — external (eBay); scripts only

**etsy.ts** (no prefix, `:338`) — **none for all 6**: `/etsy/sync/listings` `:40`, `/etsy/sync/inventory/to-etsy` `:81-82`, `/etsy/sync/inventory/from-etsy` `:125-126`, `/etsy/sync/orders` `:174`, `/etsy/orders/:orderId/status` `:213-214`, `/etsy/orders/:orderId/fulfillment` `:258-259`.
**etsy-webhooks.ts** (`:61` PUBLIC) — 6 receivers `:317-581`, none called in-repo.
**woocommerce.ts** (`:337`) — **none for all 6** `:40-266`. **woocommerce-webhooks.ts** (`:61` PUBLIC; `x-wc-webhook-signature` `:296`) — 6 receivers `:287-629`, none in-repo.

**webhooks.routes.ts** (no prefix) — `POST /api/webhooks/order-created` `:59` (`:62` PUBLIC) and `POST /webhooks/stock-adjustment` `:137` (`:61` PUBLIC) — scripts only (`scripts/verify-s1-shadow-path.mjs`).

**settings-webhooks.routes.ts** (`:112` settingsWebhooksManage) — all called by `WebhooksClient.tsx`/`page.tsx`: `GET` `:68` (`page.tsx:25`, `WebhooksClient.tsx:76`), `POST` `:95-97` (`:240`), `PATCH /:id` `:195-203` (`:459`), `DELETE /:id` `:274-275` (`:480`), `POST /:id/test` `:310-311` (`:442`).

**sync.routes.ts** (`:384` adminView/syncManage)
- `POST /api/sync/detect-drift` `:42`, `GET …/status` `:58` — scripts only (`scripts/verify-products-rebuild.mjs`)
- `POST /api/sync/amazon/catalog` `:66-67`, `GET …/:syncId` `:149-150`, `POST …/:syncId/retry` `:193-194` — **none** (the web's `SyncTriggerButton.tsx:68,105` and `SyncStatusModal.tsx:41` hit the *Next* routes of the same name, which never call the API — §0.6)

**sync-control.routes.ts** (`:276` inventoryView/inventoryAdjust) — all 10 called from `fulfillment/stock/sync-control/*` (`SyncControlClient.tsx:129,150,234,262,330,372`, `SyncProductsGrid.tsx:104`, `HistoryClient.tsx:51`, `SyncExcelBar.tsx:42,66,84`).

**sync-logs.routes.ts** (`:383` adminView/syncManage) — all 26 called (`sync-logs/*`, `inbox/InboxClient.tsx:131-134,172`, `LeverDrawer.tsx:143`, `products/_shared/ListingHealthGrid.tsx:70`, `ApiCallsClient.tsx:188,195,245,604`, `TimeSeriesChart.tsx:71`, `AlertsClient.tsx:134-256`, `SavedSearchPicker.tsx:67,110,133`, `ErrorGroupsClient.tsx:135,171`, `sync-logs/webhooks/WebhooksClient.tsx:152,184,509`, `FailingListingsModal.tsx:85,114`, `InFlightSyncBar.tsx:65`, `SyncLogsHubClient.tsx:306-356`).

**inventory-sync-diagnostics.routes.ts** — `GET /api/admin/inventory-sync/diagnostics` `:24` — `:404` adminView (the manifest's `:390` `pfx('/api/inventory-sync-diagnostics')` never matches this path) — **none**.

**marketplaces.routes.ts** (`/api`)
- `GET /api/sidebar/counts` `:38` — `:148` dashboard — `AppNavRail.tsx:72`
- `POST /api/marketplaces/seed` `:109` — `:335` channelsSync — **none**
- `GET /api/listings/all` `:132` — `:158` listingsView — **none**
- `GET /api/marketplaces` `:181` — `:335` listingsView — `ListingsWorkspace.tsx:691`
- `GET /api/marketplaces/grouped` `:195` — `edit-data.ts:39`, `BulkOperationsClient.tsx:1540`
- `GET /api/products/:id/all-listings` `:215-216` — `:365` productsView — `ChannelFieldEditor.tsx:678`
- `PATCH …/offer-availability` `:249-253` — productsEdit — `GridView.tsx:973`, `MasterDataTab.tsx:1089`
- `PATCH …/auto-publish-content` `:298-302` — `ChannelListingTab.tsx:150`
- `POST /api/products/bulk-offer-availability` `:335-338` — `BulkActionBar.tsx:1410`
- `GET`/`PUT /api/products/:id/listings/:channel/:marketplace` `:406-409`, `:441-445` — `ChannelFieldEditor.tsx:762,816,890,994`, `useFieldLinks.ts:337`
- `POST …/replicate` `:633-642` — `ChannelListingTab.tsx:794`
- `POST …/pricing` `:752-761` — `PricingPoliciesCard.tsx:186`, `ChannelListingTab.tsx:609`
- `GET …/detect-type` `:808-812` — `ChannelFieldEditor.tsx:2232`
- `GET /api/products/:id/ebay-sibling-categories` `:871-872` — `ChannelFieldEditor.tsx:2174`
- `POST …/save-browse-nodes` `:899-903` — **none**
- `POST …/publish` `:955-959` — `PublishReviewModal.tsx:157`
- `POST /api/products/:id/publish-preflight` `:1153-1157` — `PublishReviewModal.tsx:118`

**marketplaces.ts** (no prefix, `:334`) — **no caller for any**: `GET /marketplaces/status` `:43`, `POST /marketplaces/prices/update` `:68-69`, `POST /marketplaces/inventory/update` `:144-145`, `POST /marketplaces/variants/sync` `:220-221`, `GET /marketplaces/variants/:variantId/listings` `:348-349`, `POST /marketplaces/sync-all` `:398`, plus the two **never-registered** nested declarations `GET /marketplaces/health` `:485` and `POST /marketplaces/products/:productId/sync` `:508-509` (inside the `sync-all` handler's `if (listing) {` block that closes at `:551-553`).

**channel-publish.routes.ts** (`:294` marketingView/marketingPublish) — `GET _meta/mode` `:30` (`publish/page.tsx:26`), `POST amazon/ebay/shopify/woo` `:45,125,195,263` (`PublishDashboardClient.tsx:45-72`), `POST cascade` `:331` — **none**.

**product-channel-data.routes.ts** (`:365` productsView/productsEdit) — `GET/PATCH channel-pricing` `:44-45`, `:136-148` (`ChannelPricingSection.tsx:168,185,238`); `GET channel-inventory` `:217-218` (`FulfillmentCard.tsx:98`, `FulfillmentMethodCard.tsx:47`); `PATCH /api/products/:id/fulfillment` `:373-383` (`FulfillmentMethodCard.tsx:76`, `MatrixTab.tsx:561`); `GET /api/products/:id/listings` `:471-472` (`CrossChannelMatrix.tsx:94`); `GET amazon-sync-data` `:515-516` — **none**; `GET variant-image-locks` `:572-573` (`VariationMatrix.tsx:214`); `POST /api/products/listing-health/bulk` `:626-627` (`ProductsWorkspace.tsx:636`).

**sendcloud-webhooks.routes.ts** — `POST /api/webhooks/sendcloud` `:103` — `:62` PUBLIC — external; URL only displayed at `CarrierConfigDrawer.tsx:2024`.
**cloudinary-webhook.routes.ts** — `POST /api/assets/_webhooks/cloudinary` `:67` — `:63` PUBLIC — external; **none** in repo.

### 2.4 Totals

157 routes (25 files + accounts). **77 with an in-app caller; 80 without.** Of the 80: 25 inbound webhook receivers (external by design), 7 reachable only from `scripts/`/`apps/api/scripts`, **48 with no caller anywhere** — the whole of `shopify.ts` (7), `etsy.ts` (6), `woocommerce.ts` (6), `marketplaces.ts` (8, 2 never registered), `amazon-ads-auth.routes.ts` (4), `shopify-setup.routes.ts` (2), `amazon-auth-probe` (1), `inventory-sync-diagnostics` (1), plus `ebay-auth` ×3, `amazon-notifications` ×1, `ebay-notification` admin ×1, `sync.routes` catalog ×3, `marketplaces.routes` ×3, `channel-publish/cascade`, `product-channel-data/amazon-sync-data`, `accounts/diagnostics`, `cloudinary`.

---

## 3. (c) Docs

Dates are `git log` first/last commit for the file. "Current" = claims match code today; "partially stale" = core accurate, cited discrepancy; "dead" = describes something that does not exist / superseded.

| Doc | Date | Claims | Verdict + discrepancy |
|---|---|---|---|
| `docs/EBAY-INTEGRATION-PLAN.md` | 2026-04-27 | Phase 3 plan: OAuth2, token mgmt, inventory/orders sync for eBay | **Dead (plan)**: names `/api/auth/ebay/authorize|callback|disconnect|status` and `routes/ebay-auth.routes.ts`; actual routes are `/api/ebay/auth/*` in `routes/ebay-auth.ts:55-573` |
| `docs/AMAZON-SYNC-API.md` | 2026-04-27 | Endpoints `POST/GET /sync/amazon/catalog[/…]` incl. `/history`, base `localhost:3001/api` | **Partially stale**: 3 of 4 exist (`sync.routes.ts:67,150,194`); `/sync/amazon/catalog/history` does not (grep); none of the 3 has a caller (§2.3) |
| `docs/AMAZON-SYNC-IMPLEMENTATION.md` | 2026-04-27 | "successfully implemented" end-to-end: routes + `SyncTriggerButton`/`SyncStatusModal` UI | **Dead**: the UI's button calls the Next stub that fabricates results (`apps/web/src/app/api/sync/amazon/catalog/route.ts:8-23`, `[syncId]/route.ts:13-20`), never `sync.routes.ts` |
| `docs/AMAZON-SYNC-QUICKSTART.md` | 2026-04-27 | 5-minute operator guide: click Sync on Inventory, watch progress, statuses Success/Partial | **Dead** (same reason: progress is hard-coded 100/`success`) |
| `docs/AMAZON-SYNC-TESTING.md` | 2026-04-27 | Unit/integration tests at `services/__tests__/amazon-sync.*.test.ts`, `mock-amazon-data.ts` | **Dead**: none of the three files exist |
| `docs/AMAZON-SYNC-TROUBLESHOOTING.md` | 2026-04-27 | Error catalogue for the sync feature (e.g. "Product validation failed") | **Dead** with the feature above |
| `docs/AMAZON-ORDERS-SYNC-ARCHITECTURE.md` | 2026-04-24/27 | Phase 2 architecture "Review Ready": `/api/orders/sync/new`, `/api/orders/sync/:syncId`, `/api/orders/financial/summary`, `OrdersTable.tsx`… | **Dead (superseded)**: orders sync lives at `POST /api/amazon/orders/sync` (`amazon.routes.ts:1497`); `orders.routes.ts` has only `/api/orders/sync-health` (`:58`); the named components don't exist |
| `docs/INVENTORY-SYNC.md` | 2026-07-01 → 07-20 | Operator runbook: `applyStockMovement` → `OutboundSyncQueue` → BullMQ; endpoints | **Current** (6/6 referenced endpoints resolve). One soft claim: "Shopify (connected, not yet transacting)" (`:5`) vs. the UI, which shows Shopify as **Coming soon / Connector deferred** because no `ChannelConnection` row exists for it (`connections.routes.ts:121-125`) — "connected" there means env vars, not a connection row |
| `docs/PHASE27-SSOT-SYNC-ENGINE.md` | 2026-04-27 | SSOT → per-marketplace payload services + `/api/catalog/sync/bulk` | **Partially stale**: services exist (`apps/api/src/services/marketplaces/*-sync.service.ts`) and `/api/catalog/sync/bulk` exists (`catalog.routes.ts:1939`); it predates the Inventory-API-first eBay path and the flat-file/cockpit surfaces (`docs/ebay-integration-map.md`) |
| `docs/MARKETPLACE-API-DOCUMENTATION.md` | 2026-04-23/27 | "Production Ready" Shopify/Woo/Etsy API + `GET /marketplaces/health`, `POST /marketplaces/products/{id}/sync` | **Dead**: the two unified endpoints are the never-registered nested routes (`marketplaces.ts:485,508`); the `/shopify|/woocommerce|/etsy` routes have no caller and the UI says the connectors are deferred (`ChannelsClient.tsx:604`) |
| `docs/WEBHOOK-DOCUMENTATION.md` | 2026-04-23/27 | Inbound Shopify/Woo/Etsy webhook paths + HMAC | **Partially stale**: documented paths match `shopify-webhooks.ts:926-1335`, `woocommerce-webhooks.ts`, `etsy-webhooks.ts`; omits everything since — eBay platform notifications (`ebay-notification.routes.ts:326-345`), Sendcloud, Cloudinary, outbound `settings-webhooks`, replay (`sync-logs.routes.ts:1020`) |
| `docs/PHASE3-EBAY-AUTH-IMPLEMENTATION.md` | 2026-04-24/27 | eBay auth service + routes "COMPLETED"; callback compares state in `sessionStorage` (`:186-202`) | **Partially stale**: 7/8 endpoints still exist; the `sessionStorage` CSRF check was removed — state is server-signed (`EbayCallbackContent.tsx:34-43`, `ebay-auth.ts:194`) |
| `docs/PHASE3-EBAY-SYNC-IMPLEMENTATION.md` | 2026-04-24/27 | eBay inventory sync + auto-match, `/api/sync/ebay/*` | **Partially stale**: endpoints exist (`ebay.routes.ts:28-269`); the doc's UI (`ChannelResolverClient` link call) targets a relative `/api/sync/ebay/...` with no Next route (§1.11) |
| `docs/PHASE12F-LIVE-AMAZON-SP-API.md` | 2026-04-26/27 | Live SP-API client; env `AMAZON_CLIENT_ID/SECRET/REFRESH_TOKEN/REGION/SELLER_ID` | **Partially stale**: code now prefers `AMAZON_LWA_CLIENT_ID` (`amazon-sp-api.client.ts:132`) and the boot seed requires the `AMAZON_LWA_*` + `AWS_*` set (`index.ts:333-340`); `AMAZON_CLIENT_ID` survives only as a fallback |
| `docs/ebay-integration-map.md` | 2026-05-28 | Which eBay APIs are used where (Inventory-API-first, Feed, Trading…) | **Current**: all 9 spot-checked service files exist (`services/ebay-account.service.ts`, `providers/ebay.provider.ts`, `services/listing-wizard/ebay-publish.adapter.ts`, …) |
| `docs/FULFILLMENT-PER-CHANNEL.md` | 2026-05-29 | `ChannelListing.fulfillmentMethod` model, "never publish more than the pool holds" | **Current** (4/4 endpoints resolve, e.g. `PATCH /api/products/:id/fulfillment` `product-channel-data.routes.ts:383`) |
| `docs/2026-08-19-map-multi-account-profiles.md` | 2026-08-19 → 08-25 | MAP.0–MAP.4 shipped; accounts endpoints, AccountsPanel | **Current**; minor: names `/api/connections/diagnostics` — actual is `/api/accounts/diagnostics` (`accounts.routes.ts:233`) |
| `docs/2026-07-30-ebay-multi-account-ema.md` | 2026-07-30 | EMA proposal, "awaiting gate, no code changed" | **Superseded** by MAP: proposes `ebay-connection-resolver.service.ts` / `/api/ebay/accounts/diagnostics`; shipped as `services/connection-resolver.service.ts` and `/api/accounts/*` |
| `docs/multi-marketplace-2026-05-21/M0-audit.md` | 2026-05-21 | Per-marketplace order volumes from `/api/amazon/reconciliation/all` (+ self-correction) | **Historical/partially stale**: endpoints exist under the `/api/amazon` prefix (`amazon.routes.ts:2003,1979`); its own POST-M2 correction says the volume table was wrong |
| `docs/multi-marketplace-2026-05-21/PROPOSAL.md` | 2026-05-21 | M0–M16 backfill programme | **Dead by its own header**: "STATUS: SUPERSEDED — M3–M16 deferred indefinitely" (`:6-8`) |

Tally: current 4 (INVENTORY-SYNC, ebay-integration-map, FULFILLMENT-PER-CHANNEL, MAP) · partially stale 7 (AMAZON-SYNC-API, PHASE27, WEBHOOK, PHASE3-AUTH, PHASE3-SYNC, PHASE12F, M0-audit) · dead/superseded 11 (EBAY-INTEGRATION-PLAN, AMAZON-SYNC-IMPLEMENTATION/QUICKSTART/TESTING/TROUBLESHOOTING, AMAZON-ORDERS-SYNC-ARCHITECTURE, MARKETPLACE-API-DOCUMENTATION, EMA, PROPOSAL).

---

## 4. Method notes / limits

- Caller search is textual (fixed-string path fragments). It catches template literals with `${…}` only where the literal prefix survives; dynamic URL builders (`/${action}`) were resolved by hand where seen (`AlertsClient.tsx:256`, `InboxClient.tsx:131-134`).
- Internal API callers were filtered to lines containing `fetch(|url|URL|href|redirect|inject(`; a service that builds a path with string concatenation elsewhere could be missed.
- Manifest resolution is by reading `permissions-manifest.ts` order; no test was executed.
- Nothing was run against prod or a DB; "prod has N rows" statements in code comments were not re-measured.
