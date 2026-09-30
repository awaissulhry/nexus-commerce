# Attribute scope — study (`study/attribute-scope`)

**Status: 🟡 STUDY ONLY. No code, schema or product-sheet file is changed.** Written 2026-09-26.
Worktree `/private/tmp/nexus-attribute-scope`, branch `study/attribute-scope`, from `origin/main` `578c3756c`.

Labels: **read** = seen in code or a file · **measured** = counted on real data · **inferred** = follows from the code,
not run. Paths are relative to the worktree.

Files in this folder:
- `README.md` — this study.
- `appendix-a-classification.md` — **every attribute in the shared set, one row each** (242 rows).
- `classification.tsv` — the same table, machine-readable.
- `appendix-b-channels-and-industry.md` — what Amazon, eBay, Shopify and Etsy publish, and what 14 other tools do (with links).

## Summary

- **You are right.** Most of the shared set is not shared. Of the 242 shared attributes:
  - **54 are core** — facts about the product that any channel can use (colour, size, material, gender, care, armour, CE facts, package size …).
  - **74 are channel-specific** — 69 are Amazon only, 4 eBay only, 1 Shopify only.
  - **114 are unused or duplicates** — about 37 repeat another attribute, about 77 do not fit this catalogue at all (batteries, flavour, scent, ring, lens, golf grip …).
- **How it happened (read).** On 2026-09-07 one manual script (`apps/api/scripts/complete-channel-mapping.mts`) turned every
  field of 31 cached Amazon and eBay schemas into a shared attribute: 216 new attributes and 450 family links.
  It was a one-off run, not a rule. Then the "copy to another business" feature (`services/assortment/copy-run.service.ts`)
  copied the list on (inferred for Motovento: it has 197 attributes and only eBay + Etsy connected).
- **The Shared view never asks which channels you use** (read). It shows every attribute of the product's family.
- **The worst cases today:**
  - **Only eBay connected** (Motovento): Shared shows about 197 Amazon-shaped attributes. Readiness still makes Amazon rows ("no account").
  - **Only Amazon connected:** Shared shows almost nothing (a new business gets no attributes and no family). The Amazon fields exist only on the Amazon scope, but they save into the shared store.
  - Every new business gets 20 markets, 19 switched on, whether or not it has an account there.
- **Almost no values are lost if we fix it.** The shared value store is nearly empty (measured on production today:
  only `armorType` on 69 products and `waterproofRating` on 20, plus control keys). Real values live on the channel listings.
- **What the best tools do** (Appendix B): one channel-neutral core; channel-only fields in a channel layer; required fields
  per channel and category; fields of a channel you did not connect are never shown.
- **The recommendation (§6):** a small core on Shared, channel fields on their channel scope, and everything driven by the
  channels the business has **connected**. Moving an attribute between Shared and a channel is one click, with a preview, and
  can be undone. No value is deleted.
- **Sessions (§8):** keep this study separate. Build it inside the attributes session (`feat/attributes`), because that
  session owns the same files and is building the concept list now (its step P3).

---

## 1. Your questions, short answers

| Question | Answer |
|---|---|
| Why are Amazon-only attributes in the shared scope? | One script copied every Amazon schema field into the shared list on 2026-09-07 (§2). Nothing decided that they are shared. |
| Which attributes are core, channel-specific, unused? | Appendix A — all 242, with the channels that use or need each one and the equivalent name on other channels. |
| Business with only eBay? | Today: a long Amazon-shaped Shared view that does not help, and Amazon readiness noise (§3). Target: core + eBay fields only (§6). |
| Business with only Amazon? | Today: a near-empty Shared view; Amazon fields only on the Amazon scope (§3). Target: core on Shared, Amazon fields on Amazon, same store as today (§6). |
| Best, most scalable approach? | Core + channel layers + "connected channels" drive what you see (§6). It matches the leading tools (§5). |
| Stay in another session? | No for the study, yes for the build: the attributes session (§8). |

## 2. How the shared set was built (read)

| Step | What happened | Evidence |
|---|---|---|
| Before 2026-09-07 | The dictionary had 23 attributes. | `docs/audits/2026-09-07-attribute-mapping/README.md:31` |
| 2026-09-07 | `complete-channel-mapping.mts --apply` walked 31 cached Amazon/eBay schemas (Amazon DE, IT, UK, FR, ES, NL; eBay IT). Every field became a `CustomAttribute` and was attached to families as optional. A measure became two attributes (`waist__sizeValue` + `waist__sizeUnit`). | script `:24-85`, `:107-126`; `mapping/source-definition-plan.ts:86-109`; audit README `:9` ("216 typed Master attribute definitions (239 total) and 450 optional family attachments") |
| 2026-09-10 | `shopify_product_type` and two temperature fields were added → 242. | `docs/audits/2026-09-10-etsy-attributes/master-data-audit.json` (`definitions`: 242, measured) |
| 2026-09-16 on | The assortment copy creates the source's groups, attributes, options, families and links in the receiving business; the live sync repeats it. | `assortment/copy-run.service.ts:102,169-215`; `sync.service.ts:414` |
| Today (measured) | Xavia Racing: 241 attributes, Jackets family 179. Motovento: 197 attributes, Jackets 179. | read-only production probe, 2026-09-26 |

- The script does not run again by itself. Nothing else calls `planProductSource` (read).
- A new business gets **no** dictionary and **no** family (`workspace.service.ts:118-155`, read). The attributes session
  seeds 35 starter concepts on its branch, but attaches them to no family, so they do not reach Shared yet (read in
  `/private/tmp/nexus-attributes`, uncommitted).

## 3. What each kind of business sees today

Mechanics (read):
- The studio's Shared scope is always "family mode": the registry fields + every attribute of the product's family
  (`studio-sheet.service.ts:1005-1023`, `sheet-columns.service.ts:1329-1351`, `family-sheet-schema.ts:32-100`).
  Channel schemas never feed Shared. There is no channel filter.
- `FamilyAttribute.channels` only adds "required by X" marks. It does not hide anything.
- The studio lands on "All attributes". `defaultVisible` is not read there.
- You cannot hide or archive an attribute. Delete is permanent and also removes its family links (`attributes.routes.ts:328-338`).
  A value left behind comes back as "Additional saved attributes".
- "Which channels does this business use" has 3 answers in the code: `Marketplace` rows (19 switched on for everyone,
  `market-catalogue.ts:43-68`), listing presence, and connected accounts (only the web scope bar uses this, `_studio/scopes.ts:128`).
- Readiness writes a row for every switched-on market, also where there is no account ("No active account for this
  destination", `readiness-index.service.ts:43-51`).
- Amazon schemas are cached per business. A business with no Amazon account has none (`channel-specs/index.ts:67-78`).
- An Amazon field with no listing store saves into the shared `Product.categoryAttributes` bag (`channel-specs/amazon.ts:122-129`).

| Business | Shared scope | Channel scopes | Readiness |
|---|---|---|---|
| New, only eBay | Registry fields only (no family). Only `name` is required. | eBay aspects of the category. Only Brand links to Shared (`channel-specs/ebay.ts:191-193`). | Amazon "no account" rows for 12 markets. |
| New, only Amazon | Registry fields only. | Amazon schema fields (after its schemas are cached). They save into the shared bag and show up on Shared as "Additional saved attributes" (inferred). | Rows for eBay, Etsy, Shopify with "no account". |
| New, no channel | Registry fields only. | None in the bar. | "no account" rows for all 19 markets. |
| Motovento (eBay + Etsy) | ~197 Amazon-shaped attributes, all optional. | eBay and Etsy. | Amazon rows although no Amazon account. The copied dictionary came **without** Xavia's channel links (`schemaMapping` is not copied, inferred). |

## 4. The classification (Appendix A)

Source list: the 242 attributes read on 2026-09-10 (a repo snapshot). Channel facts come from the Owner's 13 Amazon
templates, the cached Italian Amazon schemas in the repo, the Owner's 14 eBay files, the repo's eBay fixture for 177104,
the public Shopify taxonomy, and the 2026-09-07 mapping audit.

| Class | Count | In the Jackets family (198 on 2026-09-11) |
|---|---:|---:|
| Core | 54 | 49 |
| Channel-specific | 74 (Amazon 69, eBay 4, Shopify 1) | 49 |
| Unused or duplicate | 114 (≈37 duplicates, ≈77 not relevant) | 100 |

**Top merge groups** (keep one, map the rest):
1. Colour: `color`, `exact_color`, `specific_color`, `color__standardized_values` → one variant colour code + one brand colour name.
2. Material: `material`, `fabric_type`, `outer`, `exact_material`, `specific_material`, `compliance_outer_surface_material` (keep lining `inner` apart).
3. Gender and audience: `target_gender`, `department`, `suitable_for` (eBay "Adatto a"), `body_type`.
4. Protection: `garmentClass`, `ceCertification`, `regulatory_compliance_certification`, `glove_*`, `armorType`, `protection`, `impactProtectors`.
5. Pockets: `number_of_pockets`, `front_pocket_count`, `has_pockets`. Pack quantity: `number_of_items`, `item_package_quantity`, `unit_count`, `number_of_pieces`.
6. Pairs: warranty ×2, features ×2, neckline/collar, pattern ×2, stretch ×2, temperature ×2, item type / Shopify product type.
7. 7 of the 13 Amazon `compliance_*` fields copy a plain fact that already exists. 10 attributes shadow a native product column (`countryOfOrigin`, `hsCode`, `ppeCategory`, …).

**Amazon only (69):** department, weave type, dangerous goods, batteries, the size records (`apparel_size__*`,
`bottoms_size__*`, `jacket__*`), lining, pocket, sleeve type, silhouette, climate, sport, glove type, hand orientation,
toy-safety warnings, all AUTO_ACCESSORY fitment fields, GPSR attestation, title differentiation, language.

**True core, mapped on 2+ channels today (18):** material, colour, size, style, age range, fit, care, country of origin,
closure, item type, seasons, features, and the 6 package size/weight fields.

**How much of Amazon is plumbing (measured on the Owner's COAT+PANTS template, 344 columns):** 107 listing plumbing
(identity, variations, images, offer, browse node, product ID), 85 safety/compliance declarations, 10 content, and only
142 columns (74 attributes) are product facts.

Judgement calls are marked in each row's "Why". Borderline: `inner`, `outer`, `number_of_pockets`, `lining_description`, `part_number`.

## 5. What the best tools do (Appendix B)

- **Every tool keeps one channel-neutral core.** Channel-only fields live in a mapping, template or listing layer
  (Akeneo catalog targets, Productsup export stage, Zentail channel attributes, Linnworks configurators).
- **Required fields are per channel and category** (Akeneo "completeness per channel", Salsify readiness reports, Channable "mandatory/recommended/optional").
- **No tool shows fields of a channel you did not connect.** Linnworks: no configurator until the channel is connected.
- **Zentail's rule is the clearest:** a channel attribute is used only for "a different value on a specific channel" or a
  fact not in the core.
- **Only Akeneo has a "promote to core" path**, and it is a suggestion to the admin. Nobody documents a safe one-click promote/demote with preview. This is where Nexus can lead.
- **Channel rules change often:** Amazon monthly (last week), eBay "fairly rapidly" with "Required soon" dates, Shopify taxonomy about every quarter, Etsy retires property IDs.

## 6. The recommended model

**Rule 1 — Placement is a decision, not a storage move.** Each business attribute gets a placement: **Shared** or
**Channel** (which channel(s)). Placement decides where the attribute is shown and who owns it. The value stays where it
is today (`Product.categoryAttributes` for product facts; listing stores for per-market values). So:
- moving an Amazon-only attribute off Shared moves **no data** — the Amazon scope already reads the same key;
- "Move to Shared" copies values up only when they live per listing (for example an eBay aspect), with a conflict preview.

**Rule 2 — Connected channels drive what you see.** One "channel footprint" per business = connected, active accounts and
their chosen markets. Sheet coordinates, readiness, "required by" marks and suggestions all read it. A switched-on market
with no account is shown as "not connected", and it is never counted as missing work.

**Rule 3 — The core is small and linked to concepts.** Shared = core attributes. Each one links to a concept (the
attributes session's `semanticKey` + concept catalogue), which knows its Amazon, eBay, Shopify and Etsy names. So a core
value reaches every connected channel with no manual rule, also after a copy to another business.

**Rule 4 — Channel fields stay on the channel scope.** They come from the channel's own schema (Amazon product type per
market, eBay category per site, Shopify category, Etsy taxonomy). They need no dictionary row.

**Rule 5 — Nothing is lost, everything can be undone.** Archive instead of delete. Merge with a preview. Every placement
change is audited and can be reversed.

**What the worst cases become:**

| Case | Shared | Channel scope | Readiness |
|---|---|---|---|
| Only eBay | Core only, with "eBay" badges on what eBay uses. | eBay aspects of the category. | eBay only. |
| Only Amazon | Core only, with "Amazon" badges. | Amazon product-type fields (the 69 Amazon-only ones live here). | Amazon only. |
| No channel yet | Core starter set (a starter family). | None. | None — "connect a channel" instead of red rows. |
| A channel is added later | Unchanged. Suggestions: "eBay asks for Season on jackets — add Season to Shared?" (one click, or bulk). | New scope appears. Core values flow in through the concepts. | That channel's gaps appear. |
| A channel is removed | Attributes only it used become "dormant": hidden by default, never deleted. | Hidden; values kept. | Gone. |

**User control (one place + in the sheet):** the attributes settings screen lists every attribute with: concept,
placement, "used by" (connected channels, and where required), fill rate, families. Actions: Move to Shared / Move to
channel, Merge into…, Archive / Restore, Required per channel. The same actions sit in the sheet column menu.

## 7. Gaps and what I could not read

- **Live attribute list: blocked.** A second read-only production read (the full attribute list, family links and
  channel-store key counts) was refused by this session's safety check. I did not try another route. So:
  - the classification uses the 2026-09-10 snapshot (242). Production has 241 now; the 1-row difference is unknown;
  - the Jackets family had 198 on 2026-09-11 and has 179 now; the 19 that left are unknown;
  - "unused" means "not filled in the 2026-09-10 snapshot and not needed by these channels". Values imported after
    2026-09-10 and values on channel listings were not counted per attribute.
  - To close it: allow that read (it is `BEGIN READ ONLY` and rolled back), or run it yourself.
- **Amazon:** no template or cached schema for HELMET, POWERSPORTS_RIDING_SUIT, MOTORCYCLE_ACCESSORY. The GLOVES folder has images only.
- **eBay:** required/recommended flags are confirmed only for 177104 (only Brand is required). 177101 and 177109 are `?`.
- **Shopify:** no product category is assigned in the store, so Shopify matches are name matches to the taxonomy, not mappings.
- **Etsy:** no category and no property cache. Most Etsy cells are `?`.

## 8. Sessions — where should the build happen?

| Session | Owns | Overlap with this work |
|---|---|---|
| Attributes (`feat/attributes`, `/private/tmp/nexus-attributes`) | schema attribute models, `packages/shared/attributes`, dictionary + concept catalogue (P3, in progress), readiness, `family-sheet-schema.ts`, `workspace.service.ts`, attributes/families routes | **High** — same files, and its concept catalogue is Rule 3. |
| Product sheet (`feature/product-sheet-views-p2`) | sheet UI, views, scope bar, design system | Medium — the badges, dormant toggle, column menu actions. |
| Channel mappings study (`feat/channel-mappings`) | versioned mapping sets | Low — it uses the concept catalogue as its default target. |
| PSIE (product-sheet import/export) | import/export files | Low. |

**Recommendation:** keep this study here (read-only, done). Hand the approved plan to the attributes session as a new step
(for example "P3b — attribute scope"), and give the UI parts to the product-sheet session. A fourth branch that edits
the same files would fight the attributes session over `schema.prisma`, `family-sheet-schema.ts` and `workspace.service.ts`.

## 9. Decisions (answered 2026-09-26)

The plan is `PLAN.md` in this folder. **🟢 APPROVED by the Owner 2026-09-26.**
- **D1 — Where channel-only attributes live:** A — a placement label; values stay where they are.
- **D2 — Which session builds it:** the attributes session (`feat/attributes`), as step P3b. The product-sheet session builds the UI parts. See `HANDOFF.md`.
- **Cleanup of the 242:** a review screen, approved group by group, with an "approve the rest" button (plan step S5).
