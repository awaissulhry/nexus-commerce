# EMA — eBay Multi-Account

**Status:** PROPOSAL — awaiting gate. No code changed.
**Date:** 2026-07-30
**Goal:** Connect and operate multiple eBay seller accounts from Nexus as a single source of truth,
with the flat file remaining the primary control surface.

**Decisions taken (operator, 2026-07-30):**
1. **Scope model** — account is a top-level **scope switcher**; markets stay the column axis (§3.2).
2. **Catalog** — **the same Xavia catalog on every account.** This is load-bearing: it makes the
   cross-account duplicate-listing guard a *gate on first push*, not a late nicety (§4, EMA.4).
3. **Sequencing** — groundwork first: EMA.0-2 ship before a second account can connect.

---

## 1. What exists today, and what each piece is for

### 1.1 The connection layer

`ChannelConnection` (`packages/database/prisma/schema.prisma:5535`) is the single table holding every
marketplace grant. eBay rows carry `marketplace = null` on purpose — one eBay OAuth grant covers all
EU sites (IT/DE/FR/ES/UK), unlike Amazon where OAuth is per-region.

Columns that matter here:

| Column | Purpose |
|---|---|
| `channelType` | `"EBAY"` \| `"AMAZON"` \| `"SHOPIFY"` |
| `marketplace` | null for eBay (multi-site under one token) |
| `managedBy` | `oauth` \| `env` \| `pending` |
| `accessToken` / `refreshToken` / `tokenExpiresAt` | generic credentials (current) |
| `ebay*` (8 columns) | legacy eBay-specific mirror, still dual-written by `saveTokens` |
| `displayName`, `ebaySignInName`, `ebayStoreName` | seller identity — already captured per grant |
| `isActive`, `lastSyncStatus`, `lastSyncError` | health |

`OAuth` itself is app-level, not account-level: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`
come from env (`ebay-auth.service.ts:33-42`). **One app, many user grants** — which is exactly the
shape multi-account needs. No new eBay developer app, no per-account credentials.

### 1.2 The blocker — verified, not inferred

`packages/database/prisma/migrations/20260506_h2_unify_channel_connection/migration.sql:72`:

```sql
CREATE UNIQUE INDEX "ChannelConnection_channelType_marketplace_active_key"
  ON "ChannelConnection" ("channelType", "marketplace")
  WHERE "isActive" = true;
```

**At most one active eBay connection can exist.** The migration's own comment (lines 69-71) is explicit:

> the application logic in ebay-auth.service.ts must mark the old row inactive before inserting the
> new one (today's flow already does this via the UI revoke path).

And `EbayAuthService.saveTokens` (`ebay-auth.service.ts:293`) sets `isActive: true` **without**
deactivating any other row. So connecting a second eBay account today does not degrade gracefully —
it throws a P2002 unique-constraint violation at the end of the OAuth callback, after the user has
already consented on eBay. Today's only "multi-account" is revoke-A-then-connect-B.

### 1.3 The singleton assumption, and why it is more tractable than it looks

**63 call sites across 37 files** resolve the eBay connection with the same copy-pasted shape:

```ts
const connection = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  orderBy: { updatedAt: 'desc' },
})
const token = await ebayAuthService.getValidToken(connection.id)
```

Spread across: 11 jobs (`ebay-orders-sync`, `ebay-feed-poll`, `ebay-token-refresh`,
`ebay-status-reconcile`, `ebay-item-status-reconcile`, `latency-watchdog`…), 12 route files
(`ebay-flat-file.routes.ts` alone has **14** of them), and ~20 services.

**The good news, and it is the single most important fact in this document:** every layer *below* the
resolver already takes a `connectionId`.

- `ebayAuthService.getValidToken(connectionId)` — `ebay-auth.service.ts:195`
- `ebayAccountService.getSnapshot(connectionId, marketplaceId)` — `ebay-account.service.ts:74`,
  cache already keyed `${connectionId}:${marketplaceId}`
- `recordApiCall({ …, connectionId })` — every outbound eBay call already logs which connection it used
- `resolvePolicyDisplayNames(connectionId, marketplaceId, …)`

So this is **"replace the resolver", not "rewrite the services"**. The services are already
account-safe. What is missing is the caller's *intent* about which account it means.

### 1.4 The data model — where accounts would collide

| Model | Unique key | Multi-account verdict |
|---|---|---|
| `VariantChannelListing` (`:1365`) | `[variantId, channel, marketplace]` | **Collides.** Already has a nullable `channelConnectionId` + index (`:1372`), but it is not in the key and is written in only 8 files. |
| `ChannelListing` (`:1421`) | `[productId, channel, marketplace]` | **Collides.** Has **no** connection column at all. This is the row that carries `flatFileSnapshot`, `platformAttributes`, per-market title/description/price. |
| `SharedListingMembership` (`:14617`) | `[marketplace, itemId, sku]` | **Survives** (eBay ItemIDs are globally unique) but has no account attribution — the pool fan-out cannot tell accounts apart. |
| `Order` (`:4437`) | `[channel, channelOrderId]` | **Survives** (order IDs globally unique) but no account attribution → "revenue by account" is unanswerable. |
| `EbayCampaign` (`:11782`) | — | **Already correct.** Relates to `ChannelConnection` with cascade. Ads is the one subsystem already account-scoped. |
| `SyncChannelPolicy` (`:14654`) | `[channel, marketplace]` | Needs an account dimension, or account-level pause is impossible. |

### 1.5 The flat file — the primary surface

`/products/ebay-flat-file` → `EbayFlatFileClient.tsx` (4,717 lines) + `ebay-flat-file.routes.ts`
(3,871 lines). The important structural facts:

- `MARKETS = ['IT','DE','FR','ES','UK']` (`ebay-variation-push.service.ts:2305`).
- The grid already has a **second axis**: fixed column groups plus per-market column groups
  `market-IT`, `market-DE`, `market-FR`, `market-ES`, `market-UK` (`ebay-columns.ts:572-628`), each
  carrying that market's Price / Qty / Follow / Buffer / Title / Subtitle / Description / Theme.
- `ChannelStrip.tsx` is the sticky channel switcher (Amazon ⇄ eBay) that shows the active marketplace
  as a badge — the natural home for an account switcher.
- Two persistence lanes: **Lane A** `ChannelListing.flatFileSnapshot` (Inventory-API listings) and
  **Lane B** `SharedListingMembership.flatFileSnapshot` (Shared-SKU / Trading-API listings). Both
  round-trip the operator's verbatim row.
- Shared-SKU pooling is the whole point of the current setup: identical child SKUs across several
  listings with `Shared-SKU (Trading API)=TRUE`, and Nexus fans one inventory pool out to all of them.

**This is the crux.** The existing model already pools one warehouse across *many listings within one
account*. Multi-account is the same idea with one more dimension — and the Shared-SKU/Trading-API
approach already in use is precisely what the market leaders use for cross-account sync (§2.2).

### 1.6 Surface area

137 eBay `.tsx` files under `apps/web/src/app`, ~100 eBay services, 11 eBay jobs, 12 eBay route files.
Settings UI (`settings/channels/ChannelsClient.tsx`) keys its connection map by `channelType`, not by
connection id — the comment at line 205 says so outright.

---

## 2. What the market does

### 2.1 The field

| Tool | Multi-account posture | Notable |
|---|---|---|
| **3Dsellers** | Unlimited eBay accounts, "switch between stores instantly" | Closest analogue to this request. Unified catalog, copy listings between accounts, bulk edit across accounts, SKU-keyed quantity sync across accounts, per-account role permissions, IP allowlisting, multi-client agency mode. From $24/mo. |
| **inkFrog** | Multiple accounts, one dashboard | Budget tier, $11/mo for 300 listings |
| **SixBit** | Multiple marketplace user IDs | Desktop. Documented "move listings from one eBay account to another"; bulk CSV across accounts |
| **Kyozou** | Multiple eBay profiles under one Kyozou account | Inventory/auction focus |
| **Sellbrite / Linnworks / Rithum (ChannelAdvisor)** | Multichannel-first; eBay accounts are just another channel instance | Scale tiers: Sellbrite ≤5k listings, Linnworks/Rithum above |
| **Zentail, Solid Commerce** | Multi-account + bulk import/export | Mid-market |

### 2.2 The one pattern everyone converges on

**Account is a first-class scope object, and SKU is the cross-account linking key.**

3Dsellers' inventory sync is explicit about it: you pick multiple eBay accounts, enter the SKUs, and
quantity is linked across them. It separates two numbers — **Quantity** (what eBay displays) and
**Warehouse** (what you actually hold) — and restocks the displayed number from the warehouse after
each sale. Set them equal to disable restocking.

That is *the same two-number model Nexus already has* as pool-qty vs. `stockBuffer` / Follow vs.
Pinned (`ebay-columns.ts:559-568`). Nexus's version is better: it has per-listing and per-variant
opt-out (`SharedListingMembership.followPool`), which 3Dsellers' own docs do not describe.

**So the strategic read: Nexus is not behind on the hard part.** The pooling engine, per-variant
opt-out, buffers, and the Shared-SKU/Trading-API technique are already built and battle-tested. What
is missing is purely the *account dimension* wrapped around them.

### 2.3 What the leaders have that Nexus would need

1. **Account switcher** with instant scope change and a persistent visual identity per account.
2. **Copy/clone listings between accounts** — the highest-value multi-account operation.
3. **Cross-account inventory sync keyed on SKU**, with per-account buffers.
4. **Per-account role permissions** (limit a VA to one account), plus IP allowlisting at the top end.
5. **Unified orders inbox** with account attribution.
6. **Cross-account rollup reporting** — revenue/health per account, side by side.
7. **Agency/multi-client mode** — hard separation with a cross-account overview.

### 2.4 Platform constraints (must be designed around, not discovered later)

- **Rate limits.** eBay Sell API limits are largely **per seller token**, so N accounts ≈ N independent
  pools. But partner-level application limits also exist, and calls to a limit-maxed seller count
  against the partner's app limit. OAuth minting is capped separately: 10k/day authorization-code,
  50k/day refresh-token. With 11 jobs currently looping one connection, a naive "loop all accounts"
  multiplies job cost linearly — jobs need per-account budgeting and staggering, not a `for` loop.
- **eBay allows multiple selling accounts** — each needs its own unique email; same personal details,
  address and payment method are permitted. Accounts must not be used to evade restrictions or
  manipulate feedback.
- **Duplicate-listing policy is the real risk.** eBay prohibits listing the same product
  simultaneously across different accounts, and links accounts via IP / fingerprint / payment details
  — a suspension on one can propagate. **This matters directly here:** the current ALT1/ALT2/ALT3
  near-duplicate tactic (GALE 5 listings, MOSS 4, AIREON 4) is already operating at the edge of that
  policy *within* one account, where distinct titles and descriptions are the mitigation. Spreading
  the same catalog across accounts raises the exposure materially. **Nexus should enforce this, not
  just permit it** — see EMA.8.
- **MUAA is not a substitute.** eBay's Multi-User Account Access delegates staff access *within* one
  seller account (now live in UK/DE/AU/CA/FR/IT/ES). It solves "my VA needs access", not "I run two
  stores". Worth knowing so it is not confused with this work.

---

## 3. Proposed architecture

### 3.1 The spine — a fail-closed resolver

Everything else is downstream of one decision. Today, 63 sites each *guess* the account with
`findFirst(...isActive: true)`. The target is one function, used everywhere:

```ts
// apps/api/src/services/ebay-connection-resolver.service.ts
export async function resolveEbayConnection(scope: EbayScope): Promise<EbayConnection>
```

with `EbayScope` being an explicit discriminated union — `{ accountId }`, or
`{ listingId }` / `{ itemId }` / `{ sku, marketplace }` that resolve *through the data* to the owning
account.

**The rule that guarantees no inconsistency: when more than one account is active and the scope does
not name one, the resolver throws. It never picks.** `findFirst` + `orderBy: updatedAt desc` silently
picking the most recently touched account is exactly how a push lands in the wrong store. Ambiguity
becomes a loud, early failure instead of a quiet mis-push.

While exactly one account exists, the resolver returns it — so Phase 2 ships with **zero behaviour
change**, which is what makes the 63-site refactor safe to verify.

### 3.2 Account as scope, market as axis

The flat file already spends its horizontal budget on 5 market column groups. Making account a second
*column* axis multiplies that to 5 × N and destroys the grid.

**Recommendation: account is a top-level scope selector; market stays the column axis.** One account
in view at a time, chosen in `ChannelStrip`, persisted in the URL as `?account=`, exactly as
`?marketplace=` works today. This matches how the leaders do it ("switch between stores instantly")
and how the operator actually works — a flat file is built for one store's listings.

Cross-account work then gets purpose-built surfaces rather than a wider grid: a **Copy to account**
action, and a **cross-account console** (§ EMA.7) for the side-by-side view.

### 3.3 Inventory: one pool, many accounts

Per `project_inventory_split` the shared-pool model is settled and per-channel splitting is rejected;
this proposal does not reopen it. The pool spans accounts: one warehouse feeds account A and account B,
and a sale anywhere decrements everywhere. This is also what 3Dsellers does.

Per-account control comes from the mechanisms that already exist, lifted one level:

- `stockBuffer` per account×market — hold back units so account B never oversells account A.
- Follow / Pinned per account×market — pin a fixed quantity for one store.
- `followPool` per variant per listing — already per-listing, already correct.
- `SyncChannelPolicy.pushesPaused` gains an account dimension → per-account kill switch.

### 3.4 Design system

Per `feedback_design_system` and `feedback_tables_use_datagrid`, everything new comes from
`apps/web/src/design-system` and any table uses the `/products/next` stack (DataGrid + GridToolbar +
FilterBar, all four DS stylesheets).

Concretely:
- **Account switcher** — DS `Listbox` or `Menu` inside `ChannelStrip`, with a per-account colour token
  and the seller sign-in name. Not a raw `<select>` (the pre-push DS ratchet greps for that — and per
  `reference_ds_guard_greps_comments`, it greps comments too).
- **Accounts settings page** — DS `Card` grid, `Banner` for token-expiry warnings, `Modal` for
  disconnect confirms. If it becomes a table, DataGrid.
- **Copy-to-account** — DS `Drawer`; any confirm inside it must use the `overlay=` slot, since
  `Drawer` z-61 sits above `Modal` z-50 (`reference_drawer_confirm_overlay`).
- **Account colour** must be a token in `design-system/tokens`, not an inline hex, so the switcher,
  the flat-file header, the orders inbox and the cross-account console all read the same identity.
- Density per `feedback_visibility_over_minimalism`; symmetric insets per
  `feedback_balanced_symmetric_spacing`; screenshot-diff + measure before showing, per
  `feedback_ui_self_verify`.

---

## 4. Phases

Each phase is independently shippable and live-by-default per `feedback_ship_live_not_dark`.
Phases 0-2 are pure groundwork with **no operator-visible change** — they exist so that the moment a
second account appears, nothing can silently go to the wrong store.

### EMA.0 — Truth: what actually assumes one account
Read-only audit script enumerating every eBay connection resolution, classified by whether the scope
is derivable (listing/item/SKU in hand) or genuinely ambient (jobs). Output: a checklist that Phase 2
burns down. Plus a `/api/ebay/accounts/diagnostics` endpoint reporting the current single-account
state so the "before" is provable on prod.
**Ships:** one script, one read-only endpoint. No schema, no behaviour.

### EMA.1 — Data model
- Drop the partial unique index; replace with `(channelType, marketplace, id)` semantics — i.e. many
  active eBay rows allowed, still exactly one active Amazon row per region.
- Add to `ChannelConnection`: `accountLabel`, `accountColor`, `isPrimary`, `sortOrder`.
- Add `channelConnectionId` (nullable + index) to `ChannelListing`, `SharedListingMembership`, `Order`,
  `SyncChannelPolicy`.
- Extend the unique keys: `ChannelListing` → `[productId, channel, marketplace, channelConnectionId]`,
  `VariantChannelListing` → `[variantId, channel, marketplace, channelConnectionId]`.
- Backfill every existing eBay row to the one existing connection.
**Gate:** the index drop and the unique-key changes are **not** additive, so this needs explicit
approval beyond `feedback_additive_migrations_preapproved`. Backfill must be verified row-count-exact
before the old keys are dropped.

### EMA.2 — The resolver
Introduce `resolveEbayConnection(scope)` and convert all 63 call sites. Fail-closed on ambiguity.
Jobs move from "resolve one connection" to "iterate accounts with per-account budget + stagger", with
one account's failure never aborting the others.
**Verification:** with exactly one account, prod behaviour is byte-identical. A pre-push ratchet
(same mechanism as the DS guard) blocks any new `channelType: 'EBAY'` + `isActive: true` lookup from
being added, so the singleton assumption cannot grow back.

### EMA.3 — Connect a second account
Rework the OAuth flow to mint a new connection per grant instead of reusing the active one; capture
seller identity (`getSellerInfo` already exists) and reject a duplicate `ebaySignInName`. New
**Settings → Channels → eBay Accounts** page: connect, label, colour, set primary, health, token
expiry, disconnect (with a blast-radius preview — how many listings/orders reference it).
Per `feedback_preserve_sensitive_config`, disconnect never destroys tokens for other accounts.
**This is the first phase the operator can see.** Two accounts connected, both healthy, nothing else
changed yet.

### EMA.4 — The flat file, account-scoped + the duplicate guard
`?account=` in the URL, account switcher in `ChannelStrip`, all rows/push/publish/pull scoped to the
selected account. Import/export carry an Account column so a downloaded xlsx round-trips to the right
store. Push preflight refuses to run when the file's account and the selected account disagree.
The 79-column format is unchanged for single-account files — the column is additive and defaults to
the primary account, so every existing xlsx keeps working untouched.

**Because the catalog is shared across accounts, the cross-account duplicate-listing guard ships in
this phase, not later.** The moment this page can push Xavia's catalog to account B, the eBay
duplicate-listing exposure described in §2.4 is live — a guard that arrives in EMA.8 arrives after the
risk. So the push preflight gains a second check: before publishing a family to account B, compare
title *and* description against every live listing for the same SKU set on every other account, and
block on a match. This is the machine-enforced form of the rule already governing ALT groups within
one account (`reference_nexus_ebay_flatfile_format`: titles *and* descriptions must be genuinely
different, not the same keywords reshuffled).

**This is the phase that delivers the actual request.**

### EMA.5 — Pool fan-out across accounts
Extend the Shared-SKU fan-out and `outbound-sync.service.ts` so one pool feeds every account's
listings. Per-account buffers and Follow/Pinned. Per-account `pushesPaused` kill switch. A sale on
account B decrements what account A advertises, within one reconcile cycle.
**Guard:** the FBA-quantity rule is untouched and the fail-closed guard is not weakened
(`feedback_fba_quantity_untouchable`).

### EMA.6 — Everything else per account
Orders inbox with account attribution and filter; returns; financial events; images publish;
description push + themes; ads (already connection-scoped — mostly verification). Each subsystem gets
the same treatment: scope through the resolver, attribute in the data, filter in the UI.

### EMA.7 — Cross-account console
The single-source-of-truth view: accounts side by side — listings, health, token expiry, sales, sync
errors, pool exposure. Plus **Copy listing to another account**, the highest-value cross-account
operation, built on the existing family/variation push. Because the catalog is shared, copy-to-account
is also the operation most likely to manufacture a policy violation, so it runs the EMA.4 duplicate
guard and requires a distinct title + description before it will complete — the copy lands as a draft
with the differences to be written, never as a straight clone. Modelled on `/marketing/ads/trust`,
which is already the proven pattern in this codebase for a truth surface.

### EMA.8 — Control and safety
- Per-account RBAC (limit a user to one account) on the existing `Role`/`UserRole` spine — noting
  `reference_rbac_enforce_ssr`: SSR fetches go out anonymous, so any enforcement needs the
  client-load fallback.
- Every account-scoped mutation into `SyncControlAudit` / `AuditLog` with the account on the row.
- Per-account rate-limit budgets surfaced in the console before eBay starts throttling.

---

## 5. Decisions taken, and what follows from them

All three forks resolved by the operator on 2026-07-30. Two of them change the shape of the work:

**Same catalog on every account** — the consequential one.

- `ChannelListing` genuinely needs the account dimension. The same `productId` on the same
  `marketplace` will exist on two accounts simultaneously, so `[productId, channel, marketplace,
  channelConnectionId]` is load-bearing in EMA.1, not defensive. Same for `VariantChannelListing`.
- The duplicate-listing guard moves from EMA.8 to **EMA.4**, where it gates the first cross-account
  push, and is re-run by copy-to-account in EMA.7.
- The Shared-SKU / Trading-API technique already in use becomes an outright advantage: identical child
  SKUs across accounts are exactly what the pool fan-out keys on, so EMA.5 extends a mechanism that is
  already proven rather than inventing one. This is the same linking key the market leaders use (§2.2).
- Per-account **content divergence** becomes a first-class requirement, not a nicety. Each account
  needs its own title and description per family. `ChannelListing` already stores per-market title /
  subtitle / description; adding the account dimension gives per-account × per-market copy for free.

**Account as scope switcher** — grid width is unchanged, and every eBay page gets the same `?account=`
treatment. The cost is that comparing two accounts requires the EMA.7 console rather than a wide grid;
that is the intended trade.

**Groundwork first** — three phases with no operator-visible change before a second account can
connect. The payoff is that EMA.2's fail-closed resolver exists *before* there is any second account
for a push to go wrong on, so the wrong-store failure mode never has a window in which to occur.

---

## 6. Risk register

| Risk | Mitigation |
|---|---|
| A push lands in the wrong store | Fail-closed resolver (§3.1) + pre-push ratchet in EMA.2 |
| Backfill mis-attributes existing listings | EMA.1 backfills to the single existing connection; row-count-exact verification before old keys drop |
| eBay duplicate-listing policy → linked-account suspension. **Highest risk in this programme**, because the catalog is shared | **EMA.4** push preflight blocks a publish whose title *and* description match a live listing for the same SKU set on another account; EMA.7 copy-to-account re-runs it and lands drafts, never clones |
| Per-account copy drifts or is forgotten, silently recreating duplicates | Per-account × per-market title/description on `ChannelListing` (EMA.4); the guard re-checks on every push, not only the first |
| Job cost multiplies with account count | EMA.2 per-account budget + stagger, not a `for` loop |
| Flat-file format churn breaks existing xlsx | Account column is additive and defaults to primary; 79-col files keep working |
| Two accounts fight over one pool | Per-account buffers + Pinned + per-account kill switch (EMA.5) |

---

## 7. What is explicitly out of scope

- Amazon or Shopify multi-account. Amazon already has its own per-region connection + ads-profile
  model; nothing here changes it.
- Reopening the shared-pool vs. split-inventory decision (`project_inventory_split`).
- WooCommerce / Etsy (`project_active_channels`).
- Any change to the existing legacy import path (`feedback_existing_import_untouchable`).
