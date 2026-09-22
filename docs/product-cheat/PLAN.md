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

---

### Step 4.2 — The gates come back

- **Do** — Restore the four gates and add the 7:1 contrast gate to the hook.
- **Approach** — 🔴 **A ratchet, not a big bang.** For each rule: write the gate → run it → it
  goes red → record the number → fix to green → **the gate stays in the hook forever.**
  **Rejected:** converting the UI in one pass and adding gates afterwards. 🟨 A big-bang UI
  rewrite with no gates is exactly the condition that produced the last P0.
- **Done when** — Five gates are in the hook and green.

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

**Size, measured, not guessed** — against the local catalogue, `master DE` builds a 47-column set of
**29.6 KiB of JSON**. 🔴 That is a **floor**: the local catalogue is empty (`Product` returned 0
rows), and a market with cached channel specs carries 185+ columns. The retained object graph is
larger again than its JSON.

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
