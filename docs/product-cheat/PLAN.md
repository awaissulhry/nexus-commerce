# The Product Sheet — THE PLAN

Date: 2026-09-22.
**Status: PLAN, FOR APPROVAL. Nothing is built. No code was changed to write this.**

This is the plan that follows from [RESEARCH.md](RESEARCH.md) in this folder.

**Read [Part 1](#part-1--four-corrections-to-the-research) first.** Four claims in the research
are out of date. I re-traced them in the code today, and they change what we should build. If I
had not checked, this plan would have told you to do three things that are wrong.

---

## Contents

| Part | What it is |
|---|---|
| [0](#part-0--how-to-read-this-plan) | How to read this plan. Conventions. |
| [1](#part-1--four-corrections-to-the-research) | 🔴 **Four corrections to the research.** Read first. |
| [2](#part-2--the-target-architecture) | The target. What we are building toward, and why. |
| [3](#part-3--the-five-rules-that-bind-every-step) | The five rules every step obeys. |
| [4](#part-4--phase-0--control) | **Phase 0 — Control.** Stop the forks. |
| [5](#part-5--phase-1--safety) | **Phase 1 — Safety.** Stop live damage. |
| [6](#part-6--phase-2--the-model) | **Phase 2 — The model.** Define "right". |
| [7](#part-7--phase-3--proof) | **Phase 3 — Proof.** Measure, then close the loop. |
| [8](#part-8--phase-4--the-ui-and-aaa) | **Phase 4 — UI and AAA.** A separate track. |
| [9](#part-9--the-decisions-i-need) | The decisions I need, with a default if you do not rule. |
| [10](#part-10--the-dependency-graph) | The dependency graph. What truly blocks what. |
| [11](#part-11--the-gate-ledger) | The gate ledger. How each rule stays true. |
| [12](#part-12--explicitly-out-of-scope) | Explicitly out of scope. |
| [13](#part-13--risks-and-what-would-invalidate-this-plan) | Risks, and what would invalidate this plan. |
| [14](#part-14--consistency-check) | Consistency check against the research. |
| [15](#part-15--scaling-to-thousands-of-products) | 🆕 🔴 **Scaling to thousands of products.** What breaks, and what to do about it. |

---

## Part 0 — How to read this plan

### Every step has the same eight fields

| Field | What it means |
|---|---|
| **Do** | The change, in one sentence. |
| **Where** | Exact `file:line`. Verified on 2026-09-22 unless marked otherwise. |
| **Why now** | What it unblocks, or what it stops. |
| **Approach** | The approach chosen, and **what was rejected and why**. |
| **Done when** | The acceptance test. A sentence you can pass or fail. |
| 🆕 **Cost when** | The numbers this must still hold at **10,000 products**. Added by [Part 15](#part-15--scaling-to-thousands-of-products). Only on steps whose cost grows with the catalog; the rest say `flat`. |
| **Gate** | What stops it regressing. A step with no gate is a step that comes undone. |
| **Rollback** | How to undo it. |

🔴 **Why `Cost when` exists.** The first draft of this plan had a gate on every rule and a number
on none. Three of its steps break somewhere around **500 products**, not thousands.

> **A rule with no gate stops being true. A budget with no number stops being affordable.**

### Confidence marks

| Mark | Meaning |
|---|---|
| 🟩 | **Verified in code today**, with `file:line`. |
| 🟦 | From the repo's own vendor-cited industry research of 2026-09-02. |
| 🟨 | My architectural judgement. A strong prior, not a citation. |
| ⬜ | **Not verified.** Stated as an assumption. Treat as unknown. |

### The one rule for the whole plan

> **No step ships without its gate.** A rule with no gate is a rule that quietly stops being true.
> This programme has already paid for that lesson twice.

---

## Part 1 — Four corrections to the research

I re-traced the research's load-bearing claims in the source today. **Four are out of date.**
Each one changes a step.

---

### 🟠 Correction 1 — `PATCH /channel-pricing` is no longer a "fake success"

**The research says** (Part 9, decision 2, and earlier files): the route gives a fake success and
should be retired.

🟩 **That is out of date.** The route was rebuilt under MX.1. It now:

- Routes through `writeChannelPrices` — `product-channel-data.routes.ts:187`
- Writes `price` **and** `priceOverride` **and** `followMasterPrice = false`
- Raises a `PriceChangeEvent`, an override audit row, and one `PRICE_UPDATE` enqueue
- 🟩 **Returns real per-row outcomes.** Its own comment records the fix: *"this route used to
  answer the request count after `Promise.allSettled`"* — `product-channel-data.routes.ts:164-167`

**What is still true:** it does **not** pass `expectedVersion`, and it still uses `aliasKey: ''`.

**What this changes.** ❌ Do not retire the route. ✅ Fix the one thing wrong with it.

---

### 🟠 Correction 2 — the "one price writer" already exists. The defect is narrower and better.

**The research says:** route the sheet's price cell through `matrix-write.service.ts`.

🟩 **The real door is one level down.** `matrix-write.service.ts` does not write prices itself —
it calls `writeChannelPrices` (`matrix-write.service.ts:200,210`). The single writer is:

> **`apps/api/src/services/pim/channel-price-write.service.ts` → `writeChannelPrices()`**

🟩 **And here is the actual defect**, `channel-price-write.service.ts:42` and `:91`:

```ts
expectedVersion?: number            // ← OPTIONAL
...
if (t.expectedVersion !== undefined && t.expectedVersion !== l.version) { … conflict … }
```

🔴 **A caller that omits `expectedVersion` silently skips the version check.** The Matrix passes
it. `PATCH /channel-pricing` does not. Nothing warns.

🟩 **And the sheet is worse than either — it does not use the price service at all.** A price
typed in the sheet goes `bulk-edit.service.ts:835` → `channelValueMutation` → a raw column write
on `ChannelListing.price`. So it skips the `PriceChangeEvent`, the audit row, **the
`PRICE_UPDATE` enqueue** and the sale-window handling. It is guarded on **`Product.version`**,
while the Matrix guards **`ChannelListing.version`** — 🔴 **two different version columns guarding
one field.**

**What this changes, and it is a better plan:** the fix is not "route through the Matrix". It is
**make `expectedVersion` required in the type, and make the sheet use the price door.** The
compiler then finds every offender. See [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler).

---

### 🟠 Correction 3 — "Unpublish (recommended) is an irreversible delete" is the wrong diagnosis

**The research says** (Part 5, danger 1): it is an irreversible delete, so rename it to Delist.

🟩 **The service already does the right thing.** `channel-delist.service.ts:5-12`:

> *"Dispatcher for OutboundSyncQueue rows whose syncType is UNPUBLISH_LISTING (**pause the offer,
> keep the listing record**) or DELETE_LISTING… **Amazon and eBay unpublish refuse until a
> reversible implementation exists.** … **No adapter may perform a more destructive action than
> the caller requested.**"*

🟩 And it refuses, rather than escalating — `:119` `AMAZON_UNPUBLISH_NOT_IMPLEMENTED`, `:181`
`EBAY_UNPUBLISH_NOT_IMPLEMENTED`.

🟩 **The API default is also safe:** `products-catalog.routes.ts:1708` —
`const channelAction = body.channelAction ?? 'none'`.

🔴 **So the real danger is different, and worse in a quieter way:**

> You pick "Unpublish", the product is hard-deleted locally, and the adapter **refuses**.
> **The listing stays live on Amazon or eBay, and you no longer have a product row to manage it
> with.** An orphaned live listing.

And because of the FK cascade bug, the queue row is deleted before the refusal is even recorded.

**What this changes.** ❌ Renaming a label fixes nothing — it would hide that removal only works
destructively. ✅ The fix is **implement reversible unpublish**, and until it exists, **refuse the
local delete too** rather than orphaning a live listing. See [Step 1.2](#step-12--never-orphan-a-live-listing).

⬜ **Not verified:** which UI string says "(recommended)" and where its default sits. The audit
recorded it; I did not find it today. **Find it before Step 1.2 ships.**

---

### 🟠 Correction 4 — the master model is wired; only its data and one line are wrong

**The research says** the master model "does almost no work".

🟩 **It is more wired than that.** `sheet-columns.service.ts:1176-1180` calls
`familySheetFields()` for the master scope, and `family-sheet-schema.ts:38,64` reads `required`
per attribute. The Prisma model (`schema.prisma:700-751`) is Akeneo-shaped, with additive family
inheritance and per-channel `channels[]`.

🔴 **Two things break it, and both are small:**
1. `required` is set on **0 of 198** attributes. *(Data, not code.)*
2. 🟩 `family-sheet-schema.ts:38` — `const required = a.required && (a.channels?.length ?? 0) === 0`
   — **treats "required on Amazon" as "not required at all".**

**What this changes.** The model work is **smaller** than the research implies. It is a data pass
plus one line. But that line is load-bearing: without it, per-channel requirements can never work.

---

### What the corrections do to the plan

| Research said | This plan says |
|---|---|
| Retire `PATCH /channel-pricing` | ❌ **No.** It was fixed. Give it `expectedVersion` |
| Route the sheet's price through `matrix-write.service.ts` | ❌ **No.** Route it through `writeChannelPrices`, and make `expectedVersion` **required** so the compiler finds every caller |
| Rename "Unpublish (recommended)" to "Delist" | ❌ **No.** Implement reversible unpublish; refuse the local delete until it exists |
| The master model "does almost no work" | 🟡 It is wired. **One line and a data pass** |

🟢 **Everything else in the research holds.** The phases, the seven layers, the three rules, the
four measurements, the ordering and the AAA definition are all unchanged.

---

## Part 2 — The target architecture

### 2.1 — What we are building toward

🟦🟨 The seven layers from the research, with the **owner** each one gets in our codebase. Naming
one owner per layer is what stops a fork.

| # | Layer | The single owner | State today |
|---|---|---|---|
| 1 | **Golden record** | `ProductFamily` + `CustomAttribute` + `FamilyAttribute` | 🟡 Wired, no data |
| 2 | **Requirements** | `FamilyAttribute.required` + `.channels[]`, **plus** the channel spec's caps and closed lists | 🔴 0 of 198 set; per-channel discarded |
| 3 | **Completeness** | `ReadinessIndex` + `readiness-index.service.ts` | 🔴 0 rows on production |
| 4 | **Mapping** | `resolve-batch.service.ts` (one resolver) | 🟢 Good. Rules cover one coordinate |
| 5 | **Governance** | `ProductWorkflow` + the audit rows | 🔴 Table exists, flow does not |
| 6 | **Syndication** | `prepare-dispatch.ts` + `sync-mapping-merge.ts` | 🟡 Publishes. No preview, diff or undo |
| 7 | **Reconciliation** | 🆕 `ChannelDrift` — does not exist | 🔴 Nothing |

### 2.2 — The one idea

> 🔴 **The channel never decides what is in your catalog. It only decides what it will accept.**

Layer 1 flows down. Layer 2 sets limits. **The arrow never points back up.**

### 2.3 — The target for each of your six concerns

| Concern | Target state |
|---|---|
| Category-supported attributes | The **family** decides the columns. The **channel** decides required, caps and closed lists, **per coordinate** |
| Shared scope with one channel connected | Shared shows the family's own fields. A channel attribute appears on its channel, with a read-only *"also required by"* marker on Shared |
| Publishes correctly | One resolver, one payload builder proven by a parity gate, a publish preview, and a `ChannelDrift` read-back |
| Variations and dedicated pages | One store and one writer for a child's axis value, proven by a gate |
| Price in the sheet | One door: `writeChannelPrices`, `expectedVersion` **required**, every surface a client of it |
| Translated dropdowns | The value is a **code**. Labels are a projection from the market's own schema. Enforced by a gate |

---

## Part 3 — The five rules that bind every step

Every step in this plan obeys all five. A step that cannot is a step that is wrong.

| # | Rule | What it forbids |
|---|---|---|
| **R1** | **One field. One writer. One store.** The sheet is another *host* for a value, never another *owner* | A second write path for a field that already has one |
| **R2** | **Put the rule in the engine. Prove it with a gate** | A rule that lives only in a document, a comment, or a reviewer's memory |
| **R3** | **The channel never decides what is in your catalog** | Columns, families or requirements derived from channel state |
| **R4** | **An absent thing is stated, never hidden** | A disappearing column, a silent skip, a blank where a reason belongs |
| **R5** | **Make the wrong thing impossible to compile** | An optional field that must not be optional; a string where a type belongs |

🟨 **R5 is the one this codebase most needs.** Every defect in the research is a *duplicate*, and
duplicates survive because nothing refuses them. `expectedVersion?: number` is the clearest case:
a question mark is why two pages can race on your money field.

---

## Part 4 — PHASE 0 — CONTROL

**Goal: one lane at a time, each ending in a commit. Nothing else in this plan is safe until
this holds.**

🔴 **Why this is first.** Every architectural defect found is a *duplicate*, not a missing
feature: two price writers, two payload builders, three axis stores, two metafield homes, eleven
tabs, two readiness vocabularies. **Forks are what parallel lanes on a shared tree with nothing
committed produce.** Fixing forks while the fork factory runs is not a plan.

---

### Step 0.1 — Settle the untracked production migrations

- **Do** — Account for the 11 migrations applied to production but untracked in the repo, and
  commit them. Name an owner for the 5 that have none.
- **Where** — `packages/database/prisma/migrations/`; the `lx4` and `lx5` folders must be
  committed before any push, or the deploy reports applied-but-missing drift.
- **Why now** — 🔴 Five schema changes are live on production and nobody can name who applied
  them. That is a control problem, and every other defect is downstream of it.
- **Approach** — Reconcile `_prisma_migrations` on production against the repo folder, one row at
  a time. **Rejected:** a `migrate resolve` sweep — it would mark them applied without anyone
  reading what they did, which is the same failure again.
- **Done when** — `prisma migrate status` against production reports no drift, and every
  migration folder is in git with a named owner in its commit message.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — 🟩 `scripts/check-schema-drift.mjs` already exists and is already in the push hook
  (`.githooks/pre-push:39`). Confirm it covers applied-but-missing, not only missing-but-applied.
- **Rollback** — None needed; this adds files and changes no schema.

---

### Step 0.2 — One lane at a time

- **Do** — Stop parallel lanes on the shared tree. Run one lane. Commit. Then the next.
- **Why now** — See above. 🟨 This is a process change, and it is the highest-value item in the
  whole plan.
- **Approach** — Sequential lanes on `main`, each ending in a commit. **Rejected:** worktrees per
  lane — the tree is not the problem, the *missing commit* is; worktrees would hide the forks for
  longer.
- **Done when** — The claims ledger has no two lanes holding the same file in the same window.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — 🟨 Process, not a script. The commit history is the evidence.
- **Rollback** — n/a.

---

### Step 0.3 — Rotate the exposed database credential

- **Do** — Rotate the Neon credential exposed in the root `.env` and in git history.
- **Why now** — 🔴 It is a live secret in history. The research notes that a *failed connection*
  is the only reason the repo-root test hazard has not already hit production.
- **Approach** — Rotate, then fix `apps/api/src/env.ts` so a repo-root vitest run cannot resolve
  `DATABASE_URL` to production. **Recommended form:** remove `DATABASE_URL` from the root `.env`
  entirely. **Rejected:** relying on developer discipline about the working directory — the
  research records that one wrong CWD already broke 43 files.
- **Done when** — The old credential is dead, and a `vitest` run started from the repo root
  cannot reach production.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A refusal in `env.ts` when the resolved host does not match the expected environment.
- **Rollback** — Keep the old credential alive for one hour, then revoke.

---

## Part 5 — PHASE 1 — SAFETY

**Goal: nothing can destroy or orphan a live listing.**

🔴 **These are the only items in this plan that touch something you cannot get back. Nothing
jumps ahead of them, and they do not get bundled with other work.**

---

### Step 1.1 — Fix the delist FK cascade

- **Do** — Stop a hard delete from destroying its own delist queue rows in the same transaction.
- **Where** — `apps/api/src/routes/products-catalog.routes.ts:1769-1795` (the cascade),
  `apps/api/src/services/channel-delist.service.ts`, and the `OutboundSyncQueue` foreign key in
  `packages/database/prisma/migrations/`.
- **Why now** — 🔴 **No delist ever runs, anywhere, on any channel.** Every other removal fix is
  decoration until this is true. Steps 1.2 and 1.3 depend on it.
- **Approach** — The queue row must **outlive** the product. Drop the cascade on the queue's
  product foreign key and make it nullable — 🟩 the service already expects this:
  *"productId (may be null after hard-delete cascade — that's OK)"*
  (`channel-delist.service.ts:17`). So the service was written for the correct model and the
  schema disagrees with it.
  **Rejected:** deleting the product only after the queue drains — it makes a user-facing delete
  wait on an external API, and a channel outage would block deletes indefinitely.
- **Done when** — Hard-deleting a product with a live listing leaves a queue row that runs, and
  the listing is removed from the channel.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A test that hard-deletes a product with a listing and asserts the queue row **still
  exists** after the transaction commits. 🟩 `delist-cascade.local.vitest.test.ts` already exists
  — extend it rather than writing a second.
- **Rollback** — Revert the migration; the FK returns to cascade.

---

### Step 1.2 — Never orphan a live listing

- **Do** — While reversible unpublish does not exist, **refuse the local hard delete** for a
  product with a live listing, and say why.
- **Where** — `products-catalog.routes.ts:1705-1795`; refusal copy alongside
  `delist-error-codes.ts`.
- **Why now** — 🔴 See [Correction 3](#correction-3--unpublish-recommended-is-an-irreversible-delete-is-the-wrong-diagnosis).
  Today: you pick "Unpublish", the product is deleted locally, the adapter **refuses**, and the
  listing **stays live on the channel with no product row to manage it**.
- **Approach** — R4, *an absent thing is stated*. The refusal names the channel, the market, the
  listing id, and the two things you can do: delist for real (destructive, confirmed) or
  disconnect the listing first.
  **Rejected (a):** silently escalating unpublish to delete — 🟩 the service explicitly forbids
  it: *"No adapter may perform a more destructive action than the caller requested."*
  **Rejected (b):** allowing the delete and logging a warning — that is today's behaviour with
  extra text.
- **Done when** — Hard-deleting a product with a live Amazon or eBay listing is refused with a
  sentence naming the coordinate, and no orphan can be created.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A test asserting the refusal, **and** an inverse test asserting a product with no
  live listing still deletes. *(R2: the gate must be able to fail in both directions.)*
- **Rollback** — Remove the refusal branch.
- ⬜ **First, find the UI string.** The audit recorded "Unpublish (recommended)"; I did not locate
  it today. Find it and fix its default in the same change.

---

### Step 1.3 — Implement reversible unpublish

- **Do** — Make `UNPUBLISH_LISTING` actually work on Amazon and eBay, so removal has a
  non-destructive option.
- **Where** — `channel-delist.service.ts:119` (Amazon), `:181` (eBay).
- **Why now** — It is the *real* fix behind Correction 3, and it is what lets Step 1.2's refusal
  be lifted.
- **Approach** — 🟨 Amazon: set the offer quantity to zero / close the offer through the Listings
  API, keeping the SKU, the ASIN link and the reviews. eBay: end the fixed-price item but keep the
  listing record and its identifiers, so relist is possible.
  **Rejected:** deleting and re-creating — 🟨 on Amazon that throws away the ASIN association and
  the review history. This is the single most expensive irreversible act in the product.
- **Done when** — An unpublish on Amazon and on eBay returns `success` and the listing stops
  selling **without losing its identifiers**, proven by a read-back (needs [Step 3.1](#step-31--open-the-two-shut-doors)).
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — 🟩 The two `*_UNPUBLISH_NOT_IMPLEMENTED` refusals are removed **only** when a test
  proves the reversible path. Invert the existing refusal tests with the fix.
- **Rollback** — Restore the refusals. The service is designed to refuse safely.
- 🔴 **Blocked on Step 3.1** for its proof, but the code can be written before.

---

### Step 1.4 — Gate the Amazon delete

- **Do** — Make `deleteListingsItem` honour the master kill switch, and stop `products.edit` from
  deleting a live listing.
- **Where** — `apps/api/src/clients/amazon-sp-api.client.ts:1150`.
- **Why now** — 🔴 Anyone who can edit a product can delete a live listing.
- **Approach** — A distinct permission (`listings.delete`), plus the kill switch checked **inside**
  the client, not at the caller.
  **Rejected:** checking at each caller — R2. A rule at the caller is a rule that the next caller
  forgets. 🟩 There is already a `amazon-sp-api.publish-gate.vitest.test.ts`, so the gate pattern
  exists here; extend it.
- **Done when** — A delete without `listings.delete`, or with the kill switch on, is refused
  inside the client.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — Extend `amazon-sp-api.publish-gate.vitest.test.ts` with a delete arm.
- **Rollback** — Remove the permission check.

---

### Step 1.5 — Make the sheet's price cell read-only, today

- **Do** — Turn off editing on the eBay sheet price column, **with a stated reason**, until
  [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler) lands.
- **Where** — 🟩 `apps/api/src/services/pim/channel-specs/ebay.ts:104`.
- **Why now** — 🔴 The sheet's price write skips the price service entirely (Correction 2): no
  `PRICE_UPDATE` enqueue, no audit row, no `PriceChangeEvent`, and a version check on the wrong
  column. This is live.
- **Approach** — 🟩 The field spec already carries both `editable: boolean` and
  `readOnlyReason?: string` (`channel-specs/types.ts:99-100`, `ebay.ts:235-258`). So R4 is
  satisfied by the existing contract:

  ```ts
  listing('price', 'Prezzo', 'Listing price', {
    kind: 'number', requirement: 'required',
    editable: false,
    readOnlyReason: 'Price is edited on the Matrix, which is the one writer for this field.',
    channelStore: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' },
  }),
  ```

  **Rejected (a):** hiding the column — R4; a missing column is a worse lie than a locked one.
  **Rejected (b):** leaving it writable and fixing it properly first — Step 2.2 is a week away and
  this is one line.
- **Done when** — The eBay price cell shows its value, refuses the edit, and states why.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — 🟩 `scripts/check-silent-disabled.mjs` is already in the push hook
  (`.githooks/pre-push:207`) — it exists precisely to stop a disabled control with no reason.
- **Rollback** — Restore `editable: true`. Reverted by Step 2.2 anyway.

---

## Part 6 — PHASE 2 — THE MODEL

**Goal: the system has a definition of "right", and one owner per field.**

🔴 **Nothing in Phase 3 or Phase 4 means anything without this.** Completeness counts
requirements. Fidelity compares against requirements. Both are empty today.

---

### Step 2.1 — Requirements become real

- **Do** — (a) Stop discarding per-channel requirements. (b) Mark the required attributes.
- **Where** —
  - 🟩 (a) `apps/api/src/services/pim/family-sheet-schema.ts:38`
  - (b) A data pass over `FamilyAttribute` (198 definitions, 0 required).
- **Why now** — 🔴 "Ready 100%" is true for everything and means nothing. This one line is why
  Akeneo's per-channel requirement idea cannot work here.
- **Approach** — Today:

  ```ts
  const required = a.required && (a.channels?.length ?? 0) === 0   // ← "required on Amazon" = not required
  ```

  🟩 The schema's own documented semantics (`schema.prisma:706-714`) are:
  *`required=true, channels=[]` → required everywhere; `required=true, channels=['AMAZON']` →
  required on Amazon only.* **The code contradicts the schema comment.** The master sheet must
  carry **both** facts: required-everywhere, and required-on-these-channels.

  **Chosen:** return a requirement *object* per attribute — `{ everywhere: boolean; channels:
  string[] }` — and let the column decide how to show it. This is what makes the *"also required
  by Amazon · DE"* marker in Part 2.3 possible, and it is the scalable shape.
  **Rejected (a):** flipping the line to `a.required` alone — it would mark Amazon-only
  attributes required on Shopify. A different wrong answer.
  **Rejected (b):** a per-coordinate boolean computed at read time for the active scope — it
  cannot answer "who else needs this?", which is the question the Shared scope exists to answer.
- **Done when** — An attribute marked required on Amazon shows as required when the Amazon
  coordinate is in view, and as *"required by Amazon"* on Shared — and **never** as plain
  "required" on a channel that does not want it.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A test per branch: everywhere-required, channel-required-and-in-scope,
  channel-required-and-out-of-scope, not-required. 🔴 **All four arms**, or the fixture pins the
  dimension that would have failed.
- **Rollback** — Revert the line; the data pass is additive and harmless on its own.
- 🔴 **Decision needed:** *which* attributes are required. See [D-A](#part-9--the-decisions-i-need).

---

### Step 2.2 — One price door, enforced by the compiler

- **Do** — Make `expectedVersion` **required** on `PriceWriteTarget`, and make every price write
  go through `writeChannelPrices`.
- **Where** —
  - 🟩 `apps/api/src/services/pim/channel-price-write.service.ts:42` — `expectedVersion?: number`
  - 🟩 `apps/api/src/routes/product-channel-data.routes.ts:187` — the caller that omits it
  - 🟩 `apps/api/src/services/products/bulk-edit.service.ts:835` — the sheet's price path, which
    bypasses the service entirely
- **Why now** — 🔴 Three surfaces, one column, one version check between them. And the sheet's
  path skips the enqueue, so **a price typed in the sheet may never reach the channel at all.**
- **Approach** — **R5: make the wrong thing impossible to compile.**

  1. Change `expectedVersion?: number` → `expectedVersion: number`.
  2. **The compiler now lists every caller that omits it.** That list *is* the audit — no grep,
     no set claim that goes stale.
  3. Fix each: `PATCH /channel-pricing` reads the listing version it already fetches; the sheet's
     price path stops using `channelValueMutation` for `price` and calls `writeChannelPrices`.
  4. `matrix-write.service.ts` needs no change. 🟩 It already passes it.

  **Rejected (a):** "route the sheet through `matrix-write.service.ts`" (the research's wording) —
  that is a *page's* service, not the field's door. It would make the sheet depend on the Matrix's
  coordinate model, and it leaves `PATCH /channel-pricing` unguarded.
  **Rejected (b):** a runtime check that throws when `expectedVersion` is missing — it finds the
  fourth caller in production instead of at compile time.
  **Rejected (c):** defaulting `expectedVersion` to the row's current version — 🔴 that is a
  compare-and-set that always succeeds. It looks safe and is not.
- **Done when** — `writeChannelPrices` cannot be called without a version; every price write
  raises a `PriceChangeEvent`, an audit row and a `PRICE_UPDATE` enqueue; and two concurrent
  edits produce one `applied` and one `conflict`.
- 🆕 **Cost when** — a **5,000-row** price edit completes in one call with per-row outcomes.
  🔴 See [15.5](#155--expectedversion-keep-it-required-add-three-things): this step needs internal
  chunking, a bulk re-read-and-retry contract, and a check that it cannot collide with
  [Step 2.7](#step-27--run-the-readiness-reconcile-on-production).
- **Gate** — (1) The type itself. (2) A concurrency test asserting the second write returns
  `conflict`. 🔴 **Run it on `concurrent-database.ts`, never on PGlite** — PGlite is one
  connection and a race test passes there regardless.
- **Rollback** — Make the field optional again. One character.
- 🟢 **This also un-does [Step 1.5](#step-15--make-the-sheets-price-cell-read-only-today):** once
  the sheet uses the door, restore `editable: true`.

---

### Step 2.3 — The language reaches the publish

- **Do** — Carry the coordinate's language into both publish callers.
- **Where** — 🟩 `sync-mapping-merge.ts:73` and `prepare-dispatch.ts:17` both call `resolveBatch`
  without a locale; 🟩 `resolve-batch.service.ts:163` accepts one and `:184-185` falls back to the
  market's first language.
- **Why now** — 🔴 On Amazon·IT with German selected, the sheet shows German and the push sends
  Italian.
- **Approach** — Short term: pass the locale through. It is two lines.
  🟨 Long term, and this is the scalable shape: **locale is a property of the value, not a dial.**
  In Akeneo an attribute is *localizable*, so there is no "current language" a publisher can
  forget to pass. **This plan does the two lines now and records the target**, because the class
  of bug only closes when the dial cannot be forgotten.
  **Rejected:** making the language dial move you to that language's market (option (c) in the
  research) — a market with two languages, like Belgium, then has no way to reach its second.
- **Done when** — M3 shows the payload carries the language the sheet was showing.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A test that resolves a coordinate at a non-default locale and asserts the payload's
  language. 🔴 **Per coordinate** — `color.scope` is `per_variant` on IT and `global` on DE, so
  one market's pass does not generalise.
- **Rollback** — Drop the argument; the fallback resumes.
- 🔴 **Decision needed:** [D-B](#part-9--the-decisions-i-need). And it resolves against
  `Marketplace.languages`, which is itself unsettled — [D-C](#part-9--the-decisions-i-need).

---

### Step 2.4 — Shared means shared

- **Do** — Stop channel attributes appearing on the Shared scope because of unrelated listing rows.
- **Where** — 🟩 `sheet-columns.service.ts:1150-1161`:

  ```ts
  prisma.channelListing.groupBy({ by: ['channel','marketplace'], _count: { _all: true } })
  //  ↑ no `where` clause at all
  ```

- **Why now** — 🔴 Your own words: *"a schema that changes when someone else sells something."*
- **Approach** — Two moves, in order.
  1. **Today, one line:** add `where: { productId: { in: familyIds } }` so the coordinate set is
     at least about *this product*. 🟢 This is the cheapest real improvement available anywhere in
     this plan.
  2. **Then, properly (R3):** the **family** decides Shared's columns. A channel attribute lives
     on its channel, and Shared carries a read-only *"also required by Amazon · DE"* marker, which
     [Step 2.1](#step-21--requirements-become-real)'s requirement object makes possible.

  **Rejected:** scoping columns by *connection* (your instinct, and better than today) — 🔴
  disconnecting a channel would delete columns from your catalog. Your data model would depend on
  an OAuth token's health. R3 forbids it.
- **Done when** — M4 counts zero columns on Shared whose only declaring coordinate is a channel
  this product is not on.
- 🆕 **MEASURED on the scale fixture, 2026-09-22** ([15.11 RESULT](#step-1511-result--the-scale-fixture-stands-up-and-the-first-thing-it-measured-was-step-24)):
  the un-narrowed `groupBy` is **6 ms at 3,000 listings** and **154 ms at 30,000** — ×26 for ×10
  rows. The same query **narrowed to a page stays at 4–5 ms at both sizes.** 🔴 At 10,000 products
  the whole cold column build is **148 ms**, and this one query is **154 ms of it**: the narrowing
  is not a stopgap, it is the entire cost. 🟠 The research's *"per-market column build 1.8–2.6 s
  cold"* ([15.12](#1512--what-the-research-dropped-and-this-plan-should-carry)) is **10× larger
  than anything measured here** — that number came from a market with cached channel specs, which
  the fixture does not have. Treat 148 ms as a floor, not a refutation.
- 🆕 **Cost when** — the `groupBy` time is **recorded before and after**. 🔴 This is the largest
  single query in the sheet read path and nobody has ever timed it. Without a before, a win and a
  regression look the same. See [15.4](#154--step-24-fix-the-line-and-measure-it) — the line as
  written above **does not compile on the channel scope**.
- **Gate** — A test asserting the Shared column set for a product with no Amazon listing contains
  no Amazon-only attribute, **with a positive control** — the same product *with* an Amazon
  listing must show the marker. 🔴 A run that finds nothing must be shown capable of finding
  something.
- **Rollback** — Remove the `where`; restore the union.
- ⚠️ **R4:** a column that vanishes is worse than one that states why. Ship the empty state with
  the narrowing, not after it.

---

### Step 2.5 — Factual values are codes

- **Do** — Enforce *"a factual attribute is a code with a localized label, never per-language free
  text"*, scoped to schema enums.
- **Where** — 🟩 The contract exists: `sheet-columns.service.ts:136` (`optionLabels`), threaded at
  `:444, :551, :711, :952`. 🟩 The ruling exists:
  `docs/2026-09-11-language-axis-design.md:85-86`. 🟩 The labels come free — the channel specs are
  built from the market's own schema (`sheet-columns.service.ts:249-250`).
- **Why now** — It is the cheapest item in the plan, and it removes a whole class of translation
  work permanently. **A code needs no translating.**
- **Approach** — Add the gate. The contract, the data and the ruling are already there; only
  enforcement is missing.
  **Rejected (a):** machine-translating labels — solving a problem that does not exist, with drift
  and review cost.
  **Rejected (b):** doing our own closed lists at the same time — 🔴 `FieldValueMap` is empty
  (which is why the variants preview shows raw `NERO`), and those need a label per language and an
  owner. **Schema enums first.**
- **Done when** — A factual attribute stored as per-language free text fails a gate, and picking
  a code on Amazon·DE shows the German label with your override still winning.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — 🆕 `scripts/check-factual-attributes.mjs`, in the push hook. 🔴 Its attribute list
  must be **derived from the schema**, never hand-written — a hand-written member list is a set
  claim and goes stale in hours.
- **Rollback** — Remove the gate. No data changes.

---

### Step 2.6 — One writer for a child's axis value

- **Do** — Name one authoritative store and writer for a child's size and colour; migrate the
  other two; delete them.
- **Where** — Three stores disagree today; the sheet writes one eBay never reads. Two children
  hold `XS` where they should hold `XXS`, giving 4 colliding variants.
- **Why now** — 🔴 It blocks variation fidelity everywhere, on every channel.
- **Approach** — R1, then R2: migrate, delete the losers, and add a gate that fails if a second
  writer appears.
  **Rejected:** picking a winner and leaving the other two in place — two stale stores remain as
  traps, and the next lane writes one of them.
- **Done when** — One store holds the value, the other two are gone, and the 4 colliding variants
  resolve to 2.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A gate asserting exactly one writer for the axis field. Same pattern as
  [Step 3.3](#step-33--a-parity-gate-between-the-payload-builders).
- **Rollback** — The migration is the risk; rehearse it before applying. 🔴 Rehearse first,
  `--apply` only when the group counts are identical.
- 🔴 **Decision needed:** [D-D](#part-9--the-decisions-i-need) — which store wins.

---

### Step 2.7 — Run the readiness reconcile on production

- **Do** — Run the one-shot reconcile so `ReadinessIndex` has rows.
- **Where** — 🟩 `apps/api/src/jobs/readiness-reconcile.job.ts`,
  `apps/api/src/services/pim/readiness-index.service.ts`.
- **Why now** — 🔴 Production has **0** rows. Every readiness, variation and completeness surface
  says "Not computed". The whole completeness UI in Phase 4 depends on it.
- **Approach** — Rehearse on a copy, then run per family root. **Do it after
  [Step 2.1](#step-21--requirements-become-real)**, so it computes against real requirements — a
  reconcile run against 0 required attributes would fill the table with meaningless 100%s and you
  would have to run it twice.
- **Done when** — `ReadinessIndex` has rows for every live coordinate, and a readiness chip shows
  a number that changes when a required field is emptied.
- 🆕 **Cost when** — the **nightly** run touches only changed families and finishes in under
  10 minutes at 10,000 products. The **one-shot backfill** is resumable and prints its cursor.
  🔴 **This step as written cannot pass at scale.** Measured in the code: **4.087 s per family**
  → 68 min at 1,000 families, **11.4 hours at 10,000**, and ~7.1 M rows. See
  [15.1](#151--readiness-reconcile-make-it-resumable-and-incremental-not-faster).
- 🆕 **MEASURED on the scale fixture, 2026-09-22** — **224 ms per family at 1,000 products, 495 ms
  at 10,000** (3 and 5 roots sampled), writing 25 index rows per family. Projected whole-catalogue:
  **≈16 minutes at 2,000 family roots.** 🔴 **This is a FLOOR and must not be read as a refutation
  of the 4.087 s.** The fixture carries three coordinates and **no cached Amazon spec** — its
  Amazon column build yields 3 columns, so the sweep has almost nothing to check there. The
  research's *"readiness cold start ~12 s after a restart"*
  ([15.12](#1512--what-the-research-dropped-and-this-plan-should-carry)) is carried here and is
  **not** reproduced by the fixture, which never restarts.
- **Gate** — A row-count check in the deploy checklist, plus the existing readiness tests.
- **Rollback** — Truncate the table and re-run; it is derived data.
- 🔴 **Needs your approval** — it is a production write. [D-E](#part-9--the-decisions-i-need).
- ⚠️ **Order matters:** 2.1 → 2.7. Not the reverse.

---

## Part 7 — PHASE 3 — PROOF

**Goal: turn every "it publishes correctly" claim into a number.**

---

### Step 3.1 — Open the two shut doors

- **Do** — Fix eBay credential decryption and the Amazon `invalid_grant`.
- **Why now** — 🔴 **No live test can run at all until this is done.** It blocks Steps 1.3, 3.2's
  live arms, 3.4 and 3.5.
- **Approach** — 🟩 A known adjacent trap: one scope off the eBay keyset kills the whole connect.
  Curl-probe the consent URL before assuming a code defect.
- **Done when** — One eBay call and one Amazon call succeed against a real account.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A connection health check that fails loudly rather than reading as a cold start. 🔴
  An API cold start reads as DOWN; the check must discriminate.
- **Rollback** — n/a.

---

### Step 3.2 — The four measurements

- **Do** — Run M1–M4.
- **Why now** — Each is cheap, and each changes what gets built. **They are the only honest input
  to the rest of the plan.**

| # | Measurement | Settles | Needs live access? |
|---|---|---|---|
| **M1** | Type a distinctive value into one Amazon·IT channel cell. Capture the payload. Is it there? | Whether an override truly reaches the channel. 🟩 The code says yes; **a trace is not an experiment** | No — capture the built payload |
| **M2** | One product, one coordinate. Dump the sheet's values, dump the payload, **diff and count** | 🔴 **The honest size of the whole fidelity gap, as a number to drive to zero** | No |
| **M3** | Set a coordinate to a non-default language. Which language is in the payload? | Confirms [Step 2.3](#step-23--the-language-reaches-the-publish) | No |
| **M4** | Open Shared on one product. Name the declaring coordinate for each column. Count the ones from a channel this product is not on | Confirms [Step 2.4](#step-24--shared-means-shared). The count is the size of the fix | No |

- **Approach — the four rules, which this programme paid for:**
  1. **A positive control.** A run that finds nothing must be shown capable of finding something.
  2. **Per coordinate.** A fixture pins a dimension, and the arm that would have failed is the one
     never run.
  3. **Write the prediction down first.** A read-back alone only confirms; a plausible wrong value
     passes unnoticed.
  4. **A claim must match its measurement.** A write's *response* is not what it *wrote*.
- **Done when** — Four numbers exist, each with its prediction recorded beforehand.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — M2's diff becomes a **recurring** check, not a one-off. That is what turns it into a
  number you can drive to zero.

---

### Step 3.3 — A parity gate between the payload builders

- **Do** — Assert that the two payload builders agree.
- **Where** — 🟩 `apps/api/src/services/amazon/mapping-payload.ts:20` and
  `apps/api/src/services/pim/mapping/prepare-dispatch.ts:26`. Same filter, no assertion.
- **Why now** — R2. 🟩 Two *column* builders already drifted once in this codebase and caused
  silent channel gaps. Two payload builders now exist with nothing asserting they agree.
- **Approach** — A gate that builds both from one fixture and diffs them.
  **Better, if it is affordable:** collapse them into one builder and keep the gate as the
  regression guard. 🟨 Two builders plus a gate is the *second*-best answer; one builder is the
  best. **Assess the collapse first; fall back to the gate.**
- **Done when** — A deliberate divergence in one builder fails the gate. 🔴 **Prove the gate can
  fail** — mutate one builder and watch it go red before trusting its green.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — Itself, in the push hook.
- **Rollback** — Remove the gate.

---

### Step 3.4 — The first live write and read-back

- **Do** — Make one live channel write and read it back.
- **Why now** — 🔴 **This has never been done, on any channel, ever.** It is the single claim the
  whole programme rests on.
- **Approach** — One field, one coordinate, a fixture product. 🔴 Probes stay inside the fixture
  family — a probe string once sat on a live ASIN for eight minutes.
  🔴 **A transport failure is an UNKNOWN outcome, not a failure.** A `000` response may still
  commit; re-read after a delay before concluding anything.
- **Done when** — A value written from the sheet is read back from the channel and matches.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — Becomes the seed of [Step 3.5](#step-35--reconciliation-the-missing-layer).
- **Rollback** — Restore the fixture's previous value, **by value, not by row**.
- 🔴 **Blocked on [Step 3.1](#step-31--open-the-two-shut-doors).**

---

### Step 3.5 — Reconciliation, the missing layer

- **Do** — Build layer 7. Read back what the channel holds; store the drift.
- **Why now** — 🟦 The standard closes this loop: Salsify and Syndigo show per-channel status and
  rejection reasons; Feedonomics and Channable push channel errors onto the offending row;
  Amazon's own API returns an `issues[]` array per submission that mature tools persist.
  **Without it your fidelity promise can only ever be half-proven.**
- **Approach** — 🆕 A `ChannelDrift` table, shaped like `ReadinessIndex`: one row per coordinate,
  computed, with `lastCheckedAt`, `field`, `ours`, `theirs`. 🟨 Reusing the shape means the
  existing readiness surfaces, filters and chips can show drift with no new vocabulary.
  **Rejected (a):** drift as a log — you cannot filter a sheet by a log.
  **Rejected (b):** computing drift on read — it would put an external API call inside a page load.
- **Done when** — A coordinate whose channel value differs from ours produces a drift row, and the
  sheet can filter to it.
- 🆕 **Cost when** — a drift refresh **never delays a publish job**, and a full catalog refresh
  fits inside the channel's daily API budget. 🔴 **The column list above (`field`, `ours`,
  `theirs`) contradicts the "one row per coordinate" sentence** — a `field` column means one row
  per coordinate **per field**, which is `ReadinessIndex` × ~150. See
  [15.2](#152--channeldrift-one-row-per-coordinate-and-never-a-full-sweep).
- **Gate** — A test with a seeded difference, plus a positive control with no difference.
- **Rollback** — Drop the table; nothing else depends on it yet.
- 🔴 **Blocked on [3.1](#step-31--open-the-two-shut-doors) and [3.4](#step-34--the-first-live-write-and-read-back).**

---

### Step 3.6 — Validate paste and fill

- **Do** — Give the paste and fill-drag path a validity verdict.
- **Why now** — 🟦 The industry research ranked this **#1** three weeks ago, and the reason still
  holds: **a shipped capability actively creates bad data today.** A corner-drag commits values
  you could not type, across a hundred rows.
- **Approach** — The validator exists as display-only rules; the write gate has verdicts
  (`no-column | grid-data | self-inflicted | unchanged`) with **no concept of validity**. Add
  validity to the gate, in the engine — R2 — not at each call site.
- **Done when** — A paste of a value over a cap or off a closed list is refused, with a per-row
  reason.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — A test per refusal reason, plus a positive control that a *valid* paste still applies.
- **Rollback** — Remove the verdict.

---

## Part 8 — PHASE 4 — THE UI AND AAA

**A separate track, as you decided. It may run in parallel with Phases 1–3 for research and
design, but it may not implement until the gate decision and Phase 2 land.**

---

### Step 4.0 — Measure the AAA baseline before researching

- **Do** — Raise `check-contrast.mjs` to 7:1, derive its token list from source, run it, count the
  failures.
- **Where** — 🟩 `scripts/check-contrast.mjs:31` (`const AA = 4.5`), `:37-56` (the hand-written
  colour map), `:87` (the console line).
- **Why now** — 🔴 **One day.** Without a number, the UI research designs blind. And "AAA" with no
  measured baseline is the same *kind* of claim as "it publishes correctly" — believed, never
  tested. You already have one of those.
- **Approach** — Change the threshold **and** derive the token list. 🔴 Doing only the threshold
  leaves a hand-written member list, which is a set claim that goes stale — the gate would go green
  on a palette it cannot see.
- **Done when** — A number exists. **Expect red. That red is the baseline.**
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — Itself, once green. Into the push hook at [Step 4.2](#step-42--the-gates-come-back).
- **Rollback** — Revert the threshold.

---

### Step 4.1 — Rule on the gates, before any UI implementation

- **Do** — Decide whether the four removed browser gates return to `.githooks/pre-push`.
- **Where** — 🟩 `.githooks/pre-push` — **0 matches** for `editor-open`, `census`, `grid-chrome`
  and `check-editor`. Removed 16–17 September.
- **Why now** — 🔴 Every item in this track changes cell editors, and the `editor-open` gate is
  the one you ordered after the "editor does not open" P0. **Decide before implementing.**
- 🔴 **Decision needed:** [D-F](#part-9--the-decisions-i-need).
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))

---

### Step 4.2 — The gates come back

- **Do** — Restore the four gates and add the 7:1 contrast gate to the hook.
- **Approach** — 🔴 **A ratchet, not a big bang.** For each rule: write the gate → run it → it
  goes red → record the number → fix to green → **the gate stays in the hook forever.**
  **Rejected:** converting the UI in one pass and adding gates afterwards. 🟨 A big-bang UI
  rewrite with no gates is exactly the condition that produced the last P0.
- **Done when** — Five gates are in the hook and green.
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))

---

### Step 4.3 — The visible changes

In this order. Cheapest-unblocking first.

| # | Change | Note |
|---|---|---|
| 1 | **The EditorShell** — one editor, one keyboard model | 🟩 Designed and approved at `docs/2026-09-04-cell-editor-shell-design.md`; **step 1 never started**. Biggest item, and it fixes two complaints at once. Today **six** files say "Enter saves" in six ways |
| 2 | **Consolidation** — scope dropdown, language dropdown, filters folded by default | 🔴 The language dropdown **must stay multi-select** — `locales.includes(...)` means more than one can be active. Also fixes a measured clip: 9 chips take 1345.4px of 1200px usable at 1280 |
| 3 | **Bullets in one cell** | ⚠️ **Add** one cell beside the ten. **Do not replace them** — import/export, the per-slot cap, formula reference values and the column width map all key off the slot names |
| 4 | **Completeness column + hover card** | 🔴 **Blocked on [2.1](#step-21--requirements-become-real) and [2.7](#step-27--run-the-readiness-reconcile-on-production).** Design now, build after. The card is a **design-system gap** — `HoverCard` takes strings only and cannot hold a link. Add it to the DS, export it, document it, record it in `.claude/DS-GAPS.md` |
| 5 | **AAA sweep to 7:1** | Last — everything above changes the pairs being measured |

**Four rules for the whole track, or it forks the codebase again:**
1. All new or changed platform UI lives in `apps/web/src/design-system`. Read `DESIGN.md` and the
   component source first. Compose existing primitives.
2. A missing control is a **design-system gap**, not a local build.
3. **Declare pixels before landing them.** Every one of these moves geometry.
4. 🔴 **No new tabs.** There are eleven. Each is a place the truth can fork — that is how the
   price bug happened.

- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))

### What AAA means, so it can be checked

| # | Claim | Measured by |
|---|---|---|
| 1 | **Contrast 7:1**, light and dark | `check-contrast.mjs` at 7:1, token list **derived from source**, in the hook |
| 2 | **One keyboard model**, identical on Master, Amazon and eBay | A gate |
| 3 | **Keyboard parity for every pointer action**, with a live announcement | 🟩 `OrderedList` already does this; new work matches |
| 4 | **No invented state** | Review + the control-census gate |

🔴 **Honest warning.** 🟨 WCAG AAA is not achievable everywhere, and the standard itself does not
recommend it as a blanket policy. **The defensible version of your ask is: AAA contrast on the
studio's own surfaces, plus the three items above, each behind a gate.** "AAA everywhere" is not a
claim this or any product can hold.

---

## Part 9 — The decisions I need

**Each has a default.** If you do not rule, the default is what I will do — so you only need to
read the ones you disagree with.

| # | Decision | Options | My recommendation | Default if you say nothing |
|---|---|---|---|---|
| **D-A** | **Which attributes are required?** (198 definitions, 0 required) | A list, per family, per channel | Start with what a channel *refuses a publish* for. That set is already knowable from the schemas | I derive the list from the channel schemas and bring it back **for approval before applying** |
| **D-B** | **What does the language dial mean at publish?** | (a) sheet only · (b) the language of the content sent to this market · (c) it moves you to that market | ✅ **(b).** The only option that serves a two-language market like Belgium, and it makes the fix mechanical | **(b)** |
| **D-C** | **`Marketplace.languages` for global markets** | (a) primary only · (b) every published locale | (b) — Shopify publishes 5 locales while its row carries 1 | **(a)**, because it needs no production change; revisit if M3 shows it matters |
| **D-D** | **Which store wins for a child's size and colour?** | Three exist | The one eBay reads, since a store nothing reads is not a source of truth | ⏸️ **I stop and ask.** A wrong pick here writes bad data to a live family |
| **D-E** | **Approve the readiness reconcile on production?** | Yes / no | ✅ Yes, **after** [Step 2.1](#step-21--requirements-become-real) | ⏸️ **I stop and ask.** It is a production write |
| **D-F** | **Do the four browser gates come back?** | Yes / no | ✅ **Yes, and decide before the UI track implements anything** | **Yes** |
| **D-G** | **Collapse the two payload builders, or gate them?** | Collapse / gate | Collapse if affordable; gate either way | **Gate first**, then assess the collapse |
| **D-H** | **Shared scope: the one-line fix now, or wait for the full family-first change?** | Now / wait | ✅ **Now.** One `where` clause, immediate improvement, no lock-in | **Now** |

**Two carried blockers, unchanged from the research:**

| # | What | Why it blocks |
|---|---|---|
| **A2** | PES.5-ii, the alias split | Alias creation throws. Alias fidelity cannot be tested |
| **F13** | Designate a development Shopify store | Nothing Shopify can be verified without one |

---

## Part 10 — The dependency graph

**What truly blocks what.** Everything not drawn here can run in parallel.

```
  0.1 migrations ─┐
  0.2 one lane   ─┼──► everything (process, not code)
  0.3 credential ─┘

  1.1 delist cascade ──► 1.2 never orphan ──► 1.3 reversible unpublish
                                                      │
  1.4 gate the delete        (independent)            │
  1.5 price read-only ──────────────────┐             │
                                        ▼             │
  2.1 requirements ──► 2.7 reconcile    2.2 one price door
        │                   │                 (un-does 1.5)
        │                   │
        │                   ▼
        └──────────► 4.3(4) completeness column
  2.3 language ─────► 3.2 M3
  2.4 shared ───────► 3.2 M4
  2.5 factual codes    (independent)
  2.6 axis writer      (independent, needs D-D)

  3.1 open the doors ──► 1.3 proof · 3.4 live write ──► 3.5 reconciliation
  3.3 parity gate      (independent)
  3.6 paste/fill       (independent)

  4.0 AAA baseline     (independent — start today, in parallel)
  4.1 gate ruling ────► 4.2 gates back ────► 4.3 visible changes
```

**Three things you can start today, in parallel, with no dependencies:**
- 🟢 **Step 4.0** — the AAA baseline. One day, and the UI track needs it.
- 🟢 **Step 1.5** — the price cell read-only. One line.
- 🟢 **Step 2.4 move 1** — the `where` clause on the Shared scope. One line.

---

## Part 11 — The gate ledger

**R2: put the rule in the engine, prove it with a gate.** Every rule this plan creates gets a row
here. A rule with no row is a rule that will quietly stop being true.

| Rule | Gate | New? | In the hook? |
|---|---|---|---|
| A delist queue row outlives its product | Extend `delist-cascade.local.vitest.test.ts` | Extend | Test suite |
| No orphaned live listing | Refusal test + inverse test | 🆕 | Test suite |
| The Amazon delete honours the kill switch | Extend `amazon-sp-api.publish-gate.vitest.test.ts` | Extend | Test suite |
| A disabled control states its reason | 🟩 `scripts/check-silent-disabled.mjs` | Exists | 🟢 Yes |
| **No price write without a version** | **The type itself** (`expectedVersion: number`) + a concurrency test on `concurrent-database.ts` | 🆕 | 🟢 Compiler |
| Per-channel requirements are not flattened | Four-arm test | 🆕 | Test suite |
| The publish resolves in the sheet's language | Per-coordinate test | 🆕 | Test suite |
| Shared shows no unrelated channel attribute | Test + positive control | 🆕 | Test suite |
| A factual attribute is a code | 🆕 `scripts/check-factual-attributes.mjs`, list **derived from schema** | 🆕 | Add |
| One writer for a child's axis value | 🆕 writer-count gate | 🆕 | Add |
| The two payload builders agree | 🆕 parity gate | 🆕 | Add |
| Paste and fill cannot write an invalid value | Per-reason tests + positive control | 🆕 | Test suite |
| Contrast is 7:1, from a derived token list | 🟩 `scripts/check-contrast.mjs`, raised | Raise | 🔴 **Add — 0 matches today** |
| The cell editor opens | `editor-open` | Restore | 🔴 **Removed 09-16/17** |
| Grid chrome holds | `grid-chrome` | Restore | 🔴 **Removed** |
| The control census holds | `census` | Restore | 🔴 **Removed** |
| Migrations do not drift | 🟩 `scripts/check-schema-drift.mjs` | Exists | 🟢 Yes |

🔴 **Four gates are missing from the hook today, and three of them were deliberately removed last
week.** That is the single clearest measure of whether this plan is being followed.

---

## Part 12 — Explicitly out of scope

Named so nobody quietly adds them.

| Out of scope | Why |
|---|---|
| **Any redesign of the sheet** | 🟦 The shape is right and the industry comparison confirms it. **This is repair and ordering** |
| **A twelfth tab** | Eleven already. Each is a place the truth can fork |
| **Making the sheet "smarter and more dynamic"** | 🟨 Least effort comes from **fewer** paths. One resolver, one writer per field, one contract per page |
| **A writable price column in the sheet** | Until [2.2](#step-22--one-price-door-enforced-by-the-compiler) lands. Then it is trivial |
| **The completeness column** | Until [2.1](#step-21--requirements-become-real) and [2.7](#step-27--run-the-readiness-reconcile-on-production) land. Otherwise it reads "Not computed" on every row |
| **Replacing the ten bullet columns** | Four systems key off the slot names. **Add** one beside them |
| **Scoping columns by connection** | 🔴 Disconnecting a channel would delete columns from your catalog |
| **Our own closed lists (`FieldValueMap`)** | 🟩 Empty today. Needs a label per language and an owner. **Schema enums first** |
| **Etsy and WooCommerce publish** | Never examined. Out of scope until they are |
| **Presence waves 4–5** | Not approved, and blocked behind Phase 1 |
| **The 694 unchecked plan items** | Unknown, not done. They are a separate audit, not this plan |

---

## Part 13 — Risks, and what would invalidate this plan

### 13.1 — What would invalidate a step

| If this turns out to be true | This step changes |
|---|---|
| **M1 shows an override does NOT reach the payload** | [2.2](#step-22--one-price-door-enforced-by-the-compiler) grows: it becomes a store migration, not a type change. 🔴 **My Correction 2 is a code trace, not an experiment** |
| **M4 shows Shared is already narrow** | [2.4](#step-24--shared-means-shared) shrinks to documentation |
| **M2's diff is near zero** | Phase 3 shrinks a lot; the fidelity gap was smaller than feared |
| **M2's diff is large** | 🔴 Mapping rule coverage becomes the biggest item in the programme. Today rules exist for **Amazon IT/DE OUTERWEAR only** |
| **The credentials cannot be fixed** | [1.3](#step-13--implement-reversible-unpublish), [3.4](#step-34--the-first-live-write-and-read-back) and [3.5](#step-35--reconciliation-the-missing-layer) all stall. **This is the single biggest schedule risk** |

### 13.2 — Standing risks

| Risk | Mitigation |
|---|---|
| 🔴 **Data is too thin to prove anything.** 90% of listings never synced; 976 of 977 coordinates miss product data; German content does not exist | Measure on the fixture family. Do not generalise from it — state the coordinate every number came from |
| 🔴 **A document can be confidently wrong.** Four claims in the research were out of date after **one day** | Every step names `file:line`. Re-read the line before acting on the sentence |
| 🔴 **A fixture pins a dimension** | Run per coordinate. `color.scope` is `per_variant` on IT and `global` on DE |
| 🔴 **A gate's green can be empty** | Every gate must be shown able to fail — mutate the thing and watch it go red |
| 🔴 **A test run from the repo root hits production** | [Step 0.3](#step-03--rotate-the-exposed-database-credential) |
| 🟨 **This plan is itself a document** | Its weakest parts are named in 13.1. Treat 🟨 and ⬜ marks as hypotheses |

---

## Part 14 — Consistency check

**Checked against `RESEARCH.md` in this folder, and against
`docs/product-sheet/RESEARCH-2026-09-21-RECOMPILED.md`.**

### 14.1 — Where this plan deliberately differs from the research

**Four places, all from [Part 1](#part-1--four-corrections-to-the-research). All verified today.**

| # | Research | This plan | Verified at |
|---|---|---|---|
| 1 | Retire `PATCH /channel-pricing` | Keep it; give it `expectedVersion` | `product-channel-data.routes.ts:164-187` |
| 2 | Route the sheet's price through `matrix-write.service.ts` | Route through `writeChannelPrices`; make the field required | `channel-price-write.service.ts:42,91`; `matrix-write.service.ts:200,210` |
| 3 | Rename "Unpublish (recommended)" | Implement reversible unpublish; refuse the orphaning delete | `channel-delist.service.ts:5-12,119,181`; `products-catalog.routes.ts:1708` |
| 4 | The master model "does almost no work" | It is wired; one line and a data pass | `sheet-columns.service.ts:1176-1180`; `family-sheet-schema.ts:38` |

### 14.2 — Where this plan agrees, and carries the research unchanged

✅ The seven layers · the three rules (here extended to five) · the phase order
(control → safety → model → proof → UI) · the four measurements and their four rules · the AAA
definition and its honest warning · the "what not to do" list · every item in
[Part 12](#part-12--explicitly-out-of-scope) · the eight places we are ahead of the market.

### 14.3 — Internal consistency

| Check | Result |
|---|---|
| Does any step contradict R1–R5? | No. Each names the rule it serves |
| Does any step depend on a later step? | No. [Part 10](#part-10--the-dependency-graph) is acyclic; the only reverse edge is 2.2 un-doing 1.5, which is intended and stated in both |
| Does any rule lack a gate? | No. [Part 11](#part-11--the-gate-ledger) has a row per rule |
| Does any step lack a rollback? | Only the process steps (0.2) and the credential fix (3.1), where none applies |
| Is "one price writer" stated consistently? | Yes — it is `writeChannelPrices` everywhere in this plan. 🔴 The research says `matrix-write.service.ts`; Correction 2 supersedes it |
| Is the completeness column blocked consistently? | Yes — in 4.3, in Part 10, and in Part 12 |
| Is the price cell's read-only state reconciled? | Yes — 1.5 sets it, 2.2 restores it, both say so |
| 🆕 Does every step whose cost grows with the catalog carry a `Cost when`? | Yes — 2.2, 2.4, 2.7 and 3.5. [Part 15](#part-15--scaling-to-thousands-of-products) sets the numbers |
| 🆕 Does Part 15 contradict any step? | It **amends** six (0.2, 1.2, 2.1/2.6, 2.2, 2.4, 2.7, 3.2, 3.5) and one decision (D-G). Each amendment is named in the step and in Part 15. 🔴 [15.4](#154--step-24-fix-the-line-and-measure-it) reports that Step 2.4's line **does not compile as written** |

### 14.4 — The honest holes in this plan

1. ⬜ **The "Unpublish (recommended)" UI string was not located.** Find it before Step 1.2.
2. ⬜ **Amazon's and eBay's reversible-unpublish mechanics are 🟨 judgement**, not verified against
   their API docs. Verify before Step 1.3.
3. 🔴 **Nothing was run.** Every claim is read from source. The four measurements exist precisely
   because a trace is not an experiment.
4. **Effort is not estimated in days.** Sizes are relative. 🟨 I do not have the team's throughput,
   and a made-up number would be worse than none.
5. **694 plan items remain unchecked.** Out of scope here, and still unknown.

---

## Part 15 — Scaling to thousands of products

Added 2026-09-22, second pass, at the Owner's request: *"flag anything that might restrict scaling
to thousands of products, or what might really not be the best approach."*

**Every finding below was read in this working tree on 2026-09-22, at the `file:line` named.**
🔴 **Nothing was run. No job was timed by me.** The 4.087 s figure is the codebase's own recorded
measurement, not mine.

---

### 15.0 — The headline

> **The plan is good on correctness and silent on cost.**
> Not one of its original ~25 `Done when` tests mentions a row count, a runtime or a memory figure.
> **Three steps break at around 500 products, not thousands.**

Four hard blockers, three future-scaling traps, three places the approach is not the best, and one
structural gap. Each has a recommendation.

---

### 15.A — A correction to my own first pass

I first wrote that the readiness cron's lock *"expires mid-run at ~440 families, so a second
instance can start."* 🟠 **That is wrong, and it changes the recommendation.**

🟩 `clustered.ts:84-89` — the lock key is **minute-granular** (`Math.floor(atMs / 60_000)`) and the
job is **daily**. The next tick is 24 h away with a different key, so the TTL expiring mid-run
doubles nothing today. The file says as much itself at `:53`.

🟩 **And in production the setting does nothing at all.** Business profiles are ON. `clustered.ts:141`
takes the workspace branch and **returns at `:160`, before `claimTick` at `:162` is ever reached.**
So `lockTtlMs: 30 * 60_000` on `readiness-reconcile.job.ts:32` is **dead code in production.**

🟩 **The real production lease is correct.** `workspace-lease.ts:26-38` claims a 90 s lease and
**renews it every 20 s**, releasing on exit. That is the right pattern, and it already exists here.

🔴 **But the same branch revealed something worse.** `clustered.ts:152-158` visits **every active
business profile, sequentially**, in pages of 50 — so a long job's runtime **multiplies by the
number of profiles.**

➡️ **The fix for 15.1 is therefore resumability, not a bigger lock.**

---

### 15.1 — Readiness reconcile: make it resumable and incremental, not faster

**Blocks [Step 2.7](#step-27--run-the-readiness-reconcile-on-production).**

🟩 The job records its own measurement — `readiness-reconcile.job.ts:26-31`:

> *"Measured: 714 rows in 4,087 ms for ONE family → ≈150 s for 37 root families"*

| Root families | Run time | `ReadinessIndex` rows |
|---|---|---|
| 37 (today) | 2.5 min | ~26,000 |
| 1,000 | **68 min** | ~714,000 |
| 10,000 | **11.4 hours** | **~7.1 million** |

🔴 **And multiply all of it by the number of active business profiles** (15.A).

Three more things in that file and its transaction:
- 🟩 Each family runs in a **Serializable** transaction, 60 s timeout, **2 retries** on `P2034`
  (`database-context.ts:71-77`). An hours-long sweep will collide with live editing.
- 🟩 The loop is **fully sequential**. No concurrency.
- 🟩 `failures` accumulates **every** error in memory and joins them into one string
  (`readiness-reconcile.job.ts:21`). A systemic failure at 10,000 products makes a giant message.

#### Recommendation — three changes, in order

| # | Change | Why |
|---|---|---|
| **a** | **Split the backfill off the cron.** Step 2.7's one-shot becomes a route or CLI with `--from <cursor> --limit <n>`, run in chunks you watch | A one-shot that takes 11 hours should never be a cron tick. You want to stop it, look, and resume |
| **b** | **Give the nightly job a wall-clock budget.** Stop after ~10 min, save the cursor, resume on the next tick | 🔴 Runtime becomes bounded **by design**. The 11-hour number then cannot happen at any product count |
| **c** | **Make the nightly job incremental.** Only families changed since the last run, or carrying a dirty marker | A full sweep every night is the thing that does not scale. A dirty-set sweep does |

🟩 Reuse `runWorkspaceTick`'s renewing-lease idea for the chunk runner — `workspace-lease.ts` is
already written and already correct. **Do not invent a second lease.**

- **Gate** — a test that the sweep resumes from its checkpoint after an interruption, plus a
  positive control that a fresh run with no checkpoint starts at the beginning.
- **Cost when** — nightly under 10 minutes at 10,000 products; backfill resumable.

---

### 15.2 — `ChannelDrift`: one row per coordinate, and never a full sweep

**Blocks [Step 3.5](#step-35--reconciliation-the-missing-layer).**

🔴 The step says *"one row per coordinate"* and then lists `lastCheckedAt`, `field`, `ours`,
`theirs`. **A `field` column means one row per coordinate PER FIELD.**

`ReadinessIndex` is already 714 rows for one family. Channel sheets carry **83–186 fields**
(`channel-specs/`). So drift is roughly `714 × 150` per family — at 1,000 families that is in the
**hundreds of millions of rows**.

🟩 And each check needs a channel API call. The outbound worker runs **`concurrency: 5` for all
channels together** (`bullmq-sync.worker.ts:36,75`).

#### Recommendation

**Shape — keep it at coordinate cardinality:**

```
ChannelDrift: <coordinate, as ReadinessIndex>
            + lastCheckedAt
            + driftCount
            + driftedFields   (capped JSON list, e.g. first 50)
```

Full per-field detail lives only for coordinates that **are** drifted, and is capped. The sheet
only needs *"does this coordinate have drift"* to filter, which `driftCount` answers.

**Scheduling — three triggers, no sweep:**

| # | Trigger | Why |
|---|---|---|
| 1 | **After a publish** | 🟩 You already have the job record. Highest value, and effectively free |
| 2 | **On demand**, when a coordinate is opened and its row is stale | Pays only for what someone looks at |
| 3 | **A low-rate background sample** for the rest | Gives the trend without the sweep |

**Rate — give drift its own queue.** 🔴 If drift shares the `concurrency: 5` lane, a drift sweep
**starves publishes** — and this programme has already recorded that *a starved route looks exactly
like a hung one*.

- **Gate** — a test asserting a drift refresh cannot enqueue onto the publish lane.
- **Cost when** — a drift refresh never delays a publish job; a full catalog refresh fits the
  channel's daily API budget.

---

### 15.3 — The column-set cache never lets go

**Affects every sheet read. Not mentioned anywhere in the original plan.**

🟩 `workspace-cache.ts:11-13` bounds the number of **workspace buckets** at 64, LRU. **Each
bucket's inner `Map` is unbounded.** 🟩 The 5-minute TTL is only checked **on read**
(`sheet-columns.service.ts:1144`); stale entries are never evicted.

🟩 The cache key (`sheet-columns.service.ts:1127-1141`) includes **`familyIds`** *and*
**`savedFields`**. So every product a user opens adds a full `SheetColumnSet` — 185+ columns of
field metadata — that **never leaves memory**.

🔴 Open 5,000 products in a day and the API holds 5,000 of them. Given the **16 September**
incident, where one upload pinned production at the V8 heap ceiling with no self-recovery, this is
the finding I would fix first among the cheap ones.

#### Recommendation

| # | Change |
|---|---|
| **a** | **Bound the inner Map.** The file already shows the idiom one level up — `if (this.buckets.size >= 64) this.buckets.delete(this.buckets.keys().next().value!)`. Do the same in `set()`, with a cap in the constructor. **≈3 lines** |
| **b** | **Expose the cache size on the existing metrics route.** Memory is the one thing you cannot gate, so you measure it instead |
| **c** | *Later:* move the column-set cache to **Redis**, so replicas share it. Today every replica builds its own copy of everything |

- **Gate** — a test that inserting cap + 1 entries leaves exactly cap.
- **Cost when** — at most N entries per workspace, whatever the product count.

---

### 15.4 — Step 2.4: fix the line, and measure it

**Amends [Step 2.4](#step-24--shared-means-shared).**

🟩 Verified: `sheet-columns.service.ts:1157` really has **no `where` clause** — a full-table
aggregate over `ChannelListing` on every cache miss. Narrowing it is right.

🔴 **But the plan's line does not compile on the channel scope.** `familyIds` is only set for the
master scope (`:1178`, `familySchema = scopeKind === 'master' && input.familyIds !== undefined`).
On a channel scope it is `undefined`.

#### Recommendation

1. **Pass `productIds` into `GetSheetColumnsInput` explicitly.** Do not reuse `familyIds`, which
   means something narrower. Add it to the cache key.
2. 🔴 **Record the query time before and after.** This is the biggest single query in the sheet
   read path and nobody has timed it. Without a before, a win and a regression look identical.
3. Keep the step's **move 2** (the family decides Shared's columns) as the real fix, and label the
   `where` clause a **stopgap** in the step text.

---

### 15.5 — `expectedVersion`: keep it required, add three things

**Amends [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler).**

Required is right. 🔴 **Do not soften it.** But the step has no bulk story.

| # | Add | Why |
|---|---|---|
| **a** | **Chunk inside `writeChannelPrices`** — e.g. 500 ids per `findMany` | 🟩 `channel-price-write.service.ts:47` is `where: { id: { in: ids } }` with **no limit**. 5,000 targets is one enormous IN list |
| **b** | **A bulk re-read-and-retry contract.** On `conflict`, re-read those rows once and resubmit automatically; show the user only what still conflicts | 🟩 The per-row `PriceWriteOutcome` shape already supports this. Without it, one stale version turns a 5,000-row edit into 5,000 red rows |
| **c** | ⬜ **Check whether the reconcile bumps `ChannelListing.version`** | If it does, [Step 2.7](#step-27--run-the-readiness-reconcile-on-production) and this step **fight**, and the plan must sequence them. **I did not verify this. Verify before 2.2 ships** |

🟩 The good news: `writeChannelPrices` is **already batch-shaped** (`targets: PriceWriteTarget[]`,
one `findMany`, per-row outcomes). The bones are right; only the limits are missing.

- **Cost when** — a 5,000-row price edit completes in one call with per-row outcomes.

---

### 15.6 — Steps 2.1 and 2.6: write the sweep helper once

**Amends [Step 2.1](#step-21--requirements-become-real) and
[Step 2.6](#step-26--one-writer-for-a-childs-axis-value).**

You now have **three** one-shot sweeps over every product: the requirements data pass (2.1), the
axis migration (2.6) and the readiness backfill (2.7). None names a runtime, a batch size or a
resume point.

#### Recommendation

**Write one resumable-sweep helper and use it for all three.** Its contract:

- cursor + saved checkpoint
- a wall-clock budget
- **a dry-run mode that prints counts**, with `--apply` only when the counts match

🟩 Step 2.6 already says *"rehearse first, `--apply` only when the group counts are identical"*.
🔴 **That is Rule R2 in this plan's own words: put the rule in the engine, not in one step's
footnote.** Three sweeps with the same hazard deserve one helper, not three notes.

---

### 15.7 — M2: split it into a gate and a sample

**Amends [Step 3.2](#step-32--the-four-measurements)**, which says *"M2's diff becomes a recurring
check."*

🔴 A full sheet-vs-payload diff per coordinate is right as a **one-off proof** and wrong as a
recurring job across thousands of products. It is the sweep problem again.

#### Recommendation — two cheap things instead of one expensive one

| # | What | Cost |
|---|---|---|
| 1 | **A gate on a fixture**, in the push hook | Fixed. Catches regressions |
| 2 | **A sampled production metric** — N random coordinates per day | Fixed. Gives the trend line |

Together these give what the step wants — *a number to drive to zero* — at a cost that **never
grows with the catalog**.

---

### 15.8 — "One lane at a time" needs an exit condition

**Amends [Step 0.2](#step-02--one-lane-at-a-time).**

It is the right call **now** — the forks are real and measured. But it is written as a standing
rule, and as a standing rule it permanently caps throughput. 🔴 It also contradicts this plan's own
**Rule R2**: gates exist precisely so that parallel work is safe.

#### Recommendation — write the exit into the step

> **Exit when the ledger is clean AND all gates in [Part 11](#part-11--the-gate-ledger) are in the
> push hook and green. Then return to short-lived branches, one commit each.**

**Keep one half permanently: nothing merges without its gate.** That is the durable rule. The
sequential-lane half is a repair measure, and a repair measure with no end date becomes the new
bottleneck.

---

### 15.9 — D-G should default to collapse, not to two builders

**Amends [D-G](#part-9--the-decisions-i-need)**, whose default is *"gate first, then assess the
collapse"*.

🔴 [Part 12](#part-12--explicitly-out-of-scope) forbids a twelfth tab because *"each is a place the
truth can fork"*. **A second payload builder is the same thing.** Defaulting to keep both
institutionalises the exact duplicate this plan exists to remove.

#### Recommendation

**Flip D-G's default to collapse.** Timebox the assessment as the first task of
[Step 3.3](#step-33--a-parity-gate-between-the-payload-builders). Fall back to two-plus-a-gate only
if the collapse is genuinely blocked — **and write down what blocked it.**

🟨 "Assess later" in this codebase has meant "never". That is how the price bug happened.

---

### 15.10 — Step 1.2 should return outcomes, not throw

**Amends [Step 1.2](#step-12--never-orphan-a-live-listing).**

Refusing is correct for one product. 🔴 At scale, a bulk delete of 500 hits the first live listing
and fails partway, with no record of what happened to the other 499.

#### Recommendation

🟩 Reuse the shape that already exists in `channel-price-write.service.ts:44-54`:

```
{ productId, outcome: 'deleted' | 'refused', reason, coordinate }
```

A bulk delete then returns *"487 deleted · 13 refused — live on Amazon·IT"*, with the coordinates
named. **That is Rule R4 (an absent thing is stated) working at scale**, instead of failing on
row 14.

---

### 15.11 — The structural gap: `Cost when`, and one scale fixture

This is the item I would push hardest.

**a. `Cost when` on every step.** Added to [Part 0](#part-0--how-to-read-this-plan) and to the four
steps whose cost grows with the catalog (2.2, 2.4, 2.7, 3.5). Every other step should say `flat`.

**b. Build one scale fixture.** A seeded workspace at **1,000 and 10,000 products**, which the
sweeps and the sheet read run against.

🔴 Without it, every `Cost when` is a guess — and this programme has already paid for guessing. It
is also the **positive control** this plan's own measurement rules demand: *a run that finds
nothing must be shown capable of finding something.* A sweep that passes on 37 families has not
been shown capable of failing.

---

### 15.12 — What the research dropped, and this plan should carry

The research recorded real numbers. **None of them reached the plan.** They belong in the
`Cost when` lines.

| Measured, in the research | Now in the plan? |
|---|---|
| Per-market column build **1.8–2.6 s cold** | 🔴 No |
| Mapping resolve **8 s timeout** while Redis connects | 🔴 No |
| Readiness cold start **~12 s** after a restart | 🔴 No |
| Payload ceiling **26.6 MB at 500 rows** | 🔴 No |
| **SSRM above 500 rows (D14.5) is NOT built** | 🔴 No |
| First paint **never measured** | 🔴 No |

➡️ **Carry all six into `Cost when` on the steps they touch, before Phase 2 starts.**

---

### 15.13 — Ranked: what to do, and when

| # | Item | Size | When |
|---|---|---|---|
| **1** | [15.3](#153--the-column-set-cache-never-lets-go) bound the cache | ~3 lines | 🔴 **Now.** Cheapest, and it is a live memory path |
| **2** | [15.11](#1511--the-structural-gap-cost-when-and-one-scale-fixture) the scale fixture | Small | **Before Phase 2.** Everything else is a guess without it |
| **3** | [15.1](#151--readiness-reconcile-make-it-resumable-and-incremental-not-faster) resumable sweep | Medium | **Before Step 2.7.** The step cannot pass otherwise |
| **4** | [15.6](#156--steps-21-and-26-write-the-sweep-helper-once) one sweep helper | Medium | Same work as 3. Do them together |
| **5** | [15.4](#154--step-24-fix-the-line-and-measure-it) fix and time the `where` | Small | **Before Step 2.4.** The line does not compile as written |
| **6** | [15.5](#155--expectedversion-keep-it-required-add-three-things) bulk price | Small | **Before Step 2.2 ships.** 5c is a check, not a build |
| **7** | [15.8](#158--one-lane-at-a-time-needs-an-exit-condition) · [15.9](#159--d-g-should-default-to-collapse-not-to-two-builders) · [15.10](#1510--step-12-should-return-outcomes-not-throw) | Rulings | **Now.** They are decisions, not code |
| **8** | [15.2](#152--channeldrift-one-row-per-coordinate-and-never-a-full-sweep) drift shape | Design | **Before any `ChannelDrift` schema is written** |
| **9** | [15.7](#157--m2-split-it-into-a-gate-and-a-sample) M2 split | Small | With Step 3.2 |

---

### 15.14 — The honest holes in this part

1. 🔴 **Nothing was run.** No job was timed by me. The 4.087 s is the codebase's own recorded
   number, and it is **one family on one machine on one day**.
2. ⬜ **Whether the reconcile bumps `ChannelListing.version`** — unverified, and 15.5c depends on it.
3. ⬜ **`ChannelDrift` has no schema yet**, so 15.2 argues with a sentence, not a design.
4. 🟠 **My own first pass got the cron lock wrong** (15.A). A document can be confidently wrong —
   including this one. **Check the line, not the sentence.**
5. **No product count was projected from real growth.** 1,000 and 10,000 are round numbers chosen
   to bracket the problem, not a forecast.

---

## The plan in one paragraph

**Stop the parallel lanes and commit what exists.** Then spend a day stopping live damage: fix the
delist cascade so removal works at all, refuse the delete that orphans a live listing, gate the
Amazon delete, and make the sheet's price cell read-only. Then spend a week on the model: make
per-channel requirements real, make `expectedVersion` **required** so the compiler finds every
price writer, pass the language to the publish, narrow the Shared scope, and run the readiness
reconcile. Then prove it: open the two shut doors, take the four measurements, gate the payload
builders, and make the first live write-and-read-back this programme has ever made — then build the
reconciliation layer that turns every claim into a number. **The UI runs as its own track**: start
the AAA baseline today, rule on the gates before implementing anything, and ratchet each rule in
behind a gate that can never come back out. **And give every step a number as well as a gate** —
[Part 15](#part-15--scaling-to-thousands-of-products) shows that three steps as first written break
at around 500 products, so bound the cache, make the sweeps resumable, and build one scale fixture
before Phase 2 begins.

> **The sheet you built is the right sheet.
> What is missing is not features.
> It is a definition of "right", a single writer per field,
> and proof that what you see is what you send.**

---

## Your amendments

Write here. **Nothing in this plan is settled.**

Change a decision in [Part 9](#part-9--the-decisions-i-need) and the steps that depend on it change
with it — [Part 10](#part-10--the-dependency-graph) shows which.

<!-- Owner: add rulings, corrections and reordering below this line. -->

---

# AMENDMENTS — proposed, awaiting the Owner's ruling

<!-- Proposed by the implementing session. Each carries its measurement. -->

## A-1 — Step 0.1's premise is false. There are no untracked production migrations.

**Proposed 2026-09-22. Status: FOR APPROVAL.**

Step 0.1 says *"11 migrations are live on production and nobody can name who applied them"* and
*"the `lx4` and `lx5` folders must be committed before any push"*.

🟩 **Measured today against production, read-only.** Host confirmed as production first, not
assumed: Railway deploy log for `@nexus/api`, deployment `19ccdbb5`, 2026-09-21T23:28:31Z —
*"Datasource `db`: PostgreSQL database `neondb`, schema `public` at
`ep-purple-river-altf6t3y.c-3.eu-central-1.aws.neon.tech`"*. That is the exact host the probe
queried.

| Measurement | Result |
|---|---|
| Migration folders in the repo | **467** |
| `_prisma_migrations` rows on production | **469** |
| PENDING — folder in repo, not applied on prod | **0** |
| **APPLIED-BUT-MISSING — on prod, no folder in repo** | **0** |
| IN-PROGRESS | **0** |
| ROLLED BACK | **2** |
| `git status packages/database/prisma/` | **clean — nothing untracked** |

🟩 `lx4` and `lx5` are both present and tracked:
`packages/database/prisma/migrations/20260912_lx4_channel_listing_translations` and
`…/20260912_lx5_readiness_index`.

**The two rolled-back rows are both accounted for**, and each has a successful sibling row:

- `20260505_b1_fulfillment_spine` — failed 05-05T04:54Z, re-applied 05-05T05:10Z with
  `applied_steps_count = 1`. **Verified on production:** `Warehouse`, `StockMovement`, `Carrier`,
  `Shipment`, `Supplier`, `PurchaseOrder`, `WorkOrder`, `InboundShipment`, `Return`, `ReturnItem`
  and `ReplenishmentRule` all exist. Positive control `Product`/`ChannelListing` = present;
  negative control `ZZZ_DefinitelyNotATable` = absent, so the probe was capable of saying no.
- `20260813a_sqp3_rows_changed` — failed 08-13T21:50Z, resolved 08-13T21:55Z with
  `applied_steps_count = 0`, i.e. `migrate resolve --applied`. That is the sweep Step 0.1
  explicitly rejects — **but here it was honest.** The migration's own header records why
  (`…/20260813a_sqp3_rows_changed/migration.sql:5-8`: the column was applied by hand first, so the
  bare `ADD COLUMN` failed with 42701). **Verified on production:** `SqpReportRequest.rowsChanged`
  exists, type `integer`.

**469 − 467 = 2** — exactly the two failed attempts. The arithmetic closes with nothing left over.

➡️ **Proposed:** Step 0.1's reconciliation work is **already done**. Strike the "11 untracked
migrations / 5 with no owner" claim and the `lx4`/`lx5` sentence. Keep the step, reduced to its
gate — see [A-2](#a-2--step-01s-gate-does-not-exist-and-cannot-exist-where-the-plan-puts-it).

🔴 **This is the fifth plan claim found out of date, and the plan predicted exactly this**
(Part 13.2: *"a document can be confidently wrong"*).

---

## A-2 — Step 0.1's gate does not exist, and cannot exist where the plan puts it

**Proposed 2026-09-22. Status: ✅ APPROVED by the Owner and BUILT — see [A-2 result](#a-2-result--built-and-measured). This was the only part of Step 0.1 that was real work.**

Step 0.1's Gate says: *"🟩 `scripts/check-schema-drift.mjs` already exists and is already in the
push hook (`.githooks/pre-push:39`). Confirm it covers applied-but-missing, not only
missing-but-applied."* [Part 11](#part-11--the-gate-ledger) marks that row **🟢 Yes, in the hook**.

**Confirmed: it does not cover it, and nothing else does.** Three findings:

1. 🟩 **The path in the plan is wrong.** There is no `scripts/check-schema-drift.mjs`. The file is
   `packages/database/scripts/check-schema-drift.mjs`, which is what `.githooks/pre-push:39`
   actually runs.
2. 🟩 **It never opens a database.** Its own header states the design
   (`packages/database/scripts/check-schema-drift.mjs:4-7`): it parses `schema.prisma` for
   `model X` and scans migration `.sql` files for `CREATE TABLE "X"`. **Both inputs are files in
   the repo.** A migration applied to production with no folder here is invisible to it *by
   construction* — not a bug, and not fixable by extending it.
3. 🟩 **The one script that does open the database reports only one direction.**
   `scripts/check-migrations-state.mjs:57` computes `pending = localMigrations.filter(m =>
   !applied.has(m))` — repo-not-on-prod. It computes no set for prod-not-in-repo. It is also a
   one-shot diagnostic, in no hook.

🟩 **And nothing runs `prisma migrate status` anywhere in this repo.** The deploy path is
`packages/database/scripts/migrate-direct.mjs` → `prisma migrate deploy`, which applies pending
migrations and says nothing about extra ones.

> **So the applied-but-missing direction is unguarded at every point in the pipeline.**
> Today that is harmless, because A-1 measured it at zero. It is exactly the condition that
> produces "11 untracked migrations" with nobody to name.

### Why the pre-push hook is the wrong home, and this matters

A pre-push gate that detects applied-but-missing must query production, so it needs a production
`DATABASE_URL` on every developer's machine. 🔴 **[Step 0.3](#step-03--rotate-the-exposed-database-credential)
exists to take that variable away** — its recommended form is *"remove `DATABASE_URL` from the root
`.env` entirely."* **Putting this gate in the push hook and then doing Step 0.3 would break the
gate.** Two steps of this plan, one page apart, pulling opposite ways.

### Proposed instead

**Put the check in `migrate-direct.mjs`, immediately before `prisma migrate deploy`.**

| Why there | |
|---|---|
| The credential is legitimately present | It is the deploy's own environment. No developer machine needs prod access |
| It fires at the moment that matters | **A merge to main migrates production.** The check runs in that same breath |
| It survives Step 0.3 | 0.3 removes the credential from the repo root, not from Railway |
| It is ~15 lines | Query `_prisma_migrations`, diff against `readdirSync(migrations)`, refuse on a non-empty applied-but-missing set |

**Gate on the gate** (R2, and the plan's own rule *prove every gate can fail*): a test that seeds a
fake row into a throwaway `_prisma_migrations` and asserts the check refuses, **plus a positive
control** asserting a clean database passes. A green that has never been shown able to go red is
not evidence.

**Rollback** — delete the check; `migrate deploy` behaves as today.

**Cost when** — `flat`. One indexed query of a table with 469 rows, once per deploy.

➡️ **Ruling needed.** Two options:
- **(a)** Build it in `migrate-direct.mjs` now, as the true close of Step 0.1. *(Recommended.)*
- **(b)** Accept A-1's zero as sufficient, log the gap, and move to Step 0.3.

---

## A-3 — Step 0.3 is live and confirmed, and the credential is still in git history

**Proposed 2026-09-22. Status: MEASURED, no ruling needed — reported so the size is known.**

🟩 The production Neon password is readable in two places on this machine right now:
`.env:2` and `.claude/settings.local.json:31`. Both are gitignored today
(`.gitignore:25` and `.gitignore:84`).

🟩 **It is not in any tracked file at `HEAD`** — `git grep -l <password> HEAD` returns 0 files.
🔴 **It is in four commits of history**, the oldest from 2026-04-27:

| Commit | Date |
|---|---|
| `c3cdd9efe` | 2026-04-27 |
| `bda99343c` | 2026-05-02 |
| `2fb3cc1cb` | 2026-08-04 |
| `a31b2cebd` | 2026-08-29 — the commit that removed it |

🟩 The repo already knows the rotation is outstanding: `migrate-direct.mjs:25` refers to *"the
pending Neon password rotation"* as a live consideration.

**Rotation itself is the Owner's action** — it needs the Neon console. The code half of Step 0.3
(removing `DATABASE_URL` from the root `.env`, and a refusal in `apps/api/src/env.ts` when the
resolved host does not match the expected environment) can be built independently and is not
blocked.

---

## A-4 — 🔴 The migration history cannot rebuild a database from zero. This blocks Part 15.11.

**Found 2026-09-22 while exercising the Step 0.1 gate. Status: FOR APPROVAL — not fixed, not in scope of Phase 0.**

Proving the new gate hands off correctly meant running the real deploy path against a fresh local
database. It does hand off correctly. **But the deploy then fails**, and it fails for a reason that
has nothing to do with this plan:

```
Applying migration `20260502_phase_d3_cascade_categoryattrs_gtin`
Error: P3018 — Database error code: 42P01
ERROR: relation "BulkOperation" does not exist
```

**18 of 467 migrations apply. The 19th refuses.** A migration from 2026-05-02 references a table
that no earlier migration creates.

🟩 **Attribution established before reporting it** — the programme's own rule, *a coordinate match
is not an attribution*. The same fresh-database deploy was run a second time on another throwaway
database **with the new gate bypassed entirely** (`npx prisma migrate deploy` directly). Identical
result: same migration name, same `42P01`. **The new gate is not the cause.** Both throwaway
databases were dropped; `abm_gate*` count afterwards is 0.

### Why this matters, and it is not academic

Production is unaffected — it is already fully migrated, so `migrate deploy` applies zero
migrations and never reaches migration 19. This is invisible in normal operation, which is
precisely why it has survived.

🔴 **But [15.11](#1511--the-structural-gap-cost-when-and-one-scale-fixture) asks for one scale
fixture: "a seeded workspace at 1,000 and 10,000 products".** That requires standing a database
up from the migration history. **You cannot.** 15.11 is ranked **#2** in
[15.13](#1513--ranked-what-to-do-and-when) — *"Before Phase 2. Everything else is a guess without
it."* So the second-highest-ranked item in the plan is blocked by something the plan does not know
about.

It also means: no true shadow database, no clean CI database, no disaster rebuild, and no honest
integration environment. Every one of those has been quietly unavailable since 2026-05-02.

### Proposed

Not Phase 0 work, and not a quick fix — 467 migrations need replaying to find every break, not just
the first. Two options:

- **(a)** Add a step to Phase 0: replay from zero, record **every** failure (not only the first),
  and repair the history. Honest, and it unblocks 15.11 properly.
- **(b)** Accept that the history is not replayable, and build the scale fixture from a
  `pg_dump --schema-only` of production instead. Cheaper and unblocks 15.11 immediately, but the
  migration history stays permanently broken and the repo stops being the source of truth for the
  schema — which contradicts **R1** (one store).

🟨 **Recommendation: (a).** (b) puts the schema's source of truth in production, and this plan
exists to remove exactly that kind of second owner. But (a) is real work and it is the Owner's
call how much Phase 0 should carry.

⬜ **Not measured:** how many of the remaining 449 migrations also fail. Only the first break was
observed, because `migrate deploy` stops at it. **A count needs a replay that continues past a
failure, and nobody has one.**


---

## A-2 RESULT — built and measured

**2026-09-22. Option (a) ruled by the Owner. Step 0.1 now closes on all four fields.**

### What was built

| File | What |
|---|---|
| `packages/database/scripts/check-applied-but-missing.mjs` | 🆕 The gate. `classifyMigrations()` is a pure function so every branch is testable without a database; `checkAppliedButMissing()` wraps it with the query |
| `packages/database/scripts/migrate-direct.mjs:50-67` | 🆕 The gate runs immediately **before** `prisma migrate deploy`, on the same DIRECT url the migration uses |
| `packages/database/scripts/check-applied-but-missing.vitest.test.ts` | 🆕 10 arms, every one paired with a control |
| `packages/database/vitest.config.mts` + `package.json` | 🆕 Harness, following the `@nexus/shared` and `@nexus/events` precedent — not a new convention |
| `.githooks/pre-push` (after the column-drift check) | 🆕 Runs the gate's test suite, so the gate cannot rot between deploys |

### Done when — ✅ measured

**Production reports no drift, and every migration folder is in git.** A-1's table: 467 folders,
469 rows, **0** pending, **0** applied-but-missing, **0** untracked. Host proved from the Railway
deploy log before the query, not assumed.

### Gate — ✅ and it was proven able to fail

`npm run test --workspace=@nexus/database` → **10 passed**, run verbatim as the hook runs it.
Verified with `--reporter=verbose` that the four database-backed arms **actually ran** (13 ms,
10 ms, 6 ms, 1 ms) rather than silently skipping — *"could not measure" must not read as "measured
empty"*.

🔴 **Mutation test.** One line of the decision was replaced with `const appliedButMissing = []`.
Result: **3 of 10 arms went red**, including the database-backed refusal arm. The original was
restored and the suite returned to 10 passed. **The green is evidence.**

**End-to-end on the real deploy script**, against throwaway local databases:

| Arm | Result |
|---|---|
| Ghost row seeded, no folder | `❌ REFUSED … 20991231_hand_applied_ghost`, **exit 1**, and `prisma migrate deploy` was never invoked |
| Positive control — ghost removed | Gate passed, execution **continued** into Prisma, which confirmed the datasource and found 467 migrations |
| Empty database, no `_prisma_migrations` | `no-history` → passed, as designed for a first deploy |
| Unreachable database | `COULD NOT CHECK`, **exit 1** — never reported as "no drift" |

Both throwaway databases and the test schema were dropped; `abm_gate*` count afterwards is **0**.

### Cost when — `flat`

One query of a 469-row table, once per deploy. It does not grow with the catalog.

### Rollback

Delete the seven lines in `migrate-direct.mjs:50-67`; `migrate deploy` behaves exactly as before.
The script and its tests are additive and can stay.

### Ledger row for [Part 11](#part-11--the-gate-ledger)

| Rule | Gate | New? | In the hook? |
|---|---|---|---|
| **No migration is applied to a database without a folder in the repo** | 🆕 `packages/database/scripts/check-applied-but-missing.mjs`, at **deploy** in `migrate-direct.mjs`; its **test suite** in the push hook | 🆕 | 🟢 Deploy + hook |

🔴 **And correct the existing row.** *"Migrations do not drift · `check-schema-drift.mjs` · Exists ·
🟢 Yes"* is **too broad**. That script reads only repo files and covers one direction. It should
read *"A Prisma model has a CREATE TABLE in some migration"*, which is what it actually asserts.

---

## A-5 — Step 0.2 closed, with [15.8](#158--one-lane-at-a-time-needs-an-exit-condition)'s exit condition written into it

**2026-09-22. Status: DONE as far as this lane can take it. One thing is the Owner's.**

[15.13](#1513--ranked-what-to-do-and-when) ranks 15.8 as a **ruling to make now**, so it is applied
here rather than left as a note.

### Done when — measured, as a snapshot

Step 0.2's test is *"the claims ledger has no two lanes holding the same file in the same window."*

| Reading, 2026-09-22 ~01:45 | |
|---|---|
| Newest claim in `docs/pes-claims.md` before this lane | **2026-09-13** — nine days old |
| Peer sessions visible | **9**, every one reporting **idle** (one at a shell) |
| Two lanes on one file in this window | **No** |

🔴 **This is a reading, not a guarantee.** Nine idle sessions still exist and any of them can wake.
The condition holds *now*; it is not structurally enforced, which is exactly 15.8's point.

A claim row for this lane was added at the top of `docs/pes-claims.md`, per rule 7 of the PES.0
hub rulings, naming the session, the branch and every file held.

🔴 **Nine open sessions is the Owner's to act on, not this lane's.** Sessions are managed by the
Owner directly and no lane issues orders to another. This step therefore **reports** the number and
stops there.

### Gate — the exit condition, adopted verbatim from 15.8

Step 0.2 as written is a standing rule, and as a standing rule it permanently caps throughput and
contradicts **R2** — gates exist so that parallel work is safe. So the step now carries an end:

> **Exit when the claims ledger is clean AND every gate in [Part 11](#part-11--the-gate-ledger) is
> in the push hook and green. Then return to short-lived branches, one commit each.**
>
> **The half that is permanent: nothing merges without its gate.** The sequential-lane half is a
> repair measure, and a repair measure with no end date becomes the new bottleneck.

🟩 **The exit is not close.** [Part 11](#part-11--the-gate-ledger) lists **four** gates missing from
the hook, three of them deliberately removed on 16–17 September: `editor-open`, `census`,
`grid-chrome` and the 7:1 contrast gate. Re-checked today — `.githooks/pre-push` still has **0
matches** for all four. Until [Step 4.2](#step-42--the-gates-come-back) restores them, the exit
condition cannot be met, so one-lane-at-a-time stands.

### Rollback — n/a, it is a process rule.

---

## A-6 — Step 0.3: half of it is already done and now proven; the other half is yours

**2026-09-22. Status: PARTLY CLOSED. Two things need the Owner.**

### The `vitest`-from-the-repo-root half is already built — and this lane exercised it

Step 0.3's `Done when` has two clauses. The second — *"a `vitest` run started from the repo root
cannot reach production"* — **was already solved by R-VT-12 on 2026-09-13**
(`apps/api/src/lib/testing/database-target.ts`, wired into `apps/api/vitest.config.ts:36` and
`vitest.setup.ts`). The plan does not mention it.

🟩 **Not taken on trust — run today, in both directions.** *A restore must be exercised.*

| Arm | Result |
|---|---|
| `npx vitest run --root apps/api …` **from the repo root** | 🔴 **REFUSED** before any connection: *"this run would talk to `ep-purple-river-altf6t3y-pooler…neon.tech` (database `neondb`) — that is Neon PRODUCTION"*, naming the resolving file, the CWD, the reason, and the correct command |
| **Positive control:** the same command **from `apps/api`** | ✅ Passed, printing *host `127.0.0.1`, database `nexus_development` — pinned … regardless of CWD* |

**So clause 2 is DONE and now has a witness.** Strike it from the step.

### 🔴 The step's Gate contradicts a deliberate prior ruling

Step 0.3's Gate is *"a refusal in `env.ts` when the resolved host does not match the expected
environment."*

🟩 R-VT-12 considered exactly that and **deliberately declined it**, in writing
(`database-target.ts:29-31`):

> *"It does **not** weaken `apps/api/src/env.ts`. That file decides the database for the running
> API `:8091`, **which other sessions are using**; the guard is scoped to the vitest setup."*

A refusal inside `env.ts` fires for **every** process that imports it — the running API, every
cron, every worker — not only tests. **Nine peer sessions are open on this machine right now**
(A-5). Putting the refusal in `env.ts` risks stopping the API they are using, to fix a hazard that
is already fixed at the boundary where it actually occurred.

➡️ **Proposed:** replace Step 0.3's Gate with *"the R-VT-12 guard, exercised in both directions"* —
which is the gate that exists, works, and was measured above.

### 🔴 "Remove `DATABASE_URL` from the root `.env`" is much larger than the step thinks

The step calls this its **recommended form**. Measured today:

| | |
|---|---|
| Files under `scripts/` + `packages/database/scripts/` | **578** |
| Of those, files that load the **repo-root** `.env` | **267** |
| Of those, files that also read `DATABASE_URL` | 🔴 **146** |

Positive control: `scripts/check-migrations-state.mjs` — a script whose whole purpose is querying
production — matches the pattern, so the count is measuring the right thing.

**146 operational scripts would stop working**, including the migration diagnostics used to measure
[A-1](#a-1--step-01s-premise-is-false-there-are-no-untracked-production-migrations). Many of them
query production *on purpose*; that is their job.

➡️ **Proposed:** do **not** remove the variable. Rotate the credential, and keep the refusal at the
boundary where a wrong target is actually dangerous — which R-VT-12 already does. Removing a
variable 146 scripts depend on trades one measured hazard for 146 unmeasured ones.

### What still needs the Owner

1. 🔴 **Rotate the Neon credential.** It needs the Neon console, so this lane cannot do it. It is
   live, and [A-3](#a-3--step-03-is-live-and-confirmed-and-the-credential-is-still-in-git-history)
   shows it in four commits of history, oldest 2026-04-27. `migrate-direct.mjs:25` already calls
   the rotation "pending".
2. **Ruling on the two proposals above** — the Gate, and whether the root `DATABASE_URL` stays.

**Until the rotation happens, Step 0.3 cannot close**, and [Part 10](#part-10--the-dependency-graph)
puts Phase 0 ahead of everything. 🟨 Phase 1 is safety work and does not depend on the credential,
so this lane can proceed there while the rotation is arranged — but that is the Owner's call, since
the plan's own ordering says Phase 0 first.

---

## OWNER RULINGS — 2026-09-22

| # | Question | Ruling |
|---|---|---|
| **R-1** | Wait for the credential rotation, or start Phase 1? | ✅ **Start Phase 1 now.** Step 0.3 stays open on the rotation. Phase 1 does not depend on it |
| **R-2** | [A-6](#a-6--step-03-half-of-it-is-already-done-and-now-proven-the-other-half-is-yours)'s two corrections to Step 0.3 | ✅ **Both accepted.** Step 0.3's Gate becomes *"the R-VT-12 guard, exercised in both directions"*. The root `.env` **keeps** `DATABASE_URL`; the 146 scripts that read it are not broken. The rotation still happens |
| **R-3** | [A-4](#a-4----the-migration-history-cannot-rebuild-a-database-from-zero-this-blocks-part-1511) — repair the history, or dump from production? | ✅ **Repair the history.** Option (a). The repo stays the one source of truth for the schema (**R1**) |

### R-3 becomes a step, scheduled where it is needed

🔴 **New Step 0.4 — repair the migration history so it replays from zero.**

- **Do** — Replay all 467 migrations against an empty database, recording **every** failure, not
  only the first, and repair the history until a from-zero replay succeeds.
- **Why now** — [15.11](#1511--the-structural-gap-cost-when-and-one-scale-fixture)'s scale fixture
  is ranked **#2** in [15.13](#1513--ranked-what-to-do-and-when) — *"Before Phase 2. Everything
  else is a guess without it."* It cannot be built until a database can be stood up from the
  history. Also unblocks a real shadow database, a clean CI database and a rebuild.
- **Approach** — `migrate deploy` stops at the first failure, so it cannot count the others. The
  replay must apply each migration **individually** and continue past a failure to produce the full
  list. **Rejected:** fixing the first break and re-running — that is 449 more round trips and no
  idea of the size before starting.
- **Done when** — an empty database reaches 467 of 467 applied, in one run.
- **Cost when** — `flat`. It is a one-off, and it runs against a throwaway local database.
- **Gate** — 🆕 the from-zero replay itself, as a script. Prove it can fail by removing one
  `CREATE TABLE` and watching it go red.
- **Rollback** — repairs are additive migration edits; the current history already does not replay,
  so there is no worse state to return to.
- ⚠️ **Order:** after Phase 1, before Phase 2. 🔴 **It is a migration change, so per the Owner's
  standing rule it gets its OWN branch and its OWN merge — it never rides with code.**
- ⬜ **Size unknown.** Only the first break has been observed. The count is the first thing the
  replay produces.

### Step 0.3 as amended by R-2

- **Done when** — the old credential is dead. *(The repo-root `vitest` clause is struck: already
  done by R-VT-12 and exercised in both directions on 2026-09-22.)*
- 🆕 **Cost when** — `flat`. Its cost does not grow with the catalogue. ([15.11a](#1511--the-structural-gap-cost-when-and-one-scale-fixture))
- **Gate** — the R-VT-12 guard (`apps/api/src/lib/testing/database-target.ts`), exercised in both
  directions: a repo-root run refuses and names the production host; an `apps/api` run passes and
  names `127.0.0.1` / `nexus_development`.
- **Status** — ⏸️ **OPEN, on the Owner.** Everything this lane can do is done.

---

# PHASE 1 — amendments

## A-7 — Step 1.1's premise is false. The delist queue rows were never destroyed.

**2026-09-22. Status: FOR APPROVAL. Step 1.1 needs no migration and no code change.**

Step 1.1 says: *"Stop a hard delete from destroying its own delist queue rows in the same
transaction"*, and *"🔴 **No delist ever runs, anywhere, on any channel.** Every other removal fix
is decoration until this is true."* Its Approach is to *"drop the cascade on the queue's product
foreign key and make it nullable."*

🟩 **Both halves of that fix are already in place, and the diagnosis is wrong.**

### 1. `productId` is already nullable

`packages/database/prisma/schema.prisma`, `model OutboundSyncQueue`:

```prisma
productId String?
product   Product? @relation(fields: [productId], references: [id], onDelete: Cascade)
```

### 2. The delist rows never carry the foreign key in the first place

🟩 `apps/api/src/services/outbound-enqueue.ts:116` — inside `enqueueDelistCascade`, the only
writer of delist queue rows:

```ts
data.push({
  productId: null, channelListingId: null,     // ← the cascade has nothing to cascade to
  …
  payload: { ...coordinate, channelListingId: listing.id, … },   // the identity is kept HERE
})
```

🟩 The calling route states the intent in as many words
(`products-catalog.routes.ts:1765-1766`): *"Capture coordinate/SKU/guards before purge; **the held
jobs intentionally have no Product or ChannelListing FK.**"*

🟩 And the dispatcher was written for exactly this
(`channel-delist.service.ts:15-16`): *"productId (may be null after hard-delete cascade — that's
OK) · channelListingId (likely null after cascade — that's OK)."*

**So `onDelete: Cascade` on that relation is real, but it is aimed at rows that do not exist.**
The plan read the schema and the service comment correctly, and drew the opposite conclusion from
the one line that decides it.

### 3. One writer — checked, not assumed

Three call sites create `DELETE_LISTING` work. 🟩 The other two —
`amazon-flat-file-remove.service.ts:53-57` and `ebay-flat-file-delete.service.ts:155-165` — call
`dispatchChannelDelist` **directly and write no queue row at all**. The eBay one says so:
*"queueId is used only by applyDelistResultToQueue; passing a synthetic value is safe since we
never write to OutboundSyncQueue from this path."*

**One writer, one store.** Nothing here needs the flat-file editors touched, and they were read
only.

### 4. Measured, not inferred

🟩 `apps/api/src/services/delist-cascade.local.vitest.test.ts` is the exact test Step 1.1 asks for
as its Gate. **Run today against local Docker: 1 passed, 33.76 s.** Its assertions at `:87-89`:

```ts
expect(held).toHaveLength(4)
for (const row of held) { expect(row.productId).toBeNull(); expect(row.channelListingId).toBeNull(); … }
expect(await prisma.product.count({ where: { sku: marker } })).toBe(0)
```

**Four queue rows survive; the product is gone.** That is Step 1.1's `Done when`, first clause,
demonstrated.

🔴 **But it is skipped by default** — `it.skipIf(process.env.PR2_LOCAL_REHEARSAL !== '1')`. A first
run without the flag reported **"1 skipped"**. *A test that does not run is not a gate*, and the
plan cites it as one.

🟩 **The invariant is separately gated by a fast test that does run** —
`outbound-enqueue.delist.vitest.test.ts:11` asserts
`toMatchObject({ productId: null, channelListingId: null, … })`. Run today: **7 passed**, no skips.

### What Step 1.1 actually is

| Clause | State |
|---|---|
| The queue row outlives the product | ✅ **True today**, and measured twice |
| Make `productId` nullable | ✅ Already nullable |
| Drop the cascade | ⚪ **Unnecessary.** The rows hold no FK |
| *"the listing is removed from the channel"* | 🔴 **Not established.** Blocked by [1.3](#step-13--implement-reversible-unpublish) (unpublish refuses) and [3.1](#step-31--open-the-two-shut-doors) (no live credentials) |

➡️ **Proposed:** strike Step 1.1's migration and its cascade change. **No migration is needed, so
no migration branch is needed.** Replace the step with its one surviving question — *does the
listing actually leave the channel?* — which is already carried by Steps 1.3 and 3.1.

🔴 **The claim "no delist ever runs, anywhere, on any channel" may still be true**, but **not for
the reason given**. The refusals are the live cause: `AMAZON_UNPUBLISH_NOT_IMPLEMENTED`,
`EBAY_UNPUBLISH_NOT_IMPLEMENTED`, and Shopify refusing both. That is Step 1.3's subject, not
Step 1.1's. *A cause is not a verdict* — the cascade was a cause that turned out not to be one.

---

## A-8 — 🔴🔴 The `apps/api` test suite does not run on push. Seven of Part 11's gates are hollow.

**2026-09-22. Status: FOR APPROVAL. This is the largest finding so far.**

[Part 11](#part-11--the-gate-ledger) records the hook status of every gate. **Seven rows say
"Test suite"**: the delist queue row, the orphan refusal, the Amazon kill switch, per-channel
requirements, the publish language, the Shared column set, and paste/fill validity.

🟩 **"Test suite" is not a hook.** `.githooks/pre-push` runs exactly three test commands:

| Line | Command | What it covers |
|---|---|---|
| 62 | `npm run test --workspace=@nexus/database` | 🆕 added by this lane today |
| 479 | `npm run test --workspace=@nexus/web` | apps/web |
| 527 | `npm run **test:security** --workspace=@nexus/api` | 🔴 `vitest run src/lib/auth src/routes/auth-routes.vitest.test.ts` — **auth only** |

🔴 **The full `apps/api` suite is never run on push.** It holds **833** `.vitest.test.ts` files plus
72 under `__tests__/`. Every gate this plan intends to place "in the test suite" would be written,
reviewed, committed — and never run by anything.

🟩 **This repo has paid for this exact failure before.** `.githooks/pre-push:452-454` records it:
*"This workspace had 89 `*.vitest.test.ts` files, no vitest config and no `test` script, so not one
of them had ever run: they were written, reviewed and committed **as if they were gates while
asserting nothing**."* That was fixed for `apps/web`. The same condition is live for `apps/api`.

### The usual objection does not survive measurement

The assumption would be that 833 files are too slow for a push hook. **Measured today, the whole
suite, on this machine:**

| | |
|---|---|
| Wall clock | 🟩 **50.85 s** (`/usr/bin/time -p real 50.85`) |
| Test files | 882 — **864 passed · 2 failed · 16 skipped** |
| Tests | 11,140 — **11,004 passed · 6 failed · 130 skipped** |

**50 seconds.** The `apps/web` suite is already in the hook on the argument that it *"finishes in
about a second"*, and the hook also runs two full Next.js builds. 50 s is not the obstacle.

### The 6 failures are pre-existing, and that is established, not assumed

`src/clients/amazon-validation-preview.vitest.test.ts` (5) and
`src/services/marketplaces/amazon-classifications.vitest.test.ts` (1). Every one asserts an Amazon
availability shape — `expected { ok: false, available: false } to match { ok: true, available: true }`
— which reads as environment, not logic.

🟩 **Attribution by construction, not by coincidence.** `git diff main...pes/phase-0 --name-only`
returns ten files: `.githooks/pre-push`, two docs, `package-lock.json`, and six under
`packages/database/`. **Zero files under `apps/api/`.** This lane cannot have caused them.

🔴 **2 failed files with 6 failed tests** — the counts match, so no suite failed to *load*. That
discrimination matters: a file count higher than the test count is a load failure wearing a
failure's clothes.

### Proposed

1. **Add the full `apps/api` suite to `.githooks/pre-push`**, next to the `apps/web` one, with the
   same 50-second budget recorded in a comment so a future regression in runtime is visible.
2. 🔴 **It cannot go in green.** Fix or quarantine the 6 Amazon failures first, each with a named
   reason — *a gate that goes in red is a gate someone will remove.*
3. **Correct Part 11.** Every row reading "Test suite" is **not in the hook** until step 1 lands.
   Seven rows are affected.

⬜ **Not measured:** whether the 6 failures are environmental (missing Amazon credentials locally)
or real. That is one command away and belongs with step 2, not here.

---

## A-9 — Step 1.2: the "(recommended)" string is gone, and the copy is already honest

**2026-09-22. Status: the step's ⬜ open item is CLOSED. The step itself still stands.**

Step 1.2 carries: *"⬜ **First, find the UI string.** The audit recorded 'Unpublish (recommended)';
I did not locate it today. Find it and fix its default in the same change."*
[Part 14.4](#144--the-honest-holes-in-this-plan) repeats it as honest hole #1.

🟩 **Found, and it no longer exists.** `Unpublish (recommended)` appears in **three** historical
commits (`b992fa650`, `905f6a3c4`, `3161da57b`) and **no current file**. *(A fourth match,
`861280afe`, is this lane's own commit quoting the plan — a search can match your own note about
the thing you are searching for.)*

🟩 `(recommended)` survives in `apps/` in **three** places, none of them about removal:
`AiBulkGenerateModal.tsx:425`, `QualityChecklist.tsx:25`, `ImportClient.tsx:1371`.

🟩 **And the replacement copy is unusually honest** — it already states the exact danger Step 1.2
was written to fix (`apps/web/src/app/products/_components/hardDelete.vitest.test.ts:47-63`):

> **"End the listing on each channel"** — *"Nexus asks each channel to stop selling, **then deletes
> the local record either way**. **Amazon and eBay: the request is refused; the listing is not
> ended.** Shopify: the request returns a visible failure; the store keeps selling it. WooCommerce
> and Etsy: nothing is sent. There is no relist from here."*

That names the orphan outcome in plain words, per channel. **R4 is already satisfied at the copy
layer.** Whoever wrote it had measured the refusals.

🟩 **The API default is safe, re-verified:** `products-catalog.routes.ts:1708` —
`const channelAction: 'none' | 'unpublish' | 'delete' = body.channelAction ?? 'none'`.

### What Step 1.2 still has to do

**The copy warns; the system still permits.** An operator who reads it and proceeds anyway still
creates an orphan, and 🟩 [A-7](#a-7--step-11s-premise-is-false-the-delist-queue-rows-were-never-destroyed)
shows the queue row survives to record it — so the refusal Step 1.2 asks for is still the fix.
➡️ **Strike only the ⬜ item and honest hole #1.** The step's Do, Gate and Rollback are unchanged.

🔴 **And apply [15.10](#1510--step-12-should-return-outcomes-not-throw) when it is built:** the
refusal must return **per-row outcomes**, not throw, so a bulk delete of 500 reports
*"487 deleted · 13 refused — live on Amazon·IT"* instead of dying on row 14.

---

## A-8 RESULT — built and measured. The `apps/api` suite is now a gate.

**2026-09-22. Owner ruled: fix the six, then add it. Done.**

### The six failures had ONE cause, and it was not six bugs

Both files reach `amazonAccount()` (`amazon-sp-client.ts:6-22`), which **reads the database**, and
this repo's dev database holds an `AMAZON` `ChannelConnection` with `authStatus: 'disconnected'`.
Line 19 refuses that, the callers catch, and everything downstream returns "not available".

| File | Why it failed |
|---|---|
| `amazon-validation-preview.vitest.test.ts` (5) | `validateListing` resolves its host via `getAmazonRegion()` → `amazonAccount()` (`amazon-sp-api.client.ts:1079`). The test mocked `getAccessToken` and the transport, but not this. The call threw and the outer catch returned `{ ok: false, available: false }` **before the transport was ever reached** |
| `amazon-classifications.vitest.test.ts` (1) | The arm stubs `AMAZON_LWA_CLIENT_ID` / `_SECRET` and asserts `isConfigured()`. 🔴 **P6.1 moved those credentials out of the environment into the `ChannelApp` table** (`amazon-sp-client.ts:29-37`). The env stubs had stopped deciding anything |

🔴 **Four of the five preview arms were PASSING — for the wrong reason.** They assert
`{ ok: false, available: false }`, which is exactly what the thrown-and-caught path returns. **One
defect produced four false passes and five false failures at once.** That is A-8's argument in a
single file: a suite nothing runs does not merely go stale, it goes *quietly* stale.

### Both fixed at the right layer, and both mutation-proven

**Preview:** `getAmazonRegion` is pinned. Nothing else is mocked, so the transport spy still proves
the request. **9 passed.** 🔴 Mutation — disabling the "unrecognized result" check in the client —
turned **3 of the 4 formerly-false-passing arms red**. They now assert something.

**Credentials:** 🔴 the two **data-access collaborators** are pinned (`listActiveConnections`,
`getChannelApp`) and `amazonCredsConfigured` itself is **not**. Re-deriving an equivalent rule
inside the test would assert the test's own copy of the logic — *a write's routing predicate binds
its readers*, and this codebase has already paid for that once. Two arms added: the credentials
come from `ChannelApp` rather than the environment, and an oauth account needs no env token, each
with a negative control. **8 passed.** 🔴 Mutation of the real function → **2 arms red**.

### 🟠 A wrong turn of my own, recorded because this plan's rule cuts both ways

With the six fixed, the suite was **11,012 passed, 0 failed — and still exited 1**, from
`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.

I tried `--pool=threads`, saw **5 clean runs**, and wrote into `vitest.config.ts` that threads was
the fix. 🔴 **That was wrong.** Against a ~50 % base rate, five clean runs is a 1-in-32
coincidence, and the very next runs through the real command failed. **The pool change was
reverted**, and the claim with it.

*A run that finds nothing must be shown capable of finding something* — and five quiet runs are not
that. The whole measurement table:

| Command | Exit 1 | Time |
|---|---|---|
| `vitest run` | **2 of 4** | ~51 s |
| `vitest run --silent` | **2 of 3** | ~51 s |
| `vitest run --pool=threads` | **2 of 8** | ~41 s |
| `vitest run --disableConsoleIntercept` | 🟢 **0 of 8** | ~50 s |

🟩 **The last one is chosen because it has a mechanism, not because it correlated.**
`onUserConsoleLog` *is* the console-forwarding RPC the error names; the flag stops intercepting
console output instead of shipping it to the reporter. `--silent` only hides the display, which is
why it changed nothing. Threads is genuinely ~20 % faster but does **not** fix the exit code, so
that change was not kept — speed was never the problem being solved.

### What was built

| Where | What |
|---|---|
| `apps/api/package.json` | 🆕 `"test:hook": "vitest run --disableConsoleIntercept --silent"`. The interactive `test` script is untouched, so local runs keep per-file log attribution |
| `.githooks/pre-push` (after the `apps/web` suite) | 🆕 runs `test:hook`, with the table above in the comment |
| Two test files | Fixed at the right layer, each mutation-proven |

### Gate — measured, and shown able to fail

- 🟢 **8 of 8 clean**, the last four through the hook's exact command: **11,012 passed**, ~50 s.
- 🔴 **Proven able to fail.** A mutation in **product** code (`amazonCredsConfigured` → `return true`)
  made the hook command exit **1** with *"2 failed | 864 passed"*. Restored; green again.
- 🟢 `tsc --noEmit -p tsconfig.json` on `apps/api`: **exit 0**.

### Cost when — `flat`

~50 s per push, and it does not grow with the catalog. The hook already runs two full Next.js builds.

### Part 11 correction

Seven rows reading "Test suite" were **not** in the hook. **They are now.** The ledger should say
*"push hook — `apps/api` `test:hook`"* for each.

---

## OWNER RULINGS — 2026-09-22 (second set)

| # | Question | Ruling |
|---|---|---|
| **R-4** | [A-8](#a-8----the-appsapi-test-suite-does-not-run-on-push-seven-of-part-11s-gates-are-hollow) — add the `apps/api` suite to the push hook? | ✅ **Yes, after fixing the six.** Done — see [A-8 RESULT](#a-8-result--built-and-measured-the-appsapi-suite-is-now-a-gate) |
| **R-5** | [A-7](#a-7--step-11s-premise-is-false-the-delist-queue-rows-were-never-destroyed) — Step 1.1 wants a migration the evidence says is unnecessary | ✅ **Strike the migration.** No schema change, no migration branch, no merge that migrates production |

### Step 1.1 as amended by R-5

- **Do** — *(struck: the cascade change and the migration)*. The queue row already outlives the
  product, because `enqueueDelistCascade` writes `productId: null, channelListingId: null`
  (`outbound-enqueue.ts:116`) and `productId` is already nullable.
- **Done when** — ✅ **Measured, first clause only.** `delist-cascade.local.vitest.test.ts`:
  1 passed, 33.76 s; four queue rows survive with null FKs and the product count is 0.
- **Gate** — `outbound-enqueue.delist.vitest.test.ts:11` asserts the invariant, runs by default,
  7 passed — 🟢 **and as of [A-8](#a-8-result--built-and-measured-the-appsapi-suite-is-now-a-gate)
  it now runs on every push.** The deeper `delist-cascade.local` rehearsal stays opt-in
  (`PR2_LOCAL_REHEARSAL=1`) because it needs the local Docker fixture.
- **Cost when** — `flat`.
- **Rollback** — n/a, nothing changed.
- 🔴 **What remains, and it is not this step's:** *"the listing is removed from the channel"* is
  **not established on any channel**. That is [1.3](#step-13--implement-reversible-unpublish) and
  [3.1](#step-31--open-the-two-shut-doors). The plan's claim *"no delist ever runs"* may hold, but
  the cascade is not why — the refusals are.

---

## Step 1.2 — BUILT. Never orphan a live listing.

**2026-09-22. All four fields pass.**

### What the defect actually was

The route deleted the product and asked the channel **afterwards**. Amazon and eBay refuse
`unpublish`; Shopify refuses both actions. So the product row vanished, the adapter refused, and
the listing kept selling with nothing left to manage it.

🔴 **And it was the default path, not an edge case.** The modal preselects `unpublish` the moment a
live listing exists — `BulkActionBar.tsx`:
`setChannelAction(data.channelListings.length === 0 ? 'none' : 'unpublish')`. The API default is
`'none'`, which sends nothing at all.

🟩 **The system already knew.** `GET /products/hard-delete-preflight` → `readHardDeletePreflight`
(`operational-impact.service.ts:157`) lists exactly these listings, and the modal displays them.
**Nothing enforced it.** The knowledge and the action were in different places.

### Built, with each rule read from its owner rather than restated

| Where | What |
|---|---|
| `channel-delist.service.ts` | 🆕 `delistCapability(channel, action)` — the ONE table of "can this pair actually remove a live listing?". It existed three times, as the first line of three adapters, where nothing outside the file could read it. **The three adapters now read it too** |
| `outbound-enqueue.ts` | 🆕 `whereDelistTargets(productIds)` — the target predicate lifted out of `enqueueDelistCascade`, which now calls it. One `where`, two callers |
| `delist-error-codes.ts` | 🆕 `hardDeleteOrphanReason(...)` — names the coordinate, the listing id, **why** it stays live (reusing `DELIST_OPERATOR_COPY`, so one wording), and the two ways forward |
| `products-catalog.routes.ts` | The refusal, inside the transaction, **before** anything is deleted or enqueued |
| `BulkActionBar.tsx` + `hardDelete.ts` | 🆕 `interpretHardDeleteOutcomes` / `hardDeleteRefusalLines` |

🟩 **R1 in practice:** when [Step 1.3](#step-13--implement-reversible-unpublish) lands reversible
unpublish, **one row of `delistCapability` changes and this refusal lifts with it.** A second copy
in the route would have gone on refusing a delete that had become safe.

### Three things the change had to fix that the plan does not mention

1. 🔴 **The audit trail.** The `hard-delete` `AuditLog` rows were built from `eligible`. A refused
   product would have carried a durable record of a destructive act that never happened. Now built
   from `deletable`.
2. 🔴 **The bin row.** `productReadCache.deleteMany` targeted **all** `productIds`. A refused
   product would have lost the cache row the bin UI reads — still existing, now invisible and
   unreachable. Now targets only the deleted ids plus the ghost rows.
3. 🔴 **The UI announced a deletion that did not happen.** `hardDeleteBulk` ignored the response
   body and emitted `product.deleted` for **every selected id**, so other open pages would drop a
   row that still exists, and the operator would be told "done". It now announces only what the
   server deleted, and states the refusal. **If nothing was deleted it throws**, because `run`'s
   success toast would otherwise say *"Permanently deleting done"*.

🟩 The toast uses the provider **already in that file** (`@/components/ui/Toast`). The repo has two
toast providers with different signatures; switching one component's provider is its own piece of
work, not a side effect of this one.

### Done when — ✅ measured

*"Hard-deleting a product with a live Amazon or eBay listing is refused with a sentence naming the
coordinate, and no orphan can be created."*

`hard-delete-orphan-guard.vitest.test.ts`: **13 passed.** The sentence asserted end to end —
`AMAZON · IT`, `B0LIVE`, and the cause — plus an arm proving **every** coordinate is named, not
just the first.

### Cost when — `flat`

One extra indexed `findMany` per call, over a set already capped at **200 products**. It does not
grow with the catalog.

### Gate — ✅ and proven able to fail **in both directions**, which this step's Gate demands

| Mutation | Result |
|---|---|
| Never refuse (the old behaviour) | 🔴 **9 of 13 red** |
| Refuse everything | 🔴 **2 of 13 red** — the positive controls |
| Web helper: announce every id again | 🔴 **3 of 33 red** |

Restored after each; green again. **Every refusal arm is paired with a positive control that must
still delete** — `AMAZON`/`EBAY` + `delete` proceed, a listing with no external id is not live, and
a clean product deletes. A guard seen only refusing cannot be told from one that refuses everything.

🟢 **In the hook.** Both suites run on push as of
[A-8](#a-8-result--built-and-measured-the-appsapi-suite-is-now-a-gate):
`apps/api` **11,025 passed**, `apps/web` **4,603 passed**, both `tsc --noEmit` **exit 0**.

### Rollback

Remove the Step 1.2 block in `products-catalog.routes.ts` and restore `eligible`/`productIds` in
the audit and cache lines. `delistCapability`, `whereDelistTargets` and the web helpers are
additive and can stay.

### ⬜ Deliberately NOT included, so it is not mistaken for done

A listing whose eBay ItemID is **still referenced by another surviving local product** is not
orphaned — another row still manages it — so it does not refuse. The cascade's own
`channelSkipped` guards (variation child, shared ItemID) therefore stay as they are. 🔴 **An
orphaned eBay *variation* under a surviving parent ItemID is not covered by this step** and is not
measured. It belongs with [Step 1.3](#step-13--implement-reversible-unpublish).

---

## A-10 — Step 1.4 is already done on Amazon. The real hole is on eBay, behind a no-touch rule.

**2026-09-22. Status: Amazon half CLOSED as already-true. One finding FOR APPROVAL.**

### The kill switch is already honoured, inside the client

🟩 `amazon-sp-api.client.ts:1160-1172` — the **first** thing `deleteListingsItem` does:

```ts
const mode = getAmazonPublishMode()
if (mode === 'gated' || mode === 'dry-run' || mode === 'sandbox') { … no HTTP … }
```

It reads `getAmazonPublishMode()`, never an env variable directly, and `'sandbox'` is included with
its reason recorded (`P0.1 — … request below targets the production host, so sandbox used to send a
real DELETE`). That is exactly what the step asks for, in the client rather than at the callers.

### And the gate the step asks for already exists and already covers delete

🟩 `amazon-sp-api.publish-gate.vitest.test.ts` opens with
*"permanent delete honours the same Amazon master gate as every write"*. **Run today: 12 arms, all
passing**, including `positive control: enabled + live reaches the mocked DELETE transport` and
`deleteListingsItem in sandbox mode is a dry run with no token and no HTTP`. The step says
*"extend it"*; there is nothing to extend.

### 🟠 The premise is false: no Amazon delete path runs on `products.edit`

*"🔴 Anyone who can edit a product can delete a live listing."* Traced today. There are exactly
**two** callers of `deleteListingsItem` — `recovery.service.ts:313` and
`channel-delist.service.ts:170` — and every route that reaches either one resolves to
**`products.delete`**, asked of `permissionForRoute` rather than read off the source:

| Route | Permission |
|---|---|
| `POST /api/products/bulk-hard-delete` | `products.delete` |
| `POST /api/amazon/flat-file/remove` | `products.delete` |
| `POST /api/products/:id/recover` | `products.delete` |

🟩 And `listings.delete` **does not exist** (`packages/shared/permissions.ts:63-67` has
`listings.view/edit/publish/recover/flatfile.edit`). Creating it would refuse every delete path
above until roles are re-granted — a live breakage, to close a hole that is not open.

### 🔴 The real hole, and it is a different one

🟩 `POST /api/ebay/flat-file/delete` → **`listings.flatfile.edit`**.

That route ends live eBay listings (`runEbayFlatFileDelete` → `dispatchChannelDelist` →
`endFixedPriceItem`). 🟩 It carries **no `preHandler` permission assertion** at
`ebay-flat-file.routes.ts:3952-3954`, so the order-sensitive manifest alone decides — and it grants
an **edit**-class permission for a permanent, irreversible channel action.

🔴 **It is also prefix-dependent.** The same handler resolves differently by path:

| Asked | Answer |
|---|---|
| `POST /api/ebay/flat-file/delete` | `listings.flatfile.edit` |
| `POST /ebay/flat-file/delete` | `channels.sync` |

🟩 This is the exact class `permissions-manifest-order.vitest.test.ts` was written for — its header
records `/api/products-ai/bulk-generate`, *"a route that SPENDS MONEY on model calls"*, resolving to
`products.edit` because a broader prefix matched first. **Neither eBay path is in that test's
list.**

### 🔴 Why this lane stops here

`apps/api/src/routes/ebay-flat-file.routes.ts` is named in the **flat-file no-touch rule**. And
changing the manifest entry instead still changes who can use that surface: an operator holding
`listings.flatfile.edit` but no delete permission loses a bulk action they use today.

The rule's own precedent is *"table the exact edits, split preserving from changing, and let the
operator approve them separately."* So: **tabled, not changed.**

| Edit | Kind | File |
|---|---|---|
| Add both eBay delete paths to `permissions-manifest-order.vitest.test.ts` | **Preserving** — a test only, changes no behaviour | `apps/api/src/lib/auth/permissions-manifest-order.vitest.test.ts` |
| Raise `/api/ebay/flat-file/delete` from `listings.flatfile.edit` to a delete-class permission | **CHANGING** — an operator may lose an action | `permissions-manifest.ts` (not the flat-file route) |

⬜ **Not measured:** which roles actually hold `listings.flatfile.edit` today, and therefore how
many people would lose the action. That is one query and it should be answered **before** the
second edit, not after.

➡️ **Proposed:** close Step 1.4's Amazon half as already-true. Do the preserving edit now. Hold the
changing edit for an explicit yes.

---

## A-11 — Step 1.5's need is real, but three of its claims are wrong, including its gate

**2026-09-22. Status: FOR APPROVAL. Not built.**

### The need is real — verified, not assumed

🟩 `apps/api/src/services/products/bulk-edit.service.ts` contains **zero** occurrences of
`writeChannelPrices`, `PRICE_UPDATE` or `PriceChangeEvent`. The sheet's price write really does
bypass the one price door: no enqueue, no audit row, no `PriceChangeEvent`.

🟩 And the cell really is editable today: `ebay.ts:251` defaults `editable: true` in the `listing()`
helper, and the `price` field at `:104` does not override it.

### 🟠 But the "one line" does not exist

Step 1.5 states: *"🟩 The field spec already carries both `editable: boolean` and
`readOnlyReason?: string` (`channel-specs/types.ts:99-100`, `ebay.ts:235-258`)"*, and shows a code
block using it. **Marked 🟩 verified. It is not.**

| Claim | Measured |
|---|---|
| `readOnlyReason` on `ChannelFieldSpec` | 🔴 **Absent.** 74 occurrences repo-wide, **none** under `channel-specs/`. It lives in the web studio drawer (`_studio/drawer/types.ts:629`) and the Shopify field types — a different type in a different app |
| `ebay.ts:235-258` carries such a field | 🔴 That range is the `listing()` **helper function**, not a field |
| `editable` expresses local policy | 🔴 Its own doc comment (`channel-specs/types.ts:100`) says the opposite: *"Amazon's `editable: false` — **cannot change on an EXISTING listing**. Still authorable."* It is a **channel fact**. Using it to mean "our Matrix owns this field" puts a local policy into the field that records what the channel said — the exact conflation **R3** exists to prevent |

### 🔴 And the named gate cannot see this change

Step 1.5's Gate is *"🟩 `scripts/check-silent-disabled.mjs` is already in the push hook — it exists
precisely to stop a disabled control with no reason."*

🟩 It does exist and it is in the hook. But its header states what it parses: *"A **JSX element**
with BOTH a `disabled` and a `title` attribute — parsed from the TypeScript AST"*. It is a **JSX
ratchet for web controls**. An API `ChannelFieldSpec` is invisible to it. **This step would ship
with no gate at all.**

🟩 Today's refusal is also silent in the sense R4 forbids: `cell-formula.service.ts:930` and `:966`
throw the generic `'This field cannot be edited in this scope.'` — no channel, no reason, no
alternative.

### Proposed, in place of the step as written

Small, but **four edits and a test, not one line**:

1. Add `readOnlyReason?: string` to `ChannelFieldSpec` — **additive**, a local-policy field kept
   **separate** from `editable`, so the channel fact is not overloaded.
2. Set `editable: false` **and** `readOnlyReason` on the eBay `price` field.
3. Make `cell-formula.service.ts` (`:930`, `:966`, `:1130`) surface `readOnlyReason` when present,
   falling back to today's sentence. A refusal that cannot say why is the defect, not the refusal.
4. 🆕 A real gate, since the named one cannot apply: a test asserting the eBay price cell refuses
   **with its reason**, plus a positive control that an editable cell still writes.

🟢 It stays honest about the ordering: [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler)
restores `editable: true` once the sheet uses the door, and both steps already say so.

➡️ **Ruling needed:** build the corrected four-edit version, or leave the price cell writable until
Step 2.2 lands.

### A-10 addendum — the "changing" edit turns out to change nothing today

**Measured on production, read-only, 2026-09-22.** Host confirmed as
`ep-purple-river-altf6t3y…neon.tech` before the query.

| Permission | Roles holding it |
|---|---|
| `listings.flatfile.edit` | **2** — `ADMIN`, `OPS_MANAGER` |
| `products.delete` | **2** — `ADMIN`, `OPS_MANAGER` |

> 🟢 **Roles that would lose the eBay bulk delete (hold `listings.flatfile.edit`, lack
> `products.delete`): ZERO.** Of 6 roles total.

`OWNER` is implicit-all and is never affected (`schema.prisma`, `Role.permissions`: *"OWNER is
implicit-all: enforcement never reads this list for OWNER"*).

➡️ So raising that route's permission is **behaviour-preserving for every role that exists today**.
It binds only future custom roles — which is the entire point. The no-touch rule's requirement to
*"split preserving from changing"* is satisfied by measurement rather than by argument: on today's
data, both edits are preserving.

🔴 **What it does NOT prove:** that no *custom* role is created later holding the flat-file edit
without a delete permission. That is the case the change exists to catch, and it cannot be measured
in advance.

---

## A-10 RESULT — the eBay delete permission is closed. Both edits landed.

**2026-09-22. Owner ruled: both edits.**

🟩 `permissions-manifest.ts` — an explicit carve-out **above** the `pfx('/api/ebay/flat-file')` rule,
exactly mirroring the Amazon line that was already there:

```ts
P(F.productsDelete, (m, p) => m === 'POST' && p === '/api/ebay/flat-file/delete'),
```

**`POST /api/ebay/flat-file/delete` now resolves to `products.delete`** — asked of
`permissionForRoute`, not read off the source. 🟢 `ebay-flat-file.routes.ts` was **not touched**;
the no-touch rule holds.

🟩 `permissions-manifest-order.vitest.test.ts` — the eBay delete pinned, **plus both `save`
neighbours**, so a future carve-out cannot widen past the one route it meant to name. Written from
the route's PURPOSE, as that file's header demands. **27 passed.**

🔴 **Proven able to fail:** removing the carve-out turns the arm red with
`expected 'listings.flatfile.edit' to be 'products.delete'` — the exact value the hole had.

⬜ `POST /ebay/flat-file/delete` (no `/api`) still answers `channels.sync`. 🟩 The router registers
this file with `prefix: '/api'` (`index.ts:729`), so that path cannot be requested. **Left alone
and named rather than "fixed"** — changing a rule for a URL that cannot occur buys nothing and
moves a line in an order-sensitive table.

---

## 🟠 A-11 CORRECTION — I was wrong about `readOnlyReason`, and then right for a different reason

**2026-09-22. Step 1.5 is NOT built. Reverted. A ruling is needed.**

### First, my error, because this plan's rule cuts both ways

A-11 stated: *"`readOnlyReason` on `ChannelFieldSpec` — 🔴 **Absent.** 74 occurrences repo-wide,
**none** under `channel-specs/`."*

🔴 **That is false.** It is at `channel-specs/types.ts:66`, and `channel-specs/etsy.ts` uses it in
**seven** places. I ran a grep, piped it through `head -10`, saw only Shopify and studio hits, and
reported the truncated list as the whole set. **The plan was right; only its line number was off.**

> *A list of members is a SET CLAIM.* I wrote one from a truncated list, having quoted that very
> rule earlier in this session. The count printed `74` on the same line I read `10` results from.

### Then the build, which the test suite refused

Setting `readOnlyReason` on the eBay `price` field works at the column level — verified,
end-to-end: the column came back `editable: false`, `formulaWritable: false`, with the reason as
help text, and a mutation turned 3 of 6 arms red.

🔴 **But the full suite failed, on an arm I had not thought about:**

```
master-default-rule.vitest.test.ts
AssertionError: expected null to match object { source: 'basePrice' }
```

🟩 **`readOnlyReason` does not mean "held". It means "the channel owns this value."** Six consumers,
and two of them carry that ownership meaning far outside the sheet:

| Consumer | What setting it would have done to the eBay price |
|---|---|
| `master-default-rule.ts:8` — `if (field.readOnlyReason) return null` | 🔴 **Deleted the master→channel mapping.** `basePrice` would stop flowing to eBay at publish |
| `source-definition-plan.ts:66` | 🔴 Relabelled its source owner **"Channel-reported data"** — false; we own this price |

That is how Etsy uses it, and correctly: *"Converted price reported by Etsy"*, *"Reported by Etsy"*.
Those fields genuinely have no master mapping. **The eBay price does.**

> **Holding a cell and disowning a field are different facts.** One field cannot carry both, and the
> suite is what said so — the column-level test I wrote was green, and would have shipped a publish
> regression.

### So Step 1.5 still needs a decision

The need is unchanged and still measured: `bulk-edit.service.ts` has **zero** occurrences of
`writeChannelPrices`, `PRICE_UPDATE` or `PriceChangeEvent`.

| Option | |
|---|---|
| **(a)** A **new, narrow** spec field — a policy hold read **only** by `sheet-columns.service.ts`, never by the mapping rules. ~3 edits + the test I already wrote. Two reason fields, deliberately, because they are two different facts | 🟨 Recommended |
| **(b)** Refuse `price` in `bulk-edit.service.ts` — block the **write** where the damage is, rather than dressing the column. Stronger, but the cell still looks editable and fails on save, which R4 dislikes | |
| **(c)** Leave it writable until [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler) | |

🟨 **(a) + (b) together** is the complete answer: the column states the hold, and the writer refuses
regardless of which surface calls it. **(a) alone** is the smallest honest step.

---

## Step 1.5 — BUILT (the column half). A-12: the write half was built, measured, and reverted.

**2026-09-22. Owner ruled: hold the cell AND refuse the write. Half of that survived measurement.**

### The column half — built and gated

| Where | What |
|---|---|
| `channel-specs/types.ts` | 🆕 `editHeldReason?: string` — a **second** reason field, deliberately |
| `sheet-columns.service.ts` (beside the `readOnlyReason` rule) | Honours it: `editable: false`, `formulaWritable: false`, reason as help text. **Read here and nowhere else** |
| `channel-specs/ebay.ts` | 🆕 `EBAY_PRICE_HELD_REASON`, set on the `price` field |

🔴 **Why a second reason field rather than reusing `readOnlyReason`** — and this cost a build to
learn. `readOnlyReason` means *"the channel owns this value"*. Setting it on the eBay price held the
column correctly **and silently deleted the field's master mapping**, because
`master-default-rule.ts:8` returns `null` for anything carrying it. The suite caught it:
`expected null to match object { source: 'basePrice' }`. It would also have relabelled the source
owner *"Channel-reported data"* (`source-definition-plan.ts:66`), which is false — we own this
price.

> **Holding a cell and disowning a field are different facts.** One field cannot carry both.
> That regression is now pinned by its own arm, so "tidying the two reason fields into one" fails.

🟩 `editable` is left **true** on purpose: it maps to the column's `editableOnExisting`, meaning
*"the CHANNEL cannot change this on an existing listing"*. eBay can. The hold is ours; the channel
fact stays eBay's.

### Done when — ✅ measured, end to end

`ebay-price-held.vitest.test.ts`: **6 passed**, asserting the **column** (not just the spec) through
the real `buildSheetColumns`: `editable: false`, `formulaWritable: false`, and the reason as the
help text the sheet turns into `writeBlockedReason` (`studio-sheet.service.ts:639`).

### Gate — ✅ proven able to fail, three ways

| Mutation | Result |
|---|---|
| Hold removed | 🔴 2 of 6 red |
| Hold switched back to `readOnlyReason` | 🔴 1 red — **the mapping-survives arm**, the exact regression |
| *(write half, while it existed)* removed | 🔴 1 red |

Full `apps/api` suite: **11,034 passed**, exit 0, `tsc` exit 0.

### Cost when — `flat`. One optional string on a field spec.

### Rollback — delete `editHeldReason` from the eBay price field. The type and the rule are additive.

---

## A-12 — the write half was reverted, and the reason is worth more than the code

**Status: NOT built. Reported, not hidden.**

Built as approved: `CHANNEL_WRITE_HELD` in `channel-field-map.ts`, consulted by `isChannelWritable`
and refused in `bulk-edit.service.ts`, sharing one sentence with the column.

🔴 **It broke 19 arms across 3 files.** `ebay_price` is this repo's **canonical fixture for a
mapped channel field**, and those arms are not about price — they are about:

`#689` the equality/no-op pass · `#700` CAS against the **listing** not the product · `#703` alias
routing and its primary control · account resolution before a write · recalc scoping per coordinate
· a real-PostgreSQL save · paste verification across column and JSON stores.

🔴 **And a wholesale swap to another field would have damaged real coverage**, because some of them
genuinely *are* about price: *"pinning the current price breaks inheritance even when the synced
number matches"* and *"routes `ebay_price` resets through its required storage boundary"* test
follow-flag and storage-boundary semantics that only price exercises.

> Refusing the repo's standard test vehicle at a generic gate is not a narrow change. It is a
> fixture migration across three files and 27 occurrences, undone again by Step 2.2.

➡️ **Proposed:** leave the write half to [Step 2.2](#step-22--one-price-door-enforced-by-the-compiler),
which refuses the bypass **at the price door** — where the refusal belongs — and deletes the column
hold in the same change. `EBAY_PRICE_HELD_REASON` is exported so 2.2 can reuse the sentence verbatim.

⬜ **What is therefore still open:** a direct API caller can still `PATCH` `ebay_price` and take the
bypass. The **sheet** cannot, which is what Step 1.5 set out to stop. **The gap is stated, not
closed** — and it closes at 2.2.

---

## Step 0.4 — MEASURED. And the obvious repair turns out to be illegal.

**2026-09-22. The replay exists and has run. The repair needs a ruling.**

### The number, and the wrong number I got first

`packages/database/scripts/replay-migrations.mjs` applies each migration individually against a
throwaway local database and **continues past a failure**, which `prisma migrate deploy` cannot do.

> **443 of 467 apply. 24 fail.**
> `42P01` relation missing ×16 · `42703` column missing ×5 · `42883` function missing ×2 ·
> `42704` index missing ×1

🟠 **The first run of this script was wrong, and the way it was wrong is the lesson.** It used
`.sort()` — code-unit order — which is **not** the order Prisma applies migrations in:

| | `.sort()` | `localeCompare` |
|---|---|---|
| `20260502_phase_d3_cascade_categoryattrs_gtin` | position **21** | position **18** |

🟩 A real `prisma migrate deploy` against an empty database printed **18** `Applying migration`
lines and died on that migration — position **18**. So Prisma orders the way `localeCompare` does.
**Pinned against an observed deploy, not assumed from documentation.**

Under the wrong order the migration that *creates* `BulkOperation` happened to run before the one
that *alters* it, so the real first failure was invisible. Correcting the order **swapped two
failures in and two out** — and left the total at 24 by coincidence. *The headline number was right
by accident; the list was wrong.*

### What the 24 actually are

🟩 **None of them is a missing migration.** Every object they want is created *somewhere* in the
history — **0 "never created"**. This is an **ordering** problem, plus a cascade:

- **13** are clean ordering: the object is created by a **later** migration.
  `20260508_cr10_warehouse_account` (#90) wants `CarrierAccount`, created at **#92**.
  `20260510_lw_aet_1_prompt_acceptance` (#146) wants `PromptTemplate`, created at **#147**.
- **11** are downstream or unclear. Several are plainly **cascades** of the first 13:
  `#456` and `#460` want `CatalogLink`, which `#454` would have created — and `#454` failed.
  ⬜ Those 11 were classified by regex and are approximate; the 13 are not.

### 🔴 The obvious repair is illegal, and this plan's own gate proves it

Renaming the folders so they sort into dependency order is the first thing anyone would try.
**It cannot be done.**

`migration_name` is the key in production's `_prisma_migrations`. Renaming a folder makes
production's row **applied-but-missing** and the new folder **pending** — so
`prisma migrate deploy` would re-run already-applied SQL against production.

🟢 **And the gate built in [Step 0.1](#a-2-result--built-and-measured) refuses exactly that**, at
deploy, before anything is applied. That is the gate doing its job against a change this programme
itself proposed. It is also why [A-1](#a-1--step-01s-premise-is-false-there-are-no-untracked-production-migrations)
measured the two directions as zero: they must **stay** zero.

So "repair the history" can only mean **editing the 24 SQL files** so each tolerates running before
its dependency — guards, `IF EXISTS`, re-ordered statements. That changes what 24 already-applied
migrations say they did, for a database that will never replay them again.

### 🟢 A third option, which was not on the table when R-3 was ruled

**Generate a baseline from the repo's own `schema.prisma`** — not from production:

```
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

🟩 **Run today: 15,233 lines.** Applied to an empty database: **OK — 446 tables**, including every
object the broken history cannot reach (`Product`, `CatalogLink`, `BulkOperation`, `PromptTemplate`)
with a negative control (`ZZ_NeverExists`) absent.

| | |
|---|---|
| Source of truth | 🟢 `schema.prisma`, **in the repo** — this is not the production dump R-3 rejected |
| Production | 🟢 Untouched. Existing databases keep the history; only a **fresh** database uses the baseline |
| Renames | 🟢 None. `_prisma_migrations` stays byte-identical, and the Step 0.1 gate stays green |
| Unblocks [15.11](#1511--the-structural-gap-cost-when-and-one-scale-fixture)'s scale fixture | 🟢 **Today** |
| Honest cost | 🔴 The 467-file history stays un-replayable. It becomes history, not a build path |

### ➡️ Ruling needed

- **(a)** 🟨 **Baseline from `schema.prisma`.** The repo stays the source of truth, nothing is
  renamed, the scale fixture is unblocked today. *Recommended.*
- **(b)** Edit the 24 SQL files to tolerate early execution. Honours R-3 literally, but rewrites
  what 24 applied migrations claim to have done, and each edit is a fresh chance to diverge from
  what production actually has.

- **Cost when** — `flat`. The replay runs against one throwaway local database, in minutes.
- **Gate** — the replay script itself. 🔴 **Not yet proven able to fail** — it must be shown to
  catch a deliberately broken migration before its green is worth anything. That is owed whichever
  option is chosen.
- **Rollback** — the script is read-only and drops its own database; `abm_gate*`/`nexus_replay_*`
  count after every run is 0.

---

## Step 0.4 RESULT — BUILT. A fresh database now stands up, and reports itself up to date.

**2026-09-22. Owner ruled: baseline from `schema.prisma`.**

| File | What |
|---|---|
| `packages/database/prisma/baseline.sql` | 🆕 **15,244 lines**, generated from `schema.prisma`. Not a migration — outside `prisma/migrations/`, so Prisma never applies it |
| `scripts/generate-baseline.mjs` | 🆕 Regenerates it |
| `scripts/bootstrap-fresh-database.mjs` | 🆕 Applies the baseline to an **empty local** database, then stamps all 467 migrations applied. Refuses a non-loopback host, and refuses any database that already has tables |
| `scripts/baseline.vitest.test.ts` | 🆕 The gate. Already in the push hook via `npm run test --workspace=@nexus/database` |
| `scripts/replay-migrations.mjs` | The diagnostic that measured the problem |

### Done when — ✅ measured end to end

```
[bootstrap] baseline applied — 446 tables
[bootstrap] marked 467 migrations as applied
$ prisma migrate status  →  "Database schema is up to date!"
```

🟢 **And the Step 0.1 gate accepts it** — `467 rows on the database vs 467 folders in the repo`,
exit 0. The two pieces of Phase 0 agree with each other, which is the point of building both.

### 🟠 A wrong turn, recorded because it is the most useful thing here

I ran `prisma migrate diff` against a database built from the baseline. It reported **420 missing**
`ALTER COLUMN "workspaceId" SET DEFAULT NULLIF(current_setting('nexus.workspace_id', true), '')`
statements. I read that as "the generator omits the defaults", added a **second pass** to append
them, and wrote it up as a measured finding.

🔴 **It was wrong, and the mutation test is what exposed it.** Deleting the second pass changed
nothing: the gate still passed. So I stopped asking the tool and queried `information_schema`:

> **Phase one alone already produces 420 of 431 `workspaceId` defaults**, emitted inline in
> `CREATE TABLE`. The actual stored default is
> `NULLIF(current_setting('nexus.workspace_id'::text, true), ''::text)` — Postgres normalises the
> expression with `::text` casts, and **Prisma does not recognise it as its own**. It will report
> those 420 statements forever, against a database that has them.

**The second pass was 420 duplicate statements solving nothing.** It is deleted.

> I used the diff as evidence that the defaults were missing, and later proved the same diff cannot
> see them. The tool whose blindness was the question was the witness I trusted.
> *A mutation says whether, not which* — but here it said "not this", and that was enough.

### Gate — ✅ and proven able to fail on the invariant that matters

The gate cannot assert "the diff is empty": that is unachievable for a `dbgenerated` default. It
asserts what is true — **the residual diff may contain those defaults and nothing else**, plus the
defaults really exist in `information_schema`, plus a positive control that a schema was built at
all.

| Mutation | Result |
|---|---|
| Add a column to `schema.prisma`, do not regenerate | 🔴 **RED**, naming it: *"unexpected drift: ALTER TABLE "Warehouse" ADD COLUMN "zzBaselineDriftProbe" TEXT"* |
| Restore | 🟢 3 passed |
| *(Invalid mutation: delete the second pass)* | Green — correctly, because it changed nothing |

`@nexus/database` suite: **13 passed**, 2 files. Every scratch database dropped.

### Cost when — `flat`. One generated file; the gate builds one throwaway database.

### Rollback — delete `baseline.sql` and the three scripts. Nothing else reads them.

### ⬜ What this does NOT do, stated plainly

The 467-migration history **still does not replay** — 443 of 467. It is now *history*, not a build
path, and `replay-migrations.mjs` keeps measuring it. 🔴 **`replay-migrations.mjs` is a diagnostic,
not a gate**: it exits non-zero every run by design, so it is deliberately **not** in the push hook.
Calling it a gate would be calling a permanent red a green.

---

# PHASE 2 — pre-steps

## Step 15.3 RESULT — the column-set cache is bounded. And two of its three sibling caches already were.

**Ranked #1 in [15.13](#1513--ranked-what-to-do-and-when).** 🟩 The premise is verified: the inner
`Map` of every `WorkspaceCache` was unbounded, and `sheet-columns.service.ts` keys its entry on
`familyIds` **and** `savedFields`, so every family and every saved column selection a user opened
added a whole `SheetColumnSet` that never left memory.

🟠 **Two line references in 15.3 have drifted** (the file grew with Step 1.5). Substance unchanged:

| 15.3 says | Today |
|---|---|
| `workspace-cache.ts:11-13` bounds the buckets at 64 | 🟩 true, now `:22` |
| `sheet-columns.service.ts:1144` TTL checked on read only | 🟩 true, now `:1173` |
| `sheet-columns.service.ts:1127-1141` the cache key | 🟩 true, now `:1156-1170` |

### What was built

1. 🆕 `WorkspaceCache` takes an optional **`maxEntriesPerWorkspace`** and enforces it in `set()`:
   the oldest **write** is evicted first, which is also the entry most likely to be past the TTL
   already. A refresh of an existing key is re-inserted, so it moves to the newest slot rather than
   being evicted from its first position.
2. 🔴 **The cap is opt-in, and the default stays unbounded.** A blanket default would silently
   lower `idempotency.service.ts`'s own 5,000-entry bound (`idempotency.service.ts:28`), and there
   a dropped entry is a **repeated write**, not a slower read. A cap belongs to the caller that
   knows the cost of a miss.
3. `columnSetCache` and `englishLabelCache` are capped at **64 per workspace**.
4. 🆕 `sheetColumnCacheStats()` exports `{ entries, max, ttlMs }` — 15.3's recommendation (b), and
   the instrument the call-site gate reads.

### 🟠 Why 64 and not the "~3 lines, pick a number" answer

The first cut was 32. It was wrong, and finding out why changed the shape of the finding:

🟩 **Two of the three caches holding `SheetColumnSet` objects were already bounded.**
`products-sheet.routes.ts:28` holds **64** per workspace and `studio-columns.ts:20` holds **128**,
both through `TtlCache`, which does true LRU. They hold the **same objects by reference**. A cap of
32 in the service would therefore have evicted entries its own consumers were still keeping alive —
paying a rebuild and freeing nothing. 64 matches the bound this codebase already accepts for this
object.

➡️ **The finding is narrower than 15.3 states.** "Affects every sheet read" is right about the
path but not about the exposure: the *route* cache was never unbounded. The unbounded one was the
service cache behind it.

### Done when — ✅ measured

| Claim | Measurement |
|---|---|
| Inserting cap + 1 leaves exactly cap | `workspace-cache.vitest.test.ts` — 4 passed |
| The oldest write is the one that goes | asserted on `keys()`, not only on `size` |
| A refresh does not evict a different entry | asserted; this arm was **added after a mutation escaped** (below) |
| An uncapped cache is still unbounded | 200 entries in, 200 out |
| The cap is per workspace, not per process | a second workspace's bucket is unaffected |
| The service's cache is still wired to a cap | `sheet-columns-bound.vitest.test.ts` reads `sheetColumnCacheStats().max` |

**Size, measured, not guessed** — against the local catalogue (355 products):

| build | columns | JSON |
|---|---|---|
| `master DE`, no family | 47 | 29.5 KiB |
| `master DE`, one family | 101 | 50.0 KiB |
| `channel EBAY DE` | 30 | 30.0 KiB |
| 🔴 **`channel AMAZON DE`, one product type** | **163** | **473.9 KiB** |
| 🔴 **`channel AMAZON DE`, three product types** | **268** | **1,159.4 KiB** |

The retained object graph is larger again than its JSON.

> 🔴 **CORRECTED 2026-09-22, second correction to this section.** The first version of this table
> stopped at 50.0 KiB and said *"no Amazon spec is cached locally, so `channel AMAZON DE` drops 30
> of its columns"*. **Both halves were wrong.** 🟩 `nexus_development` holds **32 cached Amazon·DE
> category schemas** (183 in all, across 11 coordinates). The build returned 3 columns because my
> probe passed **no `productTypes`** — and it said so, in its own output: `schemaMissing:
> ["AMAZON:category not selected"]`. I did not read the field the build provides for exactly this.
> With a product type it returns **163 columns and 473.9 KiB**, which also confirms the plan's
> *"185+ columns"* (191 before the drop pass).
>
> **The real per-entry size is therefore 9–23× what this section first reported.** The cap still
> holds — see [A-15](#a-15--the-column-set-cache-is-bounded-per-business-but-64-businesses-of-it-is-2-gb) for what that means and what it does not.

> 🔴 **CORRECTED 2026-09-22, and the correction matters more than the number.** The first version
> of this paragraph said *"the local catalogue is empty (`Product` returned 0 rows)"*. **It is
> not — it holds 355 products.** The count ran with **no workspace context**, so row-level
> security returned 0 rows. *"No context"* and *"empty"* are the same reading. The count had no
> positive control, which is the one rule this plan keeps paying for. See
> [15.11](#1511--the-structural-gap-cost-when-and-one-scale-fixture)'s result for how it surfaced:
> the scale fixture's own guard refused the database, naming 355 products, seconds after the
> paragraph above was written.

🔴 **The heap instrument failed its own positive control** and its numbers are therefore not
reported here. A deliberately retained 1 MiB string moved `heapUsed` by 2.2 KiB. JSON bytes are
used as the size proxy instead. *An instrument that cannot see a known quantity has not measured an
unknown one.*

### Gate — ✅ and proven able to fail, four ways

| Mutation | Result |
|---|---|
| Drop the cap argument at the call site | 🔴 **RED** — `sheet-columns-bound` fails on `Number.isFinite(max)` |
| Disable the eviction loop | 🔴 **RED** — `expected 5 to be 4` |
| Make the default cap finite (`8`) | 🔴 **RED** — `expected 8 to be 200`, the uncapped arm |
| Remove the refresh re-insert | 🟢 **GREEN — the gate MISSED it.** See below |

### 🔴 The mutation that escaped, and what it cost

The first version of the refresh test used the sequence `a, b, c → refresh a → d`. Both the correct
code and the mutant produce `[c, a, d]`, because when the refreshed key **is** the oldest, evicting
it and re-adding it lands in the same place. **The fixture pinned the dimension the claim was
about.**

The rewritten arm refreshes `b` — a key that is *not* the oldest — and asserts `size`, not only
order. The mutant then evicts `a` to make room for a key that was already present: `expected 2 to
be 3`. 🔴 **RED.**

> A green that has never been shown able to fail is not evidence — and neither is one whose fixture
> holds constant the very thing the claim varies.

### Cost when — at most 64 column sets per workspace, whatever the product count.

Previously: one per distinct `(family, saved column selection, coordinate, locale, account)` a user
opened, for the life of the process.

### Rollback — delete the constructor argument at both call sites. The parameter defaults to unbounded, so the class returns to its previous behaviour exactly.

### ⬜ Not done, and why

- ~~**15.3 (b)**~~ ✅ **BUILT under R-6.** See below.
- **15.3 (c) — Redis.** Marked *"Later"* in 15.3 itself. Untouched.
- 🟩 `TtlCache` (`utils/ttl-cache.ts:43`) was **already** bounded and already LRU. Not changed.


---

## OWNER RULING — 2026-09-22 (third set)

| # | Question | Ruling |
|---|---|---|
| **R-6** | 15.3 (b) — there is no existing PIM/sheet metrics route. Add one, or drop it? | ✅ **Option A. Add it under `/admin/`, behind an admin permission** |

### 15.3 (b) RESULT — BUILT

🆕 `GET /admin/pim/sheet-cache-stats` (`admin.ts`) returns `{ entries, max, ttlMs }`.

**Permission — no `preHandler`, and that is the correct wiring here.** 🟩
`permissions-manifest.ts:554` already maps the whole prefix:
`RW(F.adminView, F.adminRepair, pfx('/admin'))`. A GET therefore lands on **`admin.view`**.

🔴 **The trap this route had to avoid.** `/admin/health` is **PUBLIC** —
`permissions-manifest.ts:57` lists it by exact path. It is one of the unauthenticated monitoring
routes the 09-16 audit found. Copying the neighbouring route's shape would have published this one
too. *Being under `/admin/` is not the same as being behind admin.*

🔴 **It reports the CALLING business only.** A process-wide total would tell one business's admin
how many other businesses are cached, and `admin.view` is a business role, not a platform one.

### Gate — ✅ and proven able to fail

| Check | Result |
|---|---|
| `permissionForRoute('GET', '/admin/pim/sheet-cache-stats')` is `admin.view`, not `PUBLIC` | 🟢 in `sheet-columns-bound.vitest.test.ts` |
| Positive control in the same run: `/admin/health` really does resolve to `PUBLIC` | 🟢 — so a "not PUBLIC" pass means the manifest was read |
| **Mutation:** add the new path to the PUBLIC exact-path list at `:57` | 🔴 **RED** — *expected 'PUBLIC' not to be 'PUBLIC'* |
| RBAC coverage gate | 🟢 **2,724 routes · 0 UNMAPPED · 66 PUBLIC** — one more route than before, and the PUBLIC count did not move |

### Cost when — `flat`. One in-memory read, no query.

### Rollback — delete the route. Nothing reads it; the gate that proves the bound reads the exported function, not the endpoint.

---

## Step 15.11 RESULT — the scale fixture stands up, and the first thing it measured was Step 2.4

**Ranked #2 in [15.13](#1513--ranked-what-to-do-and-when):** *"Before Phase 2. Everything else is a
guess without it."* Built, run at **1,000 and 10,000 products**, and it produced a measured result
for Step 2.4 on its first run.

### What was built

| | |
|---|---|
| `apps/api/src/scripts/seed-scale-fixture.ts` | seeds a business: families, attributes, products, variations, listings, marketplaces, connections |
| `apps/api/src/scripts/measure-scale-fixture.ts` | times the column build, the sheet read and the readiness sweep — and **refuses to report** numbers it cannot stand behind |

```
DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/seed-scale-fixture.ts --prepare
DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/seed-scale-fixture.ts --products 10000
DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/measure-scale-fixture.ts --readiness-families 5
```

🟢 **Step 0.4 paid for itself here.** `bootstrap-fresh-database.mjs` stood `nexus_scale` up from
the baseline in seconds. The fixture seeds at **≈151 products/second** — 10,000 products and 30,000
listings in about a minute, so re-seeding is a habit rather than a decision.

### The numbers — 1,000 vs 10,000 products, same machine, same hour

| what | 1,000 products / 3,000 listings | 10,000 / 30,000 | grows? |
|---|---|---|---|
| **CONTROL** · instrument, `pg_sleep(0.25)` | 256 ms | 262 ms | 🟢 flat, as it must be |
| **CONTROL** · `ChannelListing.groupBy`, **no `where`** | **6 ms** | **154 ms** | 🔴 **×26** |
| **CONTROL** · the same `groupBy`, narrowed to a page | 5 ms | 4 ms | 🟢 flat |
| column build · master · COLD | 35 ms | **148 ms** | 🔴 linear in listings |
| column build · master · warm | 0 ms | 0 ms | 🟢 the cache works |
| column build · channel AMAZON · COLD | 6 ms | 125 ms | 🔴 |
| column build · channel EBAY · COLD | 7 ms | 131 ms | 🔴 |
| sheet row read · limit 25 (125 rows) | 95 ms | 212 ms | 🟠 |
| sheet row read · limit 200 (1,000 rows) | 155 ms | 158 ms | 🟢 paged, as designed |
| readiness reconcile · ONE family | 224 ms | 495 ms | 🔴 ×2.2 |

### 🔴 The first finding: Step 2.4's `where` clause is not a stopgap, it is the whole cost

At 10,000 products the **entire** cold column build is 148 ms and the un-narrowed `groupBy` alone
is 154 ms — the same number inside the noise. Narrowed, that query is **4 ms and does not grow**.

🟩 [15.4](#154--step-24-fix-the-line-and-measure-it) asked for exactly this: *"Record the query time
before and after. This is the biggest single query in the sheet read path and nobody has timed it.
Without a before, a win and a regression look identical."* **There is now a before.**

### The controls, because a timing that cannot move is not a measurement

| Control | What it proves | Result |
|---|---|---|
| **Instrument** — `pg_sleep(0.25)` through the same client and the same timer | the numbers are times | 🟢 **256–262 ms** for a 250 ms sleep |
| **Layer** — the same `groupBy` with and without a `where` | the harness separates two shapes of the same query | 🟢 **154 ms vs 4 ms** |
| **Scale** — the whole run at 1,000 and at 10,000 | the harness responds to the catalogue | 🟢 every catalogue-bound row moved; the two flat rows did not |

### 🟠 A control that was built, run, and DID NOT WORK

The first version injected a 250 ms sleep by assigning `prisma.channelListing.groupBy`. The run
came back **3 ms slower** — which reads as *"this query is not the cost"*, the opposite of the
truth.

🟩 The cause, measured: the app's client is a **Proxy** (`db.ts` → `contextualDatabase`), so the
assignment is silently discarded. `prisma.channelListing.groupBy === patched` is **`false`** and
the patched function is **never called** — the call counter read **0**.

> A control that cannot reach the layer it is aimed at returns a clean, confident, wrong negative.

### Gate — the tool refuses a number it cannot stand behind, and it was proven able to refuse

A measurement tool cannot be gated by a push hook; nothing pushes it. Its gate is that it exits
non-zero rather than print a number that would be wrong **in the direction of good news**.

| Refusal | Mutation | Result |
|---|---|---|
| 0 row-level-security policies | measure a database straight out of `bootstrap-fresh-database.mjs` | 🔴 **exit 1**, naming the cause and the fix |
| every channel readiness row is `absent` | set the fixture's `ChannelConnection` rows to `isActive = false` | 🔴 **exit 1** — *"the sweep never checked a channel"* |
| the reconcile wrote no channel rows at all | — | (same path) |
| 0 products visible | — | (same path) |
| instrument control outside 200–400 ms | — | (same path) |

### 🔴 The refusal that did not fire, and why it is the most useful thing here

The `absent` check first counted **the whole `ReadinessIndex` table**. With the connections
deactivated it stayed green: rows an **earlier** run had written answered for a run that had
checked nothing. The check now counts only the products **this run reconciled**, and then it fires.

> A stale measurement and a healthy one are the same reading. Scope the count to what the run
> actually touched.

### 🔴 What the fixture PINS — every number above is a floor

| Dimension | Held at | Why it matters |
|---|---|---|
| coordinates | **3** (`--coordinates`) | the sweep's cost is per destination; this is a multiplier on every sweep number |
| family size | **5 rows per root** (`--family-size`) | decides how many sweeps "10,000 products" means |
| cached Amazon spec | **none** — 🟩 verified, `nexus_scale` holds 0 `CategorySchema` and 0 `ChannelSchema` rows | the Amazon column build yields **3 columns** instead of the **163** the same build returns on a catalogue that has one, so the sweep has almost nothing to check |
| product type passed to the column build | **none** | 🔴 the measure script does not pass `productTypes`, so its channel builds are the 3-column shape even where a schema exists. **Its channel column-build numbers are a floor for that reason too** — see the second correction in the [15.3 RESULT](#step-153-result--the-column-set-cache-is-bounded-and-two-of-its-three-sibling-caches-already-were) |
| network | **loopback** | production pays a network hop this does not |
| requirements | all four of Step 2.1's arms | a fixture with only "required everywhere" cannot show 2.1 working *or* failing |
| fill | two thirds of required attributes | a uniformly complete catalogue cannot show completeness moving |

🔴 **So the reconcile's 495 ms/family is NOT a refutation of the plan's 4.087 s.** It is a
different, smaller measurement, and the gap is explained by the rows above.

### 🟠 Three defects in this lane's own code, and what caught each

| Defect | Caught by | Why it matters |
|---|---|---|
| The seeder derived a currency from the market code (`market === 'UK' ? 'GBP' : 'EUR'`) | 🟢 **`check-market-currency.mjs`, on the push** | The exact mistake that sent euro prices to Amazon Poland and Sweden. The fixture now copies `MARKETPLACES` row for row from `packages/database/scripts/seed-marketplaces.ts` |
| `process.exit(0)` placed **after** an unawaited `main()` | 🟠 a read-back: the run printed **nothing** and exited **0** | 🔴 A silent success that did no work. Nothing in the suite would have caught it; the script is not a test |
| Importing `seed-marketplaces.ts` **ran its `main()`** | 🟠 an unhandled rejection that killed the importer **mid-write**, after one marketplace had landed | A module-scope `main()` makes an import a write. It is now guarded to run only when invoked directly |

🟢 The first of those is a gate this programme already owned, refusing a change it had never seen.
That is what a gate is for, and it is worth recording as a pass rather than only as a nuisance.

### Done when — ✅

A seeded business exists at 1,000 and 10,000 products; the sweeps and the sheet read run against
it; every `Cost when` that was a guess now has a number or a stated reason it does not.

### Cost when — `flat` for the tools. Seeding is ≈151 products/second; the measurement run is under a minute.

### Rollback — `--wipe`. It removes only rows carrying `importSource = 'SCALE_FIXTURE'` or a `SCALE-` code prefix, and `nexus_scale` is a throwaway database.

### 15.11 (a) — done

All **25** steps now carry a `Cost when`. The four whose cost grows with the catalogue (2.2, 2.4,
2.7, 3.5) keep their numbers; every other step says `flat`.

### 15.12 — partly carried, and the rest stated

| Research number | Carried to | State |
|---|---|---|
| per-market column build **1.8–2.6 s cold** | Step 2.4 | 🟢 carried — and the fixture measures **148 ms**, 10× smaller. The research's market had cached channel specs |
| readiness cold start **~12 s** after a restart | Step 2.7 | 🟢 carried — ⬜ **not reproduced**: the fixture never restarts |
| mapping resolve **8 s timeout** while Redis connects | Step 2.3 / 3.5 | ⬜ **not carried** — no Redis in the fixture. Needs a step that owns it |
| payload ceiling **26.6 MB at 500 rows** | Step 3.2 | ⬜ **not carried** — the fixture times the read, it does not weigh the payload |
| **SSRM above 500 rows is NOT built** | Step 4.3 | ⬜ a fact, not a number; it has no `Cost when` to live in |
| **first paint never measured** | Step 4.0 | ⬜ **not carried** — needs a browser, which this harness has not got |

➡️ Four of the six need a browser, a Redis or a payload weigher. **Stated rather than quietly
dropped**, which is what 15.12 was complaining about in the first place.

---

## A-13 — 🔴🔴 A database built by Step 0.4's bootstrap has NO row-level security. FOR YOUR RULING.

**Found while building [15.11](#step-1511-result--the-scale-fixture-stands-up-and-the-first-thing-it-measured-was-step-24)'s fixture, by using Step 0.4 exactly as its own documentation says.**

### Measured, on two databases side by side

| | `nexus_development` (a real database) | `nexus_scale` (straight out of `bootstrap-fresh-database.mjs`) |
|---|---|---|
| row-level-security policies | **444** | **0** |
| tables with RLS enabled | **431** | **0** |
| `GRANT`s to `nexus_workspace_runtime` | present | **none** |
| `Workspace` rows | 2 | **0** |
| `ChannelListing.variationExcluded` | present | **absent** |

🟩 `packages/database/prisma/baseline.sql` contains **0 occurrences of `CREATE POLICY`**, **0 of
`ROW LEVEL SECURITY`** and **0 of `GRANT`**. It is a pure `schema.prisma` dump. The isolation layer
lives in `packages/database/scripts/workspace-policies.mjs`, which the bootstrap never calls.

### Why this is not academic

🟩 `packages/database/workspace-adapter.js:11` runs `SET LOCAL ROLE nexus_workspace_runtime` on
every query. On such a database the app dies with **`permission denied for table Product`** —
which is the *good* case, because it is loud.

🔴 **The dangerous case is someone fixing the loud one.** Add the `GRANT`s without the policies and
the application runs perfectly, with **every business able to read every other business's rows**.
The failure is a grant away from silent.

🔴 And a measurement taken on such a database is cheaper than production's, because every query
skips a per-row filter — it would read as good news.

### Step 0.4's gate could not have caught this

Its `Done when` is *"an empty database reaches 467 of 467 applied, in one run"* and its gate is the
from-zero replay. Both are about the **schema**. Neither connects the application, and neither
counts a policy. 🟩 The step's own *"What this does NOT do"* section does not mention isolation.

> The gate measured what the step built. It could not measure what the step **left out**.

### What 15.11 did in the meantime, so the fixture could exist

`seed-scale-fixture.ts --prepare` applies the `Workspace` row, the `variationExcluded` column and
`workspacePolicySql()` — byte-for-byte what `test-support/concurrent-database.ts:52-55` applies to
a disposable test database. The measure script **refuses to run** against a database with 0
policies, and that refusal is proven able to fire. 🔴 **This is a fixture-local workaround, not a
fix**, and it is deliberately not presented as one.

### Proposed — ➡️ needs your ruling

| # | Option | |
|---|---|---|
| **a** | **`bootstrap-fresh-database.mjs` calls `workspacePolicySql()` itself**, and its gate counts policies and refuses a zero. One database, one command, always isolated. | 🟩 **Recommended** — it is the same generator the test database already uses, so there is nothing new to keep in step |
| **b** | Put the policies into `baseline.sql` by regenerating it with them | 🔴 Rejected: `baseline.sql` is generated from `schema.prisma`, which cannot express a policy. It would need hand-editing every regeneration |
| **c** | Leave it, and document that the bootstrap is schema-only | 🟠 The cheapest, and it keeps a database one `GRANT` away from a silent cross-business read |

🔴 It touches a **closed step** (0.4) and the **database bootstrap**, so it is not mine to take.
**No code has been written for any of these three.**

---

## OWNER RULING — 2026-09-22 (fourth set)

| # | Question | Ruling |
|---|---|---|
| **R-7** | [A-13](#a-13----a-database-built-by-step-04s-bootstrap-has-no-row-level-security-for-your-ruling) — a bootstrapped database has 0 row-level-security policies | ✅ **Option (a). `bootstrap-fresh-database.mjs` applies the isolation layer itself, and its gate counts policies and refuses a zero** |

## A-13 RESULT — BUILT. One command now gives an ISOLATED database, and it is gated twice.

### What was built

`bootstrap-fresh-database.mjs` gained a **step 3**, applying the same three statements in the same
order as `apps/api/src/test-support/concurrent-database.ts:52-55`:

1. `ChannelListing.variationExcluded` — the deployed-only column, absent from `schema.prisma`.
2. The **`nexus_legacy_workspace` row, `status = 'active'`**. 🔴 The isolation policy *reads*
   `Workspace`, so without an active row every legacy row is invisible to every reader. The
   policies must not land before it.
3. `workspacePolicySql()` — **one generator**, now shared by the bootstrap, the disposable test
   database and the scale fixture's `--prepare`. Three callers, one home.

**Measured on a fresh database:**

```
[bootstrap] baseline applied — 446 tables
[bootstrap] marked 467 migrations as applied
[bootstrap] isolation applied — 443 policies on 430 tables, 1778 grants to nexus_workspace_runtime
```

🟢 **The end-to-end proof:** the scale fixture seeded **50 products and 150 listings** into that
database with **no `--prepare` step**. Before this, the same command died with *permission denied
for table Product*.

### Gate — two layers, and BOTH proven able to fail

| Layer | Where | Mutation | Result |
|---|---|---|---|
| The script refuses its own bad output | `bootstrap-fresh-database.mjs`, step 3 | skip `workspacePolicySql()` | 🔴 *"REFUSED: the isolation layer did not land — 0 policies, 0 RLS tables, 0 grants"*, **exit 1** |
| The push hook refuses a bootstrap that produced one | 🆕 4 tests in `baseline.vitest.test.ts`, already in the hook at `.githooks/pre-push:62` | skip the policies **and** disable the script's own refusal — the silent case A-13 was about | 🔴 **RED**: *expected 0 to be greater than 400*, twice |

🔴 **The second mutation is the one that mattered.** With the script's refusal left on, the suite
fails at `beforeAll` and the four assertions never run — `3 passed | 4 skipped`, with vitest
exiting 1. That is a real failure, but it does not show the *assertions* work. Disabling both
layers is what proved them.

🟠 **And the assertions are `> 400`, not `> 0`.** A single stray policy passes a `> 0` check. The
isolation layer covers 430 tables; a count that collapses to a handful is the failure being
guarded.

### Done when — ✅ measured

One command produces a database that is schema-correct **and** isolated, the application can use it
without further work, and both gates have been shown red.

### Cost when — `flat`. One extra script step; the gate builds one more throwaway database on push.

### Rollback — delete step 3 and the four tests. The baseline and the migration stamping are untouched, and `workspacePolicySql()` is idempotent, so re-running the bootstrap on a prepared database changes nothing.

### ⬜ What this does NOT do

- 🟩 It does **not** change `baseline.sql`. A schema dump cannot express a policy, which is why
  option (b) was rejected.
- ⬜ It does not audit **existing** databases. Any database bootstrapped before today still has 0
  policies. There is no inventory of those; `nexus_scale` was the only one this lane created, and
  it was prepared by hand.
- ⬜ The bootstrap applies **443** policies where `nexus_development` reports **444**. One policy
  differs and nobody has identified which. It is below the gate's `> 400` bar and is recorded here
  rather than quietly rounded away.

---

# PHASE 2 — amendments

## A-14 — Step 2.1's need is real and now MEASURED. Its chosen approach would be read by nothing.

**FOR YOUR RULING. Nothing built.**

### The need is real — and here it is, measured rather than argued

🟩 `family-sheet-schema.ts:38` is exactly as the step says:

```ts
const required = a.required && (a.channels?.length ?? 0) === 0
```

🟩 `schema.prisma:736-739` (the step says `:706-714` — **drifted**, substance unchanged) documents:
*"Channel codes where this attribute is required (when required=true). Empty array = required on
every channel."* The code therefore keeps only the everywhere case and **silently discards every
channel-scoped requirement.**

🔴 **Measured on the scale fixture**, which is the only catalogue that carries channel-scoped
requirements at all:

| seeded | `requiredBy` on master · DE |
|---|---|
| `material` · required, channels `[]` | `["Master"]` 🟢 |
| `browse_node` · required, channels `["AMAZON"]` | **`[]`** 🔴 |
| `search_terms` · required, channels `["AMAZON"]` | **`[]`** 🔴 |
| `ebay_category` · required, channels `["EBAY"]` | **`[]`** 🔴 |
| `season` · **not** required | `[]` |

**Five attributes marked required are indistinguishable from the ones marked optional.** That is
the defect, in a column model, on a real build.

### 🔴 But the step's chosen approach adds a SECOND requirement vocabulary

The step proposes *"return a requirement **object** per attribute — `{ everywhere: boolean;
channels: string[] }` — and let the column decide how to show it."*

🟩 **The column already has that vocabulary, and it is per coordinate.** `SheetColumn.requiredBy:
string[]` holds *who requires this*, and it already mixes both kinds:

| | |
|---|---|
| `sheet-columns.service.ts:557` | `requiredBy: input.familySchema && field.required ? ['Master'] : []` |
| `sheet-columns.service.ts:935` | `if (f.requirement === 'required') d.requiredBy.push(coordinate.label)` — e.g. `"Amazon · DE"` |

🟩 And **every** requirement reader keys off it:

| Reader | Line |
|---|---|
| `packages/shared/master-sheet.ts:88-95` `columnRequiredHere(column, coordinateLabel, …)` | `column.requiredBy.includes(coordinateLabel)` |
| `sheet-rows.service.ts:335` | `c.requiredBy.some(label => requiredHere(c, label, …))` |
| `studio-sheet.service.ts:1773` | `columnRequiredHere(c, coordinate.label, …)` |
| `variation-theme-facts.ts:149` | `column.requiredBy.indexOf(coordinateLabel) >= 0` |
| `catalog-transfer-export.ts:80`, `catalog-workbook-scopes.ts:13` | `col.requiredBy.length > 0` |

➡️ **A new `{ everywhere, channels }` object would be understood by none of them.** The sheet would
carry a correct requirement that readiness, the studio, the variation facts and both exports still
ignore. That is a duplicate — the exact shape **R1** forbids and the exact shape this whole plan
exists to remove.

### Proposed instead — no new vocabulary, and the readers need no change

1. **`family-sheet-schema.ts`** — stop collapsing. Carry each attribute's `channels: string[]`
   through. 🟩 It is already there: `EffectiveFamilyAttribute.channels`
   (`family-hierarchy.service.ts:60`) arrives intact and line 38 is the only thing that drops it.
2. **`sheet-columns.service.ts:557`** — seed `requiredBy` with `'Master'` for an
   everywhere-requirement, and with the **coordinate labels of the matching channels in view** for
   a channel-scoped one. An attribute required on `AMAZON`, with Amazon · DE and Amazon · IT in
   view, becomes `requiredBy: ["Amazon · DE", "Amazon · IT"]`.
3. 🔴 **There is a SECOND collapsed copy the step does not mention.** `master-sheet.ts:90` reads
   `column.familyRules[familyId].required`, written from the same boolean at
   `family-sheet-schema.ts:41`. Fixing line 38 alone leaves the Master coordinate still deciding
   from the collapsed value. **Both homes, or the fix is half done.**

The step's `Done when` then falls out of the existing code with nothing further:
Amazon coordinate in view → `columnRequiredHere` true; eBay coordinate → false; Shared → the
label list is already what Part 2.3's *"also required by Amazon · DE"* marker wants to render.

### 🟠 And a fact that changes what the GATE can be

🟩 Measured on the local catalogue: **486 `FamilyAttribute` rows, 0 with `required = true`, and 0
with a non-empty `channels` array.** So today line 38 discards **nothing**, and this fix changes
**no observable behaviour on any real catalogue** until D-A's data pass lands.

➡️ The gate therefore **cannot** be "the sheet changes". It must be the four arms as unit tests,
plus the scale fixture, which is the only catalogue carrying channel-scoped requirements — built
last night precisely so this dimension is not pinned. 🟢 The table at the top of this amendment is
that positive control already working.

### What I would do, on your word

| | |
|---|---|
| **(a)** ✅ **Recommended** — build Step 2.1 as amended above: two homes, `requiredBy`, four unit arms, and the fixture as the end-to-end control | |
| **(b)** Build it as the step is written, with the new object, and change all six readers to understand it | 🔴 Six files, and two vocabularies during the change |

🔴 **Step 2.1 part (b) — the data pass — stays blocked on [D-A](#part-9--the-decisions-i-need)**,
whose default is *"I derive the list from the channel schemas and bring it back for approval before
applying."* This amendment is only about part (a), the code.

---

## OWNER RULING — 2026-09-22 (fifth set)

| # | Question | Ruling |
|---|---|---|
| **R-8** | [A-14](#a-14--step-21s-need-is-real-and-now-measured-its-chosen-approach-would-be-read-by-nothing) — the new `{ everywhere, channels }` object, or reuse `requiredBy`? | ✅ **Option (a). Reuse `requiredBy`. Fix both homes. Four unit arms plus the fixture** |

## Step 2.1 (a) — BUILT. A family requirement scoped to a channel now survives.

### What the defect was, measured on both sides

| seeded on the scale fixture | `requiredBy` **before** | `requiredBy` **after** |
|---|---|---|
| `material` · required, channels `[]` | `["Master"]` | `["Master"]` |
| `browse_node` · required, `["AMAZON"]` | **`[]`** 🔴 | `["Amazon · DE"]` 🟢 |
| `search_terms` · required, `["AMAZON"]` | **`[]`** 🔴 | `["Amazon · DE"]` 🟢 |
| `ebay_category` · required, `["EBAY"]` | **`[]`** 🔴 | `["eBay · DE"]` 🟢 |
| `season` · not required | `[]` | `[]` |

### Built, in two homes because the fact was collapsed in two

1. 🆕 `FieldDefinition.requiredChannels?: string[]` (`field-registry.service.ts`) — the transport.
   `required` keeps its exact old meaning, **required everywhere**, so
   `familyRules[...].required` — read by `packages/shared/master-sheet.ts:90` for the Master
   coordinate — is untouched.
2. `family-sheet-schema.ts` — the collapse is gone. `everywhere` and `channels` travel separately.
3. `sheet-columns.service.ts` — `familyRequiredBy()` turns channel codes into **coordinate
   labels**. It is the only place that knows both the family's channels and the coordinates in
   view, which is why the conversion belongs there and nowhere else.

🟢 **No reader changed.** `columnRequiredHere`, `sheet-rows.service.ts:335`,
`studio-sheet.service.ts:1773`, `variation-theme-facts.ts:149` and both exports already decide by
asking whether `requiredBy` contains the coordinate they are looking at.

### Done when — ✅ measured, on the fixture and in units

| The step asks | Measured |
|---|---|
| required on Amazon → **required when the Amazon coordinate is in view** | `columnRequiredHere(browse_node, 'Amazon · DE') === true` |
| → **"required by Amazon" on Shared**, not a plain requirement | `requiredBy = ["Amazon · DE"]` and `columnRequiredHere(…, 'Master') === false` — the label list is what the marker renders |
| → **never plain "required" on a channel that does not want it** | `columnRequiredHere(browse_node, 'eBay · DE') === false` |
| a channel **not in view at all** | `ebay_category.requiredBy === []` with only Amazon in view — no invented coordinate |

### Gate — ✅ all four arms, proven able to fail three ways

`family-channel-requirements.vitest.test.ts`, 4 tests, in the suite that runs on every push.

| Mutation | Result |
|---|---|
| Discard the channels again (`const channels = []`) — the original defect | 🔴 **3 of 4 red** — *expected `['Master']` to deeply equal `['Amazon · DE']`* |
| The **obvious wrong fix**: `everywhere = a.required` alone | 🔴 **3 of 4 red** — *expected `['Master', 'Amazon · DE']` to deeply equal `['Amazon · DE']`*. This is the step's own **Rejected (a)**: it marks an Amazon-only attribute required on Shopify |
| Kill the coordinate-label loop in `familyRequiredBy` | 🔴 **3 of 4 red** — *expected `[]` to deeply equal `['Amazon · DE']`* |
| *(control)* the fourth arm — an attribute with **no** `channels` key — stays 🟢 through all three | correct: it must not change meaning |

### Cost when — `flat`. One loop over the coordinates already in hand, per master field.

### Rollback — restore the one line in `family-sheet-schema.ts`. `requiredChannels` is optional and `familyRequiredBy` degrades to the old `['Master']`-or-empty.

### ⬜ What this does NOT do, stated plainly

- 🔴 **Part (b), the data pass, is NOT done.** It is blocked on
  [D-A](#part-9--the-decisions-i-need). 🟩 Measured: the local catalogue has **486
  `FamilyAttribute` rows, 0 with `required = true`, 0 with a non-empty `channels` array.** So this
  change is **behaviour-neutral on every real catalogue today**. It is the mechanism; D-A is the
  data. The scale fixture is currently the only catalogue where it does anything.
- ⬜ **Family attributes are not columns in a CHANNEL scope at all** — `familySchema` is
  `scopeKind === 'master' && familyIds !== undefined` (`sheet-columns.service.ts`). Verified: a
  channel-scope build returns **no** family columns. The step's *"when the Amazon coordinate is in
  view"* is satisfied in the master/Shared scope, where every coordinate is in view. Whether
  family attributes should also appear in a channel scope is a different question and not this
  step's.
- ⬜ **Multi-family precision for a channel requirement.** With two families in view and only one
  requiring an attribute on Amazon, the column carries the Amazon label for both. `'Master'` is
  precise here because `master-sheet.ts:90` re-checks `familyRules[familyId]`; the channel path has
  no equivalent. Not worse than before — before, it was not reported at all — and out of the
  step's four arms. **Recorded, not fixed.**
- ⬜ 🟠 **A spec/family conflict is possible and untested.** `master-sheet.ts:91-92` returns early
  from the channel's own category facts. A column that is BOTH a family attribute and carries
  Amazon spec facts marked *not required* for that category would have the family's requirement
  suppressed. No such column exists on the fixture, so this is **stated, not measured**.
- ⬜ **Two exports now report an Amazon-only attribute as `required`** —
  `catalog-transfer-export.ts:80` and `catalog-workbook-scopes.ts:13` both read
  `requiredBy.length > 0`, which is scope-agnostic. Arguably right ("something requires it"), but
  it is a behaviour change and is recorded rather than assumed.

---

## A-15 — The column-set cache is bounded per business. But 64 businesses of it is 2 GB. FOR YOUR RULING.

**Found while checking a number I had already published. Nothing built.**

### The arithmetic, now that the per-entry size is measured

🟩 `workspace-cache.ts:22` bounds the number of **business buckets** at 64 — pre-existing, and it
predates this plan. [15.3](#step-153-result--the-column-set-cache-is-bounded-and-two-of-its-three-sibling-caches-already-were)
bounded each bucket at **64 entries**. So the worst case is `64 × 64 = 4,096` column sets, and a
real Amazon channel entry measures **473.9 KiB** of JSON, more in memory:

| | |
|---|---|
| **Before 15.3** | **unbounded.** 5,000 products opened ≈ 5,000 entries ≈ **2.4 GB**, and still growing |
| **After 15.3, realistic** | 1–3 active businesses × 64 ≈ 64–192 entries ≈ **30–90 MB** 🟢 |
| **After 15.3, worst case** | 64 businesses × 64 ≈ 4,096 entries ≈ **1.9 GB** 🔴 |

### What this does and does not change

🟢 **15.3 is still right and still the fix.** Unbounded → bounded is the whole difference between
a leak and a budget, and the 16 September incident was a leak.

🟢 **The cap of 64 is still the right number.** 🟩 `products-sheet.routes.ts:28` already holds 64 of
**these same objects, by reference**, and `studio-columns.ts:20` holds 128. A smaller cap in the
service would rebuild entries its own consumers keep alive and free nothing.

🔴 **The remaining exposure is the BUCKET count, not the entry count** — and it is not 15.3's, nor
this plan's. It is `workspace-cache.ts:22`, shared by all twenty-odd caches built on
`WorkspaceCache`. At 64 concurrently-active businesses the process holds 64 copies of everything.

### Proposed — ➡️ needs your ruling

| # | Option | |
|---|---|---|
| **a** | **Measure first, decide after.** `GET /admin/pim/sheet-cache-stats` already reports `entries` for the calling business. Add the **process-wide bucket count** to it (a count, never a list of businesses), watch production, and pick a number from data | 🟩 **Recommended.** Nobody knows how many businesses are ever hot at once. The number exists to be measured now |
| **b** | Lower the bucket cap from 64 | 🔴 Guessing again, and it hits every `WorkspaceCache` user including `idempotency.service.ts` |
| **c** | 15.3's own option (c): move the column-set cache to **Redis**, so replicas share one copy | The real fix, and much larger. 15.3 marked it *"Later"* |

🔴 A bucket count is a weaker cross-business signal than the process-wide entry total I refused in
15.3 (b) — but it is still one, so **option (a) needs your word, not mine.**

---

## OWNER RULING — 2026-09-22 (sixth set)

| # | Question | Ruling |
|---|---|---|
| **R-9** | [A-15](#a-15--the-column-set-cache-is-bounded-per-business-but-64-businesses-of-it-is-2-gb) — the bucket count | ✅ **Option (a). Report it, watch production, pick a number from data** |

## A-15 RESULT — BUILT. The second half of the memory bill is now visible.

`GET /admin/pim/sheet-cache-stats` gains `businesses: { held, max }`. The bill is
`entries × businesses` and only the first half was reported; one real entry measures **473.9 KiB**.

🆕 `WorkspaceCache.businesses` reads `this.buckets` **directly**. 🔴 It must never go through
`bucket()`, which moves the calling business to the newest slot **and creates a bucket when there
is none** — a diagnostic that invents the thing it measures. The `64` also became
`MAX_BUSINESS_BUCKETS`, because a second literal beside the first is a set claim that goes stale.

🔴 A COUNT, never the ids: this route is `admin.view`, a business role, not a platform one.

### Gate — ✅ and proven able to fail, on the arm that matters

| Mutation | Result |
|---|---|
| make `businesses` call `this.bucket()` first | 🔴 **RED** — *expected `{ held: 1, max: 64 }` to deeply equal `{ held: 0, max: 64 }`* |

🟠 **The first version of this gate could not have caught that.** It read the stats twice and
asserted the number had not moved — but if the first read creates a bucket, the second read finds
the one the first made, and both say `1`. The test now asserts an **empty** cache reports `0`, and
that asking **from a business that has no bucket** does not give it one. The weak check is gone,
with a note saying why, because the same mistake has now been made twice in this programme.

### Cost when — `flat`. One `Map.size` read.

### Rollback — drop the `businesses` field. Nothing depends on it; it exists to be watched.

### ⬜ Not done — the cap itself is unchanged

64 buckets × 64 entries stands. That was the point of (a): **measure before deciding.** Option (c),
moving the cache to Redis so replicas share one copy, remains the real fix and remains out of scope.

---

## A-16 — D-A derived, and the measurement changes the question. FOR YOUR RULING.

**The list is in [`D-A-PROPOSAL.md`](D-A-PROPOSAL.md), generated by
`apps/api/src/scripts/derive-required-attributes.ts`. Nothing was written to any database.**

Derived exactly as D-A recommends — *"what a channel refuses a publish for"* — by asking
`getSheetColumns` per cached coordinate rather than parsing schema JSON, so it is the channel's own
derivation and not a second one.

### What came back

| | |
|---|---|
| cached coordinates read | **49** of 58 (9 could not be read, each named in the proposal) |
| distinct fields a channel requires | **19** |
| …that are **dictionary attributes** (a `FamilyAttribute` row is possible) | **5** |
| …that are **native product fields** (`name`, `description`, `brand`, `price`, `quantity`, …) | **14** |

The 5: `supplier_declared_dg_hz_regulation`, `fabric_type`, `color`, `material`, `size` — all
Amazon, all already attached to at least one family.

### 🔴 And then the measurement that changes the question

Step 2.1 says *"'Ready 100%' is true for everything and means nothing."* Measured today, with
**0 `FamilyAttribute` rows marked required**:

| scope | required columns |
|---|---|
| **Amazon · DE, product type `OUTERWEAR`** (channel scope) | 🟢 **8 of 163** — `productType`, `brand`, `name`, `description`, `bulletPoints_1`, `fabric_type`, `country_of_origin`, `supplier_declared_dg_hz_regulation` |
| **Shared / Master**, one family | 🔴 **1 of 101** — `name`, and nothing else |

➡️ **The premise is false on a channel coordinate and true on Shared.** The channel-spec path
already supplies requirements and already reaches `columnRequiredHere`. What is empty is the
**Shared** scope, which has no source of requirements but `FamilyAttribute`, and there are none.

➡️ **So writing the derived 5 as `FamilyAttribute` rows adds nothing where they came from.** On
Amazon they are already required. The only thing such a row changes is whether they are *also*
required on **Shared** — which is a business decision about your own bar, not something a channel
schema can answer.

### ➡️ The ruling I need — what is Shared's bar?

| # | Option | |
|---|---|---|
| **a** | **Mirror.** Mark the 5 required on the channels that demand them. Shared then shows *"also required by Amazon · DE"* — exactly Part 2.3's marker, and exactly what [Step 2.1 (a)](#step-21-a--built-a-family-requirement-scoped-to-a-channel-now-survives) built the mechanism for. Adds no new requirement anywhere; it makes an existing one visible on Shared | 🟢 **Recommended.** Cheap, reversible, derived rather than invented, and it puts the mechanism to work |
| **b** | **Mirror AND raise.** Also mark some of them `channels: []` — required everywhere, including channels that never asked. That is the business's own bar, and **no schema can derive it** — it needs your list | 🔴 Not derivable. I would be guessing |
| **c** | **Neither yet.** Leave requirements to the channels and let Shared stay a projection | Honest, but leaves the Shared completeness column meaningless, which Phase 4 depends on |

🔴 **[Step 2.7](#step-27--run-the-readiness-reconcile-on-production) is affected either way.** Its
order rule — *"after 2.1, so it computes against real requirements"* — was written believing there
were none. On a channel coordinate there already are. On Shared there are not. **A reconcile run
today would be right about channels and empty about Shared.**

### ⬜ Stated, not hidden

- **9 coordinates could not be read**, all `no coordinate` — the market is not active locally
  (BE, NL, UK). Their requirements are unknown, not absent.
- **Local cache only.** 183 cached schemas across 11 coordinates. Production may hold more, and the
  same script run there would return a larger set. This list is a floor.

---

## OWNER RULING — 2026-09-22 (seventh set)

| # | Question | Ruling |
|---|---|---|
| **R-10** | [A-16](#a-16--d-a-derived-and-the-measurement-changes-the-question-for-your-ruling) — what is Shared's bar? | ✅ **Option (a). Mirror.** Mark the derived attributes required on the channels that demand them. No new requirement anywhere; the channel's existing one becomes visible on Shared |

## Step 2.1 (b) — APPLIED, on the local catalogue. Production is untouched.

### 🔴 Where this ran, first, because it is a data write

**`nexus_development`, the local development database.** 🔴 **No production database was opened,
and nothing on this branch is merged or deployed.** Applying the mirror to production is a separate
run against a separate database and needs its own word from the Owner — the same bar
[Step 2.7](#step-27--run-the-readiness-reconcile-on-production) sets for its own write.

### The rule the mirror actually used

`derive-required-attributes.ts --apply`. For each derived attribute, for each family it is attached
to: mark it required with `channels: ['<the channel that asks>']` **only when that family holds a
product of a product type the channel asks for.**

🔴 **That per-family check is not decoration — it did the work.** Of 12 candidate rows, **7 were
skipped** because the family holds none of the relevant product types. Without it the mirror would
have written 12 rows, 7 of them requiring outerwear's fields of families that sell no outerwear. *A
derivation applied bluntly is still a guess.*

### Measured, before and after, on family `cmtny43jv002jnjfbb6hnijqx` (COAT + OUTERWEAR)

| | before | after |
|---|---|---|
| `FamilyAttribute` rows marked required | **0** | **5** |
| **Shared / Master** required columns | 1 (`name`) | **1 (`name`)** — unchanged, as ruled |
| **Amazon · DE** required, in the Shared build | **0** | 🟢 **1** — `supplier_declared_dg_hz_regulation` |
| eBay · DE / Shopify / Etsy | 0 | **0** — they never asked |
| the mirrored column's `requiredBy` | `[]` | `["Amazon · DE"]` |
| …and its `defaultVisible` | `false` | 🟢 `true` |

➡️ **Exactly what option (a) promised.** Shared gains the *"also required by Amazon · DE"* fact and
gains no plain requirement of its own. eBay, Shopify and Etsy are untouched — the third arm of Step
2.1's gate, now demonstrated on real data and not only in a unit test.

🟢 **This is the first time Step 2.1 (a)'s mechanism has carried a real requirement.** Until now it
was correct and idle.

### Rollback — ✅ EXERCISED, not described

`--revert` sets `required = false, channels = []` on exactly the rows carrying a channel list —
which is the state all 486 rows started in.

| | |
|---|---|
| revert | `reverted 5 of 5` → marked required **0**, `requiredBy` `[]`, `defaultVisible` `false` |
| re-apply | `WROTE 5 rows` → back to **5**, `["Amazon · DE"]`, `true` |
| re-run `--apply` again | `MIRROR — 0 rows would be marked` — **idempotent** |

Each step was confirmed by **reading the state back**, never by trusting the exit code.

### Gate

The mechanism's gate is Step 2.1 (a)'s four arms, which run on every push. The data has no gate and
cannot have one — it is a decision, not an invariant. What it has instead is a derivation that can
be re-run and a revert that has been exercised.

🔴 The script **refuses to overwrite** a row that is already required with a different channel
list; it reports it and skips. Nothing this lane wrote was a change to somebody else's decision.

### Cost when — `flat`. Five row updates.

### ⬜ Still open

- 🔴 **Production.** Same script, same ruling, a different database, and **your word**.
- ⬜ **9 coordinates unreadable** (BE, NL, UK not active locally). Their requirements are unknown,
  not absent, so the list is a floor. Running this on production would read more.
- 🔴 **[Step 2.7](#step-27--run-the-readiness-reconcile-on-production)'s ordering rule should be
  re-read.** It says *"after 2.1, so it computes against real requirements"*, written believing
  there were none. A reconcile now computes real requirements on channel coordinates and on Shared
  still sees only `name`. **2.7's premise deserves its own check before it runs.**

---

## Steps 15.1 + 15.6 — BUILT. The sweep is bounded by design, and there is one helper, not three.

**Ranked #3 and #4 in [15.13](#1513--ranked-what-to-do-and-when):** *"Before Step 2.7. The step
cannot pass otherwise"* and *"Same work as 3. Do them together."* Built together.

### 15.6 — one resumable-sweep helper

🆕 `apps/api/src/services/pim/resumable-sweep.ts`. Its contract is 15.6's, verbatim: a resume
point, a wall-clock budget, and a **dry run that reports counts** with writing as the thing a
caller has to ask for. Three sweeps (2.1, 2.6, 2.7) had the same hazards and one of them carried
*"rehearse first"* as a footnote. **R2: the rule goes in the engine.**

🟢 **The checkpoint is DERIVED, so there is no new column and no migration** — which matters,
because a migration gets its own branch and its own merge and may never ride with code. `nextBatch`
is re-queried and returns only outstanding work; finishing a unit removes it. **A crash mid-unit
leaves that unit outstanding, so it is retried rather than skipped** — the case a stored cursor
gets wrong.

### 15.1 — the readiness reconcile

| # | 15.1 asks for | Built |
|---|---|---|
| **a** | split the backfill off the cron | 🆕 `apps/api/src/scripts/readiness-backfill.ts` — dry run by default, `--apply --budget <s>`, run it again to continue |
| **b** | a wall-clock budget, resume on the next tick | `NIGHTLY_BUDGET_MS = 10 min`. The 11-hour run cannot happen at any product count |
| **c** | incremental — only families that need it | A family is due when its readiness is older than a **20-hour** horizon. Never 24: a horizon equal to the period races its own schedule |

🟠 15.1 also said *"reuse `runWorkspaceTick`'s renewing-lease idea"*. **Not needed.** The existing
30-minute cron lock is now three times the budget instead of a bet on the catalogue staying small.
No second lease was invented — which was the actual instruction.

### Measured on the 10,000-product fixture — 2,000 family roots

| chunk | budget | families | `ReadinessIndex` rows | stopped |
|---|---|---|---|---|
| 1 | 60 s | 408 | 125 → 10,325 | `budget` |
| 2 | 60 s | 275 | → 17,200 | `budget` |
| 3 | 60 s | 258 | → 23,650 | `budget` |
| 4 | 60 s | 284 | → 30,750 | `budget` |
| 5 | 120 s | 706 | → 48,400 | `budget` |
| 6 | 120 s | 64 | → **50,000** | 🟢 `complete` |
| 7 | 120 s | **0** | 50,000 → 50,000 | 🟢 `complete` — idempotent |

🔴 **The resume is proven by the ROW COUNT, not by the label.** A run that restarted would rewrite
the same families and leave the total flat. It rose by exactly `families × 25` every chunk.

**Total: 10,000 products reconciled in ≈6.2 minutes of bounded chunks**, against the plan's
projected **11.4 hours**. 🔴 **That is not a refutation.** The fixture holds three coordinates and
no cached Amazon spec, so a family costs ~300 ms here against the 4,087 ms the codebase recorded on
a real one. What the number shows is the SHAPE: bounded, resumable, and it reaches `complete`.

🟠 **Throughput per chunk: 408, then 275, 258, 284.** The skip walk costs something after the first
chunk and then stops growing — measured, because "it will degrade" was a guess worth checking.

### Gate — ✅ 16 tests, proven able to fail FOUR ways

| Mutation | Result |
|---|---|
| remove the per-unit budget check | 🔴 **RED** — 1 failed |
| flip the dry-run default to write | 🔴 **RED** — 2 failed |
| remove the attempted-set (the retry hot loop returns) | 🔴 **RED** — 6 failed |
| ignore the freshness probe (no checkpoint) | 🔴 **RED** — 2 failed |

### 🔴 Two defects the tests found in this lane's own code

1. **A failed unit was retried forever inside one run.** `nextBatch` is re-queried, so a failure
   came straight back at the same position: `['a','b','c','b','b','b', …]` — three units,
   twenty-seven attempts, and the run abandoned on a failure budget spent entirely on one record.
   Retry belongs on the **next** run. Fixed with an attempted-set that also looks further ahead, so
   a failure early in the order cannot hide the work behind it.
2. 🟠 **The first budget mutation ESCAPED.** Deleting the per-unit check left every test green,
   because with a small batch size the next *boundary* check fired first. There are two budget
   checks and only one was exercised. A new arm sweeps with `batchSize: 100` over 8 units, where no
   boundary can arrive — and it goes red.

> A gate with two paths needs two arms. One of them was decoration until it was mutated.

### Cost when — the nightly run is **10 minutes, full stop**, at any product count. The backfill is chunked and resumable.

### Rollback — the job's previous form is one file in git history; the helper and the CLI are additive and read by nothing else yet.

### ⬜ Stated, not hidden

- 🔴 **At a real 4,087 ms per family, a 10-minute nightly budget covers ~150 families.** A 2,000-root
  catalogue then refreshes on a **rotation**, not nightly-in-full. That is what "bounded by design"
  costs, and it is the right trade — but it is a change in meaning, not just in runtime, and
  [Step 2.7](#step-27--run-the-readiness-reconcile-on-production) should read it before it runs.
- ⬜ **The 20-hour horizon is a constant, not a setting.** It has no test for the rotation case
  above, because that needs a catalogue bigger than a unit test.
- ⬜ **15.6's helper has ONE caller.** Steps 2.1 and 2.6 are meant to use it too. 2.1's data pass
  was 5 rows and needed no sweep; 2.6 has not been built.

---

## Step 2.4 (with 15.4) — BUILT. One query was the whole page, and it was answering two questions.

### What it was

🟩 `sheet-columns.service.ts` ran **one un-narrowed aggregate over `ChannelListing`** and fed two
different facts from it. The Owner's words for the result: *"a schema that changes when someone
else sells something."*

🔴 And it was the cost of the page. Measured on the scale fixture: **6 ms at 3,000 listings,
154 ms at 30,000**, against a whole cold column build of **148 ms**.

### The two questions, separated

| | |
|---|---|
| **`present`** — which coordinates **these products** are on | narrowed by the new `productIds`. This is the correctness half |
| **`availableMarkets`** — which markets the **catalogue** carries, for the operator's market switcher | 🔴 **must NOT be narrowed.** It keeps its global meaning and gets its own cache, 4 entries, same TTL |

🔴 **That second row is the trap this step could have walked into.** Narrowing both would have
shrunk the market dropdown to whatever the current page happens to sell on. The old code's own
comment said `availableMarkets` was *"derived from the presence query this service already runs"* —
a documented coupling between two facts that were never the same fact.

### Built, per [15.4](#154--step-24-fix-the-line-and-measure-it)

1. 🆕 `GetSheetColumnsInput.productIds` — **explicit**, as 15.4 insisted, not `familyIds`, which
   means something narrower and is only set on the master scope. **In the cache key**, because it
   changes the result.
2. 🆕 `catalogueMarkets()` — its own cache. A cold column build pays the catalogue query once per
   TTL instead of once per family opened.
3. `sheet-rows.service.ts` passes the page's own product ids. It already had them one line later.
4. 🆕 **R4: the absence is stated.** `SheetColumnSet.coordinatesNotListed` names the coordinates
   this market has that the products in view are not on, and `MasterSheet.tsx` renders it as a
   *"N not listed"* pill with the reason. 🔴 *"A column that vanishes is worse than one that states
   why"* — shipped **with** the narrowing, as the step demands, not after it.

### Measured — the before and after 15.4 asked for

**Ten different pages of 25 products, 10,000-product fixture, 30,000 listings:**

```
per-page cold column build, ms: 187, 7, 6, 6, 6, 5, 6, 5, 5, 9
```

| | |
|---|---|
| **before** — every page | **~150–324 ms**, growing with the catalogue |
| **after** — first page (catalogue-markets cache cold) | 187 ms |
| **after** — every page thereafter | 🟢 **6 ms**, and flat |

**≈25× on the sheet's own read path, and it no longer grows with the catalogue.**

### Gate — ✅ 6 tests, proven able to fail FOUR ways

The step asks for *"a test asserting the Shared column set for a product with no Amazon listing
contains no Amazon-only attribute, with a positive control — the same product WITH an Amazon
listing must show the marker."* Both are in `shared-scope-narrowing.vitest.test.ts`.

| Mutation | Result |
|---|---|
| remove the narrowing (the original defect) | 🔴 **3 of 6 red** |
| narrow `availableMarkets` too (the trap above) | 🔴 **RED** — the market switcher loses FR and IT |
| stop stating the absence (R4) | 🔴 **RED** |
| drop `productIds` from the cache key | 🔴 **RED** — two product sets share one column set |

### 🟠 A behaviour change I made and then took back

`catalogueMarkets()` was at first called unconditionally. That gave `includeEmptyChannels` callers
a real market list where they have always seen `[]` — arguably better, and **not what this step
claims to do**. Caught by `channel-specs/store.vitest.test.ts`, whose mock has no `groupBy`
implementation *precisely because that path never called one*. The old behaviour is preserved and
the quirk is named in the code.

### Cost when — the `groupBy` is **recorded before and after**: ~150 ms → **6 ms**, and flat in the catalogue.

### Rollback — remove `productIds` from the two callers. With it absent the presence check keeps its old catalogue-wide behaviour by design, so the union returns without touching this file.

### ⬜ Not done — and it is the bigger half

🔴 **Move 2 is not built.** The step's real fix is *"the family decides Shared's columns; a channel
attribute lives on its channel, and Shared carries a read-only 'also required by Amazon · DE'
marker."* What shipped is move 1, which the step itself calls the one-line stopgap — now with a
`where`, a cache split, a stated absence and a measurement.

🟩 **Step 2.1 (a) already built the marker's mechanism**, so move 2 has its foundation. It is a
column-ownership change and deserves its own step.

⬜ **`studio-columns.ts` does not pass `productIds`.** The studio is per product and could. Left
alone because the studio sheet has its own cache keyed on the product already, and changing two
read paths in one step is how a measurement stops being attributable.

---

## Step 2.2 — PART ONE BUILT. The price door is now compile-time mandatory.

### 15.5 (c) — ANSWERED, and it was the blocker

*"Check whether the reconcile bumps `ChannelListing.version`. If it does, Step 2.7 and this step
fight."* Measured on the fixture, one family, 15 listings:

| | |
|---|---|
| **positive control** — a deliberate bump, to prove the instrument can see one | 🟢 **visible** |
| listings whose `version` moved after a reconcile | **0 of 15** |
| listings whose `updatedAt` moved | **0 of 15** |

🟢 **They do not fight.** The reconcile writes `ReadinessIndex` and nothing else. 15.5 (c) is
closed, and it is closed with a control rather than by reading the code and feeling sure.

### The compiler's audit — and it found a caller the step does not name

Making `expectedVersion` required listed every caller that omits it, which is the step's own method:
*"That list IS the audit — no grep, no set claim that goes stale."*

| Caller | Named in the step? |
|---|---|
| `product-channel-data.routes.ts` (`PATCH /channel-pricing`) | yes (at `:187`; it is now `:180`) |
| 🔴 **`pricing.routes.ts` bulk override** | **no.** A third unguarded price writer |
| `matrix-write.service.ts` | passes a real version already, as the step says |

### 🔴 The step's Rejected (c), taken seriously

*"Defaulting `expectedVersion` to the row's current version — that is a compare-and-set that always
succeeds. It looks safe and is not."*

Both unguarded callers already fetch the listing. Reading its version and passing it would have
satisfied the compiler and **built the rejected thing with extra steps**. So the type refuses that
shape instead:

```ts
export type PriceWriteTarget =
  | (Fields & { expectedVersion: number; unguardedReason?: never })
  | (Fields & { expectedVersion?: never; unguardedReason: PriceWriteUnguardedReason })
```

A caller with no operator-seen version must **name** why, from a closed set — `'bulk-override-snapshot'`,
`'legacy-channel-pricing'` — and every outcome now carries **`guarded: boolean`**, so an unguarded
write cannot look like a checked one afterwards. Adding a third reason is a decision somebody makes
on purpose, in a type, in a diff.

### 15.5 (a) — the unbounded `IN` list

`where: { id: { in: ids } }` had no limit; a 5,000-row edit was one enormous list, twice (the same
ids went to `readSaleWindows`). Now chunked at 500.

### 🔴 A silent defect I wrote, and what caught it

Joining the chunks, I merged the sale-window results with `Object.assign`. **`readSaleWindows`
returns a `Map`.** `Object.assign` on a Map type-checks and merges **nothing** — every existing
sale window would have read as absent.

The symptom is not a crash. It is a **re-submit of the same sale being treated as a change and
written again** instead of being the no-op it is. Silent, and only on edits big enough to chunk.

🟠 **And my first mutation run did not catch it** — the chunk test asserted row counts, which do not
depend on the windows. A second arm asserts `600 noop, 0 applied` on a chunked re-submit, and the
mutation goes red: *expected 0 to be 600*.

### Gate — ✅ 6 tests, proven able to fail FOUR ways

| Mutation | Result |
|---|---|
| `guarded` always `true` (an unguarded write hides) | 🔴 RED |
| the compare-and-set removed | 🔴 RED |
| chunking removed | 🔴 RED |
| the Map merge broken again | 🔴 RED |

🟠 **The profiles-ON ratchet refused the first version of this file** for running without a
business. Production runs with profiles on; the tests now go through `withWorkspace`, and that
exposed a second thing — with profiles on the write path reads the row back **inside** the
transaction, which a stub with only `updateMany` never sees.

### Cost when — chunked at 500 per read. The 5,000-row single-call contract is not yet exercised end to end; see below.

### Rollback — make `expectedVersion` optional again and drop `unguardedReason`. The two callers' named reasons become dead and the compiler says so.

### 🔴 WHAT IS NOT BUILT — the rest of Step 2.2

1. **The sheet still bypasses the door.** `bulk-edit.service.ts` writes `price` through
   `channelValueMutation`, so a price typed in the sheet still skips the enqueue. 🔴
   [A-12](#a-12--the-write-half-was-reverted-and-the-reason-is-worth-more-than-the-code) is
   explicit about the cost: `ebay_price` is this repo's canonical fixture for a mapped channel
   field, and touching it broke **19 arms across 3 files** last time. A-12's proposal is to refuse
   the bypass *at the price door* and delete the column hold in the same change. **That is a
   fixture migration, not a line, and it is deliberately not squeezed onto the end of this one.**
2. **[Step 1.5](#step-15--make-the-sheets-price-cell-read-only-today)'s hold is still on.** It
   lifts when (1) lands — that is what the step promises.
3. **The real concurrency gate.** The step demands *"a concurrency test asserting the second write
   returns `conflict`, on `concurrent-database.ts`, never on PGlite."* The six tests here are
   contract arms on mocks. 🔴 **The concurrency arm is NOT written**, and it is the one the step
   names.
4. **15.5 (b)** — see the amendment below.

⬜ **Observed, not caused:** `mapping/formula-database.vitest.test.ts` failed twice in four full
suite runs, at ~10 s, and passes alone and on re-run. PGlite is one connection; it looks like a
timeout under parallel load. **Recorded rather than ignored** — a gate that fails one run in two is
on its way to being disbelieved.

---

## A-17 — 15.5 (b) asks for a retry that defeats the guard. FOR YOUR RULING.

15.5 (b): *"On `conflict`, re-read those rows once and resubmit automatically; show the user only
what still conflicts."*

🔴 **Re-reading and resubmitting is the lost update `expectedVersion` exists to prevent.** If a row
conflicted, somebody else changed it. Re-reading takes their version and writing over it discards
their change — quietly, in bulk, and with the audit recording it as `applied`.

The problem 15.5 (b) is really pointing at is real: *"without it, one stale version turns a
5,000-row edit into 5,000 red rows."* But 🟩 the service already returns **per-row outcomes**, so a
conflict on one row has never failed the others. The auto-retry adds no resilience — only the
overwrite.

### What would actually solve it

A conflict today cannot tell **"someone changed this price"** from **"this row's version moved for
an unrelated reason"** — a quantity write bumps the same `version`. The caller does not say what it
believed the price was, so the service cannot tell the two apart.

| # | Option | |
|---|---|---|
| **a** | 🆕 Add `expectedPrice` to the target. On a version conflict, if the stored price still equals `expectedPrice`, **nobody touched the price** — retry safely. Otherwise, conflict stands | 🟢 **Recommended.** It retries exactly the case that is safe, and never the case that is not |
| **b** | Build 15.5 (b) as written | 🔴 A lost update by design |
| **c** | Leave it. Per-row outcomes already stop one conflict failing 4,999 good rows | Honest, and the cheapest |

🔴 Nothing built for any of these. **Step 2.2's `Cost when` — a 5,000-row edit in one call — is
not yet exercised end to end either way.**

---

## A-18 — The price door does not preserve the sheet's reset cleanup. ✅ APPROVED (R-11) — BUILT below.

**2026-09-22. Found before Step 2.2 part 2; product code unchanged at `7221436aa`.**
The Owner's stop-and-amend rule applies: routing the sheet to the existing door would drop
behaviour its reset already has. A-12 named reset coverage, but did not identify this difference.

### The two writers disagree — checked at the lines

| Existing path | What it does |
|---|---|
| `channel-field-map.ts:78` — `channelOverrideKeys('ebay_price')` | Derives the legacy keys `price` and `ebay_price` |
| `bulk-edit.service.ts:1783-1786`, `:1864-1870` | Uses that key list and removes those keys from `overrideData`, scoped to product, channel, market, account and alias, in the sheet transaction |
| `channel-price-write.service.ts:173` | Clears `price` and `priceOverride`, restores `followMasterPrice`, but leaves `overrideData` untouched |
| `channel-price-write.service.ts:158-160` | Returns `noop` when already following with no explicit price override, even if legacy price keys remain |
| `attribute-resolver.ts:259-264` | Applies `overrideData` first; following master skips the explicit price columns but does **not** remove the bag's price |

### Reproduced, with a control and two arms

The probe uses **`concurrent-database.ts`**, which creates and drops a disposable local PostgreSQL
database with the isolation layer. The price service, persistence and raw resolver are real.
Only outbound job dispatch is mocked; the queue rows themselves are written and read back.
Neither the local catalogue nor `nexus_scale` nor production was changed.

Fixture: base price `10`; `overrideData = { price: 99, ebay_price: 98, unrelated: 'keep' }`.
The prediction, asserted before the run: reset removes both price keys, retains `unrelated`, and
the raw resolver no longer reports the bag's price.

| Arm | Observed |
|---|---|
| **Control:** persist the current sheet's `channelValuePatch(..., 'INHERIT')` | Both legacy keys removed; `unrelated` retained; raw resolved `price` absent. **PASS** |
| Price door: pinned price `25` → reset | `applied`; price columns null; following true; **both legacy keys remain**; raw resolver returns `99`; **one event and one queue row**, whose price is `10`. **FAIL** |
| Price door: already following, price columns null → reset | `noop`; **both legacy keys remain**; raw resolver returns `99`; **zero events and queue rows**. **FAIL** |

**Profiles OFF: 2 failed, 1 passed. Profiles ON: 2 failed, 1 passed.** These are assertion
failures, not skipped tests or a load failure. The first probe omitted `Marketplace.languages`
and failed in its scaffolding; that run is not evidence. Supplying the coordinate's language
produced the results above.

The existing `price-door.vitest.test.ts` and `ebay-price-held.vitest.test.ts` still report
**12 passed** on the unchanged product code. They do not cover this cleanup. No full-suite green,
concurrency proof or step closure is claimed by that focused run.

Evidence: [probe source](probes/A-18-price-door-reset.vitest.test.ts.txt) and
[profiles-ON output](probes/A-18-profiles-on.log.txt). The probe is archived as text so a known
red diagnostic is not installed as a permanent failing push gate. To reproduce, copy it to
`apps/api/src/services/pim/price-door-reset.probe.vitest.test.ts`, then, **from `apps/api`**, run:

```sh
NEXUS_WORKSPACES_ENABLED=1 npx vitest run src/services/pim/price-door-reset.probe.vitest.test.ts --disableConsoleIntercept --reporter=verbose
```

Remove that temporary copy afterwards; keep the archived evidence.

### Proposed amendment to Step 2.2 part 2

**(a), recommended:** move the sheet's existing legacy-price cleanup into the price door as part
of the handoff, including its no-op decision. A reset with residual price keys is an **applied
cleanup**, guarded on the listing version, with the price columns, audit/event and enqueue in
the same transaction. Derive the key list from the existing storage contract; remove only those
keys atomically, preserving unrelated JSON and account/alias isolation. A clean repeat remains
`noop`. Then route both sheet price paths through the door and remove the column hold together,
as already ordered. Keep A-17's retry work separate.

**(b):** leave the door unchanged and retain the sheet hold until this reset behaviour is settled.
Simply routing reset to it would lose the cleanup demonstrated by the control.

- **Done when** — both reset arms remove the stale keys, a clean repeat is a no-op, unrelated
  values and other listings survive, and the sheet's set/reset paths use the price door.
- **Cost when** — the cleanup is bounded to the addressed listing and declared price keys.
  Step 2.2's **5,000-row** call still needs its measurement; this three-row probe does not close it.
- **Gate** — preserve both reset arms plus the clean-repeat control. Prove separate mutations
  fail for removing cleanup and for skipping cleanup on the already-following path. Keep the
  stale-version, account/alias and non-price controls required by A-12. The concurrency gate
  remains a separate queued task; this probe is **not** a concurrency test.
- **Rollback** — revert the handoff and cleanup together and restore the eBay column hold.
  No migration or catalogue sweep is proposed.

**Limits:** this proves a persisted-state and raw-resolver difference on a deliberately seeded
listing. It does not count affected production rows or establish which visible sheet cells or
publish builders expose it; some readers apply later mappings. No production access was needed.

**Approved by the Owner: option (a), 2026-09-22. Implementation and gates pending; no step closed.**

## OWNER RULING — 2026-09-22 (eighth set)

| # | Question | Ruling |
|---|---|---|
| **R-11** | A-18 — preserve the sheet's legacy-price reset cleanup at the price door? | ✅ **Option (a).** Both dirty reset paths are applied, version-guarded cleanups in the price transaction; clean repeats remain no-ops. Route sheet set/reset through the door and remove the column hold together. A-17 remains separate. |

---

## Step 2.2 part 2 — BUILT (A-18 / R-11). The sheet now writes prices through the one door.

**2026-09-22, second session on this lane.** The eBay price hold (Step 1.5) is lifted in the same
change, as ordered.

### What was built

| Where | What |
|---|---|
| `channel-price-write.service.ts:162-165` | Legacy price keys come from the storage contract (`channelOverrideKeys`). A listing whose `overrideData` holds one is **dirty**; a dirty reset or set is a write, even when the columns already follow master |
| `channel-price-write.service.ts:187` | After the version compare-and-set succeeds, the door removes **only** those keys, in the same transaction. Unrelated JSON stays |
| `channel-price-write.service.ts:224` | The job dispatch now waits for the outer commit (`afterDatabaseCommit`). A rolled-back sheet save dispatches nothing |
| `bulk-edit.service.ts:1263-1276` | A sheet price edit (`ebay_price`, or any `attr_*` whose store is the listing `price` column) needs the **listing** `expectedVersion`. A missing version, or a family cascade, is refused |
| `bulk-edit.service.ts:1389` | Price is taken out of the generic equality pass. The door decides equality, because a pinned number can hide a stale legacy key |
| `bulk-edit.service.ts:1522-1557` | The door is called with the full coordinate: product, channel, market, **account and alias**. Conflict → 409 with `versionOf: 'channelListing'`; refusal → 400 |
| `bulk-edit.service.ts:1825` | The generic channel mutation never writes `price` again |
| `channel-specs/ebay.ts:104-108` | `EBAY_PRICE_HELD_REASON` and the column hold are deleted |

**The web side needs no change** (traced, read-only): the channel sheet already sends the
listing's version for listing cells (`_studio/sheet/channel/useChannelSheet.ts:296,312`), tracks it
from `versionOf: 'channelListing'` (`:333-335`), sends one request per row, and never sends
`cascade`. Editability comes from the server cell; there is no second hold in `apps/web`.

### Done when — ✅ measured, on disposable PostgreSQL (`concurrent-database.ts`), profiles OFF and ON

- Both reset paths (pinned → reset, already-following → reset) remove both legacy keys and keep
  `unrelated`. The raw resolver no longer returns the bag price.
- A clean repeat is a `noop`: no version, event, audit row or queue row spent.
- A stale version changes nothing and writes no event or queue row.
- The sheet's `ebay_price` and `attr_price` set, pin and reset all go through the door and report
  the listing version. A same-value `attr_price` set is a no-op when clean, and an applied cleanup
  when dirty.
- Reset stays on the chosen account and alias; the other three listings are unchanged. One request
  over two aliases writes each listing once.
- A price + quantity paste shares one guard. A later failure rolls back price, cleanup, event and
  queue, and dispatches no job.

`price-door-reset.vitest.test.ts`: **16 tests**. Five focused files: **116 passed**, profiles ON and
OFF. Full `apps/api` hook suite: **874 files passed, 0 failed**. Profiles-ON ratchet: **none new,
none worse**. `tsc`: exit 0.

### Gate — ✅ proven able to fail, 12 ways

| Mutation | Result |
|---|---|
| cleanup SQL removed | 🔴 8 red |
| dirty reset counted as `noop` | 🔴 6 red |
| only the generic `price` key cleaned (not `ebay_price`) | 🔴 8 red |
| job dispatched before commit | 🔴 1 red (rollback arm) |
| sheet does not route `ebay_price` | 🔴 8 red |
| sheet does not route `attr_price` | 🔴 4 red |
| no version / cascade guard | 🔴 2 red |
| account and alias ignored when matching the listing | 🔴 1 red |
| generic mutation also writes `price` | 🔴 9 red |
| later guard uses the pre-write version | 🔴 1 red |
| price put back into the generic equality pass | 🔴 1 red |
| an Amazon price column added to the sheet | 🔴 1 red (see §3a below) |

🟠 **Two mutations escaped first**, and each needed a new arm, not a new line. *Account ignored*
escaped because the database query already filters by account; only a request over two aliases
reaches the second filter. *Equality pass* escaped because on real PostgreSQL `price` is a
`Decimal`, and the generic compare never matched it anyway. It matters only on `attr_price`, whose
reader converts the Decimal. 🔴 **A first attempt to "restore" a same-value no-op on `ebay_price`
was wrong and was undone:** on the real database that path had always pinned.

### Review §3a — the Amazon sale-price wipe. RULED: lift the hold for eBay only.

`amazon-sp-api.client.ts:637-655` replaces the whole `purchasable_offer` and so drops a sale price.
**The sheet cannot reach it today:** the only mapped price field is `ebay_price`
(`channel-field-map.ts:27`), and no Amazon store declares a `price` listing column
(`channel-specs/amazon.ts:45-73`). Etsy does declare one (`etsy.ts:44`); it now reaches the door,
which records the event but enqueues nothing, because Etsy is not a sync target.

So the hold is lifted for **eBay only**, and the limit is **gated**, not only written:
`ebay-price-held.vitest.test.ts` fails if any Amazon price column appears, with the eBay column as
its positive control. **The Amazon wipe itself is NOT fixed.** It stays live for the three existing
callers (Matrix, `PATCH /channel-pricing`, bulk override). It needs its own step before any Amazon
price column joins the sheet.

### Cost when — measured on disposable PostgreSQL, profiles ON

| One `writeChannelPrices` call | Time |
|---|---|
| 500 clean rows | **8.7 s** |
| 5,000 clean rows | **84 s** |
| 5,000 rows, half dirty, 1 stale | **89 s** — 4,999 applied, 1 conflict, per-row outcomes |

🟢 The 5,000-row call **completes in one call with per-row outcomes**; that clause of the step is
now met. 🔴 **But it is linear at ~17 ms per row**: one transaction per row (part 1's design). The
A-18 cleanup adds ~6 %. The sheet sends one request per row, so the sheet is not affected; a bulk
caller of 5,000 rows is ~1.5 min — longer than a normal request. See **A-19**.

### Rollback — revert the one commit. It restores the hold, the generic price write and the old door together. No migration, no data change.

### ⬜ Not done, stated

- **The real screen was not exercised.** No API server of this lane was running, and a save would
  write to the local catalogue, which is not authorised. The server's cell contract is gated
  (`editable: true`, no hold) and the web path was traced.
- ~~**Step 2.2's concurrency gate**~~ — built next; see below.
- **A-17** (`expectedPrice` retry) — still separate.

---

## A-19 — The price door is linear at ~17 ms a row. FOR YOUR RULING, not blocking.

**Measured above.** 5,000 rows = 84–89 s, because each row runs its own transaction with its own
event, audit row and queue row. 15.5 asked for chunked *reads*; those are built, and they are not
the cost.

| # | Option | |
|---|---|---|
| **a** | Leave it; record the limit in Step 2.2's Cost when. No surface sends 5,000 rows in one call today (the sheet sends one per row) | 🟢 **Recommended now** — honest and free |
| b | Batch the writes: one transaction per chunk of N rows, per-row outcomes kept | Real work; revisit when a surface needs it |

Nothing built for either.

---

## Step 2.2 Gate (2) — BUILT. Two concurrent price edits give one `applied` and one `conflict`.

`apps/api/src/services/pim/price-door-concurrency.vitest.test.ts`, on **`concurrent-database.ts`**
(a real multi-connection PostgreSQL), never PGlite.

### The race is forced, not hoped for

A third connection takes `SELECT … FOR UPDATE` on the listing. Both writers read the same version
and block on the row. The test then asks PostgreSQL (`pg_stat_activity`, `wait_event_type = 'Lock'`)
until **both** are waiting, and only then releases the row. 🔴 That check is the positive control:
without it, the "race" could run one writer after the other and pass on the early version check
alone.

| Arm | Winner | Loser receives |
|---|---|---|
| door vs door | one `applied` | `conflict`, `guarded: true`, `version: v+1`, no queue row |
| sheet vs door | either | door: `conflict` · sheet: **409 `VERSION_CONFLICT`**, `versionOf: 'channelListing'`, `currentVersion: v+1` |
| sheet vs sheet | one 200 | 409 `VERSION_CONFLICT` on the listing version |

Every arm also asserts: the stored price is the winner's, the version moved by exactly one, and there
is exactly **one** price event, **one** audit row and **one** queue row.

### 🟠 What the race showed about the sheet path

The sheet saves inside `inDatabaseTransaction` (`lib/database-context.ts:59-83`), which is
**Serializable** and retries a `P2034` write conflict up to twice. So the blocked sheet write fails
with a serialization error (Prisma logs *"Transaction failed due to a write conflict or a
deadlock"*), and the helper **re-runs the whole save with the caller's original
`expectedVersion`**. The re-run reads the new version and the door refuses it: 409. The logged
errors are that retry, not a failure. This is **not** A-17's lost update: the retry re-checks the
caller's version, it does not adopt the new one.

### Gate — ✅ proven able to fail, and each guard by a DIFFERENT arm

| Mutation | door vs door | sheet vs door | sheet vs sheet |
|---|---|---|---|
| the database compare-and-set (`version` in `updateMany`) removed | 🔴 | 🟢 | 🟢 |
| the early check against the caller's version removed | 🟢 | 🔴 | 🔴 |
| both removed | 🔴 | 🔴 | 🔴 |

> A gate with two paths needs two arms. The door path is protected by the compare-and-set; the
> sheet path by the early check, because its retry re-reads the row. Either arm alone would have
> left one guard unproven.

Stable: 3/3 profiles OFF, 5/5 profiles ON in a row, and inside the full hook suite (875 files pass).
The harness waits up to 15 s for both writers to block, so a busy machine reads as slow, not as "no
race".

### Cost when — `flat`. One disposable database per file, ~2 s.

### Rollback — delete the test file. It changes no product code.

### Step 2.2 — where it stands now

| Done when clause | |
|---|---|
| `writeChannelPrices` cannot be called without a version | ✅ part 1 |
| every price write raises a `PriceChangeEvent`, an audit row and a `PRICE_UPDATE` enqueue | ✅ part 1 + part 2 (the sheet) |
| two concurrent edits produce one `applied` and one `conflict` | ✅ this gate |
| **Cost when:** 5,000 rows in one call, per-row outcomes | ✅ completes (84–89 s); linear cost is **A-19** |
| **Cost when:** 15.5 (b) the bulk retry contract | 🟡 **A-17**, awaiting ruling (the Owner's stated preference: (a) `expectedPrice`) |

**Step 2.2 is built except A-17.** It does not close until A-17 is ruled and, if (a), built.

---

## A-20 — Step 2.4 move 2: the editor already does it; only the products grid is left, and most of its rows have no family. FOR YOUR RULING.

**2026-09-22. Measured read-only on the local catalogue (`nexus_development`, profiles ON, inside the
workspace context). Nothing built.**

### The premise is half out of date

Move 2 says *"the family decides Shared's columns"*. 🟩 **The product editor's Shared scope already
works that way**, since `f212c2348` (09-12):

- `studio-sheet.service.ts:1004-1016` always passes `familyIds` (an empty list when the product has
  no family).
- With `familyIds` present, `sheet-columns.service.ts:1319` sets `familySchema`, `:1341` skips every
  channel spec, and `buildSheetColumns` skips them again at `:619`. Only family fields and the core
  registry make columns; a family requirement scoped to a channel shows as the *"required by
  Amazon · IT"* label (Step 2.1 (a)).

🔴 **What is left is the products grid.** `sheet-rows.service.ts:435` calls `getSheetColumns`
**without** `familyIds`, so its Shared scope is still the union of the channel specs of the
coordinates the page's products are on (narrowed by move 1). Three smaller callers do the same:
`products-sheet.routes.ts:59`, `ai/enrichment/generate.service.ts:255`,
`family-variation-axes.ts:29`.

### Measured — what a family-owned grid would change

| | |
|---|---|
| products · parents | 355 · 54 |
| 🔴 **parents with no family** | **40 of 54** (341 of 355 products; 324 of them have a listing) |

Family `cmtny43jv002jnjfbb6hnijqx` (COAT, OUTERWEAR, PANTS; 219 products; Amazon·IT, eBay·IT,
Shopify, Etsy), market IT:

| | columns |
|---|---|
| the grid today | **330** |
| the same page, family-owned | **225** |
| only in the grid | **182**: 95 Amazon-declared attributes stored in the product's own `categoryAttributes` (the real move-2 set, e.g. `externally_assigned_product_identifier`, `recommended_browse_nodes`, `chest`) · 75 list slots (`bulletPoints_1…`, a shape difference — the family shows one list column) · 8 channel identity columns (ASIN, eBay item id, buy box — the family path drops them on purpose) · 3 old registry attributes (`armorType`, `ceCertification`, `waterproofRating`) · 1 alias (`country_of_origin`) |
| 🔴 **only in the family** | **77** — the family's own attributes the grid **never shows today** (`ppeCategory`, `notifiedBodyNumber`, `declarationOfConformityUrl`, `hazmatClass`…) and split measure fields |

Two more families (17 and 18 products) show the same shape: 180 → 98 and 199 → 101 columns.

So the grid breaks R3 in **both** directions: a channel adds 95 columns to Shared, and the family's
own 77 are missing.

### Why this needs a ruling, not a build

Flipping the grid to family-owned columns is correct by R3, but on this catalogue it would leave
**40 of 54 parents** with only the core registry columns on Shared, because they have no family.
Their Amazon attributes would still be editable on the Amazon scope, but a grid that loses most of
its columns for most rows is a visible change the plan did not measure. Production's family
coverage is not measured here (no production access in this lane).

| # | Option | |
|---|---|---|
| **a** | **Close move 2 for the editor (already true), and make the grid's move 2 wait for families.** Add a data step before it: count parents with no family on production, then assign families. Until then the grid keeps move 1, and it states the gap (R4): *"N products have no family — Shared shows the channels' attributes for them."* | 🟢 **Recommended.** No visible loss; the real blocker (missing families) becomes a step with a number |
| b | Flip the grid now: pass the page's `familyIds` from `sheet-rows.service.ts`. Rows with no family show the core columns and a stated *"no family"* absence | Strict R3 today; most local rows lose their attribute columns on Shared |

Either way, the 77 family attributes the grid hides today are a finding to carry: under (a) they
appear when the grid flips; under (b) at once.

**Done when (either option)** — M4 on the grid's Shared scope: zero columns declared only by a channel,
for products that have a family; a positive control with an Amazon listing shows the marker.
**Gate** — extend `shared-scope-narrowing.vitest.test.ts` with a family arm and a no-family arm.
**Rollback** — drop `familyIds` from the one caller.

---

## A-21 — Step 2.7's premise, re-checked. Its ordering rule no longer blocks anything; Shared's 100 % is by design. FOR YOUR RULING, with D-E.

**2026-09-22. Measured on the local catalogue with the CURRENT code, each reconcile run inside a
transaction that was then rolled back.** Control: `ReadinessIndex` held **714 rows, newest
2026-09-13T07:47:57Z** before and after all seven runs; inside each transaction the new rows were
visible (e.g. 918, 1,088), so the write happened and was undone. Nothing was persisted.

### What the step says

*"Do it after 2.1, so it computes against real requirements — a reconcile against 0 required
attributes would fill the table with meaningless 100 %s and you would have to run it twice."*

### What the reconcile produces today

| Family (children) | ms | Amazon avg % (req) | eBay avg % (req) | Shared avg % (req) |
|---|---|---|---|---|
| 5 | 2,169 | 22 (5) | — (5) | **100 (1)** |
| 10 | 1,641 | 21 (5) | — (5) | **100 (1)** |
| 10 | 3,279 | 21 (20) | 84 (5) | **100 (1)** |
| no family, 0 | 1,443 | — (1) | 83 (5) | — (1) |
| no family, 0 | 1,919 | — (1) | 83 (5) | — (1) |
| 15 · family with the 2.1 (b) mirror | 4,229 | 20 (20) | 67 (5) | **100 (1)** |
| 20 · family with the 2.1 (b) mirror | 3,488 | 46 (20) | 84 (5) | **100 (1)** |

(`—` = no percentage: the coordinate has no cached schema or no listing, and says so in its state.)
The rows stored on 09-13, before any of Step 2.1, already read Amazon **40–47 %** with ~30 required.

### What that means

1. 🔴 **The ordering rule protects nothing.** Channel coordinates have given real, non-100 % numbers
   since before 2.1, from their own schemas (A-16's *8 of 163*). **Shared reads 100 % with 1
   required both before and after 2.1** — including on the family where the 2.1 (b) mirror is
   applied — because under **R-10** a channel's requirement shows on Shared as a *marker*, not as a
   Shared requirement. So 2.1 was never going to move Shared's number. And *"run it twice"* costs
   nothing now: the nightly sweep (15.1) refreshes every family within its horizon anyway.
2. 🟠 **Shared's readiness is 100 % by design, and that is a separate question.** A chip that is
   always 100 % tells the operator nothing (R4). Whether Shared should show a readiness number at
   all — or show *"see each channel"* — is a UI ruling for Phase 4, not a blocker for 2.7.
3. **The cost is 1.4–4.2 s per family on real cached schemas** (7 samples; 3.5–4.2 s at 15–20
   children, matching the research's 4.087 s). The fixture's 0.2–0.5 s is a floor, as the plan
   already warned. At 2–4 s, the 10-minute nightly budget covers **~150–300 families**. A catalogue
   above that fills on a **rotation** over several nights; the local catalogue (42 roots) fits one
   night (~1.5 min). The production root count is not measured here.

### Proposed

- **Strike the ordering rule** (*"⚠️ Order matters: 2.1 → 2.7"*). D-E is the only gate left on 2.7,
  and it no longer needs to wait for the 2.1 (b) production mirror.
- **Add to 2.7's Cost when:** *"~2–4 s per family on real schemas; the first fill is a rotation of
  ⌈roots ÷ ~150⌉ nights at worst; count production roots before D-E."*
- **Carry to Phase 4:** Shared's always-100 % readiness chip (R4).

Nothing built. D-E (the production run) stays the Owner's.
