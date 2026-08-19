# MAP — Multi-Account & Profiles

**Status:** MAP.0, MAP.1, MAP.2a, MAP.3a **SHIPPED and prod-verified 2026-08-19**.
**Burn-down:** 60 → **54** ambient resolution sites; all six jobs converted. MAP.2b folds into MAP.3b.
**Commits:** `0f9fc2fb9` (MAP.0/MAP.1) · `ba235d71e` (RBAC mapping)
**Date:** 2026-08-19
**Supersedes / absorbs:** [`2026-07-30-ebay-multi-account-ema.md`](2026-07-30-ebay-multi-account-ema.md)
(eBay-only, never shipped — verified: zero EMA commits, the blocking index is still in place).
**Goal:** Operate several seller accounts per channel from one Nexus, with a top-right account chip
that says which one you are in, and a two-click path to connect the next one.

**Decisions taken (operator, 2026-08-19):**

1. **Amazon — not now, but design for it.** MAP.5 (SP-API seller OAuth) is **dropped from the
   programme**. In exchange, MAP.2's schema and MAP.3's resolver are **channel-agnostic by
   requirement, not by accident**: nothing may hard-code `'EBAY'`, and Amazon must be addable later
   by adding a connect flow alone — no data-model or resolver rework. This costs nothing extra now
   and is the whole reason it is written down (§6, Q1).
2. **MAP.2's non-additive migration — approved**, conditional on a row-count-exact backfill verified
   *before* the old keys drop, and a rollback shipping alongside.
3. **Flat file — decided at MAP.6, not now.** Everything through MAP.4 leaves the flat-file files
   untouched; the chip reaches both flat files through the app chrome (§2.4) — shipped, verified on
   prod. The MAP.6 edit list goes back to the operator for approval when the phase comes up.
4. **Catalogue overlap — deliberately deferred, and made a data question.** See §6 Q4: the answer
   binds nothing before MAP.6, and the intent-label mechanism (§3.4) resolves it *per product*
   instead of forcing a global policy.

---

## 0. Method, and what this study can and cannot claim

The operator supplied `~/Desktop/Screen Recording 2026-08-12 at 15.01.31.mov` (55:58, 3456×2234,
166,151 frames) and asked for a frame-by-frame read of **10:40–11:11**, focus **10:49–11:11**.

- Extracted **every frame** in 636.0–676.0 s with `-fps_mode passthrough` — **2,247 frames**
  (the file is VFR at ~56 fps; without passthrough ffmpeg pads to a nominal 120 and invents
  duplicates — see `reference_video_frame_study_method`).
- Per-frame change signal over the shared-screen region only (the Zoom participant tiles are above
  it and would otherwise swamp the signal). Threshold: fraction of pixels changed at |Δ|>24,
  measured against the **last kept keyframe**, not the previous frame, so slow cumulative drift
  cannot hide.
- **33 distinct visual states** in the whole window. All 33 were rendered at full resolution
  (2816×1584 crop of the shared screen) and read. The 24 not quoted below are intermediate scroll
  positions of one list, whose top, middle and bottom are all quoted.

**Limit, stated plainly: the recording has no audio track at all** (`ffprobe` reports one stream,
h264, video). Everything below is what the screen *shows*. What Alex Slater *said* about it is not
recoverable from this file. Where behaviour is inferred rather than seen, it is marked
**[INFERRED]**.

---

## 1. What Rithum actually does — read off the screen

### 1.1 The correction that matters

`~/Desktop/COMMERCE-PLATFORM-RESEARCH/02-RITHUM/00-RITHUM-INDEX.md:70` states:

> **Rithum did not build an "account switcher"**; it made the account a targeting dimension on the
> product.

**The video disproves the first half.** Rithum has a full account switcher, and it is the most
prominent control in the entire top nav. The prior study's Labels finding stands — Rithum has
**both**, and they answer different questions:

| Question | Rithum's answer | Where it lives |
|---|---|---|
| *Which account am I in right now?* | The top-right chip + switcher panel | Global chrome — **newly verified** |
| *Which accounts is this product meant for?* | Labels on the SKU | Product editor — previously verified |

Building only the switcher gives an operator a scope with nothing to route products into it.
Building only labels gives routing with no way to see or check the result. **We need both**, and
they arrive in different phases (§5).

### 1.2 Anatomy of the switcher — verbatim from the frames

**The chip** (`t=636.010`, closed): far right of the primary purple nav bar, past the utility icons
(bell with `99+`, help, user, what's-new) and past a separate `Account` nav item:

```
🇬🇧  CA Sales Demo - UK  ▾
```

Flag + account name + caret. It is a focusable button — at `t=645.818` it carries a visible focus
ring with the panel not yet open, so keyboard reaches it.

**One click opens the panel** (`t=646.635`). It is wide (~55 % of the viewport), anchored under the
chip, and has four parts:

1. **`🔍 Search Accounts`** — a text input pinned to the top of the panel, autofocused (blue focus
   border). It stays fixed while everything below it scrolls; confirmed at four different scroll
   depths.
2. **`▾ Recent Accounts`** — 5 rows, then `+ 14 More`.
3. **`▾ Pinned Accounts`** — 5 rows, then `+ 5 More`.
4. **`▾ Accounts for "ChannelAdvisor Sales Demos (Auto-Maintained)"`** — the full roster of the
   *current account's organisation*, alphabetical, scrollable, ~40 rows.

All four section headers carry a disclosure triangle, so the sections collapse. **[INFERRED]** — no
frame shows one collapsed.

**A row** is: `🇮🇹 <Organisation>: <Account name> (<numeric account id>)` … `📌`

- The flag is the account's country, not the organisation's.
- The organisation prefix is part of every row, so identity is two-level: **organisation → account**.
- `Recent Accounts` crosses organisations — `A.M. LONDON FASHION LTD`, `TB International GmbH`,
  `Fitness Cubed Inc.` all appear beside the ChannelAdvisor demo org. The bottom section does not;
  it is scoped to one organisation.
- The pin at the far right is a **per-row toggle**: filled for pinned accounts, outline for the
  rest. The same account shows filled in both the Pinned section and the full roster.
- The current account (`CA Sales Demo - UK (22001379)`) is highlighted **everywhere it appears** —
  in Recent, in Pinned, and again down in the roster at `t=667.752`.

**A row is a real link.** The browser status bar reveals the href on hover, four times across the
window:

```
https://complete.channeladvisor.com/Surround.mvc/SelectAccount
    ?apid=12049263
    &url=https%3A%2F%2Fcomplete.channeladvisor.com%2F%3Fapid%3D22001379
```

Two facts fall out of that single URL, and both are load-bearing for us:

- **The account id is the scope, and it lives in the URL** — the page itself is
  `complete.channeladvisor.com/?apid=22001379`.
- **`url=` is the page you were on.** Switching account does not dump you on a dashboard; it
  re-enters *the same route* under the new account. This is the behaviour that makes a switcher
  usable rather than annoying, and it is the single most copyable detail in the whole clip.

**Dismissal** (`t=672.302`): a click outside closes the panel with no selection and no navigation.
Across the whole 40 s window the demo never actually switched account.

### 1.3 The second scope, which is not the switcher

The Dashboard behind the panel shows the other half of the model. Two `Marketplace Summary` widgets
sit side by side, and **each has its own account selector**:

- widget 1: `CA Sales Demo - DE`
- widget 2: `2 Selected` ← a **multi-select**
- `Marketplace Performance Trends` below: `CA Sales Demo - UK`

So Rithum separates two things deliberately:

| | Working scope | Reporting scope |
|---|---|---|
| Cardinality | exactly **one** account | **many** accounts |
| Control | the top-right chip | a per-widget selector |
| Why | you edit, price and publish *into one store* | you compare stores |

That split is the answer to "how do I see everything at once" without widening every grid, and it is
exactly the trade EMA §3.2 chose blind. The video confirms the market leader made the same call.

### 1.4 What Xavia should *not* copy

Rithum's panel is built for an agency with ~40 accounts across many organisations. Recent, Pinned,
`+ 14 More`, `+ 5 More`, search-first, organisation grouping — all of that is machinery for a list
too long to read. Xavia will have **2–6 accounts**. Copying the machinery would be
overcomplicating a list that fits on screen.

**Take:** the chip position, the flag/label/health identity, the current-account highlight, the
URL-carried scope, and above all `url=` (switch stays on the page).
**Leave:** organisation grouping, Recent, Pinned, `+N More`, and the search box — until the account
count actually crosses ~8, at which point search is added and nothing else.

---

## 2. Where Nexus stands today — verified, not assumed

### 2.1 The connection layer

`ChannelConnection` (`packages/database/prisma/schema.prisma:5812`) is the one table holding every
marketplace grant. `channelType` ∈ AMAZON | EBAY | SHOPIFY | WOOCOMMERCE | ETSY,
`managedBy` ∈ `oauth` | `env` | `pending`.

| Channel | State today | Multi-account distance |
|---|---|---|
| **eBay** | Real OAuth. `ChannelsClient.tsx:157` `handleConnectEbay()` → `POST /api/ebay/auth/initiate` → eBay consent → `/settings/channels/ebay-callback`. **Already two clicks.** | Short. Remove the index, replace the resolver. |
| **Amazon** | **No OAuth at all.** `seedEnvManagedConnections()` (`apps/api/src/index.ts:328`) synthesises one row per boot from `AMAZON_LWA_*` + `AWS_*` + a single `AMAZON_REFRESH_TOKEN`. `marketplace: null`. | Long. Needs a real SP-API authorization-code flow — **there is none in the repo** (grep for `/apps/authorize`: zero hits). Amazon *Advertising* OAuth exists (`amazon-ads-auth.routes.ts:296`, `amazon.com/ap/oa`) but writes ads tokens, not `ChannelConnection`. |
| **Shopify** | `pending` placeholder row so the settings card renders. | Full build. |
| Woo / Etsy | `pending`. Out of scope per `project_active_channels`. | — |

### 2.2 The blocker, unchanged since EMA

`packages/database/prisma/migrations/20260506_h2_unify_channel_connection/migration.sql:72`:

```sql
CREATE UNIQUE INDEX "ChannelConnection_channelType_marketplace_active_key"
  ON "ChannelConnection" ("channelType", "marketplace") WHERE "isActive" = true;
```

At most one active connection per channel. `saveTokens` sets `isActive: true` without deactivating
the previous row, so a second eBay grant throws P2002 **after** the operator has already consented
at eBay. Today's only multi-account is revoke-A-then-connect-B.

### 2.3 The singleton assumption — re-counted today, not quoted from EMA

```
63 occurrences of  channelType: 'EBAY'  across 37 files (excluding tests)
60 of them paired with  isActive: true
```

Identical to the July count. Nothing has drifted, and nothing has been fixed.

**The good news is still the most important fact here:** every layer *below* the resolver already
takes a `connectionId` — `getValidToken(connectionId)`, `getSnapshot(connectionId, marketplaceId)`,
`recordApiCall({ connectionId })`, and `EbayCampaign` already relates to `ChannelConnection` with
cascade. This is *replace the resolver*, not *rewrite the services*.

### 2.4 The chrome — and a free win

`AppShell` (`apps/web/src/components/layout/AppShell.tsx:25`) renders `TopBar` on every route except
a standalone list: `/marketing/ads`, `/marketing/ads-console`, `/products/next`, `/shared`, and the
auth pages.

**`/products/amazon-flat-file` and `/products/ebay-flat-file` are not on that list.** They render
inside `AppShell`, so anything in the app chrome reaches them.

> A chip added to the chrome appears on both flat files **without editing a single flat-file file** —
> which is how the operator's first ask is delivered without going near
> `feedback_flat_file_untouchable`. Confirmed on prod, MAP.1.

**⚠ Corrected while building MAP.1 — where the chrome actually is.** The obvious answer,
`components/layout/TopBar.tsx`, is **dead code: nothing imports it.** It looks exactly like the app's
top bar and even carries two hard-coded marketplace chips —

```tsx
<span className="w-2 h-2 rounded-full bg-green-500" />
<span …>Amazon IT</span>          {/* static string, permanently green, reads from nothing */}
```

— but those have never rendered, so they are not the `reference_fleet_stale_constant_class` defect
this phase looked like it was retiring. The file was left untouched.

What actually renders on desktop:

| Slot | Component | Reaches |
|---|---|---|
| `sidebar` | `AppNavRail` | left rail, every non-standalone route (**and** `/products/next`) |
| `topBar` | `MobileTopBar` | `md:hidden` — phones only |
| `overlays` | `NotificationsBell`, `fixed top-3 right-3 z-40` | **the desktop top-right corner** |

So the chip is a sibling of the bell in `overlays`, offset left by its width. One mount point, not
three — and it lands exactly where the operator asked for it.

The other two shells were left alone on purpose: `AppNavRail` **already** fetches `/api/connections`
and derives real per-channel connected state, so a second control there would duplicate a working
one; and the ads console's `AdsPageHeader` is per-page furniture across 49 pages, where a global
identity chip does not belong until it can actually switch (MAP.4).

### 2.5 Permissions already have the right bone

`UserRole` (`schema.prisma:4386`) carries:

```prisma
channelScope Json?   // null = all; else { "channels": ["EBAY"], "marketplaces": ["IT"] }
```

Deny-by-default, OWNER implicit-all, union across assignments, and `Invitation.channelScope`
(`:4418`) mirrors it so an invite can be pre-scoped. **The operator's "not every employee needs
access to everything" is one key away**: `accounts: [connectionId]` inside the JSON that already
exists. No new tables, no new spine.

### 2.6 Design system inventory for this work

`Menu`, `Listbox`, `Combobox`, `Banner`, `Modal`, `Drawer`, `Card`, `DataGrid`, `Stepper`,
`SegmentedControl`, `Badge`, `Pill`, `Tag`, `Tooltip` all exist. The switcher composes from
`Menu` + `Combobox`; the accounts settings surface from `Card` + `Banner` + `Modal`. **No DS gap.**
The new `AccountSwitcher` and `AccountBadge` are built *into* the DS, not into a page directory.

---

## 3. The design

### 3.1 Scope model — one line

> **Account is the working scope, selected globally, carried in the URL, and it never changes the
> page you are on. Market stays the column axis. Reporting selects many accounts; editing selects
> one.**

This is Rithum's model, verified on screen, and it is what EMA chose in July on reasoning alone.

### 3.2 The chip, for Xavia

```
┌──────────────────────────────────────┐
│  🟠 Xavia Racing · Amazon        ▾   │      ← closed chip, top-right of TopBar
└──────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│  AMAZON                                            │
│  ● 🟠 Xavia Racing            IT DE ES FR   ✓      │  ← current, checked
│  ● 🟠 Xavia Motorsport DE     DE                   │
│  EBAY                                              │
│  ● 🔵 xavia_racing            IT DE ES FR UK       │
│  ⚠ 🔵 xavia_outlet            IT            token  │  ← health surfaced inline
│  ─────────────────────────────────────────────────  │
│  + Connect another account            Manage ↗     │
└────────────────────────────────────────────────────┘
```

- **Grouped by channel**, not by organisation — Xavia has one organisation and three channels, so
  channel is the axis that actually separates the rows.
- **Health dot per row** (green / amber / red) driven by `isActive` + `tokenExpiresAt` +
  `lastSyncStatus`, which `/api/connections` already returns. This is what the two fake chips
  pretended to be.
- **Market badges** show reach at a glance — the thing an operator actually needs to know before
  editing.
- **`+ Connect another account`** at the foot of the panel: the two-click path, reachable from the
  chip, without hunting through Settings.
- **Account colour** is a design-system token, not an inline hex, so the chip, the flat-file header,
  the orders inbox and every future badge read the same identity.
- Selecting a row navigates to **the current route with `?account=` swapped** — Rithum's `url=`,
  done natively.
- No search until the roster crosses 8 rows.

### 3.3 The rule that prevents every inconsistency

One resolver, and **when more than one account is active and the caller did not name one, it
throws.** It never picks.

```ts
resolveConnection(scope: ConnectionScope): Promise<ChannelConnection>
// { accountId } | { listingId } | { itemId } | { sku, marketplace } | { orderId }
```

`findFirst(…isActive: true, orderBy: updatedAt desc)` silently choosing the most recently touched row
is precisely how a push lands in the wrong store. Ambiguity becomes a loud early failure instead of a
quiet mis-push.

While exactly one account exists the resolver returns it — so the 63-site conversion ships with
**zero behaviour change**, which is what makes it verifiable on prod before any second account exists
to get it wrong.

### 3.4 Labels — the half EMA never named

From the prior Rithum research, and still correct: `ChannelListing` records *"this product **has** a
listing on account B"* — an outcome. It cannot express *"this product **should** sell on account B"* —
an intent. Only the second makes these answerable:

- "Publish everything intended for `xavia_outlet` that isn't live yet"
- "Which products are on account A but not B?" — the gap report
- "This product is intended for two eBay accounts → **run the duplicate-title guard**"

That last one is not a nicety. eBay prohibits the same product listed simultaneously across
accounts, and links accounts by IP / fingerprint / payment details — a suspension on one propagates.
With a shared catalogue, **the intent set *is* the duplicate-risk signal**, and it must be queryable
rather than inferred.

---

## 4. Phases

Each phase is independently shippable and live-by-default (`feedback_ship_live_not_dark`).
Phases marked **🔒** cannot start without an explicit operator decision — they are listed in §6.

> **MAP.0, MAP.1, MAP.2a and MAP.3a are SHIPPED and prod-verified, 2026-08-19.**
> What the build found that this plan did not predict is recorded in §2.4 (the chrome) and §7 (the
> defect, the DS gap, and two things MAP.4 inherits).

### MAP.0 — Truth (read-only) ✅ SHIPPED
Audit script enumerating every connection-resolution site for **all** channels, classified by whether
the scope is derivable (listing / item / SKU / order in hand) or genuinely ambient (jobs, crons).
Plus `GET /api/connections/diagnostics` reporting the live single-account state so the "before" is
provable on prod.
**Ships:** one script, one read-only endpoint. No schema, no UI, no behaviour.

### MAP.1 — The chip tells the truth ⭐ ✅ SHIPPED
DS `AccountSwitcher` + `AccountBadge` + an `AccountContext` provider. Reads the real
`/api/connections`. Shows every connected account grouped by channel, with real health, real market
reach, real labels. Mounted in `TopBar` (→ **both flat files inherit it, zero flat-file edits**), in
the ads shell, and in the products/next rail. Deletes the two hard-coded fake chips.

With one account per channel it does not yet *switch* anything — it **says what you are connected
to**, which today nothing does honestly. Fully useful on day one, and it is the surface every later
phase plugs into.
**Risk: none.** No schema, no writes, no resolver change.

### MAP.2a — Data model, the part that is safe today ✅ SHIPPED
`20260819a_map2_account_dimension` (+ `rollback.sql`), applied to prod 2026-08-19.

- `ChannelConnection` gains `accountLabel`, `accountColor`, `isPrimary`, `sortOrder`, and
  **`externalAccountId`** — the account's identity at the marketplace.
- `channelConnectionId` (nullable, indexed, **`ON DELETE SET NULL`**) on `ChannelListing`,
  `SharedListingMembership`, `Order`, `SyncChannelPolicy`. SET NULL, not CASCADE: deleting a
  connection must never delete 977 listings or 4,394 orders. Disconnecting loses attribution, not
  history.
- **The singleton index is gone.** Its replacement keys on account *identity*, not on channel —
  `("channelType", COALESCE(marketplace,'~'), COALESCE("externalAccountId",'~')) WHERE isActive`.
  That is the channel-agnostic form decision 1 requires (no channel name appears in it) and a
  stronger invariant than "many rows, full stop": **the same seller account cannot be connected
  twice.** While `externalAccountId` is NULL it collapses to exactly today's constraint, so MAP.2a
  loosens nothing on its own — MAP.4 unlocks the second account by capturing identity, and cannot
  admit one it is unable to tell apart from the first.
- Plus one primary per channel, enforced by a partial unique index.

**The backfill gate.** Decision 2's condition is not a checklist item, it is §4 of the migration: a
`DO` block that counts every row which *could* have been attributed and was not, and `RAISE`s if the
count is non-zero — aborting the transaction before any index is dropped. Both directions were
proven against prod inside rolled-back transactions: the real run attributes **977/977 listings,
712/712 memberships, 4394/4394 orders** with zero channel mismatches; a deliberately sabotaged run
refused with *"MAP.2 backfill incomplete: 977 attributable row(s) … Old unique keys NOT dropped"*
and left the original index in place. A gate that has never refused is an unproven gate.

### MAP.2b — The unique-key widening 🔒 *(deferred, and why)*
The plan put the `ChannelListing` / `VariantChannelListing` / `SyncChannelPolicy` key changes in
MAP.2. **Measuring stopped that.** Prisma compiles a compound-unique `upsert` to
`INSERT … ON CONFLICT (<those exact columns>)` — verified on prod inside a rolled-back transaction —
and `ON CONFLICT` needs an index matching the named columns *exactly*. The replacement is an
expression index (`COALESCE`), which cannot match. So dropping those keys would not fail at compile
time; it would fail at **runtime with 42P10** across all 24 call sites that use them (17 ×
`productId_channel_marketplace`, 2 × `productId_channelMarket`, 1 ×
`variantId_channel_marketplace`, 4 × `channel_marketplace`).

They therefore widen **in the same commit as MAP.3's caller conversion**, so the Prisma schema and
the database never disagree about what is unique. Nothing is lost by waiting: a second account cannot
exist until MAP.4, and the attribution columns those keys need are already in place and backfilled,
so MAP.2b is a pure index swap with no data movement.

⚠ Note for MAP.2b: every replacement must wrap the connection id in `COALESCE`. In Postgres NULL is
never equal to NULL, so a plain four-column unique index would let unlimited duplicates through the
moment `channelConnectionId` is NULL — the opposite of a constraint.

### MAP.3a — The resolver, the ratchet, and the jobs ✅ SHIPPED

`services/connection-resolver.service.ts`. One function, **fail-closed**: when more than one account
is active for a channel and the caller has not said which one it means, it throws. It never picks.

The scope forms fall into three groups, and the naming is the point:

| Group | Forms | Why |
|---|---|---|
| **NAMED** | `{ accountId }` | the caller already holds the id |
| **DERIVED** | `{ listingId }` · `{ variantListingId }` · `{ itemId }` · `{ orderId }` · `{ channel, channelOrderId }` | reads the attribution MAP.2a backfilled, so it cannot drift |
| **DECLARED** | `{ channel, primary: true }` | for ambient work with no row to derive from. Verbose and greppable on purpose: "the primary account for this channel" is a claim someone can audit; "whatever `findFirst` returned" is not |

What it replaces did `orderBy: { updatedAt: 'desc' }` — **the most recently touched account**. With
one account that is correct by accident; with two it is a coin flip, and the coin is not even
weighted the way the author imagined, because sync heartbeats bump `updatedAt` constantly
(`reference_updatedat_is_a_sync_heartbeat`).

The decision itself is a **pure function**, `chooseConnection`, so the rule is testable without a
database — 13 tests, including one that asserts nothing is returned when the input is ambiguous.
Every scope form was also exercised against prod: all six derived forms resolve Amazon rows to the
Amazon account and eBay to eBay, and all three refusal cases throw rather than guess.

**The ratchet.** `map0-connection-resolution-audit.mts --ratchet` fails the push when the ambient
count exceeds `AMBIENT_BASELINE`, wired into `.githooks/pre-push`. Structural, not a grep — a regex
here counts comments and misses shorthand, which is exactly how the DS guard came to fail on a
comment. The resolver file itself is the one exemption: `listActiveConnections` genuinely means
"every active account for this channel", which is what the decision is made *from*.

**The jobs — all six converted, zero remain in the burn-down (60 → 54).** Not all six could take the
same treatment, and the differences are recorded rather than smoothed over:

- **Per-account sweeps** — `ebay-item-status-reconcile` iterates accounts and selects each account's
  memberships by `channelConnectionId`, with the cap applied *per account* so a second store cannot
  starve the first, and one account's token failure skipping only that account.
- **Enumerate-all** — `ebay-orders-sync`, `ebay-token-refresh`, `latency-watchdog` legitimately mean
  "every active account" (or "is any account live"), now through `listActiveConnections` so one
  definition of "active" serves them all.
- **Declared primary, with the gap named** — `ebay-feed-poll` because **`EbayPushJob` carries no
  `channelConnectionId`**, so iterating accounts would poll each account for tasks belonging to
  another; and `ebay-status-reconcile` because its ~150-line body has four early returns and module
  state, so a per-account loop needs a function extraction first. Both carry a 🔴 marker naming the
  follow-up. A named limitation beats a silent mis-poll.

### MAP.3b — the remaining 54, and MAP.2b's keys 🔒 *(next)*
29 route sites in 9 files (12 of them in `ebay-flat-file.routes.ts`), 24 service sites in 22 files,
1 in `index.ts` (`seedEnvManagedConnections`, arguably legitimate). Landing in the same commit:
MAP.2b's four unique-key widenings and the 24 compound-key callers, for the `ON CONFLICT` reason in
MAP.2b above.

### MAP.4 — Connect the second account, in two clicks
Settings → Channels becomes a list of accounts per channel rather than one card per channel.
`+ Connect another eBay account` → eBay consent → back. The OAuth callback mints a **new** connection
per grant instead of reusing the active one, captures seller identity, and rejects a duplicate
sign-in name. Label, colour, primary, health, token expiry, and disconnect with a blast-radius
preview (how many listings and orders reference it). Disconnect never touches another account's
tokens (`feedback_preserve_sensitive_config`).

**The MAP.1 chip now actually switches** — `?account=` on the current route, page preserved.
**This is the phase where the request becomes real.**

### ~~MAP.5 — Amazon becomes two clicks too~~ — **DROPPED** (decision 1)
One Amazon selling account is enough for now, so the SP-API seller authorization-code flow is not
built. **What survives is a constraint on MAP.2 and MAP.3**, and it is the reason this section stays
in the document rather than being deleted:

- No table, column, resolver branch or UI string may hard-code `'EBAY'`. `channelType` is a
  parameter everywhere, including in the pre-push ratchet.
- `ChannelConnection.marketplace` keeps its per-channel meaning (null for eBay, per-region for
  Amazon), and the replacement uniqueness rule must already express "many active eBay rows, one
  active Amazon row per region" — not "many active rows, full stop".
- Amazon's env row routes through `resolveConnection` like any other, so it is already a first-class
  account in the chip and in every scoped read.

Adding Amazon later then costs **one connect flow and nothing else**. If that ever happens:
Seller Central `/apps/authorize` → LWA exchange → `ChannelConnection` with `managedBy:'oauth'`;
`seedEnvManagedConnections` (`apps/api/src/index.ts:349-358`) already stands aside when an active
OAuth Amazon row exists, so the handover is anticipated in code today.

### MAP.6 — The flat file, account-scoped 🔒 *touches untouchable files*
`?account=` honoured, rows / push / publish / pull all scoped, import-export carries an Account
column so a downloaded xlsx round-trips to the right store, and push preflight refuses when the
file's account and the selected account disagree. The 79-column format stays valid: the column is
additive and defaults to the primary account.

**The cross-account duplicate-listing guard ships here, not later** — the moment this page can push
the catalogue to account B, the eBay policy exposure is live, and a guard that arrives afterwards
arrives after the risk.

### MAP.7 — Everything else per account, and intent
Orders inbox / returns / financials / images / descriptions / ads attributed and filtered by account
(ads is already connection-scoped — mostly verification). Pool fan-out across accounts with
per-account buffers and a per-account kill switch; the FBA-quantity rule untouched
(`feedback_fba_quantity_untouchable`). Product↔account **intent** (§3.4) driving publish-by-intent,
the gap report, and the duplicate guard.

### MAP.8 — Profiles & permissions *(the operator's stated future)*
`accounts: [connectionId]` added to the `UserRole.channelScope` JSON that already exists; the team
page grows an Accounts column and the invite flow pre-scopes it. Every account-scoped mutation lands
in `SyncControlAudit` / `AuditLog` with the account on the row. Note `reference_rbac_enforce_ssr` —
SSR fetches go out anonymous, so enforcement needs the client-load fallback.

---

## 5. Sequencing, and why this order

```
MAP.0 ──▶ MAP.1 ⭐ visible today, zero risk, no flat-file edit
            │
            ▼
         MAP.2 ──▶ MAP.3 ──▶ MAP.4  ← the second eBay account can now exist
          ✅        (both channel-agnostic     │
                     by requirement)           │
                                   ┌───────────┴───────────┐
                                   ▼                       ▼
                                MAP.6 🔒               MAP.7 ──▶ MAP.8
                              (flat file —            (intent labels,   (profiles &
                               approval at             per-account       permissions)
                               the phase)              everything else)

   MAP.5 (Amazon OAuth) — dropped. Re-enters as a leaf whenever wanted,
   costing one connect flow, because MAP.2/MAP.3 stay channel-agnostic.
```

MAP.2 and MAP.3 produce **no operator-visible change**. That is the point: the fail-closed resolver
must exist *before* a second account exists for a push to go wrong on, so the wrong-store failure
mode never gets a window.

---

## 6. Gates

**Q1 — Amazon multi-account? → ANSWERED: not now, design for it.** MAP.5 dropped; the
channel-agnostic constraint on MAP.2/MAP.3 is what remains, and it is binding. See the MAP.5 entry
in §4 for exactly what that constrains.

**Q2 — MAP.2's non-additive migration? → ANSWERED: approved.** Dropping a unique index and changing
unique keys sits outside `feedback_additive_migrations_preapproved`, so this is the explicit yes.
Conditions: backfill row-count verified *before* old keys drop, rollback ships with it.

**Q3 — MAP.6 edits the flat file? → ANSWERED: decide at the phase.** The chip reaches the flat file
for free (§2.4). Making it genuinely *account-scoped* means editing `EbayFlatFileClient.tsx`
(4,717 lines) and `ebay-flat-file.routes.ts` (3,871 lines) — a hard no-touch zone under
`feedback_flat_file_untouchable`. The exact edit list goes back to the operator at MAP.6.

### Q4 — Catalogue overlap: deferred on purpose, and why that is safe

EMA's July decision was "same catalogue on every account". The operator is **not sure** in August,
and that is the correct position, because the decision is a *commercial* one about what the second
store will sell — not an architectural one. Three things follow:

**It blocks nothing before MAP.6.** MAP.0–MAP.4 are identical under either answer. The chip, the
schema, the resolver and the connect flow do not care whether two accounts share products. So this
does not need answering to start.

**Picking wrong in either direction has a real cost.** Committing to "same catalogue" makes
per-account title/description divergence mandatory for every product and pulls a hard gate in front
of every push. Committing to "different catalogue" removes the gate — and eBay's duplicate-listing
policy links accounts by IP, fingerprint and payment details, so a wrong guess there risks a
suspension that propagates across accounts.

**So build the mechanism that answers it per product instead.** The intent labels of §3.4 record
which accounts a product is *meant* for. That turns the global policy question into a per-product
fact, and the guard becomes: *a product intended for more than one account must have a genuinely
different title and description on each.* Products intended for one account are unaffected and pay
no cost.

**Consequence for the plan:** the duplicate guard stays in MAP.6 as a **gate**, but scoped by intent
rather than applied to the whole catalogue — which is the safe reading of "not sure". If the answer
later turns out to be "same catalogue everywhere", the guard already covers it with no rework,
because every product will simply carry both labels.

**What would settle it:** whether the second eBay store is a *second shopfront for the same range*
(overlap → guard does real work) or a *distinct range*, e.g. an outlet or a different brand
(no overlap → guard idles). Worth revisiting at MAP.4, when the second account is about to exist and
the question stops being hypothetical.

---

## 7. What MAP.0 found

### 9.1 The measured state (prod, 2026-08-19)

`GET /api/accounts/diagnostics`: **11 `ChannelConnection` rows, 2 active** — one Amazon (`env`), one
eBay (`oauth`) — and **9 revoked eBay grants**, the residue of revoke-then-reconnect being the only
multi-account move available today. The partial unique index is present and read straight from
`pg_indexes`, not inferred from the migration file.

### 9.2 The burn-down, counted structurally

`scripts/map0-connection-resolution-audit.mts` parses the TypeScript AST rather than grepping source
(`reference_verification_probe_false_positives`: ES6 shorthand beats a regex, a `vi.fn()` mock reads
as a call site, a comment counts). **94 call sites; 60 AMBIENT across 38 files** — 59 eBay, 1 Amazon.
That set is `docs/2026-08-19-map0-burndown.md`, and it is what MAP.3 converts.

### 9.3 🔴 A live defect, three months old, found by the audit and NOT fixed

Two sites filter `ChannelConnection` on a field that does not exist:

```ts
await (prisma as any).channelConnection.findFirst({
  where: { channel: 'EBAY', isActive: true },   // the column is `channelType`
})
```

- `apps/api/src/routes/orders.routes.ts:994` — eBay **order cancellation**
- `apps/api/src/services/ebay-pushback/index.ts:226` — eBay **markAsShipped / tracking upload**

Both introduced 2026-05-07 (`45830c7ef`, `2da934350`). Proven, not inferred:

1. `Prisma.ChannelConnectionWhereInput` rejects `channel` at compile time — `error TS2353`. The
   `(prisma as any)` cast is exactly what hides it, the `reference_as_never_hides_write_failures`
   class again, third measured instance.
2. Run against the production database: `{ channel }` throws
   **`PrismaClientValidationError: Unknown argument 'channel'`**; `{ channelType }` returns a real
   connection id. Prisma rejects the unknown argument — it does not ignore it.

So both paths have thrown on every invocation since May. **Left unfixed pending approval** — it is a
plain bug outside the MAP.0/MAP.1 grant, and the one-word fix belongs to whoever owns those paths.

### 9.4 A design-system gap

`.dark` (`design-system/styles/tokens.css:190`) redefines the text, surface and border tokens but
**not** `--h10-warning-strong`, `--h10-danger-strong` or `--h10-text-link`. On a dark panel those
light-mode values measure **2.94:1** and **3.18:1** — both below AA. Fixed scoped to the switcher's
own classes rather than to the tokens, because the token-level fix touches every component and
belongs to the DS-hardening session.

Contrast was verified by compositing each element against **its own** background
(`reference_contrast_probe_own_background`) with opacity folded in: **28 text nodes, 0 failures, in
both themes.**

### 9.5 Two things MAP.4 now has to carry

- **eBay has no seller identity.** `ebay-auth.service.ts:451` writes the literal
  `"eBay seller (verified)"` because the OAuth scope in use returns no name. MAP.4 must add the
  identity scope, or it cannot reject a duplicate account by sign-in name.
- **Amazon's label is its merchant id.** `displayName` holds `A1VRHKTGYO1JNU`. Both are surfaced as
  `labelIsPlaceholder`, which is the concrete case for MAP.2's `accountLabel`.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| A push lands in the wrong store | Fail-closed resolver (MAP.3) + pre-push ratchet |
| eBay duplicate-listing policy → linked-account suspension. **Highest risk in the programme** | Guard ships in MAP.6, gating the first cross-account push; intent labels make the risk queryable |
| Backfill mis-attributes existing listings | Row-count-exact verification before old keys drop |
| eBay job cost multiplies per account | Per-account budget + stagger in MAP.3, never a `for` loop |
| Flat-file format churn breaks existing xlsx | Account column additive, defaults to primary; 79-col files keep working |
| Two accounts fight over one inventory pool | Per-account buffers + Pinned + per-account kill switch (MAP.7) |
| The chip ships and switches nothing, looking broken | MAP.1 is deliberately framed as *status*, not *switching*; the caret only appears once >1 account exists |

---

## 9. Explicitly out of scope

- WooCommerce and Etsy (`project_active_channels`).
- Reopening shared-pool vs. split inventory (`project_inventory_split`).
- The legacy import path (`feedback_existing_import_untouchable`).
- Rithum's organisation grouping / Recent / Pinned / `+N More` machinery (§1.4) — revisit only if the
  account count crosses ~8.
