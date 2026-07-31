# LL — Locale Layer

**Status:** PROPOSAL — awaiting gate. No code changed.
**Date:** 2026-07-31
**Goal:** Separate *"this copy is Italian"* from *"this copy is Amazon-formatted"*, so one Italian
description can serve Amazon IT, eBay IT and Shopify IT instead of being authored three times.

**Evidence base:** five vendor studies —
`~/Desktop/COMMERCE-PLATFORM-RESEARCH/06-PIM-AND-SYNDICATION/` (Akeneo, Salsify, Pimcore, inRiver) and
`02-RITHUM/`. This proposal is the schema-shaped half of what those studies concluded; the
non-schema half is tracked separately in `08-BULK-OPERATIONS/07-WHAT-NEXUS-SHOULD-TAKE.md`.

**Decisions needed from the operator before LL.1 — see §5.**

---

## 1. What exists today, and what each piece is for

### 1.1 The listing layer

`ChannelListing` (`packages/database/prisma/schema.prisma:1421`) is the per-market overlay on `Product`.
The coordinate is expressed **four times**, for historical reasons:

| Column | Line | Purpose |
|---|---|---|
| `channelMarket` | 1443 | legacy composite, `"AMAZON_IT"` |
| `channel` | 1444 | `"AMAZON"` \| `"EBAY"` \| `"SHOPIFY"` … |
| `region` | 1445 | `"US"`, `"DE"` … (legacy) |
| `marketplace` | 1449 | **the current key** — country code `"IT"`/`"DE"`/`"FR"`, or `"GLOBAL"` for single-store channels |

The uniqueness that matters (`schema.prisma:1643`):

```prisma
@@unique([productId, channel, marketplace], name: "productId_channel_marketplace")
```

Content lives on the same row (lines 1466-1467, plus an override tier):

```prisma
title       String?
description String?          // HTML or plain text
platformAttributes  Json?
titleOverride        String?
descriptionOverride  String?
bulletPointsOverride String[]
```

### 1.2 The conflation — stated precisely

**`marketplace` is a country code.** So `(channel, marketplace)` fuses two facts that vary
independently:

- **locale** — *this text is Italian* (a property of the content)
- **channel** — *this text is formatted for Amazon* (a property of the destination)

The consequence is one row per fused pair, and **no row can express "Italian, any channel"**:

```
ChannelListing[MISANO, AMAZON,  IT] .description  ← Italian, authored once
ChannelListing[MISANO, EBAY,    IT] .description  ← the SAME Italian, authored again
ChannelListing[MISANO, SHOPIFY, GLOBAL] .description  ← and again
```

Three rows, one language, three copies to keep in sync. Multiply by ~279 master SKUs × 4 EU markets.

**This is not a hypothetical.** It is the first of the two headline findings from the research
programme, reached independently from five vendors.

### 1.3 What already exists that helps

Two things make this cheaper than it looks.

**A. The layering instinct is already in the schema.** `title` / `titleOverride`,
`description` / `descriptionOverride`, `bulletPointsOverride` — Nexus already resolves content through
**two** tiers. This proposal adds a tier *beneath* them; it does not introduce layering as a new concept.

**B. The transformation machinery already exists.** Channel differences are overwhelmingly *format
constraints*, and Nexus already owns every mechanism for expressing them:

| Constraint | Existing machinery |
|---|---|
| Amazon title byte limits, eBay 80-char | push preflight (per-channel) |
| Vocabulary translation | `FieldValueMap` |
| Size scales | `SizeScaleMap` |
| Description formatting | description themes / Description Studio |
| Column shape per market | flat-file column generators |

**What is missing is the locale layer underneath them, not the transformation layer above them.**

### 1.4 Surface area

**198 files** under `apps/api/src` reference `channelListing`. That is the blast radius of a
re-model — and the reason §3 proposes an **additive** layer rather than a re-key.

---

## 2. What the market does

Five systems were studied end to end. On the question *"where does channel live?"*:

| System | Locale | Channel |
|---|---|---|
| **Akeneo** | stored (`localizable` flag) | **stored** (`scopable` flag) |
| **Salsify** | **stored** (nested in the value) | **computed at publish** |
| **Rithum** | computed | **computed at send** |
| **Pimcore** | **stored** (`Localized Fields`) | **computed at export** |
| **inRiver** | **stored** (`LocaleString` type) | an **entity**, linked to |
| *Nexus today* | *fused with channel* | *fused with locale* |

**Four of five store locale. Only Akeneo stores channel on the value.** Nexus is not at one end of a
spectrum — it is off it.

### 2.1 The three things the field agrees on

1. **Locale is a property of the content; channel is a property of the delivery.** Every vendor that
   separated them separated them this way.
2. **Almost everything that genuinely differs, differs by locale.** Channel differences are format
   constraints — length caps, vocabularies, required-field sets.
3. **Changing a field's scope must be a migration, not a schema edit.** Akeneo makes it a gated,
   data-preserving background job that asks *which coordinates the value should copy to*. **Pimcore
   destroys the data** and warns about it in its own documentation. Two of four vendors make this
   correction destructive — §3.4 follows Akeneo.

### 2.2 The cost of computing channel, and its mitigation

Salsify, Rithum and Pimcore all compute channel output and **do not store it**. Rithum's own
documentation concedes the consequence: *"output won't show in our system outside of previews."*

**Nexus must not acquire that weakness.** Read-back, drift detection with per-field `nullIsMeaningful`,
and the reconcile pass exist because Nexus owns the listing — and none of the five has them. §3.1
preserves them by keeping `ChannelListing` as a real, stored override tier.

---

## 3. Proposed architecture

### 3.1 One new table, above nothing and below `ChannelListing`

```
Product                                   ← golden record (unchanged)
  └── LocaleContent[productId, locale]     ← NEW: one Italian description, one German…
        └── ChannelListing[productId,      ← EXISTING: reinterpreted as the override tier.
              channel, marketplace]           Empty column = inherit. Populated = override.
```

**Additive.** No column is dropped, no key changes, no existing row is invalidated. Every one of the
198 files keeps compiling.

```prisma
model LocaleContent {
  id        String  @id @default(cuid())
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId String
  locale    String            // "it", "de", "fr", "es"

  title            String?
  description      String?
  bulletPoints     String[]
  descriptionShort String?     // see §3.3.C

  version   Int      @default(0)   // see LL.0
  updatedAt DateTime @updatedAt

  @@unique([productId, locale])
  @@index([productId])
}
```

### 3.2 Resolution order — and why one order is not enough

Reads resolve:

```
ChannelListing.titleOverride     →  explicit channel override
ChannelListing.title             →  existing channel value
LocaleContent[locale].title      →  NEW: the locale layer
Product.name                     →  golden-record default
computed                         →  theme / FieldValueMap / generator
```

**But a single vertical order is wrong for some fields**, and Pimcore is the only vendor with an
explicit position on this. It ships **two** localization systems with **opposite** resolution orders:

| System | Order | Meaning |
|---|---|---|
| Localized Fields | **vertical** — inheritance first | *the parent's French beats this variant's English* |
| Classification Store | **horizontal** — translation first | *this product's English beats the parent's French* |

**Linguistic content wants vertical. Factual attributes want horizontal.** A missing French
*description* means nobody wrote it yet; a missing French *material* means the attribute is
language-independent.

**The proposal takes the cheaper of the two available fixes** (see §3.3.B): do not localize factual
attributes at all.

### 3.3 Which fields go where — Xavia, field by field

**A. Genuinely locale-level → move to `LocaleContent`**

| Field | Why |
|---|---|
| `description` | The Italian text is the same on Amazon IT, eBay IT and Shopify IT |
| `bulletPoints` | Same |
| `title` (base) | Same — the *constraint* differs per channel, not the copy |

**B. Factual attributes → unlocalized codes with localized labels, NOT `LocaleContent`**

`Materiale`, `Stagione`, `Protezione`, `Cura`, `Colore`, `Taglia`, `Marca`, `body type`, `athlete`,
`team name`.

Three vendors converged on this (Akeneo attribute options, Pimcore Classification Store keys, inRiver
CVLs): **store a stable code once, render a localized label.** `materiale_pelle` stored; "Pelle" /
"Leder" / "Cuir" rendered.

⭐ **`FieldValueMap` is already this shape.** The gap is that it is a *mapping* table rather than the
*source of truth* for the value. This removes the vertical-vs-horizontal question for most of Xavia's
attribute surface **and** removes a live class of translation drift — today the same material is
free text on every row in every market.

**C. Length variants → separate properties, selected by the channel**

Salsify authors `Description`, `Long Description`, `Short Description` as **real fields**, then the
channel mapping picks one with a fallback chain:

```
COALESCE(VALUE('Description'), VALUE('Long Description'), VALUE('Short Description'))
```

**Author several genuine lengths once per locale; let the channel choose.** Three fields authored once
beats nine channel rows maintained forever. This is the generalised form of the *attribute-level
default* recommendation.

**D. Stays on `ChannelListing` — genuinely per-channel**

`price`, `salePrice`, `quantity`, `stockBuffer`, `fulfillmentMethod`, `externalListingId`,
`platformAttributes`, `flatFileSnapshot`, all sync/status columns, and **any title or description the
operator has deliberately overridden for one channel**.

### 3.4 The migration — the Akeneo pattern, not the Pimcore one

**Per field, ask which coordinates the existing value should land on.** Never a schema change that
drops data.

```
for each (product, field) with per-market ChannelListing values:
    are the values identical across channels within a market?
       YES → promote to LocaleContent[locale]; blank the channel rows
       NO  → leave every channel row as an override; record the divergence for review
```

**The divergence report is the deliverable of LL.1**, not the migration itself. It tells the operator
how many fields are genuinely per-channel versus accidentally duplicated — which is the number that
justifies (or shrinks) the rest of the work.

Run as a job, behind its own permission, dry-run first. Akeneo gates this behind a dedicated ACL
(*Edit scopable and localizable properties*); the Nexus equivalent is a one-off script with an explicit
confirm, consistent with the standing rule that flat-file editors are untouchable without approval.

### 3.5 Making the layer visible — the three-state cell

Adding a tier without showing it is how Salsify earned its most-cited complaint (*"3–4 clicks and
multiple page loads to edit a single product"*). Akeneo's answer is the reference:

| State | Render |
|---|---|
| **Editable here** | normal input |
| **Inherited** | grey + 🔒 + *"can be edited on the Italian content"* — **the destination is named** |
| **Computed** | grey + ⚠ + **the rule's name** (`FieldValueMap`, a theme, a default) |

The two annotations are **independent and stack** — a value can be both inherited and rule-computed.

**Nexus already knows which of the three every value is. All three render identically today.** This is
CSS and one helper line, and it is what makes the layering legible rather than confusing.

---

## 4. Phases

Each phase is separately gated. **LL.0 and LL.1 are read-only** and worth doing regardless of whether
the rest proceeds.

### LL.0 — Truth: how much duplication actually exists
Read-only report over production. For each `(product, field)`, compare values across channels within a
market. Output: **how many field-values are byte-identical across channels** (the waste), and how many
genuinely diverge (the real per-channel need).
**Gate criterion: if duplication is low, stop here.** The rest of this proposal is justified by that
number and nothing else.

### LL.1 — Divergence report + per-field classification
Classify every content field as locale-level (§3.3.A), factual-code (§3.3.B) or channel-level (§3.3.D).
Operator reviews and signs off the classification. Still no schema change.

### LL.2 — `LocaleContent` table, written but not read
Additive migration. Backfill from LL.1's classification. **Nothing reads it yet** — pure shadow write,
verifiable against the existing rows.

### LL.3 — Read-path resolver
One resolver function, used everywhere: `resolveContent(productId, field, channel, marketplace)`.
Order per §3.2. Feature-flagged, off by default. Compare resolver output against current values across
the whole catalog; **zero diffs is the gate**.

### LL.4 — Three-state rendering
The cell shows inherited / overridden / computed, with the destination and rule named (§3.5).
**Read-only UI change**, and useful on its own even if LL.5 never ships.

### LL.5 — Blank the promoted channel rows
Only for fields LL.0 proved byte-identical. Reversible: the values remain in version history.

### LL.6 — Factual attributes to codes + labels
`FieldValueMap` becomes the source of truth for `Materiale`, `Stagione`, `Protezione`, `Colore`,
`Taglia`. Separately gated; larger than it sounds because the flat file surfaces these as free text
today.

### LL.7 — Length variants (`descriptionShort`, `bulletPoints`) + channel selection
The `COALESCE`-style fallback chain per channel.

---

## 5. Decisions needed from the operator

**None of the phases start until these are answered.**

1. **Is per-channel title divergence real or accidental?**
   Amazon's byte limits and eBay's 80-char cap are real constraints — but is the *copy* deliberately
   different, or is it the same text truncated differently? **LL.0 answers this with data**, but the
   operator's intent decides whether truncation should be computed or authored.

2. **Shopify's `marketplace = "GLOBAL"`.** Shopify is Xavia's own storefront and currently one row.
   Does it need per-locale content (an Italian and a German storefront), or does it stay single-locale?

3. **Does `LL.6` (factual attributes → codes) go in this proposal or its own?**
   It is the largest single item and touches the flat file, which is under a standing no-change rule.
   **Recommendation: its own gate, after LL.5.**

4. **Locale granularity.** `"it"` or `"it_IT"`? Xavia sells IT/DE/FR/ES with no regional variants
   today. **Recommendation: `"it"`** — language, not language-region, until a case for the latter
   exists. Changing it later is a data migration on one column.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Resolver adds a read hop everywhere** | Low | ~279 SKUs. Salsify's users report slowness from *click count*, not query depth — §3.5 addresses that directly |
| **198 files reference `channelListing`** | Medium | Additive design: nothing is dropped or re-keyed. LL.3 introduces one resolver rather than editing call sites |
| **Migration mis-classifies a field** | **High** | LL.0/LL.1 are read-only and operator-signed-off. LL.5 is reversible via version history. Never a schema change that drops data (§3.4) |
| **Layering makes editing more confusing** | **High** | LL.4 ships *before* LL.5. If the three-state cell isn't legible, stop |
| **Flat file interacts badly** | **High** | Flat-file editors are untouchable without explicit approval. LL.0-LL.5 do not change flat-file behaviour; LL.6/LL.7 need their own gate |
| **We lose the ability to inspect the outbound value** | Medium | Explicitly avoided — `ChannelListing` stays a *stored* override tier (§2.2). Read-back and drift are untouched |

---

## 7. What is explicitly out of scope

- **Re-modelling `ChannelListing`.** It stays. This is a layer beneath it.
- **Computing channel values at send time.** Rithum and Salsify do this and both lose read-back. Nexus
  keeps storing.
- **A general PIM.** No families, no attribute editor UI, no reference-entity system.
- **AI translation.** The prod AI provider is exhausted and gated. This proposal moves existing
  human-authored text; it does not generate any.
- **`flatFileSnapshot`.** Tracked separately — see `docs/2026-07-31-snapshot-versioning-sv.md`.

---

## 8. The one-paragraph version

`ChannelListing` is keyed `(productId, channel, marketplace)` where `marketplace` is a country code, so
*"Italian"* and *"Amazon-formatted"* are fused and the same Italian description is authored once per
channel. Four of five studied vendors store locale and compute or overlay channel. **Add one additive
table, `LocaleContent[productId, locale]`, beneath the existing override tier**; resolve
override → channel → locale → product → computed; render the three states in the cell so the layering
is visible. **LL.0 is a read-only report that measures how much duplication actually exists — and if
that number is small, this proposal should be declined.**
