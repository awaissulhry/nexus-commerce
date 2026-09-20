# Channel connections — PLAN (short version)

Written 2026-09-19. What was **designed or decided** for channel connections, accounts, business profiles and channel sync. It covers today's channels and the planned future channels.

- The research is in [RESEARCH.md](RESEARCH.md).
- The word-for-word text of every source is in [full/PLAN-FULL.md](full/PLAN-FULL.md).
- Build states here come from the docs and notes, not from a code check. Check the code before you rely on one.

## Read this first

Source tags: `[cx]` = docs/2026-08-29-cx-channel-connections.md · `[cx0]` `[cx1]` `[cx2]` `[cx3a]` `[cx3b]` `[cx3c]` `[cx4a]` = the 2026-08-29-cx* unit docs · `[kms]` = 2026-08-29-kms-runbook.md · `[bp]` = 2026-09-08-business-profiles-architecture.md · `[bps]` = 2026-09-16-bp-shared-accounts-and-access.md · `[map]` `[map0]` `[map6]` = the 2026-08-19 MAP docs · `[ema]` = 2026-07-30-ebay-multi-account-ema.md · `[m-cx]` `[m-map]` `[m-bp]` = memory files (may be stale) · `[MEMORY]` = the memory index lines (only pointers, files not opened) · `[eip]` = docs/EBAY-INTEGRATION-PLAN.md · `[p/…]` `[s/…]` = docs/superpowers/plans|specs/2026-… files (short name).

States are what each doc or memory says. None of this was checked in code.

### Every plan, one line each

| Plan | File | What it does | State (per doc / memory) |
|---|---|---|---|
| CX programme (Phase C) | docs/2026-08-29-cx-channel-connections.md | One self-owned connection layer for all channels: catalogue, token service, OAuth, ingress, sync, normalisation, UI. Phases CX.0–CX.9+ | APPROVED 2026-08-29, all 12 decisions taken [cx §5] |
| CX audit / research (Phase A/B) | docs/2026-08-29-cx-audit.md, cx-research.md | Inputs to the proposal | Delivered, not read here [m-cx] |
| CX.0 Stop the bleed | docs/2026-08-29-cx0-security-stop-the-bleed.md | Delete public probes/receivers, fail-closed webhook checks, Ads OAuth state, revoke on disconnect | BUILT per record `a31b2cebd`, PUSHED, prod checks (§6) VERIFIED per memory [m-cx] |
| CX.1 Connection core | docs/2026-08-29-cx1-connection-core.md | Additive schema, catalogue, KMS crypto v2, leased token service, OAuthSession, API-host callback, eBay max scopes + RFC 9421 signing, heartbeat | BUILT per record, PUSHED `61774d222`, DEPLOYED + prod-verified per memory [cx1 §15] [m-cx] |
| CX.2 Channels UI on DS | docs/2026-08-29-cx2-channels-ui.md | /settings/channels tabs Accounts · Connect · Diagnostics; honest rows; Ads paste form removed | BUILT per record `9fadf5130` + `c86393577`, DEPLOYED + verified on prod [cx2 §11] |
| CX.3a Ads on the core | docs/2026-08-29-cx3a-amazon-ads-on-the-core.md | Amazon Ads = 1 ChannelConnection + profile scopes; credential read from core | BUILT per record `2d269c6f7`, `4be9d2c53`, verified on prod [cx3a §10] |
| CX.3b Ads engine on the core | docs/2026-08-29-cx3b-ads-engine-on-the-core.md | Profile resolver shim, leased Ads token, 9 duplicate secrets archived | BUILT per record, verified on prod [cx3b §8] |
| CX.3c Ads truth on the page | docs/2026-08-29-cx3c-ads-truth-on-the-page.md | /api/advertising/connections serves measured heartbeat/expiry/error | BUILT per memory `389d3cf98` [m-cx] |
| CX.3 SP-API OAuth half | (in cx + cx3a) | Amazon seller OAuth (public app) | HELD — blocked on Owner registering the SP-API public app [cx3a §0] [m-cx] |
| CX.4a Inbound ledger + eBay signature | docs/2026-08-29-cx4a-inbound-ledger.md | WebhookEvent → InboundEvent columns; real eBay ECDSA check; 412 on reject | BUILT per record, verified on prod [cx4a §4b] |
| CX.4b / 4c / 4d | (named in cx4a) | 4b subscriptions + reconciler; 4c retry/DLQ/replay/archiver; 4d Ingress tab | Not built; 4b needs a deliberate Owner yes [cx4a §5–6] |
| CX.5 Shopify, CX.6 Etsy, CX.7 Normalisation, CX.8 Sync hardening, CX.9+ new channels | (in cx §4) | See phase sections below | APPROVED as plan, not started per docs read [cx §4] |
| KMS runbook | docs/2026-08-29-kms-runbook.md | Owner steps to turn on KMS for credentials | Code side ready `70e8c301c`; Owner side pending [kms] [m-cx] |
| BP Business profiles | docs/2026-09-08-business-profiles-architecture.md | Workspace = business profile; memberships; RLS isolation; channel accounts owned by one workspace | BUILT per record (`f212c2348`, dark); switched ON in prod 2026-09-16 12:39 UTC per memory [bp] [m-bp] |
| BP.S Shared accounts + access | docs/2026-09-16-bp-shared-accounts-and-access.md | Share one seller account with other profiles (read/publish); per-person account limits | BP.S1–S3, L1, L2 BUILT per record, PUSHED + migrated in prod 2026-09-16; "not end-to-end AAA" [bps §23] [m-bp] |
| MAP Multi-account & profiles | docs/2026-08-19-map-multi-account-profiles.md | Several seller accounts per channel; account chip; fail-closed resolver | MAP.0–MAP.4 BUILT + prod-verified per doc; MAP.5 dropped; MAP.6(2), MAP.7 not started; MAP.8 closed by BP.S2 [map] [m-bp] |
| MAP.0 burn-down | docs/2026-08-19-map0-burndown.md | Generated list of ambient connection lookups | 0 ambient sites [map0] |
| MAP.6 flat-file edit list | docs/2026-08-19-map6-flat-file-edit-list.md | (1) 12 lookups in eBay flat-file route; (2) account-scoping the flat file | (1) APPROVED + BUILT 2026-08-19; (2) not proposed [map6] |
| EMA eBay multi-account | docs/2026-07-30-ebay-multi-account-ema.md | eBay-only multi-account plan | SUPERSEDED by MAP (never shipped, zero commits) [map] |
| eBay integration plan (Phase 3) | docs/EBAY-INTEGRATION-PLAN.md | First eBay OAuth + read syncs + price push | Doc silent; checklist unticked [eip] |
| eBay shared-variant-SKU spec | s/0627-ebay-shared-variant-sku-sync-design | Same child SKU under several eBay listings, one pool | Draft for review at write; built via phases 1–4 per later plans [s/0627] [p/0702-ssku-unblock] |
| eBay shared-SKU phases 1–4 | p/0627-ebay-shared-sku-phase1…4 | Trading API module, membership model, fan-out, flat-file wiring | BUILT per later plan ("engine already exists on main") [p/0702-ssku-mgmt] |
| Flat-file shared rebuild | p/0627-flat-file-shared-rebuild | One shared editor tree for Amazon + eBay | Doc silent |
| Nexus-as-Hub SKU linkage | s/0629-nexus-hub-sku-linkage-design | 1:1 SKU mirror + full listing lifecycle | FOR APPROVAL at write [s/0629] |
| Amazon browse nodes (spec + plan) | s/0630-…browse-nodes-design, p/0630-…browse-nodes | Category = product type + browse node per group | Spec APPROVED; plan doc silent on build |
| Real-time inventory sync (spec) + Phases 0–7 | s/0630-realtime-inventory-sync-design, p/0630-phase0…3, p/0701-phase4…7 | Outbound sync correctness, oversell, reservations, reconciliation, control tower | Phases 0–6 BUILT per record (PR `inventory-sync-hardening`); Phase 7 FOR APPROVAL [p/0701-phase7] |
| Amazon custom groups (spec + plan) | s/0701-…custom-groups-design, p/0701-…custom-groups | View-only named SKU groups | Spec APPROVED 2026-07-01 |
| eBay sync fix | p/0701-ebay-sync-fix | eBay pushes failed 0/4,120 (header bug) | Doc silent |
| Feed summary parity (spec + plan) | s/0701-…, p/0701-… | Full Amazon feed-report parsing + export | Spec DRAFT at write |
| eBay add variant / reparent | p/0702-ebay-add-variant-import-reparent | Persist new variants + reparent | APPROVED 2026-07-02 |
| eBay custom groups | p/0702-ebay-custom-groups | Family / Custom / None groups on shared grid | APPROVED; P1–P4.1 BUILT per record |
| eBay shared-SKU flat-file management | p/0702-ebay-shared-sku-flatfile-management | Shared child row under every parent; per-listing price | Doc silent; needs migration go |
| eBay shared-SKU unblock + persist | p/0702-ebay-shared-sku-flatfile-unblock-persist | Option A | SUPERSEDED by the management plan |
| eBay explicit parentage columns | s/0704-ebay-explicit-parentage-columns-design | Parent/child columns like Amazon | Design study; verdict inside doc |
| Channel/market-scoped flat files (spec) | s/0706-channel-market-scoped-flat-files-design | "A file" = channel+market view; Action column | FOR APPROVAL (verbal yes) at write |
| Scoped removal / scoped view / eBay per-market | p/0706-… (3 files) | Delete only the channel listing; listed/all toggle; per-market eBay view | Doc silent (plans carry approval via spec) |
| Stock import wizard | p/0707-stock-import-wizard-perfection | Fix IM.1 stock import | FOR APPROVAL at write |
| Follow-master bulk tool | p/0708-follow-master-bulk-tool | Per-market Follow/Pin qty + price | FOR APPROVAL at write |
| eBay flat-file excellence (EFX) | p/0709-ebay-flatfile-excellence | Axis/theme/image defects | FOR APPROVAL at write |
| eBay axes consistency (EAC) | p/0710-ebay-axes-consistency-fix | One theme-authoritative axis source | Partly APPLIED 2026-07-10 per doc |
| Unified flat-file excellence (UFX) | p/0710-unified-flat-file-excellence | Shared grid, Amazon multi-category | BUILT + verified per record (complete 2026-07-11) |
| eBay description engine (ED) | p/0716-ebay-dynamic-description-engine | Themes rendered at push | BUILT per record (ED.1–ED.5) |
| XLSM + Amazon template hybrid | p/0716-xlsm-amazon-template-hybrid | .xlsm import/export; hybrid workflow | BUILT per record (A1–A8 + B1) |
| Amazon import excellence (AMX) | p/0717-amazon-import-excellence | Total control Amazon import | FOR APPROVAL at write; AMX.1/2/4 BUILT per FFT record |
| eBay import excellence (EI) | p/0717-ebay-import-excellence | Dynamic eBay import | BUILT per record (EI.1–EI.6) |
| Flat-file trust (FFT) | p/0719-flat-file-trust | Zero data loss | BUILT per record (FFT.0–7 + 3 incidents) |
| Real-time FBM sync (RT) | p/0719-realtime-fbm-sync-perfection | Real-time FBM sync all channels | FOR APPROVAL at write; RT.0–RT.7 delivered per later study |
| Pool → Amazon sync study (AS) | p/0720-pool-to-amazon-sync-study | Study + AS hardening | APPROVED; AS.1–AS.5 BUILT per record |
| Sync Control SCG / SCV / SCD | p/0721-sync-control-datagrid, p/0721-…-scv, p/0725-…canonical-grouping | Sync Control table, product view, grouping | BUILT + prod-verified per record |
| Sync Control SC series | p/0721-sync-control-sc-series | Routing + muting per location/market/product | FOR APPROVAL at write |
| SCT.6 market offer control | p/0726-sct6-market-offer-control | Close / reopen an Amazon offer per market | Doc silent |

### The Owner's decisions (verbatim where the doc has them)

**CX programme — all 12 decided 2026-08-29: "I'll go with your recommendations"** [cx §5]. The memory quote is longer: "I just want the best in the industry approach … I'll go with your recommendations" [m-cx].
1. Callback host: API host `GET /api/cx/callback/:channel` for every channel, eBay too. The Owner re-points the eBay RuName once [cx §5.1].
2. Amazon SP-API: **public app** in the Solution Provider Portal. It gives OAuth consent, 25 authorisations and a possible second seller account [cx §5.2].
3. Shopify (own stores): **custom-distribution app + authorization-code grant**, with a non-expiring offline token [cx §5.3].
4. Etsy: **Seller App** now. Personal/Commercial only if other sellers' shops must connect [cx §5.4].
5. WooCommerce code: **delete** (CX.0/CX.5). The Owner said: "we will not do woo as of now" [cx §5.5] [m-cx].
6. Destructive drops: one approval each, after the replacing additive phase has run green for a week [cx §5.6].
7. Queue: keep BullMQ and add groups/buckets. Not a Nango-style Postgres task table [cx §5.7].
8. OTTO: register as a **Service Partner** (true OAuth) [cx §5.8].
9. Raw-event retention: **archive, never delete**. After 90 days, payloads and old ChannelRecord raw versions move to S3-compatible storage (per-env bucket, server-side encrypted, 7-year lifecycle). The row keeps a pointer + digest [cx §5.9]. Memory says "90 d", which is stale [m-cx].
10. Amazon Ads lives on the Channels page as an account. /settings/advertising keeps engine controls only [cx §5.10].
11. New-channel order: Allegro → TikTok Shop → Google Merchant Center → Meta catalog → then exception channels by revenue [cx §5.11].
12. `ORDER_STATUS_CHANGE` gap: Amazon removed it on 2026-07-29. CX.4 subscribes `ORDER_CHANGE` with `eventFilter` [cx §5.12].

**CX unit go-aheads:** CX.0 "Go ahead." [m-cx] · CX.1 "Go ahead with the next unit" [cx1 §15] · CX.2 "We should go ahead with CX to rebuild and make sure it all aligns properly with the nexus design system." [cx2] · CX.3a "Go ahead, I'll go with your recommendation." [cx3a] · CX.3b "Let's actually start it." [cx3b] · CX.3c "Go ahead. I'll go with your recommendations." [cx3c] · CX.4a "Go ahead, proceed with the next." [cx4a]

**BP / BP.S:**
- Ask: "the ability to connect a single account to multiple profiles and limit the profiles by access or something like that." [bps]
- Scope: **read-only sharing first, publish after**; **both** limits — per profile (read vs publish) and per person (account restriction) [bps]
- Profiles-ON test failures: "Guard now, fix over time" [bps §22]
- Commit: "commit and push it all" [bps §23]
- Prod switch-on: "Switch it on now" (2026-09-16, after risks were stated) [m-bp]
- Notification backlog: mark everything older than 7 days read **except** `severity='danger'`, delete nothing [bps §19.2]
- A live test that gets 401 `unauthenticated` = "cannot measure here" → skip with a named reason (`431856f0e`) [bps §23.1]

**MAP (operator, 2026-08-19)** [map]:
1. Amazon multi-account: **"not now, but design for it"**. MAP.5 (SP-API seller OAuth) dropped. Schema and resolver must never hard-code `'EBAY'`.
2. MAP.2's non-additive migration: **approved**, if the backfill row count is exact before old keys drop and a rollback ships with it.
3. Flat file: **decided at MAP.6, not now**.
4. Catalogue overlap: **deliberately deferred**. It becomes a per-product question via intent labels.
- MAP.6 item (1), the 12 lookups: **APPROVED and SHIPPED** 2026-08-19 [map6]

**EMA (operator, 2026-07-30)** [ema]:
1. Account = top-level **scope switcher**; markets stay the column axis.
2. **Same Xavia catalog on every account**, so the duplicate-listing guard becomes a gate on the first push. MAP later reopened this as "not sure" [map §6 Q4].
3. Groundwork first: EMA.0–2 before a second account can connect.

**Older Owner rules found in Part B:**
- "A separate file for each channel and market, managed my way, while still keeping the inventories all in sync by using the child SKU." [s/0706-scoped]
- "All inventories sync in real time for all FBM offers across all platforms, extremely accurate, best in class. FBA excluded — Amazon-managed." [p/0719-rt]
- "complete control over each and every thing." [p/0710-eac]
- XLSM gate: qty import default OFF, price ON, deletes excluded by default with explicit Owner override, vault auto-capture ON [p/0716-xlsm]
- FFT: flat-file data loss "must not ever happen again, at any cost"; D1–D8 as recommended [p/0719-fft]
- Standing invariants repeated across plans: FBA quantity untouchable; shared pool model (per-channel allocation rejected 2026-06-24); flat-file editors untouchable without approval; legacy import untouched; design system only [p/0719-rt] [p/0721-sc]

---

## Target architecture

### One-line model
- The connection core lives in `apps/api/src/services/cx/*`. It has a declarative ChannelCatalog, OAuth service, token service, ChannelConnection + child tables, and a heartbeat cron [cx §1.1].
- Bespoke connectors, one directory per channel (`services/cx/connectors/<channel>/`). No lowest-common-denominator layer [cx §1.2E] [cx §1.3].
- Adding a channel = one catalogue entry + one connector directory. The UI is derived from the catalogue [cx §1.2A] [cx1 §2].
- Rules: we own everything, with no Nango/Paragon/Merge/Rutter/ChannelEngine dependency. Read their code for design, but Nango and Airbyte are ELv2, so re-implement only [m-cx].

### ChannelCatalog (per channel, in code)
- Fields: `authMode` (oauth2_code | oauth2_pkce | oauth2_cc | api_key | hmac_key), authorize/token URLs, auth/token/refresh params, `scopeSeparator`, `requiredScopes` (maximal), `reviewGatedScopes`, `codeParamInCallback` (`spapi_oauth_code`), `callbackMetadata` (`selling_partner_id`, `sellerId`), `tokenResponseMetadata`, regions + per-region hosts, refresh-token lifetime, `rotatesRefreshToken`, heartbeat call, identity call, rate-limit headers + model, signing, webhooks (verifier, subscription API or "portal-only", lifecycle topics), `apiVersion`, sandbox, `connectExceptionDoc` [cx §1.2A].
- Refresh-token lifetimes: eBay 18 months, Ads 365 d, Etsy 90 d, Allegro 3 months [cx §1.2A].
- Signing schemes: eBay digital signature (`ebay-rfc9421`), Kaufland HMAC, TikTok `sign` [cx §1.2A] [cx1 §2].
- Rate-limit models: token_bucket, daily_quota, leaky_bucket, points [cx1 §2].
- Webhook schemes: ebay-ecdsa, shopify-hmac, sqs, standard-webhooks, none [cx1 §2].
- `connectException` holds reason, deep link, key-format regex and a verify call, for key-paste channels [cx1 §2].
- CX.1 entries: EBAY (full), AMAZON_SP, AMAZON_ADS. SHOPIFY and ETSY carry auth shape + scopes + heartbeat only, with `available: false` until their phases [cx1 §2].
- Unlike Nango's entries, ours carry rate-limit headers, refresh lifetime and region/marketplace ids [cx §1.2A].

### ChannelConnection (extended, not replaced)
- New columns: `authStatus`, `region`, `credentialsEnc`, `credentialsKeyId`, `grantedScopes[]`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `lastRefreshAt`, `lastHeartbeatAt`, `lastInboundAt`, `lastOutboundAt`, `lastErrorAt`, `lastError` (class-tagged), `consecutiveFailures`, `refreshLeaseUntil`, `refreshLeaseOwner`, `identity` Json, `apiVersion` [cx1 §1.1].
- `authStatus` values: connected · degraded · needs_reauth · revoked · disconnected · unknown [cx1 §1.1].
- Indexes on authStatus, accessTokenExpiresAt, refreshTokenExpiresAt [cx1 §1.1].
- Legacy `ebay*` columns and `AmazonAdsConnection` are read-through during migration, then dropped in a separately approved phase [cx §1.2B].
- MAP columns stay: `accountLabel`, `accountColor`, `isPrimary`, `sortOrder`, `externalAccountId` [map].
- MAP keys stay: `ChannelConnection_active_account_key` = `(channelType, COALESCE(marketplace,'~'), COALESCE(externalAccountId,'~')) WHERE isActive`, plus one primary per channel [map] [cx1 §1.3].
- BP adds workspace ownership. RLS makes the row belong to one profile [bp] [bps §1].

### Child tables
- **ConnectionScope**: connectionId (CASCADE), kind `marketplace | shop | profile | storefront`, externalId, label, region, isActive, metadata. Unique (connectionId, kind, externalId) [cx1 §1.2].
  - One SP-API grant → 11 marketplaces; one Ads grant → N profiles; one TikTok auth → N shops; one Kaufland key → 9 storefronts [cx §1.2B].
- **ChannelApp**: our app credentials, never copied into connection rows. Holds channelKey, environment, clientId, `clientSecretEnc`, redirectUris, extra (RuName, Etsy keystring, SP-API app id), `signingKeyEnc`, `signingKeyId`, `secretExpiresAt`, `rotatedAt`. Unique (channelKey, environment). Seeded once at boot from env; after that the row wins [cx1 §1.2].
  - SP-API needs secret rotation every 180 days [cx §1.2B].
- **OAuthSession**: id = state (32 random bytes), channelKey, intent `connect | reconnect | adopt`, targetConnectionId, startedByUserId, codeVerifier, redirectUri, cookieNonce, region, expiresAt (10 min), consumedAt, resultConnectionId, error. Swept after 1 day [cx1 §1.2].
- **ConnectionEvent**: ledger rows of type grant · reconsent · adopt · refresh · refresh_failed · revoke · disconnect · heartbeat_ok · heartbeat_failed · scope_drift · status_change · secret_rotated · signing_key_created. Carries actorUserId and detail (never token material) [cx1 §1.2].
  - Archive, never delete: after 90 days it moves to object storage. The archiver is a no-op until a bucket exists [cx1 §1.2].
- BP tables: `ChannelAccountOwnership` (PK channelType+environment+externalAccountId → one owning workspace) keeps seller ownership across disconnect/reconnect [bp] [bps §1].
- `ChannelAccountRoute` is the active index for verified inbound messages [bp].
- BP.S tables: `ChannelAccountGrant`, `WorkspaceMemberAccountLimit`, `ChannelListingClaim` [bps].

### Token service (the only decryptor)
- `services/cx/token.service.ts` is the only code that decrypts. Resolver rows never carry credentials (`CONNECTION_PUBLIC_SELECT`). Callers get a `ConnectionHandle` with a `token()` closure [cx §1.2C] [cx1 §4.1] [cx1 §8].
- API: `getAccessToken(connectionId, {restricted?, forceRefresh?})`, `refreshNow`, `revoke`, `storeGrant`, `handleOf` [cx1 §4.1].
- Encryption: envelope `v2:<kid>:<wrappedDek>.<iv>.<tag>.<ct>`. Each blob gets its own AES-256-GCM data key, wrapped by an AWS KMS master key (`alias/nexus-credentials-<env>`, eu-west-1, yearly auto-rotation, CloudTrail audit) [cx §1.2C] [cx1 §3].
- Unwrapped data keys are cached 10 min (LRU 256) [cx1 §3].
- `v1` env key (`NEXUS_CREDENTIAL_ENC_KEY`) is for local dev and break-glass only. It raises a `CONNECTION_HEALTH` alert when used. v1 still decrypts forever [cx §1.2C] [cx1 §3].
- A `cx-reencrypt` / `cx-credentials-rotate` job re-wraps blobs whose key id is old [cx1 §3] [kms].
- Refresh algorithm [cx1 §4.2]:
  - Buffer 15 min (eBay 10 min).
  - In-process in-flight map.
  - DB **lease**: `UPDATE … refreshLeaseUntil = now()+30s WHERE lease free`. This replaces the proposal's advisory lock: no lock is held across HTTP.
  - A loser polls every 250 ms for up to 12 s, then fails with `RefreshContended`.
  - Double-check after taking the lease.
  - Rotation: store a new refresh token if one is returned (Etsy/TikTok), else keep the old one (eBay/Amazon).
- Failure classes: auth_revoked, auth_expired, rate_limited, network, unknown. Memory adds signature, forbidden and transient, so eBay 215001 never pushes needs_reauth [cx1 §4.2] [m-cx].
  - 30 s cooldown.
  - auth_revoked / auth_expired → `needs_reauth` at once.
  - Other classes → `degraded` after 3 failures, `needs_reauth` after 10 in a row (about 5 h).
- A refresh never touches `lastSyncAt/lastSyncStatus` [cx1 §4.2].
- `needs_reauth` pauses writes: `assertWritable(connectionId)` throws `ConnectionNeedsReauth` and the queue row is deferred. Reads continue while the access token lives [cx1 §4.2].
- RDT (Amazon restricted data token): `createRestrictedDataToken` per {method, path, dataElements}, cached 50 min [cx1 §4.2].
- State machine [cx1 §4.3]:
  - unknown → connected on grant, heartbeat or refresh.
  - connected → degraded after 3 non-auth failures; back to connected on the next success.
  - → needs_reauth on auth failure or a missing **required** scope for a write path.
  - → revoked only from a channel signal.
  - → disconnected on operator disconnect.
  - Every transition writes `ConnectionEvent{status_change}`.
- Alerts (`AlertType.CONNECTION_HEALTH`): on needs_reauth, on revoked, and 30/7/1 days before refresh-token expiry [cx1 §4.3].
- BP guard: `assertCredentialOwner(row)` throws `account_not_owned` (403) when the row's workspace is not the caller's. It admits an active `publish` grant [bps §10.1] [bps §16.3].

### OAuth service, routes and callbacks
- `POST /api/cx/connect/:channel/start` (permission `channelsConnect`) takes {intent, targetConnectionId?, region?} [cx1 §5].
  - It creates an OAuthSession and sets cookie `nexus_oauth_<state>` (HttpOnly; Secure; SameSite=None; Max-Age=600; Path=/api/cx/callback).
  - It returns authorizeUrl with all required scopes, prompt param and PKCE S256.
  - PKCE is off for SP-API and Walmart [cx §1.2D].
- `GET /api/cx/callback/:channel` is PUBLIC and sits on the API host [cx1 §5]:
  - The session is single use (consumed in the same UPDATE) and bound to the starting user.
  - The cookie double-submit is **enforced**; `NEXUS_OAUTH_COOKIE_ENFORCE=0` is an escape hatch for one release.
  - It exchanges the code and captures metadata.
  - It records `grantedScopes`: eBay needs `introspect`, SP-API has implicit roles, Ads returns a scope.
  - It runs identity, then applies the MAP fold/adopt/unmatched rules (`IDENTITY_UNMATCHED` / `IDENTITY_UNAVAILABLE`).
  - It stores the grant, discovers scopes and writes a ConnectionEvent.
  - It renders a DS page that sends `postMessage` + `BroadcastChannel('nexus-oauth')`, waits up to 1.5 s for an ACK, then closes.
  - Provider errors are shown verbatim.
- Popup opens synchronously in the click, with a same-tab fallback [cx §1.2D].
- eBay bridge: the old web page `/settings/channels/ebay-callback` forwards to the API callback until the RuName is re-pointed. After that the forwarder is removed (planned for CX.2) [cx1 §5].
- Old eBay routes: initiate → start; create-connection/callback → 410 `OAUTH_FLOW_MOVED`; connections / connection/:id / refresh removed; test → heartbeat [cx1 §15].
- BP: OAuth state binds user, workspace, connector, operation and reconnect target. A workspace switch in another tab must not change where the account attaches [bp].

### Webhook ingress, verifiers, DLQ (planned)
- One plugin `POST /api/ingress/:channel/:topic?` with a raw-body parser scoped to that prefix [cx §1.2F].
- Verifiers [cx §1.2F]:
  - Shopify HMAC over raw body + `timingSafeEqual`.
  - eBay ECDSA via `getPublicKey(kid)`.
  - Kaufland HMAC; bol RSA; Meta `X-Hub-Signature-256`; TikTok HMAC; Etsy Standard-Webhooks.
  - Amazon SQS: dedupe on `NotificationId`, check the SNS envelope.
- **Fail-closed**: 503 when a secret or app is missing [cx §1.2F].
- `InboundEvent` extends `WebhookEvent` additively. The row is written **before** processing. Worker is BullMQ, ordered per `entityKey`, with backoff, dead-letter and a replay endpoint [cx §1.2F].
- Subscription reconciler runs on connect and nightly [cx §1.2F]:
  - Shopify `webhookSubscriptions` diff.
  - eBay Notification API destination + subscriptions.
  - SP-API destination + per-type subscriptions.
- Reconciliation pollers per channel (`streams`) cover missed webhooks [cx §1.2F].
- Lifecycle topics flip `authStatus = revoked`: `app/uninstalled`, `MARKETPLACE_ACCOUNT_DELETION`, `SELLER_DEAUTHORIZATION` (eBay: `AUTHORIZATION_REVOCATION`). Shopify compliance topics write a `DataRequest` row [cx §1.2F] [cx §2.1].
- Built so far (CX.4a) [cx4a §3]:
  - New columns: `connectionId, status, attempts, nextAttemptAt, signatureOk, verifiedBy, payloadDigest, lastError, archivedAt, archiveUri`.
  - `signatureOk` is tri-state: true, false, or null = "no signature on this transport".
  - `verifiedBy` is `sqs_iam` or `ebay_ecdsa`.
  - **Arrival creates the row, not acceptance.**
- BP: inbound context comes from a verified provider-account mapping. `workspace-ingress.ts` refuses 2+ candidates with 503 `ingress_account_ambiguous` [bp] [bps §1].

### Sync engine, jobs, queues
- Keep `OutboundSyncQueue` + BullMQ + the 60 s autopilot + janitor [cx §1.2G].
- Add per-(channel, connectionId) BullMQ group concurrency [cx §1.2G].
- Add a per-connection token bucket fed by `parseRateLimit`: Shopify `throttleStatus`, SP-API `x-amzn-RateLimit-Limit`, eBay daily quota, Etsy `x-remaining-*` [cx §1.2G].
- `AsyncJob` table (kind feed | report | bulk_query | bulk_mutation | data_kiosk) replaces the 3 bespoke job tables over time [cx §1.2G].
- `ChannelFieldPolicy` (channel, marketplace?, field, sourceOfTruth pim|channel, conflict rule) turns "who is master of a field" into data, instead of logic spread across 28 files [cx §1.2G].
- Idempotency key = queue row id (e.g. Shopify `@idempotent`) [cx §1.2G].
- `ChannelPublishAttempt` stays as the dry-run/live audit [cx §1.2G].
- Ghost engines to delete: Phase-27 no-send lane, `inbound-sync.service`, `variation-sync-processor`, `unified-sync-orchestrator`, `marketplaces.ts` + `marketplace.service` [cx §1.2G].
- Heartbeat job `cx-heartbeat`, `*/15 * * * *` [cx1 §7]:
  - Heartbeat per active row: eBay identity; Amazon env row `getMarketplaceParticipations`.
  - Refreshes tokens that expire within 2× the interval.
  - Sends expiry alerts for tokens and `ChannelApp.secretExpiresAt`.
  - Prunes sessions and releases stale leases.
  - Replaces `ebay-token-refresh.job.ts`.
- BP: jobs carry workspace + destination; queued work rechecks account status and authority; clustered crons run once per active business inside `withWorkspace` [bp] [bps §20.3].

### Normalisation (planned CX.7)
- `ChannelRecord` holds the raw typed payload per channel. Fields: connectionId, scopeId, entityType, externalId, raw jsonb, rawHash, fetchedAt, sourceEventId, deletedAt. Unique (connectionId, entityType, externalId) [cx §1.2H].
- Core Product/Variant/ChannelListing/Order rows are **derived** by re-runnable mappers and carry `channelRecordId` [cx §1.2H].
- A product "Channel data" tab shows the raw payload [cx §1.2H].
- `ChannelSchema` (536 rows) becomes the writable-field catalogue [cx §1.2H].
- `Marketplace.schemaMapping` gets wired into the **real** push builders (today it only reaches the no-send lane) [cx §1.2H].
- Delete detection by generation [cx §1.2H].
- Why raw-first: every unified vendor lost fields [cx §1.3].

### Scopes, drift, reconnect
- Maximal scopes on every grant. `reviewGatedScopes` lets the UI say what is missing and why [cx §1.3].
- Drift = `requiredScopes − grantedScopes`, exposed as `scopeDrift` [cx1 §6].
- An account with drift shows "N permissions not granted" and **"Reconnect to grant N permissions"** [cx2 §2].
- A scope the eBay keyset is not entitled to makes eBay return `invalid_scope`. The final list = what the production keyset accepts [cx1 §6].
  - Memory index: one off-keyset scope kills the whole connect; 09-16 names `sell.logistics` and `commerce.catalog.readonly` [MEMORY].
- Adding a scope later forces re-consent for every user. eBay refresh tokens do not rotate (18 months) [m-cx].
- Existing eBay accounts (`xaviaracing`, `motovento`) show drift until reconnected. Prod showed "22 permissions not granted" [cx1 §6] [cx2 §11].

### UI (planned + built)
- `/settings/channels` has DS tabs Accounts · Connect · Diagnostics, synced to the URL. Ingress and Field-policy tabs come later [cx §1.2I] [cx2 §1].
- One disconnect path: revoke at the channel, null the credentials, write a ConnectionEvent, confirm the blast radius first [cx §1.2I].

---

## How Nexus will change products on channels (the planned write path, per channel)

### Common path (all channels)
- A change enqueues an `OutboundSyncQueue` row. A BullMQ worker dispatches it, with the 60 s autopilot and a DB backstop [cx §1.2G].
- Planned additions: per-connection groups + token buckets, `AsyncJob` for feeds/reports/bulk, `ChannelFieldPolicy`, idempotency key = queue row id [cx §1.2G] [cx §4 CX.8].
- `tokenService.assertWritable()` defers writes on `needs_reauth` [cx1 §4.2].
- The connection resolver is fail-closed. With more than one active account and no account named, it throws and never picks [map §3.3].
  - Scope forms: NAMED `{accountId}`; DERIVED `{listingId|variantListingId|itemId|orderId|channel+channelOrderId}`; DECLARED `{channel, primary:true}` [map MAP.3a].
- Pre-push ratchet: 0 ambient lookups allowed [map6] [bps §1].
- BP: the real destination (workspace + account + market) is resolved and **persisted before queueing**. A later default change cannot retarget it. Never fall back to another workspace's primary [bp].
- BP.S3 claim preflight in `enqueueOutboundRowsInstant` (no-op unless the account is shared) [bps §16]:
  - `ChannelListingClaim` PK `(connectionId, marketplace, sellerSku)` → the second business collides at the DB (23505).
  - A total refusal throws 409 `listing_coordinate_claimed`; a partial refusal proceeds and reports.
  - Refusals notify the actor + the refused business's active owners [bps §19.3].
- Mappings wired into real push builders; a changed rule must change the real payload digest in `ChannelPublishAttempt` [cx §4 CX.7].
- Sync correctness rules from older plans:
  - Re-read current `ChannelListing.quantity` at dispatch; coalesce superseded PENDING qty rows (`NEXUS_SYNC_ORDERING_V2`) [p/0630-phase1].
  - Oversell clamp for FBM = max(0, warehouse available − stockBuffer), with an event (`NEXUS_OVERSELL_CLAMP`) [p/0630-phase2].
  - Order-driven priority lane (`NEXUS_OUTBOUND_PRIORITY`) [p/0701-phase4].
  - Read-backs: Amazon daily, eBay every 30 min [p/0721-sc].
- Invariants [p/0719-rt] [p/0721-sc]:
  - FBA quantity untouchable (fail-closed guard; `buildAmazonListingPatch` strips qty).
  - Listing-level writes never write StockLevel/totalStock.
  - One shared pool; no per-channel allocation.

### Amazon SP-API
- Auth moves to the token service: 14 `SellingPartner` constructions + 5 LWA exchanges = the "19 auth sites" [cx §3.2] [cx §4 CX.3].
- Quantity for Following FBM listings = pool available − buffer. FBA and Pinned listings get a snapshot only [p/0720-as].
- Writes use the Listings API PATCH (`listings/2021-08-01`) and `JSON_LISTINGS_FEED` feeds [p/0726-sct6] [s/0701-feed].
- Feeds/reports planned as `AsyncJob`. `AmazonFlatFileFeedJob` is dropped later, after parity [cx §3.4].
- The RDT covers restricted PII calls [cx1 §4.2].
- Close an offer in one market: PATCH `op:delete` on `/attributes/purchasable_offer`, scoped by `marketplaceIds`. Reopen = back to Follow. ASIN, reviews and the shared EU `fulfillment_availability` qty are untouched [p/0726-sct6].
  - Four write stacks exist, with no single choke point. The plan adds "resurrection-proofing" and a pilot before bulk [p/0726-sct6].
- Keep `amazon-eu-quantity-guard` and the publish gates [cx §3.1].
- The flat file lists via Amazon's own `.xlsm` template. The imported workbook becomes the family's export base per market (`AmazonFamilyWorkbook`) [p/0716-xlsm] [p/0719-fft].
- Feed report parsing keeps every issue (code, severity, attributeNames, categories) [s/0701-feed].
- `amazon-qty-readback` compares Amazon's actual qty with the intended qty and enqueues fixes (cap 100) [p/0720-as].
- Planned test: a mapping rule changes the real Amazon payload [cx §4 CX.7].

### Amazon Ads
- The bid engine writes through `ads-api-client` `liveCall`. Credentials come from the core envelope; the token from the leased refresh [cx3a §4] [cx3b §3].
- The token is account-level; the profile travels in the `Amazon-Advertising-API-Scope` header [cx3b §1].
- Write gate `checkAdsWriteGate` needs `mode='production'` and `writesEnabledAt` set. It refuses with `connection` / `connection_writes` / `connection_mode_not_production` [cx3b §2] [cx3b §8].
- Retry/quota ledger and `recordSuccessfulWrite` are kept [cx3b §3].
- 4 production profiles write (DE, ES, FR, IT); 5 are sandbox [cx3a §0].

### eBay
- Inventory API `inventory_item` PUT must send `Content-Language` + `Accept-Language` in the market locale (e.g. `it-IT`) and `X-EBAY-C-MARKETPLACE-ID` [p/0701-ebay-sync].
  - Missing headers caused 400 errorId 25709 and 0/4,120 successes in 30 days [p/0701-ebay-sync].
- Shared-SKU listings use the **Trading API**: `AddFixedPriceItem` (InventoryTrackingMethod=ItemID, so the same `Variation.SKU` can repeat) and `ReviseInventoryStatus` by ItemID + SKU [p/0627-ssku-1].
  - Auth is the OAuth IAF token header; app headers come from env [p/0627-ssku-1].
  - The stock cascade enqueues one queue row per `SharedListingMembership` [p/0627-ssku-3].
- RFC 9421 request signing (`Content-Digest`, `x-ebay-signature-key` JWE, `Signature-Input`, ED25519 `Signature`) [cx1 §6]:
  - Applies to `/sell/finances/**`, `issueRefund`, Trading `GetAccount`, and Post-Order refund/cancel approvals.
  - Key from `POST /developer/key_management/v1/signing_key`, stored in `ChannelApp.signingKeyEnc`.
  - Mandatory for EU/UK sellers.
- Descriptions are themed and rendered **at push**. They are sanitised and never block a push [p/0716-ed].
- eBay Feed will run through `AsyncJob`; `EbayPushJob` is dropped later [cx §4 CX.8] [cx §3.4].
- `EbayPushJob` has no `channelConnectionId`, so `ebay-feed-poll` stays on the declared primary [map MAP.3a].
- Flat file (untouchable zone) push path: 12 lookups now resolve by DERIVED `{itemId, marketplace}` with a fallback to the primary [map6].
- Planned (MAP.6 item 2): account-scoped flat file, plus a cross-account duplicate-listing guard (title **and** description must differ) before the first push to a second account [map §4] [ema EMA.4].
- Rate limits are mostly per seller token; there are partner app limits too. OAuth minting cap: 10k/day auth-code, 50k/day refresh [ema §2.4].
- eBay read-back (`GET inventory_item`) feeds `recordChannelStockEvent` (≤1 unit auto-apply) [p/0701-phase5].

### Shopify (CX.5, planned)
- Typed GraphQL client (2026-07); bulk operations as `AsyncJob` [cx §4 CX.5].
- Inventory compare-and-set (`compareQuantity`) + idempotency [cx §4 CX.5].
- Also: markets/catalogs/price lists, metafields, translations [cx §4 CX.5].
- The 7 old clients get consolidated [cx §4 CX.5].
- Writes stay behind the existing publish gate [cx §4 CX.5].
- Shopify dispatch re-read, clamp and read-back were deferred earlier because Shopify was "connected, not transacting" [p/0630-phase1] [p/0630-phase2] [p/0701-phase5].

### Etsy (CX.6, planned)
- Listing writes: create/update/inventory/images/variation images/translations/personalization [cx §4 CX.6].
- Refresh must survive rotation [cx §4 CX.6].
- Polling streams: receipts by `min_last_modified`, listings by state, batch inventory, ledger [cx §4 CX.6].
- The FR/DE address-field gating is probed and shown honestly [cx §2.1].

### Tier 2 / exception channels (CX.9+)
- Each gets one real connect, one inbound event and one outbound write verified on prod [cx §4 CX.9].

---

## Connect flow per channel

### Common flow (all Tier 1)
- Settings → Channels → Connect → "Connect eBay" → popup on the channel login → sign in → consent lists every scope → `GET /api/cx/callback/:channel` → identity call → card `authStatus=connected`, scopes recorded, heartbeat scheduled, subscriptions reconciled. **Anything more is a defect unless it is on the exception list** [cx §2].
- BP: capture the destination workspace **before** authorisation starts. Reconnect checks the returned external identity against the existing account [bp].
- MAP rules [map MAP.4] [cx1 §5]:
  - Re-consent with a matching identity folds into the existing row.
  - An unidentifiable second account is refused early.
  - "+ Connect another account" is a two-click path.
- Memory index: with profiles ON, eBay's return page went to /profiles on 09-16 (consent OK, nothing connected). Fixed with one public-route list [MEMORY].

### Tier 1 (existing channels, in plan order)

| Channel | Flow | Owner prerequisite (outside code) | Scopes |
|---|---|---|---|
| eBay | Moved onto shared service; `prompt=login`; identity via `commerce/identity` on the **apiz** host; fold by `externalAccountId`; max scopes → "Reconnect" on old accounts | Keep prod keyset; re-point RuName accept URL to `https://nexusapi-production-b7bb.up.railway.app/api/cx/callback/ebay`; set Marketplace Account Deletion endpoint to the new ingress | ~20+ EU-seller scopes: api_scope, sell.inventory(+ro), sell.account(+ro), sell.marketing(+ro), sell.fulfillment(+ro), sell.finances, sell.payment.dispute, sell.analytics.readonly, sell.logistics, sell.stores(+ro), sell.listing.read (if on keyset), commerce.identity.readonly, commerce.notification.subscription(+ro), commerce.catalog.readonly, commerce.message, commerce.feedback, commerce.shipping; Buy/VeRO/Leads review-gated [cx §2.1] [cx1 §6] |
| Amazon SP-API | **New**: public-app consent from Seller Central (`application_id`, `state`, `version=beta` while draft) → `spapi_oauth_code` (5 min) → LWA exchange; `selling_partner_id` captured; region on card (EU default); `getMarketplaceParticipations` → scopes; env row adopted on first connect; yearly re-auth flagged 30 days ahead | Register app in Solution Provider Portal with every eligible role; redirect = API callback; LWA id/secret into ChannelApp | Roles: Product Listing, Inventory & Order Tracking, Pricing, Amazon Fulfillment, Buyer Communication, Buyer Solicitation, Finance & Accounting, Brand Analytics, Selling Partner Insights, Account Information SP, Notifications in Seller Central; Direct-to-Consumer Shipping + Tax Invoicing restricted (PII review, "pending approval") [cx §2.1] |
| Amazon Ads | Rebuilt on shared service; LWA + PKCE; `/v2/profiles` per region host → one scope per profile; 365-day expiry | Ads console allowed return URL = API callback; manual rows adopted by profile id | Plan said `advertising::campaign_management` (+ test, audiences). Built spec: `profile` + `campaign_management`; test + audiences review-gated. Hosts that work today: `www.amazon.com/ap/oa`, `api.amazon.com/auth/o2/token` [cx §2.1] [cx3a §3] |
| Shopify | **New**: Dev Dashboard app with Custom distribution (no review); card asks for shop domain (anchored regex); auth-code → `X-Shopify-Access-Token`; `app/uninstalled` + `app/scopes_update`; compliance topics; per-shop webhooks reconciled | Create app, redirect = API callback, id/secret into ChannelApp, make custom install link per store | Every `read_*/write_*` in research R3 §B except payments-partner/Plus-only; `read_all_orders` [cx §2.1] |
| Etsy | **New**: Seller App; PKCE mandatory; refresh rotates; 4 order webhooks set in Etsy portal (no API); polling for listings/inventory/ledger | Register Seller App; exact callback URL; keystring into ChannelApp; add 4 webhook endpoints in portal | `listings_r listings_w listings_d shops_r shops_w transactions_r transactions_w email_r address_r` [cx §2.1] |

- Second Shopify shop: a second custom app (unless Plus org), **or** a client-credentials grant for stores in the same Dev Dashboard org. §2.1 still calls this "open decision §5.3" [cx §2.1].
- WooCommerce: out of scope [cx].

### Tier 2 (real OAuth, one phase each after CX.8)
- Allegro: auth-code + PKCE, device flow for headless, poll event streams [cx §2.2].
- TikTok Shop: auth_code → `token/get`, signed calls, 16 webhooks, `shop_cipher` scopes [cx §2.2].
- Google Merchant Center: Google OAuth `content` scope, developer registration, product notifications [cx §2.2].
- Meta catalog: Login for Business, system-user token. App Review + Business Verification are one-time Owner tasks [cx §2.2].
- OTTO as Service Partner: auth-code `installation partnerId` [cx §2.2].
- Order: decision 11 says Allegro → TikTok → GMC → Meta → exceptions by revenue [cx §5.11]. The §4 table lists Allegro → TikTok → GMC → Meta → Kaufland → bol → OTTO → Mirakl, marked "(Owner to confirm)" [cx §4].
- Walmart appears only as a `disable_pkce` catalogue case. Temu, SHEIN and storefront platforms are not in the phase plan. They are covered in research R6/R7, which was not read here [cx §1.2D] [m-cx].

### Exception list (no operator OAuth exists) — key-paste
- Kaufland: Client Key + Secret Key from `sellerportal.kaufland.de/settings/api` → verify `GET /v2/info/storefront` → storefronts as scopes; push subscriptions auto-created [cx §2.3].
- bol.com: Client ID + Secret (Seller Dashboard → Settings → Services → API Settings) → verify token + `GET /retailer/orders`; Subscriptions v11 with RSA check [cx §2.3].
- Mirakl instances: instance URL + API key (+ shop_id) → verify `GET /api/account`; channels as scopes [cx §2.3].
- Cdiscount / Octopia: clientId + clientSecret (+ SellerId) [cx §2.3].
- Zalando zDirect: invitation from Fashion Partner, then client id/secret. "Invite-gated" [cx §2.3].
- ManoMano, eMAG: API key / Basic auth (+ IP allowlist). Docs partly unverified, and the card says so [cx §2.3].
- OTTO (only if not a Service Partner): client id/secret self-app [cx §2.3].
- Every exception card must [cx §2.3]:
  - say in one sentence why there is no sign-in button;
  - link the exact settings page;
  - check the key format before saving and encrypt on save;
  - run the verify call before showing "Connected".
- The key-paste form is not built yet (none in Tier 1) [cx2 §3].

---

## Keep / refactor / delete list

### Keep
- `ChannelConnection` + MAP.2a/2b/3/4 (resolver, AccountsPanel, primary/adopt rules, `ChannelConnection_active_account_key`) [cx §3.1].
- `OutboundSyncQueue` + `OutboundSyncService` + BullMQ + autopilot + janitor [cx §3.1].
- `sync-control-core` qty resolver + `SyncChannelPolicy`; `ChannelPublishAttempt`; `OutboundApiCallLog`; `ChannelStockEvent` drift triage [cx §3.1].
- `amazon-eu-quantity-guard`; publish gates; `ChannelSchema` + PIM mappings UI; `AccountsPanel` (DS) [cx §3.1].
- `api/lib/crypto.ts` → v2 envelope [cx §3.1].
- `oauth-state.ts`, retired for OAuthSession once eBay moves [cx §3.1].
- SQS poll job, which becomes an ingress source [cx §3.1].
- The Ads client's quota ledger + retry, as a model for the others [cx §3.1].

### Refactor (move behind the core)
- eBay connect/callback/refresh/revoke → `connectors/ebay` + shared services [cx §3.2].
- 14 `SellingPartner` + 5 LWA → `connectors/amazon-sp` token service [cx §3.2].
- `AmazonAdsConnection` → `ChannelConnection(AMAZON_ADS)` + profile scopes, with dual-read for one release [cx §3.2].
- `WebhookEvent` → `InboundEvent`; eBay notification receivers → ingress [cx §3.2].
- 7 Shopify clients → `connectors/shopify` [cx §3.2].
- settings/channels → DS tabs; the advertising manual form → a Connect button [cx §3.2].
- AccountsPanel disconnect → one revoke path [cx §3.2].

### Delete
- `amazon-auth-probe.routes.ts`, `/api/amazon-ads/debug/test-auth` [cx §3.3].
- `webhooks.routes.ts` public stock routes; `etsy-webhooks.ts` (fictional) [cx §3.3].
- `woocommerce*` (decision 5) [cx §3.3].
- `unified-sync-orchestrator.ts` + `product-sync.service.ts` + `sync/index.ts`; `marketplaces.ts` + `marketplace.service.ts` [cx §3.3].
- `inbound-sync.service.ts` + its route + Next proxy + unmounted button [cx §3.3].
- `outbound-sync-phase9.service.ts` (fold `markSync*` first); `variation-sync-processor.service.ts` [cx §3.3].
- The Phase-27 `channel-sync` lane: repoint "Sync all" at OutboundSyncQueue [cx §3.3].
- Root `amazon-sync.service.ts` status/retry endpoints + the fabricating Next routes + `SyncStatusModal` [cx §3.3].
- `services/marketplaces/ebay.service.ts` (app-token client) after its callers move; `services/ebay-sync.service.ts` (wrong endpoint) [cx §3.3].
- `sync-monitoring.service.ts` + `monitoring.routes.ts` + 2 unmounted dashboards; `RealTimeStockMonitor.tsx` [cx §3.3].
- `packages/shared/vault.ts`; shadowed/unmatched manifest entries; 11 dead docs (audit A6 §3) [cx §3.3].
- **Destructive, each needs its own approval** [cx §3.3] [cx §3.4]:
  - `ChannelConnection.ebay*` columns
  - `AmazonAdsConnection`
  - `MarketplaceSync`, `Channel`, `Listing`
  - `EbayPushJob` / `AmazonFlatFileFeedJob` after AsyncJob parity

### Migration path (additive first)
1. CX.1: new columns + 4 tables. Backfill `credentialsEnc` from plaintext (job, not SQL) and `authStatus` from isActive/lastSyncStatus. Code stops writing plaintext; plaintext is nulled after a row-count-exact gate [cx §3.4] [cx1 §1.3].
2. CX.3: AMAZON_ADS connection + profile scopes backfilled from `AmazonAdsConnection`; dual-read; Amazon env row → oauth on first connect [cx §3.4].
3. CX.4: WebhookEvent gains InboundEvent columns; the existing 5,158 rows → `status='done'` [cx §3.4].
4. CX.7: `ChannelRecord`, `ChannelFieldPolicy`, `AsyncJob`, `channelRecordId` FKs (SET NULL) [cx §3.4].
5. Destructive drops, each approved on its own [cx §3.4].

### Done since (per records)
- CX.0 deleted the public stock routes, Etsy + Woo receivers, Amazon probe, Ads debug route and refunds test route. Woo *services* stay until CX.5/CX.7 (imported by outbound sync, tracking pushback, marketplace.service) [cx0 §1] [m-cx].
- CX.1 deleted `ebay-token-refresh.job.ts` (registry key kept as an alias) [cx1 §7].
- CX.3b emptied the 9 Ads credential columns (restore job exists) [cx3b §8].
- CX.3a: `POST /api/advertising/connections` → 410 [cx3a §5].

---

## Phases CX.0 to CX.9+

### CX.0 — Stop the bleed
- **Goal:** close every Critical/High audit finding with the smallest diff. No schema, no new subsystem [cx0].
- **Deletions** [cx0 §1]:
  - D1 public stock routes (`webhooks.routes.ts`) + script.
  - D2 Etsy receivers + sync-logs replay branch.
  - D3 Woo routes + `validateWooCommerceSignature`.
  - D4 amazon-auth-probe + manifest entry.
  - D5 `GET /amazon-ads/debug/test-auth`.
  - D6 `POST /webhooks/shopify/refunds/create-test`.
  - D7 stop echoing 20 token characters (`refreshed: true`).
- **Guards** [cx0 §2]:
  - G1: Ads `/connect` behind `adsConnect`; callback 400 `missing_state` / `invalid_state`; always send `code_verifier`; prune PKCE store.
  - G2: raw-body JSON parser per receiver plugin (Shopify/eBay/Sendcloud) + `timingSafeEqual`.
  - G3: eBay push check → 503 if the token env is unset.
  - G4: AMS ingest → 503 if the secret is missing + timingSafeEqual.
  - G5: AccountsPanel disconnect revokes at eBay and nulls tokens.
  - G6: logger `redact()` of token/secret/authorization/password/code_verifier/api-key keys.
- **Secret scrub (S3):** 3 Neon URLs in `docs/PHASE33-CLOUD-DEPLOYMENT-PREP.md`. **The Owner must still rotate the Neon password** (it is in git history) and update Railway `DATABASE_URL` [cx0 §3].
- **Not in CX.0:** shared OAuth, real eBay ECDSA, subscriptions, token encryption, CSRF on body-less POSTs (S15) [cx0].
- **Gates:** new unit tests (Shopify HMAC over byte-exact fixture, Ads state, disconnect revoke). Prod curl table: 404s for removed routes, 401 for Ads connect, 400 for missing state, 503/204 eBay, 401/200 Shopify, AMS 401/503. Crons green 24 h [cx0 §5–6].
- The disconnect live test needs the Owner present to reconnect [cx0 §6].
- **State:** BUILT per record `a31b2cebd`, 44 tests. Deploy was held by Railway during a GCP incident. §6 prod table VERIFIED per memory. Shopify unsigned returns 400 "not configured" because there is no prod secret [m-cx].

### CX.1 — Connection core
- **Goal:** shared core with KMS-encrypted credentials decrypted in one module, leased refresh, ledger, `authStatus` + 4 timestamps, scope drift, eBay full scopes + signing, and a resolver that never hands out tokens. The operator's view must not change [cx1].
- **Changes:**
  - migration `20260830a_cx1_connection_core`
  - catalogue; crypto v2 (`@aws-sdk/client-kms`); token service
  - OAuth service + `cx-connect.routes.ts` + `cx-connections.routes.ts` (refresh/revoke/heartbeat/events admin)
  - `identity.service` (MAP rules moved); eBay connector dir + RFC 9421 signing
  - `cx-heartbeat` job; `cx1-credentials-backfill` + `cx1-credentials-restore` jobs
  - resolver `CONNECTION_PUBLIC_SELECT`; `/api/connections` + `/api/accounts` gain CX fields; `deriveHealth` reads authStatus first
  - boot `seedChannelApps()`; env Amazon row no longer stamped SUCCESS
  - web forwarder [cx1 §1–9] [cx1 §14]
- **Backfill rules** [cx1 §1.3]:
  - Encrypt + null plaintext in the same UPDATE, refused if the round-trip fails.
  - eBay `refreshTokenExpiresAt = createdAt + 547 d` until the next re-consent.
  - Scope backfill gate RAISEs on 0 scopes.
- **Flags:** `NEXUS_CX_TOKEN_SERVICE` (0 = legacy path), `NEXUS_OAUTH_COOKIE_ENFORCE`, `NEXUS_KMS_KEY_ID` [cx1 §9].
- **Owner prerequisites:** KMS key + IAM (`kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey`) + `NEXUS_KMS_KEY_ID`; RuName re-point (optional now, required by CX.2); one reconnect of `xaviaracing` [cx1 §10].
- **Gates (prod):**
  - every active oauth row has `v2:` (or honest `v1:`) and plaintext NULL
  - reconnect `xaviaracing`: scopes, drift = [], expiry ≈ 547 d, replay → 400 `state_consumed`
  - missing cookie → 400 `state_cookie_missing`
  - 2 parallel refreshes → 1 exchange
  - `ebay-financial-sync` 200 (was 403/215001)
  - heartbeat within 15 min; Amazon scopes = 11
  - old routes 410/404 [cx1 §11]
- **Build deviations** [cx1 §15]:
  - GLOBAL eBay scope ("All eBay sites") instead of 5 EU codes.
  - `/api/accounts` returns scopes + timestamps.
  - 410 `OAUTH_FLOW_MOVED`.
  - `admin/ebay-token-status` reads the key id.
  - `=== true` narrowing, because apps/api has no strictNullChecks.
- Prod facts before the build: 3 active rows (Amazon env, eBay `xaviaracing` primary since 2026-07-03, eBay `motovento` since 2026-08-20). 12 Amazon Marketplace rows, 11 participating [cx1 §15].
- **State:** PUSHED `61774d222`, DEPLOYED, prod-verified per memory [m-cx]:
  - backfill `candidates=3 encrypted=3 failed=0`
  - clean heartbeats + leased refreshes
  - daily eBay Finances failure FIXED. Three faults were stacked: no signature, wrong host (api→apiz), empty body parsed as JSON.
  - KMS not set: envelopes use the v1 env key and an alert fires.

### CX.2 — Channels UI on the design system
- **Goal:** one honest Channels page on the DS; tabs, not routes [cx2].
- **Problems fixed** [cx2 §0]:
  - two conflicting "connected" facts
  - "Coming soon" cards
  - Test always hit eBay
  - Ads manual paste form, with browser autofill putting a saved password into it
  - detail page off the DS
  - 632-line mixed client
- **Changes:**
  - Tabs `?tab=accounts|connect|diagnostics`; `useConnectPopup()` hook [cx2 §1].
  - Accounts rows: authStatus pill (Connected / Degraded — N failures / Sign-in needed / Access revoked / Disconnected / Not yet checked), region tag, scope chips, permissions line, timestamps line. `lastInboundAt/lastOutboundAt` show "not tracked yet" until CX.4 [cx2 §2].
  - Row buttons: Test = real heartbeat; Reconnect (relabelled on drift); one Disconnect [cx2 §2].
  - Connect tab is driven by the catalogue [cx2 §3]:
    - Held buttons use `aria-disabled`, stay focusable and show their reason inline.
    - Ads card: profile chips + Connect with Amazon Ads (existing PKCE flow).
    - `/settings/advertising` loses its paste form and shows a Banner instead.
  - Diagnostics tab: Run heartbeat, Refresh token now (409 on lease), ledger grid, recent inbound events, eBay category probe (labelled as IT + primary token) [cx2 §4].
  - Detail page rebuilt on the DS; new DS `KeyValue`, mirrored to `apps/factory` [cx2 §5–6].
- **Gates:** screenshots of every state (light/dark); component tests for states prod cannot show; geometry; honesty round-trips; held-button keyboard check; all pre-push guards [cx2 §8].
- **Built** `9fadf5130` + `c86393577` (event lists on NexusGrid, because the grid-kit ratchet refuses new DS-DataGrid users) [cx2 §11].
- **11 prod defects fixed** [cx2 §11–11c]:
  - title shown twice
  - Ads shown twice
  - "0 requested" scopes on SP-API (roles, not scopes)
  - env row "0 permissions"
  - "Last sync never (SUCCESS)"
  - old sync error floating under Connected
  - heartbeat result vanished after 200 ms
  - 502 px dead space
  - 22 repeated scope prefixes
  - `--nds-space-*` is a **pixel** scale (`--nds-space-3` = 3 px)
  - "Last sync" was really the last token refresh (a fossil); the orders cron now writes real sync fields
- **Not verified:** keyboard activation of held buttons (the harness could not press Enter); 390 px [cx2 §11b].
- Held-button copy says "SHOPIFY arrives with CX.4 … ETSY with CX.5". The plan has Shopify = CX.5 and Etsy = CX.6 [cx2 §3].

### CX.3 — Amazon SP-API OAuth + Ads Connect (split into 3a/3b/3c + SP-API half)
- **Plan goal:** `connectors/amazon-sp` (consent flow, participations → scopes, yearly re-auth, LWA secret-rotation listener) and `connectors/amazon-ads`; 19 auth sites → token service; boot seed removed [cx §4 CX.3].
- **Plan gates:** Connect Amazon on prod shows seller id + 11 marketplaces; all Amazon crons green 24 h on the new path; Ads profiles appear as scopes; bid writes continue (`lastWriteAt` advances) [cx §4 CX.3].
- **CX.3a** (Ads onto the core) [cx3a]:
  - Prod facts: 9 `AmazonAdsConnection` rows (4 prod DE/ES/FR/IT, 5 sandbox IE/NL/PL/SE/UK) sharing **1** credential blob. `lastVerifiedAt` stale since 2026-05-18; token expiry only an estimate; 75 read sites; 6 write sites.
  - Migration `20260831a_cx3a_amazon_ads_scopes`: 1 connection + 9 profile scopes, gate = scope count equals row count. No write to the old table.
  - Real connector spec: identity, heartbeat and `discoverScopes` across EU/NA/FE.
  - `resolveCredentials` reads core first, then the row (`NEXUS_CX_ADS_CREDENTIALS`).
  - The legacy callback dual-writes. Fixed: token shown in HTML, dead Railway link, 2 wrong marketplace ids.
  - `POST /api/advertising/connections` → 410.
  - Verified: `adopted=1`; both credential sources proven live; **14 profiles found** (EU 9, NA 3 US/CA/MX, FE 2 AU/JP).
  - Fixed: discovery wiped scope metadata (now merges); a duplicate label map.
- **CX.3b** (engine on the core) [cx3b]:
  - A: `adsProfileFor(marketplace)` shim over scopes, falling back to the row (`NEXUS_CX_ADS_RESOLVER`). The write gate was converted first and alone.
  - B: Ads token from the leased refresh (`NEXUS_CX_ADS_LEASED_TOKEN`).
  - C: archive the 9 duplicate secrets, with a restore job.
  - Verified: gate codes correct; log shows `source: core` + `leased`; `archived=9 mismatched=0`; restore run and re-archived; export cycle `created=9`.
  - Found: `utils/marketplace-code.ts` mapped `AMEN7PMS3EDWL` (Belgium) to IE, and Ireland `A28R8C7NBKEWEA` was missing → fixed `2c209a0c5`.
  - About 39 read sites were left on the legacy row.
  - Memory adds 3 near-misses [m-cx]:
    - the gate would have refused every write;
    - 'UNKNOWN'=='UNKNOWN' market match;
    - the export cycle would have made 0 jobs silently.
- **CX.3c** (truth on the page) [cx3c]:
  - `/api/advertising/connections` keeps its shape (9 web callers) but serves `lastVerifiedAt` ← `lastHeartbeatAt`, `lastError(At)` ← the connection, `tokenExpiresAt` ← `refreshTokenExpiresAt`, `tokenIssuedAtIsEstimate=false`.
  - The scope metadata shape is documented in `ads-profile-resolver.ts`.
  - Dead columns are not dropped. The 39 sites stay.
  - Rule: **account-level facts live on the connection** [m-cx].
- **SP-API OAuth half:** HELD. It needs the Owner to register the public app in the Solution Provider Portal [cx3a] [m-cx].
  - Background: in July an SP-API listings-write 403 looked like an auth-role problem. It was resolved the same day ("Amazon is syncing"; the raw client's Bearer read was the fault) [p/0720-as].

### CX.4 — Webhook ingress
- **Plan goal:** `POST /api/ingress/:channel/*`, verifiers, `InboundEvent`, ordered processor + retry + DLQ + replay, subscription reconciler, lifecycle → authStatus, Ingress tab [cx §4 CX.4].
- **Plan gates:** real eBay `marketplace.order.created` verified; account-deletion test passes; SP-API `LISTINGS_ITEM_STATUS_CHANGE` subscription fires; forged signature → 401 and no row; DLQ replay [cx §4 CX.4].
- **CX.4a** (built) [cx4a]:
  - Prod facts: `WebhookEvent` = 5,158 rows, all Amazon; 0 unprocessed; signature NULL on all; `ORDER_STATUS_CHANGE` last seen 2026-07-29 while `ORDER_CHANGE` still arrives.
  - eBay check was HMAC with the verification token (wrong) and returned 204 on reject (meaning "accepted"), writing nothing.
  - Now: ECC check via `GET /commerce/notification/v1/public_key/{kid}` with an app token, SHA-1 digest (`ssl3-sha1`), over the JSON re-serialised payload first, then the raw bytes. Reject → **412** + a ledger row. Key errors split into `app_token_unavailable`, `public_key_forbidden`, `public_key_not_found`.
  - The protocol was read from eBay's Apache-2.0 SDK and re-implemented.
  - Verified on prod: forged → 412; challenge still 200; 7 probe rows kept (archive never delete); Amazon rows unchanged.
  - **Not verified:** no genuine eBay signature has been checked (nothing subscribed); the Amazon ledger write has not run in prod yet.
  - `MARKETPLACE_ACCOUNT_DELETION` is acknowledged + recorded, but **erasure is not automated** (needs the Owner).
- **CX.4b** (planned): subscriptions + reconciler; eBay destination + topics; clean up the dead `ORDER_STATUS_CHANGE` subscription. This is an outward write, so a deliberate decision [cx4a §5–6].
- **CX.4c** (planned): retry / DLQ / replay + archiver [cx4a §6].
- **CX.4d** (planned): Ingress tab [cx4a §6].
- Memory index: AMS ingest has dropped Amazon Ads hourly data since profiles went ON (09-16 public-route audit) [MEMORY].

### CX.5 — Shopify connector (planned)
- Scope: Dev Dashboard custom app; auth-code connect with domain check; typed GraphQL (2026-07); bulk ops as AsyncJob; inventory CAS + idempotency; markets/catalogs/price lists, metafields, translations; compliance + uninstall topics; reconciliation streams; 7 old clients merged [cx §4 CX.5].
- Gates: connect the real store; `products/update` webhook verified; inventory round-trip with `compareQuantity`; bulk query as AsyncJob; uninstall/reinstall flips authStatus [cx §4 CX.5].
- Owner prerequisite: app + custom install link [cx §4 CX.5].

### CX.6 — Etsy connector (planned)
- Scope: Seller App + PKCE; rotation-safe refresh; polling streams; 4 portal webhooks; listing writes; FR/DE gating probe; old `etsy*` files deleted [cx §4 CX.6].
- Gates: connect the real shop; real `order.paid` verified; hourly refresh stores the new token; a listing edit round-trips [cx §4 CX.6].
- Owner prerequisite: Seller App approved + portal webhooks [cx §4 CX.6].

### CX.7 — Normalisation layer (planned)
- Scope: ChannelRecord + generated types; derived mappers with `channelRecordId`; ChannelFieldPolicy; mappings in the real push builders; Channel data tab; delete detection; retire the ghost engines [cx §4 CX.7].
- Gates: per channel, ChannelRecord count = channel count; dropped fields become visible (Shopify `vendor`, eBay `lineItems[].listingMarketplaceId`, Amazon `IsBusinessOrder`); a mapping rule changes the real Amazon payload digest [cx §4 CX.7].
- Mappers run in shadow mode first [cx §4 CX.7].

### CX.8 — Sync engine hardening (planned)
- Scope: per-connection concurrency groups + token buckets; AsyncJob for SP-API feeds/reports, Shopify bulk, eBay Feed; `DeprecationWatch` job; contract tests on recorded fixtures; sandbox-connect mode [cx §4 CX.8].
- Gates: a 429 storm is absorbed with no dead letters; an SP-API report runs end to end; a deprecation alert fires [cx §4 CX.8].

### CX.9…n — New channels (planned)
- One phase per channel: connector dir + catalogue entry; real connect, one inbound, one outbound on prod [cx §4 CX.9].
- Order: see Connect flow above (Owner to confirm the exact list).

### KMS turn-on (Owner runbook)
1. Create a symmetric key in eu-west-1 + alias `alias/nexus-credentials-production` (~$1/month) [kms §1].
2. IAM policy with only `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` for the API's AWS identity [kms §2].
3. Set `NEXUS_KMS_KEY_ID` on Railway [kms §3].
4. Run `POST /api/sync-logs/cron/cx-credentials-preflight/trigger` → expect `ok mode=kms`. A WARNING (`kmsConfigured=true` but mode=env) or FAILED means stop [kms §3b].
5. Run `cx-credentials-rotate`. It re-wraps everything and refuses if the preflight fails [kms §4].
6. Run `cx-credentials-status` → the finished state is `onEnvKey=0 kmsConfigured=true`. The Amazon env row shows as `noEnvelope=1`, which is expected. Then check the alert has stopped and a heartbeat passes [kms §5].
- Why it matters more now: the single Ads envelope is the only copy of the credential that authorises spend on 4 marketplaces [kms].
- Rollback: unset the var + rotate. **Never delete the key until `onKms=0`** [kms].

---

## Business profiles and shared accounts (BP, BP.S)

### BP model
- A **Business profile** = a `Workspace`. It owns business data, channel accounts, settings and access. A login reaches workspaces through memberships; an email is not an authorisation boundary [bp].
- Several accounts per channel inside one workspace are allowed. There is no one-account-per-channel rule [bp].
- **Separate catalogs and stock between workspaces by default.** Catalog sharing and inventory sharing are separate decisions [bp].
- Keep the hierarchy shallow. No mandatory parent-organisation tier [bp].
- Terms [bp]:
  - User; Workspace; Membership; Role (Owner / Administrator / Operator / Viewer).
  - Channel account = a verified external seller/shop identity with **one** owning workspace.
  - Connection / grant.
  - Marketplace destination (a country is not a profile).
  - Listing = product × account × marketplace.
- Grants ≠ profiles. Grant boundaries and account/market boundaries may differ [bp].
- One external seller account → one owning workspace. Two brands on one account → model them inside the workspace, or delegate. **Never duplicate credentials** [bp].
- No simple move of a live account [bp]. The assignment review only allows unused, disconnected accounts, and only with Owner access to both sides.
  - It refuses active credentials, pending sign-ins, recorded activity and linked records.
  - The destination gets a new inactive connection and needs a fresh sign-in; the source is retired.
  - The assignment runs atomically, with both audits.
- Disconnect suspends but keeps history. Archive ≠ delete [bp].
- Header: current profile + a shortlist + Search / Create / Manage. Server-side search + cursor pagination, pages ≤100 (UI asks for 24). No hard profile limit [bp].
- **Settings contract** [bp]:
  - User: name, email, password, MFA, sessions, theme, display language.
  - Workspace: identity, address, timezone, currency, branding, defaults.
  - Team/API keys/integrations: workspace, optionally narrowed to an account.
  - Connection status/permissions/sync options: account/grant.
  - Shipping/returns/tax/listing overrides: account + marketplace.
  - Personal views and notifications: user + workspace.
  - Shared views/automation: workspace.
  - Inheritance is per setting; nothing inherits across profiles; currency changes never rewrite history.
- **Interaction contract** [bp]:
  1. The switcher always allows creating a second profile.
  2. Personal settings stay in the user menu.
  3. Channels lists this profile's accounts; connecting captures the destination first; reconnect checks identity.
  4. Channel operations name account + marketplace; bulk ops list their destinations.
  5. Workspace in the route `/w/<id>/…`; switching keeps the page type and drops record ids.
  6. Unsaved edits get save / discard / cancel; a profile switch cannot retarget a write.
  7. Tabs are independent; last-used is only a default.
  8. Cross-profile reporting is an explicit read-only aggregate.
- **Enforcement** [bp]:
  - Per request: user + workspace + live membership + actions; roles never union across workspaces.
  - Check resource ownership, not just the route.
  - Same rules for API, GraphQL, server actions, SSR, exports, search, webhooks, jobs, workers and machine credentials.
  - Carry workspace + destination into jobs, audits, caches, storage and subscriptions.
  - OAuth state bound to user + workspace + connector + operation + target.
  - DB-level scoping; SKU unique per workspace; provider id uniqueness per identity domain / env / account / market.
  - Never fall back to another workspace's primary.
  - One stock authority per pool.
  - RLS with a non-bypass role.
- **Implemented** (per 2026-09-08 record) [bp]:
  - Workspace/membership/roles/invitations/audit; atomic create (+ settings + default warehouse).
  - **409 business models owned by workspace**, with PostgreSQL policies on a non-bypass runtime role + transaction-local context; natural ids scoped; triggers refuse cross-workspace links.
  - `ChannelAccountOwnership` + `ChannelAccountRoute`; OAuth state captures workspace/user/env/target.
  - `/w/<id>` routes; jobs keep their context; scheduled work pages through businesses with Redis leases; archive/restore cutoff.
  - Namespaced caches/search; credential resolution refuses another business's account; legacy env credentials limited to the initial legacy business.
  - Profile manager: create/rename/archive/restore; team roles/invites.
- Findings that drove it: role-based "profile" selector; first-row settings; first-user profile writes; global SKU unique; connection resolution without workspace. Legacy account-restricted roles stop the migration preflight [bp].
- **Migration sequence** [bp]:
  1. Inventory everything.
  2. Additive models + verified backfill + quarantine.
  3. Enforce scope + fix singleton paths.
  4. Build UI on one contract.
  5. Enable multiple workspaces only after reconciliation.
  - Once new workspaces hold data, rollback must keep ownership (forward fix, not snapshot).
- **Required evidence list** [bp]: one login across two workspaces; Amazon + eBay in one; two accounts on one channel; identical SKUs in two catalogs; scoped settings/files/search/exports/cache; denied member cannot use B's ids; revocation hits open sessions + queued work; tabs independent; OAuth return after a switch; wrong-account reconnect; counts reconcile.
- **Flags:** web `NEXT_PUBLIC_WORKSPACES_ENABLED=1` (also AuthProvider ENFORCE + `/backend/[...path]` proxy); api `NEXUS_WORKSPACES_ENABLED=1` (also RBAC enforce → unauthenticated = 401); `NEXUS_API_PROXY_TARGET` [m-bp].
- The 6 prod rollout conditions live in `docs/audits/2026-09-08-business-profiles/README.md`, not read here [m-bp].
- **State:** shipped dark `f212c2348` (2026-09-08). **Switched ON in prod 2026-09-16 12:39 UTC** (Railway deploy `827ccba8`, Vercel redeploy) [m-bp].
  - Everyone must sign in again.
  - Users created after 09-08 may have no membership.
  - Owner membership was inferred, not measured, because prod reads were blocked.
- **Prod issues at switch-on:** boot jobs `[amazon-notifications-boot] setup failed — Select a business profile` and `[fleet-workflow] custom clock resync failed` both run with no business context [m-bp].
- **Rollback:** Railway flag 0 + remove the Vercel env + redeploy. **Only safe while prod has ONE business** [m-bp].
- A push to main runs `prisma migrate deploy` in prod (`railway.toml`) [bps §23.2] [m-bp].

### BP.S model — "one owner, many guests"
- A seller account keeps one owning profile. Others get a **grant**. Ownership, credentials, reconnect, disconnect and inbound routing never move [bps §2].
- Why not a second owner: the PK refuses it, and `workspace-ingress.ts` would 503 `ingress_account_ambiguous` on every order. **Inbound must stay with one owner** [bps §1–2].
- Not chosen: copying the connection (two credential copies, two leases, two owners of listings/stock); a `workspaceIds[]` column (would need all 409 policies redone) [bps §2].
- Measured facts [bps §1]:
  - USING/WITH CHECK clauses are separate.
  - Resolver ratchet at 0 ambient (46 NAMED / 8 SCOPED / 31 WRITE / 14 OTHER).
  - One decrypt module.
  - `UserRole.channelScope` inert.
  - The RBAC hook keys on (method, pattern), so it cannot see the account.

### BP.S1 — read-only grant (a–d)
- **S1a** `20260916a`: `ChannelAccountGrant` (connectionId, guest workspaceId, ownerWorkspaceId, mode read|publish, marketplaces[] (empty = all), grantedBy/At, revokedAt/By; PK connection+guest) [bps §3.1] [bps §9].
  - Revoke = `revokedAt`, never DELETE.
  - A separate **`FOR SELECT`** policy on ChannelConnection + ConnectionScope. Widening the `FOR ALL` USING would have let a guest DELETE the owner's row.
  - 19-arm rehearsal passed.
  - Guest sees the account but **0** products/listings/orders/ConnectionEvents.
- **S1b**: `assertCredentialOwner` in `readCredentials` **and** in `getAccessToken` (the env-Amazon branch never decrypts) [bps §10].
  - Policies are GENERATED from `model-ownership.json` by `workspace-policies.mjs`. The shared `.sql` is copied byte-for-byte into the migration.
  - `ChannelAccountGrant` belongs in `globalModels`.
- **S1c**: routes `GET/POST /api/accounts/:id/grants`, `POST …/grants/:workspaceId/revoke`, `GET /api/accounts/shared-with-me`, at `settings.integrations.manage` [bps §12].
  - Owner of both sides required.
  - The account must be **owned**, not just visible.
  - API keys can never share.
  - `publish` was refused by name at first.
  - Re-share updates one row; both businesses get a WorkspaceAudit row; malformed marketplaces are refused.
- **S1d**: `rowActions()` in the DS engine [bps §13]:
  - Guest row = 0 controls, chip "Shared by <owner>", reason text.
  - Owner row adds "Share with a profile" beside "Assign profile" (Assign **moves**, Share **lends**).
  - `ShareAccountDialog`.
  - 8 colour swatches were still live until the accessibility tree caught them.
  - Mirrored to Factory. Contrast AA passes. The 390 px check did not run.
- ConnectionEvent is not shared, so a guest's Diagnostics shows no history. The doc left this for BP.S1d to decide; no outcome is recorded [bps §9.4] [bps §11].

### BP.S2 — per-person account limits (closes MAP.8)
- `20260916b`: RESTRICTIVE policy `nexus_account_restriction` on ChannelConnection. It is ANDed with every permissive one, so it covers owned + shared accounts, reads + writes, and all 46 lookups with no call-site change [bps §14.1].
- Three arms: no actor (jobs) → free; not restricted → free; on their list → allowed [bps §14.1].
- WITH CHECK blocks INSERT for restricted members [bps §14.1].
- The flag is a **row** in `WorkspaceMemberAccountLimit`. v1's boolean on `WorkspaceMembership` was self-liftable because that table had no RLS. Empty list = **no** accounts [bps §14.2].
- A restricted member can read their own allow-list [bps §14.4].
- `UserRole.channelScope` writers now refuse with `channel_scope_retired`. The column is not dropped [bps §14.5].
- Routes live on `/api/workspaces/:id/account-access` and `…/members/:memberId/account-access` (`/api/team/*` is 410 with profiles on) [bps §14.6].
- UI: Team & Access → Manage access → Account access [bps §14.7].
- Measured: a limited member saw 1 of 17 accounts; the owner and a job saw 17 [bps §14.7].

### BP.S3 — publish grants
- `20260916c`: `ChannelListingClaim` PK `(connectionId, marketplace, sellerSku)` makes a coordinate exclusive. One business pushes qty for it, so there are no double counters [bps §16.1].
- A claim is a lock: deleted on release, history in WorkspaceAudit [bps §16.1].
- Seller identity = `sellerSkuForClaim` (same rule as delist). A null identity on a shared account → refused [bps §16.1].
- Preflight is a no-op unless the account is shared; lazy import [bps §16.2].
- A publish grant mints a token; the grant is re-read on every call [bps §16.3].
- Correction: at first a guest **could not** publish, because the reference-guard trigger raised 23503 [bps §19.1].
  - Fixed by `20260916e` (`reference-guard.sql`): ChannelListing / VariantChannelListing / ProductListingAlias may link to a shared connection only with an active **publish** grant.
  - Orders, scopes, events, campaigns and policies stay refused.
  - Revoking publish freezes the guest's listings.
- Refusal notices: `publish-refusal-notify.service.ts`, deduped per listing while unread [bps §19.3].
- E2E probe 11/11 [bps §19.5].
- Share dialog: "See the account only" / "See it and publish with it"; guest chip names the mode [bps §16.7].

### Loose ends and extras
- **L1** `20260916d`: membership + role **writes** are owner-gated. Reads stay open, because sign-in resolves membership before a context exists. There is a bootstrap arm for creating a business. `Workspace` itself is still unprotected [bps §17.1].
- **L2**: CSRF is enforced. The alarm came from `install-fetch.ts` adding the header automatically; plain XHR with no header → 403 [bps §17.2].
- **Bell fix**: the bell read `'default-user'` and had never shown anything (391,197 rows) [bps §19.2] [bps §19.4].
  - Now scoped to the session user; permission is `PG.dashboard`; unread rows fetched first; rebuilt on the DS.
  - Local backlog marked read (older than 7 days, except danger).
- **Ads notifier**: active members of the business only, no cap, deduped per person, nobody when there is no context [bps §20].
- **Push-blocking checks**: `check-model-ownership.mjs` (437 models: 415 workspace, 22 global) and `check-policy-migration-parity.mjs` (6/6) [bps §21].
- **Profiles-ON ratchet**: `profiles-on-ratchet.mjs` vs a baseline of 42 files / 218 tests / 7 load failures. The list can only shrink; ~30 s per push [bps §22].
- `vitest.setup.ts` pins the flag to 0 unless the shell sets it [bps §22.1].

### BP.S state
- **Committed + pushed 2026-09-16:** `86a2a4777`, `80a6f4dc4`, `b1e47aa34`, `b0390cb39`, `4b868085d`, `46a70bad3`, `2c84f7e5e`, `633dfc34e`, `431856f0e` (+ docs to `2562b0a6e` per memory). Railway `e47e0815` SUCCESS; all 5 migrations applied in prod [bps §23] [m-bp].
- Two pushes were refused first: PH.4a route ratchet, and web live test 401 [bps §23.1].
- Prod changes that showed up: the bell works (prod backlog not marked read); ads notices go to active users only [bps §23.2].
- **Still open** [bps §18] [bps §22.4]:
  - 42 test files fail with profiles ON (guarded, not fixed).
  - No 390 px check.
  - `Workspace` has no write protection.
  - The mutation harness and ratchet branch proof live in the scratchpad, not the repo.
  - Not in CI.
- **Out of scope** [bps §6]: sharing listings/orders/stock/catalog into a guest; cross-profile reporting; moving an account with history.
- Local state: one live **read** grant (eBay `xaviaracing` → "Second Business (test)"); `ChannelListingClaim` empty [bps §19.6].
- Memory index: the account-move guard refused an UNUSED store (heartbeat `lastSyncAt`, API logs and ReadinessIndex count as "activity"). eBay order import never saves the store link [MEMORY].

---

## Multi-account (MAP, EMA, map0, map6)

### EMA (2026-07-30) — eBay only, SUPERSEDED by MAP
- **Goal:** many eBay seller accounts from one Nexus, with the flat file as the main surface [ema].
- Facts [ema §1]:
  - One eBay app, many user grants (env `EBAY_CLIENT_ID/SECRET/RUNAME`).
  - Blocker: unique index `(channelType, marketplace) WHERE isActive`, so a second grant hit P2002 after consent.
  - 63 `findFirst` sites in 37 files.
  - All layers below the resolver already take `connectionId`.
- Collision table: ChannelListing / VariantChannelListing keys collide; SharedListingMembership / Order survive but lack an account; EbayCampaign already correct; SyncChannelPolicy needs an account [ema §1.4].
- Market research: 3Dsellers, inkFrog, SixBit, Kyozou, Sellbrite/Linnworks/Rithum, Zentail. All treat account as a scope, with SKU as the cross-account key [ema §2].
- Platform rules [ema §2.4]:
  - Rate limits per seller token + partner limits.
  - Multiple accounts allowed (unique email each).
  - **Duplicate-listing policy is the top risk**: accounts are linked by IP/fingerprint/payment, so a suspension spreads.
  - MUAA is staff access, not multi-store.
- Architecture: fail-closed `resolveEbayConnection(scope)`; account = scope switcher with `?account=`; one pool across accounts with per-account buffer / Follow / Pinned / `pushesPaused` [ema §3].
- Phases [ema §4]:
  - EMA.0 audit
  - EMA.1 data model (non-additive, gated)
  - EMA.2 resolver + ratchet
  - EMA.3 connect second account
  - EMA.4 account-scoped flat file + **duplicate guard**
  - EMA.5 pool fan-out across accounts
  - EMA.6 everything per account
  - EMA.7 cross-account console + copy-to-account (lands as a draft)
  - EMA.8 per-account RBAC + audit + rate budgets
- Out of scope: Amazon/Shopify multi-account, reopening pool split, Woo/Etsy, legacy import [ema §7].

### MAP (2026-08-19) — channel-agnostic multi-account
- **Goal:** several seller accounts per channel; a top-right account chip; a two-click connect [map].
- Rithum study (screen recording, 2,247 frames, no audio) [map §1]:
  - Rithum **has** an account switcher (this corrects our research).
  - It also has product Labels.
  - Switching keeps the page (`url=`).
  - Working scope = one account; reporting = many.
- What to take: chip, flag/label/health, current highlight, scope in URL, stay-on-page switch. What to leave: org grouping, Recent/Pinned, search until more than ~8 accounts [map §1.4].
- Scope rule: "Account is the working scope, selected globally, carried in the URL, and it never changes the page you are on. Market stays the column axis. Reporting selects many accounts; editing selects one." [map §3.1]
- Intent labels (product → account) answer the gap report and drive the duplicate guard [map §3.4].
- **Phases and state** [map §4]:
  - MAP.0 ✅ audit script + diagnostics endpoint. 94 sites, 60 ambient.
  - MAP.1 ✅ DS AccountSwitcher/AccountBadge/AccountContext, mounted in the overlays beside the bell. Both flat files inherit it with no edit. `TopBar.tsx` is dead code.
  - MAP.2a ✅ `20260819a`:
    - account columns on ChannelConnection;
    - `channelConnectionId` SET NULL on ChannelListing / SharedListingMembership / Order / SyncChannelPolicy;
    - identity-keyed unique;
    - gate proven both ways (977/712/4394).
  - MAP.2b ✅ `20260819b`: 4-column keys with `NULLS NOT DISTINCT` (PG 17.10); the compiler forced 18 callers; 977/977 same row.
  - MAP.2b-ii ✅ `20260819c`: old keys dropped. A second eBay account can now exist.
  - MAP.3a ✅ fail-closed resolver + pure `chooseConnection` (13 tests) + pre-push ratchet. All 6 jobs converted.
    - `ebay-feed-poll` stays on the declared primary (EbayPushJob has no connectionId).
    - `ebay-status-reconcile` needs a function extraction.
  - MAP.3b ✅ 54 → 12; `tryResolveConnection` for sites that degrade instead of throw.
  - MAP.4 ✅:
    - eBay `commerce.identity.readonly` + `getSellerIdentity()` on apiz;
    - fold on re-consent; refuse an unidentifiable second account;
    - the chip switches `?account=` on the same route;
    - AccountsPanel with Rename / Make primary / Disconnect / + Connect another;
    - `PATCH /api/accounts/:id`, `POST :id/primary`, `POST :id/disconnect`, `GET :id/blast-radius`;
    - primary swap = one transaction (unset, then set);
    - disconnect deactivates, never deletes, and refuses on the primary while others exist (blast radius 981 rows);
    - env Amazon row shows a reason, not a button;
    - fixed 8-swatch account colour.
  - MAP.5 ❌ DROPPED (Amazon seller OAuth). It re-enters later as one connect flow; `seedEnvManagedConnections` already stands aside when an OAuth Amazon row exists.
  - MAP.6 🔒 (1) ✅ 12 flat-file lookups; (2) account-scoped flat file + duplicate guard, **not proposed**.
  - MAP.7 not started: per-account orders/returns/financials/images/descriptions/ads; pool fan-out per account with buffers + kill switch; intent labels.
  - MAP.8: **closed by BP.S2** [m-bp]. The MAP plan had it as `accounts: [connectionId]` in `channelScope`; memory says it is "NOT a small key addition" [m-map].
- MAP Q4, catalogue overlap: the guard is scoped by intent. What would settle it is whether store 2 is a second shopfront (overlap) or a distinct range. Revisit at MAP.4 [map §6].
- Defects found [map §7]:
  - `channel` vs `channelType` bug in order cancellation + eBay markAsShipped (thrown on every call since May). Fixed in MAP.3b per memory [m-map].
  - DS `.dark` missing strong tokens.
  - eBay "eBay seller (verified)" placeholder; Amazon label = merchant id.
- Risks: wrong-store push (resolver + ratchet); duplicate-listing suspension (highest risk); backfill; job cost per account; flat-file format churn; pool fights [map §8].
- **Latent defect (memory, not fixed):** `channelConnectionId` is nullable but inside ChannelListing compound uniques. Ten call sites would throw on the first unattributed listing (e.g. a Shopify listing before Shopify connects). Guarded by `compound-unique-null.vitest.test.ts`; fix pattern is the PES.5 dual column [m-map].

### map0 burn-down
- Generated by `apps/api/scripts/map0-connection-resolution-audit.mts`. Now **0 ambient sites across 0 files** [map0].

### map6 flat-file edit list
- 12 statements in `ebay-flat-file.routes.ts`: 5 DERIVED `{itemId(, marketplace)}`, 7 DECLARED primary. 60 insertions / 46 deletions [map6].
- Derived sites fall back to the primary: `reconcile-item`, `verify-item`, `convert-axes-italian` and `relabel-item` create the memberships attribution derives from [map6].
- All 31 prod (itemId, marketplace) pairs resolve to the same connection as before [map6].
- Burn-down **60 → 0**; baseline 0 [map6].
- Item (2), account-scoping, is separate and large (`EbayFlatFileClient.tsx` 4,717 lines, route 3,871 lines) [map6].

---

## Older plans (Part B) — one block per file

**EBAY-INTEGRATION-PLAN.md (Phase 3, undated)**
- Goal: eBay as the second channel — OAuth2, token management, inventory pull + auto-match, order sync.
- Direction: eBay→DB read-only for inventory and orders; DB→eBay writes for price.
- Endpoints: `/identity/v1/oauth2/token`, `/sell/inventory/v1/inventory_item`, `/sell/fulfillment/v1/order`, `…/offer`.
- Weekly phases 3.1–3.4.
- State: checklist unticked; "Proceed with Phase 3.1". Historical [eip].

**s/0627-ebay-shared-variant-sku-sync-design**
- Goal: the same variant SKU (e.g. a liner) under genuinely different eBay parent listings; the same Custom Label in Seller Hub; real-time pool sync.
- Compliant because the products really differ.
- eBay only; sequential sub-plans.
- State: Draft for review.

**p/0627-ebay-shared-sku-phase1-trading-api-foundation**
- Goal: `ebay-trading-api.service.ts` with `AddFixedPriceItem` (InventoryTrackingMethod=ItemID, never SKU) and `ReviseInventoryStatus` by ItemID+SKU.
- OAuth IAF token header; app headers from env (`EBAY_DEV_ID/APP_ID/CERT_ID`, compat 1193, per-market SITEID).
- Client only.
- State: BUILT per later plan.

**p/0627-…-phase2-membership-create-service**
- Goal: `SharedListingMembership` model (migration created, not applied) + `ebay-shared-listing-push.service.ts` (`buildSharedListingInput` → `createSharedListing` → `pushSharedListings`), dry-run default.
- No Inventory API use (it forces unique SKUs).
- State: BUILT per later plan.

**p/0627-…-phase3-fanout-sync**
- Goal: a stock change pushes qty to **every** listing holding the shared SKU.
- The existing cascade gains `enqueueSharedTradingFanout`: one `OutboundSyncQueue` row per ACTIVE membership, capped by `computeAvailableToPublish`.
- No new queue/worker/cron.
- State: BUILT per later plan.

**p/0627-…-phase4-flatfile-ux**
- Goal: a per-parent `sharedSkuListing` flag in `platformAttributes` routes a family to `pushSharedListings`.
- No migration; untouchable-file exception approved (option A).
- State: BUILT per later plan.

**p/0627-flat-file-shared-rebuild**
- Goal: one shared component tree for the Amazon + eBay editors (`useFlatFileCore`, `FlatFileToolbar`, `ColumnGroupModal` with dnd-kit).
- No API/schema change; 10 tasks.
- State: doc silent.

**s/0629-nexus-hub-sku-linkage-design**
- Goal: Nexus mirrors each channel listing **1:1**: `Product.sku` == seller SKU.
- Linkage by ASIN / ItemID / Shopify variant id in `ChannelListing.externalListingId`.
- Rename = relist the same ASIN under the new SKU; direct SKU edits on live products stay blocked.
- Supersedes the Shadow-SKU draft.
- State: FOR APPROVAL.

**s/0630-amazon-flat-file-browse-nodes-design**
- Goal: browse nodes first-class. "Category" = product type + browse node, assigned per group, taken from PTD `recommended_browse_nodes`.
- Required fields come from the product type, not the node.
- State: APPROVED design.

**p/0630-amazon-flat-file-browse-nodes**
- Plan for the spec above: phases 0–4 (source of truth, picker column, per-group Category, toolbar replacement, freshness/validation).
- Ship live, no flag.
- State: doc silent on build.

**s/0630-realtime-inventory-sync-design**
- Goal: provably correct cross-channel real-time inventory.
- Live channels at the time: Amazon (FBA+FBM EU) + eBay; Shopify connected, not transacting.
- Phases 0–7.
- State: roadmap APPROVED.

**p/0630-phase0-inventory-sync-baseline**
- Goal: read-only instruments — outbound latency (`createdAt→syncedAt`), config/health diagnostic, drift baseline, gated canary.
- No behaviour change; FBA guard untouched.
- State: BUILT per Phase 7 doc.

**p/0630-phase1-outbound-ordering-correctness**
- Goal: kill last-writer-wins. `resolveDispatchQuantity()` re-reads current qty at dispatch; `coalescePendingQuantityRows()` cancels superseded PENDING rows.
- Flag `NEXUS_SYNC_ORDERING_V2` (default ON). Shopify re-read deferred.
- State: BUILT per Phase 7 doc.

**p/0630-phase2-symmetric-oversell-guard**
- Goal: Amazon-FBM gets eBay's warehouse clamp; every clamp emits `sync.oversell.clamped`.
- Flag `NEXUS_OVERSELL_CLAMP`; FBA never clamped; Shopify deferred.
- State: BUILT per Phase 7 doc.

**p/0630-phase3-reservation-lifecycle**
- Goal: stop `OPEN_ORDER` reservations locking stock.
- Hourly reconcile: CANCELLED → release; SHIPPED/DELIVERED → consume; REFUNDED/RETURNED or stale non-terminal → alert only.
- State: BUILT per Phase 7 doc.

**s/0701-amazon-flat-file-custom-groups-design**
- Goal: operator-named collapsible SKU groups + an FBA/FBM preset.
- View-only; zero feed leak.
- State: APPROVED 2026-07-01.

**p/0701-amazon-flat-file-custom-groups**
- Plan for the spec above: `group-model.ts`; header rows only at render; localStorage per market (`ff-amazon-${market}-groups`); per-SKU groups may split a family.
- State: doc silent.

**p/0701-ebay-sync-fix**
- Found: eBay outbound was 0/4,120 in 30 days (83 failed, 3,986 circuit-open).
- Root cause: `Content-Language: en-US` hardcoded; missing `Accept-Language` + `X-EBAY-C-MARKETPLACE-ID` → 400/25709.
- Fix: market-locale headers (copied from the working flat-file push); show the real error instead of "circuit open"; failure isolation.
- State: doc silent.

**s/0701-feed-processing-summary-parity-design**
- Goal: Amazon-grade feed summary — every issue with code/category/severity/message/attribute/location, by-code roll-up, jump to cell, CSV/Excel.
- Channel-neutral `FeedIssue`.
- State: DRAFT.

**p/0701-feed-processing-summary-parity**
- Plan for the spec above: stored in the existing `AmazonFlatFileFeedJob.perSkuResults` (no migration); backward compatible; messages verbatim.
- State: doc silent.

**p/0701-phase4-latency-hardening**
- Goal: order-driven BullMQ priority (`NEXUS_OUTBOUND_PRIORITY`) + hourly latency watchdog (`NEXUS_LATENCY_WATCHDOG`, `NEXUS_LATENCY_P95_BREACH_MS`).
- P4.1 (eBay real-time ingestion) already shipped.
- State: FOR APPROVAL at write; built per Phase 7 doc.

**p/0701-phase5-reconciliation-drift**
- Goal: schedule Amazon reconcile (reporting-only) + eBay read-back via `GET inventory_item` into `recordChannelStockEvent`.
- Flags `NEXUS_RECONCILE_CRON`, `NEXUS_EBAY_READBACK` (cap 200), `NEXUS_DRIFT_ALERTS`. Shopify deferred.
- State: as Phase 4.

**p/0701-phase6-control-tower**
- Goal: one DS page for per-SKU × channel sync state, resync, bulk retry, suppress, delta preview, live banner.
- One new aggregation endpoint; existing actions reused.
- State: as Phase 4.

**p/0701-phase7-polish-closeout**
- A menu of polish items:
  - A1 delete dead `outbound-sync-phase9` code
  - A2 audit `followMasterQuantity` toggles
  - A3 runbook of all flags
  - B deferred tower actions
  - C larger hardening
- Phases 0–6 are in PR `inventory-sync-hardening`.
- State: FOR APPROVAL.

**p/0702-ebay-add-variant-import-reparent**
- Goal: add variant / import under parent / re-parent on the eBay flat file, persisted.
- Link = `platformProductId` + `_isParent` + `aspect_*`.
- Gap: eBay save could not create products.
- State: APPROVED 2026-07-02.

**p/0702-ebay-custom-groups**
- Goal: Amazon-style named groups on the shared FlatFileGrid.
- Modes Family | Custom | None, keyed by `item_sku`, gated by `enableCustomGroups`.
- State: APPROVED; P1–P4.1 BUILT per record.

**p/0702-ebay-shared-sku-flatfile-management**
- Goal: the shared child row shows under every parent listing (rebuilt from memberships); per-listing price on a new `SharedListingMembership.price`; qty always from the pool.
- Needs a migration go.
- State: doc silent; it supersedes the unblock plan.

**p/0702-ebay-shared-sku-flatfile-unblock-persist**
- Option A: relax the duplicate-SKU guard for shared families + create member products on save.
- State: SUPERSEDED (folded into the management plan).

**s/0704-ebay-explicit-parentage-columns-design**
- Goal: an Amazon-style parent/child column on the eBay flat file, replacing the implicit `platformProductId` + modal flows; manage many parents in one sheet.
- The Amazon model is `parentage_level` / `parent_sku` / `variation_theme`.
- State: design study; verdict in the doc.

**s/0706-channel-market-scoped-flat-files-design**
- Goal: "A separate file for each channel and market …"
- Keep C1 (one Product per SKU; stock on the child SKU) and C2 (follow-master content).
- Fix: deletes crossing channels.
- An Action column for staged per-row lifecycle.
- State: FOR APPROVAL (verbal yes).

**p/0706-channel-market-scoped-removal**
- Goal: "remove" deletes only that channel + market `ChannelListing`, never the Product or stock.
- eBay `remove-channel-listing` intent; Amazon `removeAmazonListing` + `POST /amazon/flat-file/remove`.
- State: doc silent.

**p/0706-ebay-per-market-flat-file**
- Goal: each eBay market (IT/DE/FR/ES/UK) is its own URL-driven view.
- `GET /rows?marketplace=`; rows keep all-market columns.
- State: doc silent.

**p/0706-scoped-view-load**
- Goal: editors show only SKUs listed on their channel (+ market) via `buildListingScopeWhere`.
- Listed/All toggle + hidden-count indicator.
- State: doc silent.

**p/0707-stock-import-wizard-perfection**
- Found: the IM.1 stock wizard's two parsers disagree ("No valid rows"); mapping defects; channel-sync defects.
- Phased fix proposed.
- State: FOR APPROVAL.

**p/0708-follow-master-bulk-tool**
- Goal: one pool number per product; per-listing Follow vs Pin qty and Follow vs override price; Qty + Follow columns in both flat files; safe saves.
- State: FOR APPROVAL.

**p/0709-ebay-flatfile-excellence (EFX)**
- Found: 10 axis/theme defects. D1: `GET variation-matrix` 404s. D2: `variation_theme` has no effect on push. Plus a Team Name column, image issues, follow/buffer audit.
- Phased.
- State: FOR APPROVAL.

**p/0710-ebay-axes-consistency-fix (EAC)**
- Found: five UI surfaces re-derive axes instead of using `resolveVariationAxes`.
- Fix in two layers. Safeguards warn, never block.
- State: APPLIED in part 2026-07-10; next steps approved.

**p/0710-unified-flat-file-excellence (UFX)**
- Goal: Amazon multi-category; infinite canvas; one shared grid; schema fixes; UX.
- State: BUILT + verified per record (8 phases, 2026-07-11).

**p/0716-ebay-dynamic-description-engine (ED)**
- Goal: `EbayDescriptionTheme`, rendered at push around the operator's body; per-market assignment in `platformAttributes.descriptionThemeId`; galleries per group; active-content sanitiser; never blocks a push.
- State: BUILT per record (ED.1–5).

**p/0716-xlsm-amazon-template-hybrid**
- Goal: `.xlsm` import/export; list on Amazon's own template, then import so Nexus runs it; compact `#` column + View menu.
- 32 MB body limit fix.
- State: BUILT per record.

**p/0717-amazon-import-excellence (AMX)**
- Goal: total-control Amazon import on every scenario.
- State: FOR APPROVAL at write; AMX.1/2/4 BUILT per FFT record.

**p/0717-ebay-import-excellence (EI)**
- Goal: typed coercion, market-aware mapping, Review-listings (Adopt/Create/Skip), import policies, typed-END destructive gate, sheet picker.
- State: BUILT per record (EI.1–6); EI.7 = `docs/ebay-import-runbook.md` + Owner E2E.

**p/0719-flat-file-trust (FFT)**
- Goal: zero data loss.
  - 32 MB limit on 5 save routes.
  - eBay save read-back verify.
  - `listing-content-write.service.ts` choke point.
  - `AmazonFamilyWorkbook` as export base.
  - Feed-reject re-arm.
- Incidents I1–I3 resolved.
- State: BUILT per record.

**p/0719-realtime-fbm-sync-perfection (RT)**
- Goal: real-time FBM sync on all platforms.
- Invariants: FBA untouchable, listing-level writes, shared pool.
- Measured baseline; target SLOs; phased.
- Re-opens the 07-06 deferral.
- State: FOR APPROVAL at write; RT.0–7 delivered per the AS study.

**p/0720-pool-to-amazon-sync-study (AS)**
- Findings:
  - Engine correct: 415/417 FBM listings matched the pool.
  - The apparent SP-API write 403 turned out to be a raw-client read issue; Amazon is syncing.
  - `amazon-qty-readback` found 172 diffs and self-heals.
- Verdict: do not rebuild; make silent failure impossible.
- State: APPROVED; AS.1/3/3b/4/5/2-lite BUILT per record.

**p/0721-sync-control-datagrid (SCG)**
- Goal: rebuild the Sync Control table on the /products/next DS stack; cards capped; search debounced.
- State: BUILT + prod-verified per record.

**p/0721-sync-control-product-view-scv (SCV)**
- Goal: product-first master rows (37, not 1,760), with thumbnails, rollups and full bulk/import/export control.
- State: BUILT + prod-verified per record.

**p/0721-sync-control-sc-series (SC)**
- Goal: route a location's stock to chosen channel-markets; mute products/variants from real-time sync; Stock-page tab.
- Principles: pool is the single truth, empty = today, FBA untouchable, listing-level writes, audited + recascaded, read-backs aware of routing.
- State: FOR APPROVAL.

**p/0725-sync-control-canonical-grouping (SCD)**
- Goal: fold duplicate families into one logical product using the shared-inventory pool relationship (37 masters → 15 products); live creation.
- State: BUILT + prod-verified per record.

**p/0726-sct6-market-offer-control (SCT.6)**
- Goal: stop FBM selling in chosen EU markets without touching reviews/ASIN/other markets.
- Close = Listings PATCH delete `purchasable_offer` for one marketplace; reopen = back to Follow.
- Four write stacks, so resurrection-proofing is needed; pilot before bulk.
- Research: 24-agent workflow.
- State: doc silent.

---

## Open questions and held items for the Owner

**Owner actions outside code (holding programme work)**
1. **KMS key** (alias `alias/nexus-credentials-production`, 3-action IAM, `NEXUS_KMS_KEY_ID`, then preflight → rotate → status). Credentials are on the v1 env key and the alert fires until this is done [kms] [m-cx].
2. **Rotate the Neon password.** It is in git history; update Railway `DATABASE_URL` in the same window [cx0 §3] [MEMORY].
3. **Register the SP-API public app** in the Solution Provider Portal with every role; redirect = API callback. This blocks the CX.3 SP-API half [cx §2.1] [cx3a].
4. **Re-point the eBay RuName** Auth Accepted URL to `https://nexusapi-production-b7bb.up.railway.app/api/cx/callback/ebay`. Until then the web forwarder stays [cx1 §10].
5. **Ads console** allowed return URL → API callback. The legacy callback keeps working until then [cx §2.1] [cx3a §5].
6. **Reconnect** `xaviaracing` and `motovento` to grant the full eBay scope set (prod showed 22 missing) [cx1 §6] [cx2 §11].
7. Shopify Dev Dashboard custom app + install link (CX.5); Etsy Seller App + 4 portal webhooks (CX.6); Meta App Review + Business Verification (Tier 2) [cx §2.1–2.2].
8. Set the eBay Marketplace Account Deletion endpoint to the new ingress [cx §2.1].

**Decisions waiting**
9. **CX.4b**: create the eBay Notification API destination + topic subscriptions. This is an outward write that starts live traffic. It also covers cleaning up the dead `ORDER_STATUS_CHANGE` subscription [cx4a §5–6].
10. **Automated erasure** for eBay `MARKETPLACE_ACCOUNT_DELETION`. Today it is acknowledged only [cx4a §6].
11. CX.9+ channel order: decision 11 and the §4 table differ; §4 says "Owner to confirm" [cx §4] [cx §5.11].
12. Second Shopify shop: custom app per shop, or client-credentials? §2.1 still calls it open [cx §2.1].
13. Each **destructive drop** needs its own yes (after a green week): `ebay*` columns, `AmazonAdsConnection` (+ its dead `lastVerifiedAt/lastError` columns), `MarketplaceSync`, `Channel`, `Listing`, `EbayPushJob`, `AmazonFlatFileFeedJob`, `UserRole.channelScope` [cx §5.6] [cx3c §3] [bps §14.5].
14. Raw-event archive needs an S3-compatible bucket. Until then the archiver only logs [cx1 §1.2].
15. **MAP.6 item (2)**: account-scoping the eBay flat file + the cross-account duplicate-listing guard. Not proposed; touches untouchable files [map6].
16. **MAP Q4** catalogue overlap: is store 2 the same range or a distinct one? This decides whether the guard does real work [map §6].
17. MAP.7 (per-account everything + intent labels) is not started [map].
18. Part B proposals still marked FOR APPROVAL in their docs: Phase 7 menu, stock import wizard, follow-master tool, EFX, AMX (partly built), SC series, Nexus-hub SKU linkage, channel/market-scoped spec [p/…].

**Known gaps / risks recorded in the docs**
19. About 39 Ads read sites still read the legacy `AmazonAdsConnection` row (deliberate) [cx3b §9] [cx3c §3].
20. No genuine eBay notification signature has been checked yet; the Amazon ledger write has not run in prod [cx4a §5].
21. CX.2 held-button copy has the wrong phase numbers (Shopify "CX.4", Etsy "CX.5" vs the plan's CX.5/CX.6) [cx2 §3].
22. Memory says decision 9 is "retention 90 d"; the doc says archive, never delete (7-year lifecycle). The doc is newer [m-cx] [cx §5.9].
23. MAP latent defect: nullable `channelConnectionId` inside compound uniques. 10 call sites break on the first unattributed listing [m-map].
24. `ebay-feed-poll` stays on the declared primary (EbayPushJob has no account); `ebay-status-reconcile` needs extraction before it can loop per account [map MAP.3a].
25. BP with profiles ON: 42 API test files fail (guarded by the ratchet, not fixed); `Workspace` has no write protection; no 390 px check; the gate harnesses live in the scratchpad; not in CI [bps §18] [bps §22.4].
26. Prod boot jobs fail with no business context: `amazon-notifications-boot`, `fleet-workflow` clock resync [m-bp].
27. BP rollback is unsafe once a second business holds data [m-bp].
28. The prod notification backlog was not marked read (local only) [bps §23.2].
29. A guest profile sees no ConnectionEvent history on a shared account. No recorded decision on whether that is honest [bps §11].
30. Out of scope until decided: sharing listings/orders/stock/catalog into a guest; cross-profile reporting; moving an account that has history [bps §6].
31. Memory-index pointers, not opened (verify before acting) [MEMORY]:
    - AMS ingest drops Amazon Ads hourly data since profiles ON.
    - 14 monitoring routes are unauthenticated.
    - eBay `invalid_scope` from off-keyset scopes (`sell.logistics`, `commerce.catalog.readonly`).
    - The account-move guard refuses unused stores.
    - eBay order import never saves the store link.
    - LX4/LX5 tables have no RLS in prod.
32. Not covered by any plan read: Walmart, Temu, SHEIN, storefront platforms. They are only in research R6/R7, which was not read here [m-cx].
