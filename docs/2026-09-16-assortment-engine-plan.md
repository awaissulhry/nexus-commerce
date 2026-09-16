# Assortment engine (AE): share products, settings and stock between business profiles

Date: 2026-09-16
Status: **APPROVED 2026-09-16** (all six decisions, R-AE-1…10). **AE.0 done (§12). AE.1 shipped to production (§13).** Later phases need their own yes.
Programme code: **AE**

## Owner rulings (newest first)

| When | Ruling | Decision |
| --- | --- | --- |
| 2026-09-16 | **R-AE-10** | Commit and push AE.1. |
| 2026-09-16 | **R-AE-9** | Add the push checks for AE.1 (static stock-writer lock check + race test on a throwaway PostgreSQL). |
| 2026-09-16 | **R-AE-8** | **Go:** start AE.0 (measure, read only) and AE.1 (stock lock). AE.1 has no database migration. Nothing is committed or pushed until the Owner says so. |
| 2026-09-16 | **R-AE-7** | D5: mapping settings **follow live**, with a revision for each incoming change. |
| 2026-09-16 | **R-AE-6** | D4: **one profile owns the stock and lends it.** One counter. |
| 2026-09-16 | **R-AE-5** | D2: products are a **linked copy** per profile. |
| 2026-09-16 | **R-AE-4** | Standing rule for every phase: **AAA quality, and everything aligns with the Nexus design system.** The rules are in §7.1 and §9. |
| 2026-09-16 | **R-AE-3** | D6: add the stock lock (AE.1) **first, before any sharing**. |
| 2026-09-16 | **R-AE-2** | D3: a SKU renamed in the source profile **goes to every follower profile**. Where the follower's listing is live, the rename is held until relist. |
| 2026-09-16 | **R-AE-1** | D1: the profiles **are separate businesses**. Build sharing across profiles (not the one-profile alternative). |

All six decisions are answered. The go-ahead covers AE.0 and AE.1 only; every later phase needs its own yes.

---

## 0. The short version

You want four things:

1. Share products from one business profile to another.
2. Share mapping settings the same way.
3. Keep them in sync in real time. Each profile has its own item IDs. The SKU stays the same unless you change it on purpose.
4. Let several channels and several profiles sell from one stock pool.

My recommendation, in one line each:

- **Products:** each profile keeps its own real product. A link joins it to the source product. The link copies changes across in seconds. You can override one field in one profile.
- **Settings:** the same link idea. Each incoming change is saved as a revision, so you can undo it.
- **Stock:** one profile owns the stock. It lends the stock to other profiles. There is only one counter. Other profiles never get their own copy of the number.
- **SKU:** the link uses the product ID, never the SKU text. So a SKU change never breaks the sync or the stock.

Three facts found in the code change the order of the work (see §2.3):

- Stock updates have no lock today. Two sales at the same moment can lose one update. Sharing stock across profiles makes this more likely. **We must fix this first.**
- Most code that saves a product does not send a change signal. Real-time sync cannot trust those signals. **The database must catch the changes.**
- The database layer refuses one transaction that touches two profiles. So stock that crosses profiles needs a guarded database function.

---

## 1. What you asked for

| # | Requirement | Where the plan answers it |
| --- | --- | --- |
| R1 | Share products with another profile | §3.1, §4, §5.1 |
| R2 | Share mapping settings | §3.8 |
| R3 | Real-time sync | §3.2, §5.2 |
| R4 | Item IDs differ per profile. SKU stays the same unless changed on purpose | §3.3 |
| R5 | One stock pool for several channels and several profiles | §3.5, §3.6, §5.4, §5.5 |
| R6 | Industry standard, AAA quality | §3 (each argument), §9 (proof) |

---

## 2. What exists today (measured 2026-09-16)

### 2.1 Profiles are real walls

| Fact | Evidence |
| --- | --- |
| 415 business tables carry `workspaceId`. PostgreSQL row-level security keys every one on `nexus.workspace_id`. | `packages/database/workspaces/model-ownership.json` (415 workspace models, 22 global) |
| A trigger refuses any row that points at another profile's record. BP.S3 needed a special exception for only 3 tables. | `packages/database/workspaces/reference-guard.sql:41` |
| The same SKU can already exist in two profiles. They are separate records. | `schema.prisma:463` `Product @@unique([workspaceId, sku])`; `:1424` the same for `ProductVariation` |
| Every mapping table belongs to one profile: `Marketplace.schemaMapping`, `MappingRevision`, `FieldValueMap`, `SizeScaleMap`, `CategoryChannelMapping`. | `model-ownership.json`; `schema.prisma:1941`, `:2100`, `:2124` |
| Every stock table belongs to one profile: `Warehouse`, `StockLocation`, `StockLevel`, `StockReservation`, `StockMovement`. | `schema.prisma:8995–9270` |
| One seller account has exactly one owning profile. Other profiles can get a read or publish **grant**. A listing coordinate on a shared account is exclusive. | `ChannelAccountGrant`, `ChannelListingClaim` (`schema.prisma:19106`, `:19135`); `docs/2026-09-16-bp-shared-accounts-and-access.md` |
| The BP design already set the rule for this feature: *"Catalog sharing and inventory sharing are independent decisions"* and *"a copied catalog must not create two independent counters for the same physical stock."* | `docs/2026-09-08-business-profiles-architecture.md:31-35`, `:154-156` |
| No code shares a catalog or stock between profiles yet. | Code search, 2026-09-16 |

### 2.2 How stock works inside one profile

- **Main writer:** `applyStockMovement` (`apps/api/src/services/stock-movement.service.ts:317`). It updates the level, writes the movement, runs the cascade and publishes `inventory.stock_changed`, all in one transaction.
- **Reservations** change `reserved` directly and skip the cascade: `reserveStock` (`stock-level.service.ts:72`), release (`:186`), consume (`:256–281`, in two separate transactions).
- **Cascade:** `cascadeQuantityToListings` picks listings **by productId only** (`stock-movement.service.ts:695`). It sums WAREHOUSE locations only. Each listing gets *available at its routed locations − its `stockBuffer`* (`sync-control-core.ts:146-180`). FBA is excluded.
- **One pool, every channel.** Per-channel allocation was rejected on 2026-06-24. Each listing shows the full pool minus its own buffer.
- **Orders:** Amazon and Shopify reserve. eBay deducts directly with no reservation (`ebay-orders.service.ts:689`). Amazon and eBay find their profile from the seller account (`workspace-ingress.ts:5-9`). Shopify webhooks are hard-wired to the legacy profile (`lib/workspace-hook.ts:45-49`).
- **Bulk stock import** writes `StockLevel` with raw SQL and runs its own cascade (`stock-import.service.ts:1251`).

### 2.3 🔴 Three findings that shape this plan

**F1 — Stock updates can lose a sale today.** Every stock writer reads the row, computes the new number in JavaScript and writes an absolute value. There is no `FOR UPDATE`, no lock and no version check (`stock-movement.service.ts:353→375`, `stock-level.service.ts:87→111`). Two orders at the same moment can both read 5 and both write 4. The database checks (`available = quantity − reserved`, both ≥ 0) do not catch this. It is a risk already, inside one profile. A pool shared by two profiles adds more writers at the same time. **AE.1 fixes this before any stock is shared.**

**F2 — Change signals miss most product saves.** 66 non-test files write `Product` (182 call sites, plus 8 raw `UPDATE "Product"`). **52 of those 66 files contain no call to any event helper** (`product-event.service`, `publishListingEvent`, `publishEvent`, `emitTx`, or a direct `productEvent` write). The event service's `emit` mode also runs outside the transaction and fails open (`product-event.service.ts:1-14`). A sync that listens to those signals would silently miss edits. **The capture must sit in the database** (§3.2).

**F3 — One transaction cannot touch two profiles.** The database router refuses it: `workspace_transaction_changed` (`packages/database/workspace-router.ts:116`). That is a correct wall. So a sale in profile B cannot "just also update" profile A's stock row in the same transaction. **Cross-profile stock needs a guarded database function** (§3.6).

---

## 3. The arguments

Each argument lists the options, what the industry does, what our code says, my pick, and what would change my mind.

### 3.0 First question: are these really two businesses?

If both profiles are the same business, run by the same people with the same settings, **do not share across profiles at all.** Put both seller accounts in one profile. That already works today (the MAP layer: several accounts per channel in one profile, one catalog, one pool). Then the only new thing is an assortment per account: which products go to which account.

This is how commercetools and Salesforce Commerce Cloud do it. They share one catalog and one stock list between many **stores inside one project**, not between separate tenants.

Share across profiles only when the businesses must be apart: different team access, different settings, different money. The rest of this plan assumes that.

### 3.1 Products: one shared row, or a linked copy?

| | A. One shared row | B. Linked copy (**pick**) |
| --- | --- | --- |
| How | The product stays in profile A. Profile B can read it. B's listings point at A's product. | Profile B has its own real product row. A link row joins it to A's product. Changes travel across. |
| Industry | commercetools and SFCC, but only inside one project | Shopify expansion stores (no native sharing; sync apps copy from a master store), syndication tools |
| Sync lag | None | Seconds |
| SKU can differ on purpose (R4) | **No.** One row has one SKU. It would need a shadow SKU, which you rejected on 2026-06-29. | Yes |
| B can set its own price | Needs new override tables | Yes, it is B's row |
| Existing pages, flat files, studio, publish, search, caches | All assume one profile per row. Hundreds of reads need changes. The reference guard needs exceptions on most catalog tables. | Work unchanged in B |
| Revoke | B loses the products | B keeps its products as normal, independent ones |

**Pick B.** It meets R4, keeps the walls whole, and reuses every existing page.

**Cost of B:** we build change capture, field rules, loop protection and a repair job. §3.2 covers them.

**What would change my mind:** if §3.0 is answered "same business". Then there is nothing to copy.

### 3.2 How changes travel: app signals, or database capture?

| | A. App signals | B. Database trigger + queue + repair job (**pick**) |
| --- | --- | --- |
| How | Add a signal to every code path that saves a product. | A PostgreSQL trigger on the shared tables writes a small change row **in the same transaction**. It only fires when the product has an active link (one indexed lookup, so unshared products pay nearly nothing). A worker claims the rows and applies them in the follower profile. |
| Catches every save | No. F2: 52 of 66 files that write products send no signal. Every new code path is a new hole. | Yes, including raw SQL and imports |
| Industry | Common, but known to drift | "Transactional outbox" and change data capture. This is the standard pattern for reliable replication. |
| Other option | — | Logical replication (full CDC). Stronger, but needs replication slots and more operations work. Not needed at our size. |

**Pick B.** Plus a **repair job** (a reconciler): it compares a hash of the followed fields on both sides and heals or reports any difference. A sync without a repair job is not AAA.

**Rules the worker follows:**

- **Order.** Each change carries the source `Product.version`. The link stores the last version it applied. An older change is skipped. A retry does no harm.
- **No loops.** A write made by the worker sets a transaction-local flag. The trigger ignores writes with that flag.
- **One direction only in v1.** No two-way sync. No chains: a product that follows a source cannot share the same fields onward.
- **Wake-up.** The worker waits with adaptive backoff, not a fixed 1-second poll. A fixed poll on an empty table cost 86,400 queries a day in production on 2026-08-31.

### 3.3 The SKU rule (R4)

Facts: `Product.sku` **is** the channel seller SKU (decision of 2026-06-29). A live SKU cannot be renamed directly. Amazon needs a relist under the new SKU.

The rules I propose:

1. **The link uses product IDs.** It never matches on SKU text after the first share. A SKU change never breaks sync or stock.
2. **At share time**, the follower gets the source SKU.
3. **Existing product with that SKU in the follower:** the preview offers "Link to the existing product" (with a field-by-field diff) or "Skip". Nothing is overwritten without you seeing it. No second product is created.
4. **You change the SKU in the follower on purpose:** that field becomes an override for that product only. A badge says "SKU differs from <source profile>". One click follows the source again.
5. **You change the SKU in the source on purpose:** two options.

| | A. It goes to every follower (**pick**) | B. It stays in the source only |
| --- | --- | --- |
| Meaning | "SKUs stay the same everywhere" | Each profile renames by itself |
| Live listings | If the follower's product is live, the rename is **held**, not applied. You get a notice with the relist steps. The live-SKU guard stays in every profile. | Nothing to hold |

I pick A. It is what "the SKUs remain the same" means.

Variations follow the same rules, one child at a time. A child added at the source is created in the follower. A child removed at the source is **detached** in the follower, never deleted.

### 3.4 What follows, and what each profile keeps

| Field group | Default | Why |
| --- | --- | --- |
| Identity: SKU, GTIN/EAN/UPC, brand, manufacturer | Follow | Same product |
| Content: name, description, bullets, keywords, A+ | Follow | |
| Attributes: product type, category attributes, variation theme and axis values | Follow | |
| Translations | Follow | |
| Media: images, documents | Follow | Files are **copied** into the follower's storage, so a delete in the source never breaks the follower |
| Physical: weight, dimensions | Follow | |
| Compliance: certificates, safety data | Follow | |
| Family and variation structure | Follow | |
| Price and cost | **Keep per profile** | Business decision |
| Status, fulfilment method, workflow stage | **Keep per profile** | Business decision |
| Channel listings, item IDs, channel overrides | **Never shared** | Each profile publishes with its own accounts (R4) |

Each field has a state: **FOLLOW** or **OVERRIDE**. When you edit a followed field in the follower, it turns to OVERRIDE and shows a badge. A bulk edit tells you, before you save, how many fields will stop following.

**Publishing:** a synced change lands in the follower's product. The follower's own publish settings decide if and when it goes to its channels. Same as an edit made by hand there.

### 3.5 Stock: who owns the pool?

| | A. Copy the number | B. One profile owns the pool and lends it (**pick**) | C. A new level above profiles owns the pool |
| --- | --- | --- | --- |
| How | Each profile keeps its own stock and they sync numbers | Stock stays in the owner's ledger. A **pool grant** lets other profiles read the available number and reserve against it | A new "organisation" owns warehouses and stock |
| Counters | Two. Races cause oversell. | **One** | One |
| Industry | Anti-pattern | SFCC: one inventory list assigned to many sites. commercetools: one supply channel for many stores. Linnworks: one location linked to many channels. | Large ERP set-ups |
| Our code | — | Stock tables stay where they are. Adds a grant and guarded functions. | Moves every stock table, cost layer, bin, lot and serial. The BP design chose to keep no extra level. |

**Pick B.** C stays possible later if three or more businesses share everything.

**Hard rules for the pool:**

- **Only WAREHOUSE locations can be lent.** FBA stock belongs to one Amazon seller account. It is never in a pool grant. The FBA quantity guard does not change.
- **Supply is one source per linked product.** In the follower, a linked product uses either the shared pool or its own stock, never a sum of both. A sum would need rules for which pool to take from first. Not in v1.
- **Reuse routes.** The grant can name which of the follower's channels and markets draw from the pool, with the same `CHANNEL:MARKET` grammar as `StockLocation.syncRoutes`.
- **Amazon EU** holds one quantity per seller account and SKU. Two profiles on one shared seller account still go through `ChannelListingClaim`. Only one of them pushes quantity.

### 3.6 Stock across the wall: switch context, or guarded function?

| | A. The app switches profile in the middle of the work | B. Guarded database functions (**pick**) |
| --- | --- | --- |
| How | Code changes `nexus.workspace_id` to the owner, writes, and switches back | `SECURITY DEFINER` functions: `nexus_pool_available`, `nexus_pool_reserve`, `nexus_pool_release`, `nexus_pool_consume`. Each checks for an active grant for the caller's profile, locks the owner's stock row, writes, and records which profile consumed it |
| Safety | A bug writes into the wrong profile, and row security cannot tell | The follower **never** gets direct read or write on the owner's stock tables. The database enforces the grant. |
| Precedent | The router refuses it (F3) | `nexus_assign_channel_account()` works this way (`packages/database/workspaces/account-assignment.sql:13`) |
| Cost | — | Some ledger logic lives in SQL. We keep the SQL small: lock, check, change the numbers, write the movement. The cascade and events stay in the app. |

**Pick B.**

### 3.7 Allocation between profiles: not proposed

Every listing in every sharing profile shows *pool available − that listing's buffer*. Same as between channels today. Per-channel allocation was rejected on 2026-06-24, and the same reason holds.

The oversell watchdog must widen to the whole pool: *excess = the highest single listing commitment across all sharing profiles − the pool*. Amazon counts once per seller and SKU. FBA is excluded. It is never the sum (`reference_oversell_is_per_channel_not_summed`).

**The honest counter-argument:** across two businesses, one can sell out the other. If the two businesses have different owners or money, a cap per profile matters. If the owner is the same, it does not. A cap can be added later, as a field on the grant. It is not in v1.

### 3.8 Mapping settings: follow, or copy once?

What counts as mapping settings: `Marketplace.schemaMapping` (per channel and market), `MappingRevision`, `FieldValueMap`, `SizeScaleMap`, `CategoryChannelMapping`. AE.0 checks for any more (for example `ChannelSchema` and `CategorySchema` may be downloaded channel data that each profile can fetch for itself).

| | A. Copy once | B. Follow (**pick**) |
| --- | --- | --- |
| How | "Import settings from profile X" | The same link engine. Each incoming change is saved as a `MappingRevision` in the follower, so it shows in history and can be rolled back. One rule can be overridden. |
| Drift | Starts drifting at once | None |
| Match key | — | `(channel, market code)`, never a database ID. Only markets the follower has are touched. |

**Pick B.** A later option (AE.5b): a share can say "review incoming changes first" instead of applying them at once.

### 3.9 What is "the assortment"?

An **assortment** is a named set of products in the source profile. It is what you share.

| | A. A fixed list | B. Rules (brand, family, product type, tag) plus manual includes and excludes (**pick, in two steps**) |
| --- | --- | --- |
| Industry | commercetools Product Selections are mostly lists, with an "all except" mode | SFCC storefront catalogs assign by category |

**Pick B, built in two steps.** v1: a fixed list, plus "all products", plus excludes. Rules come in AE.8. The table shape supports rules from day one.

The same assortment idea can later answer "which accounts in one profile list this product". The MAP plan names that as intent labels (`docs/2026-08-19-map-multi-account-profiles.md` §3.4). AE.0 checks what shipped, so we never build two assortment ideas.

### 3.10 Consent, pause, revoke

- **Two sides agree.** An owner of the source creates the share. An owner of the follower accepts it. Both sides are audited. If one person owns both, accepting is one click, and it is still recorded.
- **Pause** stops sync and keeps the links.
- **Revoke a product share:** the links end. The follower keeps its products as normal, independent products. Nothing is deleted. No listing is ended.
- **Revoke a pool grant:** the follower's linked listings lose their stock source. They are set to **0**, never left at an old number (an old number is an oversell). Before you confirm, a preview shows how many live listings go to 0.
- **Source product deleted:** the follower's product is detached and flagged, never deleted.
- **Profile archived:** its shares freeze.

---

## 4. The data model (names are proposals)

| Table | Owner | Purpose |
| --- | --- | --- |
| `Assortment` | source profile | Name, optional rules |
| `AssortmentMember` | source profile | Product includes and excludes |
| `AssortmentShare` | global (spans two profiles) | Assortment → follower profile. Status (pending, active, paused, revoked), field groups, settings scope, who created, who accepted |
| `CatalogLink` | global | Source product or variation ↔ follower product or variation. Field states, last applied source version, status (active, held, detached) and the hold reason. **A follower product follows at most one source.** |
| `AssortmentChange` | global queue | One captured change: link, table, changed columns, source version, claim state |
| `StockPoolGrant` | global | Owner profile → follower profile. Lent WAREHOUSE locations, routes, status, who created, who accepted |
| `StockReservation`, `StockMovement` | owner profile (existing) | **Additive** columns `consumerWorkspaceId` and `consumerOrderRef`, so the owner sees what each profile sold |

Rules from BP.S that apply to every global table here:

- Classify it in `model-ownership.json`, or the runtime role cannot read it. The push gate checks this.
- Write its policy in `packages/database/workspaces/*.sql`. The migration must end with the same bytes. The parity gate checks this.
- Read access for the guest is a **separate `FOR SELECT` policy.** Never widen `USING` on a `FOR ALL` policy: `DELETE` reads `USING` alone, so that would let the guest delete.

---

## 5. How it flows

### 5.1 Create a share
1. Owner of A builds an assortment and chooses the follower profile, field groups, and optional settings and pool.
2. Owner of B accepts.
3. Preview: N new products, M SKU matches (link or skip), K conflicts.
4. First copy in batches. It can resume and it is safe to retry. Links become active.

### 5.2 Edit in A
1. The write commits. The trigger writes a change row in the same transaction (linked products only).
2. The worker claims it and switches to B.
3. It applies followed fields only, skips overrides, and raises B's `Product.version`. It writes a product event in B with source `ASSORTMENT`.
4. B's normal paths run: read cache, search, and B's own publish settings.
5. The link stores the applied version.

**Target: p95 under 5 seconds from commit to B.** We measure it and state the load with the number.

### 5.3 SKU rename in A
As in §3.3. It is applied where the follower still follows the SKU and is not live. Where the follower is live, it is held, with a notice.

### 5.4 Stock change in the owner profile
1. `applyStockMovement` runs as today, and A's listings cascade as today.
2. **New:** for each active pool grant, a cascade job runs in the follower profile for its linked products.
3. The follower's listings get *pool available − their buffer*.

### 5.5 Order in the follower profile
1. The order arrives in B, as today. B owns its seller account, so ingress does not change.
2. `nexus_pool_reserve` locks A's stock row, checks the grant, and reserves.
3. Available drops. §5.4 then fans out to **every** sharing profile, A included.
4. Cancel calls `nexus_pool_release`. Ship calls `nexus_pool_consume`.

### 5.6 Repair job
Runs nightly and on demand:
- Compares followed-field hashes per link. It heals or reports.
- Checks that every consumer reservation still matches a live order in its profile.

---

## 6. Hard rules

1. One counter per physical unit. Never copy stock numbers between profiles.
2. FBA is never in a pool. The FBA guard does not change.
3. Links use IDs, never SKU text.
4. A share never deletes anything in the follower. It detaches.
5. No two-way sync and no chains in v1.
6. Inbound orders stay with the profile that owns the seller account.
7. Every cross-profile write is audited on both sides.
8. Every refusal reaches a person (the bell). It is never only logged (BP.S3 lesson).
9. Real-time claims come with a measured latency and the load they were measured under.

---

## 7. Screens (existing pages are extended, no new pages)

- **Profile manager** (`/settings/profiles`): a Sharing section. Outgoing and incoming shares, accept, pause, revoke, each with its preview.
- **Products grid:** a Source column and filter (Own, Following <profile>, Shared out). Followed cells show FOLLOW or OVERRIDE, with "Follow again".
- **Product studio:** the same field badges. The SKU override badge.
- **Stock pages:** who owns the pool and who uses it. In the owner profile, sales split by profile.
- **Mappings** (`/settings/mappings`): a "Following <profile> · revision N" banner, and override per rule.
- **Bell:** held renames, SKU collisions, refused reservations.

### 7.1 Design system and quality rules (R-AE-4)

These rules apply to every AE screen. A screen that breaks one is not done.

**Build from the design system only**
1. Compose every screen from `apps/web/src/design-system` (components, patterns, primitives, grid, tokens). Use the mapping in `/DESIGN.md`.
2. Check the design system **before** building any structure. Existing parts this work must reuse:
   - `SourceIndicator` for FOLLOW and OVERRIDE (it already has the `master`, `override` and `linked` kinds, with the tooltip and one action).
   - `AccountsPanel` and its engine `lib/accounts-panel.ts` for share rows, the same way BP.S1d shows a shared account.
   - `Banner`, `Modal`, `ActionConfirm`, `Stepper`, `DataGrid` / the grid engine, `FilterBar`, `KeyValue`, `SummaryTable`, `Toast`.
3. A part that does not exist is **added to the design system first**, then used. The gap is written in `.claude/DS-GAPS.md` with its measurement. Never a local one-off.
4. **Shared means exactly the same.** One component owns the markup, the words and the behaviour. The grid, the studio and the mappings page use the same FOLLOW/OVERRIDE control with the same words. The words come from one engine function, not from props on each page.
5. Every design-system file changed is mirrored into `apps/factory`. `npm run check:ds-parity --workspace=@nexus/factory` must show no new drift from these files.
6. No raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<table>`. The raw-primitives ratchet in `.githooks/pre-push` must not get worse.

**Honest screens**
7. Every badge and number is a real reading from the database. "Following", "Override", "Held" and "Pool owned by" come from the link and grant rows, never from a guess on the page.
8. Every control writes through to the real thing. A control with no reader or no writer is not shown.
9. An action that is not allowed is not shown as a disabled button with a tooltip (a tooltip on a disabled button cannot be reached). The screen shows the **reason** as text, like the BP.S1d shared-account row.
10. Before a large action (share, revoke, SKU rename to followers), a preview shows the exact counts: products, live listings, listings that go to 0.

**Checked on the running app, every screen**
11. Light and dark theme. Contrast is measured, not assumed: at least WCAG AA for all text, and 7:1 (AAA) where we can reach it. The measured numbers go in the build record.
12. Keyboard only: every control can be reached and used. Focus is visible and never lost after a dialog closes.
13. The accessibility tree (`read_page`, interactive filter) lists every control a person can press. Screenshots alone are not proof.
14. Narrow width (390 px). The browser window tool cannot go that narrow (the OS clamps it), so AE.0 finds a method that works. If a width check did not run, the build record says so.
15. Balanced spacing, no dead space, density as the design system sets it.

### 7.2 AAA for the parts nobody sees

16. Every phase is proven end to end through the real path (§9), not only by unit tests.
17. Every number we claim (latency, counts) comes with how it was measured and the load at the time.
18. Every gate in `.githooks/pre-push` passes. No gate is bypassed.
19. A refusal always reaches a person with its reason. It is never only logged.

---

## 8. Phases

| Phase | What | Depends on | Changes production data? |
| --- | --- | --- | --- |
| **AE.0** | Measure, read only. The full list of tables that make up "a product". How media is stored. The full list of mapping settings. How shipments use warehouses (see §10.1). What MAP intent labels shipped. Load numbers. | — | No |
| **AE.1** | **Stock safety first.** Make every stock writer atomic: `quantity = quantity + change` with the guard in the same statement, or a row lock. Covers `applyStockMovement`, reserve, release, consume and the stock import. Plus a concurrency test. **Useful even without sharing.** | AE.0 | Code only |
| **AE.2** | Foundation: the tables, policies, ownership map and parity. Create, accept, pause and revoke shares, with audit. No data moves. | AE.0 | Additive migration |
| **AE.3** | First copy: preview (new, SKU match, conflict), batch copy, links. | AE.2 | Yes, in the follower only |
| **AE.4** | Live product sync: trigger, worker, field states, version order, loop guard, SKU rules and held renames, repair job. | AE.3 | Yes, in the follower only |
| **AE.5** | Settings follow: the mapping bundle, revisions in the follower, override per rule. | AE.2 | Yes, in the follower only |
| **AE.6** | Stock pool: grants, the four guarded functions, cascade fan-out, the wider oversell watchdog, FBA refusal, revoke to 0. | **AE.1**, AE.2 | Yes |
| **AE.7** | Orders and shipping on a shared pool (shape decided by AE.0). | AE.6 | Yes |
| **AE.8** | Rule-based assortments. | AE.4 | Yes |
| **UI** | Screens from §7, as parallel lanes once AE.2 fixes the contracts. | AE.2 | — |
| **AE.9** | End-to-end proof on two local profiles, then a production decision by you. | all | Your decision |

---

## 9. How we prove it works

- **End to end through the real paths.** Not unit tests of each gate. BP.S3 passed its unit tests and did not work until an end-to-end write was tried.
- **Every refusal has a positive control,** and the test asserts the reason.
- **Row security is tested under the runtime role** `nexus_workspace_runtime`, never as `postgres` (a superuser skips every policy). Every "guest cannot write" test includes `DELETE`. Each expected failure gets its own savepoint.
- **Concurrency:** two profiles order the last unit at the same moment, 100 times. Exactly one reservation wins each time. Available never goes below 0.
- **Sync:** change one field as the positive control. Write the expected value down before reading. Read after a delay. Also test changes arriving out of order, and a crash between claim and apply.
- **Loop:** an edit in A does not bounce back.
- **Load:** 10,000 linked products and a bulk edit of 1,000. Lag p50 and p95, with the load stated.
- **FBA:** a pool grant refuses an `AMAZON_FBA` location. An FBA listing's quantity is unchanged after pool events.
- **Revoke:** the affected listings go to 0. Nothing is deleted.
- **Profiles-on test debt:** every new test runs with profiles ON. The ratchet (`apps/api/scripts/profiles-on-ratchet.mjs`) must not get worse.

---

## 10. Risks and open questions

1. **Shipping from a lent warehouse.** `Shipment.warehouseId` points at a warehouse in the same profile, and the reference guard refuses another profile's warehouse. When B sells a unit that sits in A's warehouse, who packs it, and on which shipment screen? AE.0 measures this, and AE.7 depends on the answer.
2. **Cost and profit** for B's sales come from A's cost layers. How B sees its cost of goods is open.
3. **Media copy cost.** AE.0 measures storage size before we choose copy or shared files.
4. 🔴 **Production rollback line.** Profiles are ON in production. The BP audit says rollback is safe only while production has one business with data. Real sharing needs a second business with data. After that, turning profiles off is no longer a safe rollback.
5. 🔴 **A push to `main` migrates production** (`railway.toml` runs `migrate deploy`). Every AE migration reaches production at the next push.
6. **Shopify webhooks** are hard-wired to the legacy profile (`lib/workspace-hook.ts:45-49`). A Shopify store in a second profile would route to the wrong profile. That is not caused by this plan, but it blocks Shopify in a follower profile.
7. **F1 exists today.** The stock race is present now inside one profile, with or without this plan.

---

## 11. Decisions I need from you

| # | Question | Option 1 | Option 2 | My pick | Owner |
| --- | --- | --- | --- | --- | --- |
| D1 | Are the profiles really separate businesses? | Yes: build this plan | No: one profile, several accounts, assortment per account only | Your call, it decides everything else | **Yes** (R-AE-1) |
| D2 | Products | Linked copy per profile | One shared row | Linked copy | **Linked copy** (R-AE-5) |
| D3 | SKU renamed at the source | Goes to every follower (held where live) | Stays in the source | Goes to followers | **Goes to followers** (R-AE-2) |
| D4 | Stock | One profile owns the pool and lends it | A new level above profiles | Owner lends | **Owner lends** (R-AE-6) |
| D5 | Mapping settings | Follow live, with revisions | Copy once | Follow live | **Follow live** (R-AE-7) |
| D6 | Fix the stock race (F1) first, as AE.1 | Yes | Later | Yes | **First** (R-AE-3) |

---

## Sources

- commercetools, Stores and Product Selections: https://docs.commercetools.com/api/projects/stores, https://docs.commercetools.com/api/projects/product-selections
- commercetools, supply channels for store inventory: https://docs.commercetools.com/merchant-center/releases/2020-08-17-configure-your-stores-inventory-supply-channels
- Salesforce B2C Commerce, create inventory lists (one list can be assigned to several sites): https://help.salesforce.com/s/articleView?language=en_US&id=cc.b2c_creating_inventory_records.htm
- Salesforce B2C Commerce, multi-site catalog and inventory sharing: https://www.sapotacorp.vn/blog/sfcc-multi-site-catalog-inventory-sharing
- Shopify, expansion stores (products and inventory are not synced between stores by default): https://help.shopify.com/en/manual/organization-settings/expansion-stores
- Linnworks, inventory mapping and multiple locations: https://help.linnworks.com/support/solutions/articles/7000034383-channels-inventory-mapping, https://help.linnworks.com/support/solutions/articles/7000023181-locations-multiple-warehouses

---

## 12. AE.0 — measured (2026-09-16, read only)

No database was queried, no test was run, no repo file was changed for AE.0. Every set claim below
was derived by a script with a positive control. Scripts and raw output were kept in the session
scratchpad; the full product list is copied to `docs/audits/2026-09-16-ae0-product-closure.md`.
Three claims were re-checked by hand before being written here (marked ✔).

### 12.1 What "a product" is (for AE.3 / AE.4)

- **121 models reference a product** (61 by declared FK, 34 by an id column only, 26 one hop
  further). **13 can follow** (definition), **101 must never be copied** (per-profile business
  data), **7 are derived** caches. 13 are ambiguous and need a ruling in AE.3 (for example
  `Bundle` carries cost; `ListingImage` mixes media with listing state; `ProductCategory` and
  `ProductTag` point at per-profile trees).
- Variations are child `Product` rows. `Product.version` and `ProductTranslation.version` exist;
  `ProductVariation` and `ProductImage` have no version column (updatedAt only). The worker's
  "last applied version" needs a rule for the unversioned tables.
- A followed product points at per-profile rows by database id: family and its attributes,
  category, tags, digital assets, workflow stage. **Each needs a match key in the follower.**

### 12.2 Media (for AE.3)

- Every upload goes to one Cloudinary account. Folders are **not** per profile
  (`product-images/{productId}`).
- 🔴 **Sharing a file by reference is unsafe.** Bytes are deleted only when no image row still
  points at them, and that count runs under the deleting profile's row security — it cannot see
  the follower's rows. **AE.3 must upload a copy** into the follower. No copy helper exists yet.
- Storage size could not be measured (needs a database query).

### 12.3 Mapping settings (for AE.5)

Operator-authored, per profile, with their natural keys: `Marketplace.schemaMapping`
(channel, code) + `MappingRevision`; `FieldValueMap`; `SizeScaleMap`; `CategoryChannelMapping`;
`MasterFieldRule` + revisions; `FeedTransformRule`. Read by mapping code: `EbayDescriptionTheme`,
`TerminologyPreference`.

- 🔴 **`schemaMapping.presentationRules` store database ids** (account, family, categories,
  theme). AE.5 must translate them to the follower's rows, or refuse the rule with a reason.
- 🔴 **`CategoryChannelMapping` is keyed by `categoryId`**, a database id. The category tree's own
  key is (parent, slug), so AE.5 matches by category path.
- `ChannelSchema`, `CategorySchema` and the marketplace taxonomies are **downloaded** from the
  channel, not authored. They are not shared; each profile fetches its own.

### 12.4 Shipping from a lent warehouse (answers §10.1)

- Marking a shipment shipped **does not take stock out** ✔ (`fulfillment.routes.ts`, it only sets
  `shippedAt`). Stock is consumed when the channel says the order shipped.
- Reservations use a hard-coded `IT-MAIN` location (17 literals outside tests), not the routed
  warehouse. AE.6/AE.7 must route by pool instead.
- **Smallest shape that works:** the order and the shipment stay in profile B. B has its own
  "mirror" warehouse row at the same address, so carrier, sender and routing work in B. Only the
  stock number crosses, through the pool functions. "A packs B's order on A's screens" needs a new
  cross-profile object and is not in v1.
- 🔴 **Pre-existing, not caused by AE:** Sendcloud webhooks always run as the legacy profile ✔
  (`lib/workspace-hook.ts:45-49`), like Shopify webhooks. Carrier scans can never reach a shipment
  in any second profile. This blocks tracking for every follower profile until fixed.

### 12.5 MAP intent labels (for AE.8)

Nothing shipped: no model, no column, no code. The assortment in AE.8 is the only such concept.

### 12.6 Trigger and worker substrate (for AE.4)

- No `LISTEN/NOTIFY` anywhere. The event relay backs off to a **10-second** cap and is only woken by
  `publishEvent`. A row written by a database trigger would wait up to 10 s — above the §5.2 target
  of p95 < 5 s. **AE.4 needs its own wake-up** (for example `pg_notify` from the capture trigger).
- Reusable: `visitActiveWorkspaces`, `runWorkspaceTick`, `withWorkspace`, `WorkspaceQueue`, and the
  relay's claim (`FOR UPDATE SKIP LOCKED` inside a transaction). Do **not** copy
  `jobs/scheduled-changes.job.ts:125-135`: it runs `SKIP LOCKED` outside a transaction, so the lock
  ends at once, whatever its comment says.
- 🔴 **Found, belongs to the LX programme, not fixed here:** migration folder order ✔. On a fresh
  database, `20260912_lx1_remove_legacy_content_guard` (DROP TRIGGER) sorts and runs **before**
  `20260912_lx1_translation_store` (CREATE TRIGGER), so the trigger
  `Product_localizedContent_readonly` survives and refuses every change to
  `Product.localizedContent`. Production state was not measured. (The disposable test database
  does not replay migrations, so tests do not see this.)

### 12.7 Narrow width (for §7.1 rule 14)

Playwright 1.60 is installed, and `scripts/studio-browser-auth.mjs` (`authenticatedStudioPage`)
accepts a viewport. **Method:** Playwright at 390 × 844 through that helper. No check has run at
480 px or below so far.

### 12.8 Cost of goods (answers §10.2)

A pool consume runs in the owner profile, so the cost is computed from A's layers and written on
A's movement. B's reports read B's own `costPrice` / weighted average, and B has no cost layers.
**Open for AE.6:** B needs a cost source (for example cost follows as a field group, off by default).

---

## 13. AE.1 — build record (2026-09-16). Stock lock. Committed and deployed (§13.6).

### 13.1 The defect, measured before the fix

A new test runs on a **real multi-connection PostgreSQL** (a throwaway Docker container). The usual
test database (PGlite behind one connection) cannot show a race: every transaction is queued, so a
race test passes there whether or not the code is safe.

On the code **before** AE.1 (8 of 10 arms failed):

| Arm | What happened | Result before |
| --- | --- | --- |
| A1 | 20 sales at the same moment on 20 units | **19 units left** — 19 sales lost |
| A2 | 25 buyers reserve 20 units at once | **25 reservations** — 5 oversold |
| A3 | Sales, receipts and reservations at once | 6 orders refused by the database check |
| A4 | One reservation consumed twice at once | **Stock taken twice** (−6, not −3) |
| A6 | One order reserved twice (webhook + poll) | **Two reservations** |
| A7 | A sale lands while an import (ADJUST +5) runs | **15, not 14** — the sale was overwritten |
| A8 | An import SET races 6 sales | Level 50, ledger says 44 |

### 13.2 The fix

`apps/api/src/services/stock-lock.ts` — `lockProductStock(tx, productIds)`: **every stock write
locks the product row first** (`SELECT … FOR NO KEY UPDATE`, several products in one statement
ordered by id). Why this lock:

- Every stock write already locked this row when it updated `Product.totalStock` — only late. Taking
  it first adds no new kind of lock, so no new deadlock with the routes that edit a product and its
  stock in one transaction (they lock the product first too).
- The product is the unit: the cascade reads every location and writes every listing.
- `FOR NO KEY UPDATE`, so inserting rows that point at the product (movements, events) is not blocked.

Where it is taken (the full list of runtime `StockLevel` writers was derived from source first —
7 call sites in 3 files, plus 2 threshold-only writes in `stock.routes.ts` that never touch quantity):

| Writer | Change |
| --- | --- |
| `applyStockMovement` | Split into `applyStockMovementInTx` (lock → read → write → cascade → event) and `afterStockMovementCommit` (queue push, stockout hook, read cache). Same behaviour for every existing caller. |
| `recascadeProduct` | Takes the lock before it reads stock and writes listings. |
| `reserveStock` | Lock before reading `available`. |
| `releaseReservation` | Lock, then re-read the reservation (a concurrent call may have settled it). |
| `consumeReservation` | Now **one** transaction: lock, re-read, settle `reserved`, take the stock, mark consumed. Before, the "already consumed?" check ran outside any transaction and the two halves committed separately. |
| `reserveOpenOrder` | The "already reserved for this order?" check runs under the lock. |
| `consumeWithFefo` | One transaction with the lock; lots are picked under the lock. Its old comment claimed this was already atomic; it was not. Accepts a caller's `tx`. |
| Bulk stock import | Each chunk now **locks, reads, plans and writes in one transaction**. Before, every product was planned from reads taken up front and written seconds later. Retries re-plan from fresh reads. |

Size: 274 lines added, 158 removed across the 4 changed files, ignoring indentation (the raw diff
is larger because two blocks moved into functions). New files: `stock-lock.ts`,
`stock-concurrency.vitest.test.ts`, `test-support/concurrent-database.ts`.

### 13.3 Proof

- **After the fix: 10 of 10 arms pass, 3 runs in a row**, exit 0, no leftover test databases.
- **The lock is what fixes it** (lock replaced by a no-op, everything else unchanged): 8 of 10 fail.
  The two that still pass are the sequential control and A7. A7 tests the import *reading under the
  transaction*, which the before-run proves.
- Two arms first passed for the wrong reason and were tightened. A4 passed without the lock only
  because a database check rejected the second call. It now asserts **no error** and exactly one
  consume row. A5 passed because two stale writes cancelled out. It now asserts exactly one release
  row.
- A9: two writers lock two products in opposite orders at once. Both finish. Without the ordered
  lock this deadlocked.
- **Typecheck:** `apps/api` `tsc --noEmit` exit 0 (the changed files are in the program).
- **Existing tests:** every test whose imports reach the changed files (`vitest related`):
  164 files pass, 5 skipped. **5 files were not measured**. They need the shared local database,
  which was deliberately blocked for this run. None of them calls stock code. The 9 test files with
  hand-made stock fakes: 136 of 136 pass.

### 13.4 Push checks (R-AE-9: Owner, "Add it")

Both are in `.githooks/pre-push`:

1. **`scripts/check-stock-writer-lock.mjs`** (static, TypeScript AST). Only the files in
   `scripts/stock-writer-lock.json` may write `StockLevel`, each with an exact count of write
   sites. A file marked `lock: true` must call `lockProductStock(`. The one `lock: false` entry
   (threshold-only writes in `stock.routes.ts`) must give its reason. Mutation-tested on scratch
   copies, 11 of 11 arms: a new writer file, a raw `UPDATE "StockLevel"` in a template, a
   multi-line raw `INSERT INTO`, an extra write in an approved file, an approved file dropping the
   lock, a removed write (the list must shrink), a deleted approved file, an empty tree (zero files
   scanned) all FAIL. A write only in a comment and a write in a test file PASS. Every mutation was
   hash-checked to have changed its file.
2. **`scripts/run-stock-race-test.mjs`**. It starts a throwaway PostgreSQL container on a random
   local port, runs `stock-concurrency.vitest.test.ts`, and removes the container. It passes only
   with exactly 10 passed, 0 skipped and 0 failed. Branches witnessed: real tree → exit 0 (about
   5 s); lock disabled → exit 1 (8 failed); a skipped suite → exit 1; a wrong test count →
   exit 1; Docker unreachable → a named SKIP line, exit 0. No container was left behind by any arm.

### 13.5 Limits (said plainly)

1. **The static check works per file.** A listed file must call `lockProductStock(` at least once.
   It cannot tell that a second writing function in the same file forgot it, **unless** that
   function also adds a write site, which changes the count. The race test is the functional backstop.
2. **Where Docker is absent, the race test skips** (with a named line). It runs on this machine.
3. **Lock waits count toward a transaction's timeout** (Prisma default 5 s). 20 simultaneous sales
   for one product finished locally (load average ~2). A burst under production latency was **not
   measured**.
4. **A multi-product transaction can still deadlock against another one that locks products in a
   different order**, for example a bulk grid edit (which updates products in its own order) against
   an import chunk (which locks in id order). PostgreSQL detects this and cancels one transaction;
   the import then retries each product alone. This risk existed before AE.1 on the import's
   `UPDATE "Product"`.
5. `transferStock` is still two transactions (an OUT, then an IN). Each is locked, so no update is
   lost, but a crash between them leaves the transfer half done. Pre-existing, not changed.

### 13.6 Shipped (2026-09-16)

- Commits on `main`: `8b279db5f` (the fix), `bd3390ca3` (push checks), `ce04e1188` (docs). They were
  committed through a private index, so only AE files went in; other sessions' uncommitted work stayed out.
- **The first push was refused** by the profiles-ON ratchet. It flagged another session's uncommitted test
  file (`src/services/sync/data-validation.vitest.test.ts`) as failing to load. That file passed alone
  (3 of 3), and the ratchet passed on a kept rerun (743 files, none new or worse), so it was a one-off
  failure under machine load (load average 14). A normal retry passed every gate, including both
  new AE.1 checks. No gate was bypassed.
- **Railway:** the deploy for `ce04e1188` (`78bb60a3`) was superseded 3 minutes later by `adfbe113`, a
  deploy with no commit attached (an upload from the working tree by another session). It started after
  the push, from the tree that holds these commits, so it carries AE.1; that is inferred from timing,
  not read from the build log. It went live with SUCCESS: 452 migrations, none pending, health check passed.
- Boot errors seen are pre-existing (the same lines appear in the deploy before the push): Shopify,
  WooCommerce and Etsy configuration missing; `amazon-notifications-boot`, `fleet-workflow` and the
  stock-import stuck-job sweep refusing to run without a business profile.
- No stock, lock, deadlock or transaction-timeout errors in the first minutes after boot. Traffic in that
  window was small, so this is not a measurement under load.

**How to run the proof again:**

```
docker run -d --rm --name ae1-stock-pg -p 127.0.0.1:55498:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg17
cd apps/api && NEXUS_TEST_CONCURRENT_PG_URL=postgresql://postgres@127.0.0.1:55498/postgres \
  npx vitest run src/services/stock-concurrency.vitest.test.ts
docker stop ae1-stock-pg
```
