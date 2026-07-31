# SV — Snapshot Versioning

**Status:** PROPOSAL — awaiting gate. No code changed.
**Date:** 2026-07-31
**Goal:** Stop `flatFileSnapshot` being a detached copy that every write path must remember to patch,
by making it an ordered version of the listing rather than a blob beside it.

**Evidence base:** `~/Desktop/COMMERCE-PLATFORM-RESEARCH/` — Salsify (changesets) and Pimcore
(unpublished versions) reached the same diagnosis by different routes. **Pimcore's is the cheaper fix,
and it was invisible until that study.**

**Companion proposal:** `docs/2026-07-31-locale-layer-ll.md`. Independent — either can ship without
the other.

---

## 1. What exists today

### 1.1 Two snapshots, and they know they are twins

**`ChannelListing.flatFileSnapshot`** (`schema.prisma:1494`), with its own comment explaining why it
exists:

> RR.1 — verbatim flat-file row for the Amazon flat-file editor (the exact key→value map the operator
> pulled/edited). The grid reads this back losslessly instead of expanding the nested
> `platformAttributes` (**which dropped gated fields**).

**A second one** at `schema.prisma:14692`, on the eBay shared-listing variant model:

> Round-trip integrity (2026-07-17): the FULL flat-file row as the operator saved it (minus `_internal`
> keys) — **the Lane-B twin of `ChannelListing.flatFileSnapshot`**.

**Surface: 116 references across 27 files** under `apps/api/src`.

### 1.2 Why it exists — and why that reason is still valid

The snapshot is **not** a design error. It solves a real problem: expanding nested
`platformAttributes` was lossy, and gated Amazon fields were being dropped on round-trip. Storing the
operator's row verbatim fixed that.

**This proposal does not remove the snapshot.** It changes where it lives.

### 1.3 The actual defect — a fork every write path must remember

`apps/api/src/routes/catalog-organize.routes.ts:138-165` is the clearest statement of the problem
anywhere in the codebase, and it is a comment the code wrote about itself:

```ts
// AUTHORITATIVELY (applySnapshotOverlay returns the snapshot
// verbatim): a DB re-parent that leaves the child's snapshots stale
// re-creates the AIREON phantom-family trap. Rewrite them in the
// same transaction (eBay reasserts parentage from the tree on read,
// but its raw snapshot self-heals here too).
```

followed by a hand-patch:

```ts
flatFileSnapshot: {
  ...snap,
  ...('parent_sku'      in snap ? { parent_sku: newParent.sku } : {}),
  ...('parentage_level' in snap ? { parentage_level: 'child' } : {}),
  ...('parentage'       in snap ? { parentage: 'child' } : {}),
}
```

**This path is correct.** The problem is that correctness here is **per-call-site and voluntary**.
The snapshot is a copy of the record's state that lives *beside* the record, so **every mutation
anywhere must independently remember to rewrite it.** One that forgets produces a ghost.

### 1.4 The three recorded defects, and what they have in common

| Recorded defect | Why a detached copy causes it |
|---|---|
| *"`parent_sku` must be rewritten on re-parent"* | the fork holds a stale parent reference |
| *"aspect ghosts persist in `flatFileSnapshot`"* | the fork holds values the record no longer has |
| *"eBay aspect/theme cleanup must rewrite `flatFileSnapshot` or ghosts persist"* | every record mutation must also mutate the fork |

**All three are the same defect.** None is a spreadsheet problem, an eBay problem, or an aspect
problem — they are consequences of a copy that has no relationship to the thing it copied.

### 1.5 What Nexus already has that helps

**Five version/revision tables already exist in the schema:**

`MappingRevision` (1847) · `APlusContentVersion` (6928) · `BrandStoryVersion` (7077) ·
`PurchaseOrderRevision` (8891) · `EbayAdsRuleVersion` (12269) — plus `AuditLog` (6823).

`EbayAdsRuleVersion` is the shape to copy verbatim:

```prisma
model EbayAdsRuleVersion {
  id     String      @id @default(cuid())
  rule   EbayAdsRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  ruleId String
  version   Int
  …payload columns…
  changedBy String?   // operator id or engine actor
}
```

**The pattern is established, used five times, and has simply never been applied to the object that
most needs it.**

---

## 2. What the market does

### 2.1 Two answers, and the second is much cheaper

| Vendor | Draft mechanism | Does it fork? |
|---|---|---|
| **Salsify** | **Changesets** — proposed deltas, held separate until applied | **No** — stores only what changed |
| **Pimcore** | **An unpublished version** of the element itself | **No** — the draft *is* a version |
| Akeneo | Proposals (EE) | partially |

**Salsify's diagnosis, taken at face value, says: replace the snapshot with a delta overlay.** That is
correct, and it is a large rewrite — 27 files, 116 call sites, and a new mental model for the
flat-file editor.

**Pimcore refines the diagnosis, and this is the finding that changes the recommendation:**

> **Pimcore's drafts are snapshots too.** An unpublished version *is* a full copy of the element.
>
> The problem with `flatFileSnapshot` is **not that it snapshots.** It is that it snapshots **outside
> any versioning system**, with no ordering relative to the record and no lifecycle.

### 2.2 So there are two viable fixes, not one

| Fix | Model | Cost | Keeps the flat-file editor working as-is? |
|---|---|---|---|
| Delta overlay *(Salsify)* | store only what changed | **High** — new model, 116 call sites | No — the editor reads a reconstructed row |
| ⭐ **Versioned snapshot** *(Pimcore)* | keep the blob, **make it a version** | **Medium** | **Yes** — same JSON, same read path |

**This proposal takes the second.** Same data, same shape, same reads — but now ordered, comparable,
restorable, and impossible to orphan.

### 2.3 And the rule the whole bulk study produced

> **Never ship a bulk capability ahead of its undo.**

inRiver is the cautionary case — best bulk ingest in the study, no native versioning behind it.
Pimcore's answer is the cheap one: **if every object a write touches gets a version, you do not need
job-level rollback to be safe.**

---

## 3. Proposed architecture

### 3.1 One new table, and the blob stops being authoritative

```prisma
model ChannelListingVersion {
  id               String         @id @default(cuid())
  channelListing   ChannelListing @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  channelListingId String

  version   Int                    // monotonic per listing, from 1

  snapshot  Json                   // the same verbatim row as today
  published Boolean @default(false) // false = draft / working copy

  reason    String?                // "operator-save" | "import" | "re-parent" | "theme-cleanup"
  jobId     String?                // ⭐ set when a bulk job produced this version
  changedBy String?                // operator id or engine actor
  createdAt DateTime @default(now())

  @@unique([channelListingId, version])
  @@index([channelListingId, published])
  @@index([jobId])
}
```

`ChannelListing.flatFileSnapshot` **stays** — it becomes a **materialised pointer to the current
published version**, so every existing read keeps working unchanged.

### 3.2 What this buys, defect by defect

| Today | With versions |
|---|---|
| Re-parent must hand-patch the blob in the same transaction | Re-parent writes **a new version** with `reason: "re-parent"`. The old one stays, correctly, as history |
| An aspect ghost is undetectable | `diff(v6, v7)` shows exactly which keys survived a cleanup that should have removed them |
| *"What did that import change?"* is unanswerable | `WHERE jobId = …` returns every version the job created |
| A bad save is unrecoverable | Restore version *n* — the same operation `EbayAdsRuleVersion` already supports for ads rules |
| Every new write path must remember the fork | ⭐ **Writing a version is the write path.** Forgetting produces no version, not a stale one |

**That last row is the point.** Today, a mutation that forgets the snapshot leaves a *wrong* snapshot
behind. With versions, a mutation that forgets leaves *no new version* — visibly missing rather than
silently wrong.

### 3.3 Restore and publish are two different verbs

Pimcore separates them and the distinction is real:

- **Restore** — bring an old version back as the working copy (operator wants to keep editing from there)
- **Publish** — make an old version the live one **without** disturbing the working copy

Nexus needs both, and today has neither.

### 3.4 Retention

Unbounded versioning on 279 SKUs × ~4 markets × 3 channels is not a scale problem, but it should still
be bounded. Pimcore's model: **configurable count and period, with protected versions.**

**Proposed:** keep the last **20** versions per listing and everything from the last **90 days**;
**never prune** the currently-published version, version 1, or any version carrying a `jobId` that is
still referenced by an open issue.

### 3.5 The eBay twin

`schema.prisma:14692` gets the same treatment, or is folded into the same table with a discriminator.
**Recommendation: same table, `laneB Boolean`** — the comment already calls them twins, and one
versioning mechanism is easier to reason about than two.

---

## 4. Phases

### SV.0 — Truth: where are the snapshots already stale?
Read-only. For every `ChannelListing` with a `flatFileSnapshot`, compare snapshot keys against the
live record: stale `parent_sku`, orphaned aspects, values the record no longer holds.
**Output: a count of currently-wrong snapshots in production.**
**Gate criterion: this number justifies or kills the proposal.**

### SV.1 — The table, shadow-written
Additive migration. Every existing write path that touches `flatFileSnapshot` **also** writes a
version. `flatFileSnapshot` remains authoritative. Nothing reads versions yet.
Verifiable: the latest version's `snapshot` should be byte-identical to `flatFileSnapshot`, always.

### SV.2 — Diff view
Read-only UI: version list per listing, with `diff(n, n-1)` showing changed keys.
**Useful on its own** — it makes SV.0's staleness visible per product, and it is the first time
*"what changed in this row?"* has ever been answerable.

### SV.3 — `reason` + `jobId` on every write
Classify every one of the 27 files' write paths. `jobId` on bulk/import writes.
**This is the phase that makes "what did that import touch?" answerable.**

### SV.4 — Restore
Restore version *n* as the working copy. Append-only — restoring v6 creates v9, per Akeneo's model.
Behind a confirm.

### SV.5 — Publish-a-version + working/published split
`published` becomes meaningful. The flat-file editor gains an explicit draft state.
**Larger than it looks** — this changes editor behaviour, and flat-file editors are under a standing
no-change rule. Separate gate.

### SV.6 — Job-level rollback
*"Restore these 40 listings to their state before job #1878."*
**No vendor in the nine studied has this.** Given SV.1 + SV.3 it is mostly plumbing — select versions
by `jobId`, restore each.

---

## 5. Decisions needed from the operator

1. **Does SV.5 (working/published split) belong in this proposal at all?**
   It changes flat-file editor behaviour. SV.0-SV.4 do not.
   **Recommendation: split it out.** SV.0-SV.4 + SV.6 deliver most of the value with no editor change.

2. **Retention numbers.** 20 versions / 90 days proposed (§3.4). Higher is cheap at this catalog size;
   the question is whether any compliance need argues for longer.

3. **One table or two for the eBay Lane-B twin?**
   **Recommendation: one, with a discriminator** (§3.5).

4. **Does `reason` need to be a strict enum?**
   Free string is easier to add incrementally; an enum is easier to query and report on.
   **Recommendation: enum, seeded from the 27 files' actual write paths in SV.3.**

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Write amplification** — every listing save writes two rows | Low | 279 SKUs. `EbayAdsRuleVersion` already does this for ads rules with no issue |
| **27 files must be touched in SV.1** | Medium | Mechanical and additive — each gains one write. SV.1 is verifiable byte-for-byte against the existing blob |
| **Versions and `flatFileSnapshot` diverge** | **High** | SV.1 keeps the blob authoritative and asserts equality. Any divergence is a bug caught by the assertion, not by an operator |
| **Storage growth** | Low | Bounded by §3.4. Snapshots are small JSON rows |
| **Flat-file editor behaviour changes** | **High** | SV.0-SV.4 change **nothing** the editor sees. SV.5 is the only phase that does, and needs its own gate |
| **Restore reintroduces a bad state** | Medium | Append-only (restoring creates a new version), behind a confirm, and the diff view (SV.2) exists first |

---

## 7. What is explicitly out of scope

- **Removing `flatFileSnapshot`.** It stays, and stays authoritative through SV.4.
- **Changesets / delta overlays.** Salsify's model is cleaner and much larger; this proposal takes
  Pimcore's cheaper route. Revisit only if SV.0 shows the blob itself is the problem.
- **Versioning `Product` or `LocaleContent`.** Related and worth doing — the research argues **config
  deserves versioning more than data does** — but a separate proposal.
- **Concurrency control.** Three PIM vendors were studied and **none documents concurrent-edit
  handling**. Salsify's `salsify:version` counter is the only primitive found anywhere. Versions here
  are a *recovery* mechanism, not a *prevention* one, and the `CONFLICT`-row problem stays open.

---

## 8. The one-paragraph version

`flatFileSnapshot` is a verbatim copy of the operator's row stored beside the record it copies, so
**every write path must independently remember to rewrite it** — and `catalog-organize.routes.ts:138`
is a hand-patch doing exactly that, with a comment naming the AIREON trap it exists to prevent. Three
recorded defects are the same defect: a copy with no relationship to its original. Salsify says replace
it with a delta overlay; **Pimcore shows the cheaper fix — its own drafts are snapshots too, and the
difference is that they live inside a versioning system.** Add `ChannelListingVersion` using the
`EbayAdsRuleVersion` pattern already used five times in this schema, shadow-write it, and the same JSON
becomes ordered, diffable, restorable and impossible to orphan. **SV.0 is a read-only report counting
how many snapshots are already stale in production — and that number should decide whether this ships.**
