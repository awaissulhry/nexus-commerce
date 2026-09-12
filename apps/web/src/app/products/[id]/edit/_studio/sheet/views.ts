/**
 * The studio sheet's VIEWS — one module for BOTH scopes (moved from `master/views.ts`, 2026-09-04).
 *
 * The rules here read a column's own `group`, `storage`, `key`, `axis` and `requiredBy`, none of
 * which is master-specific, and the channel scope had been importing this file from under
 * `master/` since #467 — a shared rule filed under one scope's directory is how a peer forgets it
 * is shared. It lives beside `flaggedColumns.ts` now, the other rule the two scopes share.
 *
 * ## The ground state is EVERY column (Owner, 2026-09-04)
 *
 * The sheet LANDS FULL — every declared column, in the §9.2 order — on every scope and on every
 * reload (`design-system/grid/views/landing.ts`). "All attributes" is the first preset in the
 * menu and the way back from any narrower view. The narrow landing rule the Owner approved on
 * 09-01 (#173, "identity + required + spine + flagged") is NOT gone: it is the **Essentials**
 * preset, one click away, and its derivation is unchanged. What ended is its role as the thing
 * the sheet hides behind. See `docs/2026-09-04-sheet-views-and-full-attributes-design.md`.
 *
 * ## Defined as RULES, not as key lists — and the task views are the CONTRACT's groups
 *
 * The column set is a union over product types and markets and changes with both: `fabric_type`
 * exists for OUTERWEAR and not for a product type without it, and a channel's schema gains and
 * loses attributes when it is refreshed. A view written as ninety literal keys is correct on the
 * day it is written and quietly wrong afterwards — it cannot classify an attribute nobody had seen
 * yet. A rule can: it reads the column's own `group`, `storage`, `requiredBy` and `axis`.
 *
 * 🔴 AM.1 (2026-09-05, session 5c) made the second half of that literal. The contract now serves
 * every attribute a channel declares, in the CHANNEL's OWN groups — master·IT went 102 → 185
 * columns (Identity 6 · Content 12 · Offer 48 · Images 16 · Shipping 4 · Variations 3 · Product
 * details 41 · Product identity 7 · Safety and compliance 25 · Identifiers 6 · Pricing 7 ·
 * Inventory 4 · Physical 6), Amazon·IT 186, eBay·IT 83 — and the flat "Attributes" bucket the old
 * Content / Specs / Logistics / Identifiers rules carved up no longer exists. Those hand-written
 * key lists would have classified `item_name` and `bullet_point`, which are gone (merged into
 * `name` and `bulletPoints_1..10`), and would have filed 140 columns under "Everything else".
 * So the task views ARE the contract's groups, one preset per group in the contract's order —
 * the server has already decided what goes together, and a second opinion here would drift the
 * day the server's changes. Essentials (the #173 rule) and Localisation·<locale> stay, because
 * they are facts about the columns (required-ness, axes, per-language storage), not a grouping.
 *
 * ## These are the FALLBACK
 *
 * PES.5 §3.1 may serve `views: [{id, label, columnKeys}]` from `/studio/columns`, computed against
 * the same schema the columns come from. When the server supplies them, they win — one definition,
 * server-side. Measured 2026-09-04: `views` is `null` on every coordinate, so these rules ARE the
 * live path and `sheetViews()` reports which source produced them. "All attributes" is prepended
 * either way: the ground state is the sheet's, not a server view's.
 *
 * ## Every column is reachable
 *
 * `RESIDUAL` catches whatever no view claims, so a new attribute is never invisible: it lands in
 * "Everything else" and in the Customise dialog — and, since the sheet lands full, on screen.
 */
import { allColumnsPreset, type GridViewPreset } from '@/design-system/grid/views/presets'

import { flaggedColumnKeys } from './flaggedColumns'
import type { SheetColumn } from './master/types'

/**
 * The INTENT: what a view must never drop — identity, and the numbers that rank the work.
 *
 * 🔴 Two of these three are no longer COLUMNS, and asking for them by name is a live defect (#770).
 * `sku` became the identity band's key line (#714) and `completeness` became the readiness pill
 * inside it (#727); neither is built any more — `sku` is in `RESERVED_COLUMN_IDS` and `completeness`
 * is not on the wire at all. So every master load asked the prefs bridge for two columns the grid
 * cannot address, and PES.3's refusal logged `sku, completeness` to the console on each one.
 *
 * The list is KEPT rather than trimmed to `['product']`, because it records what the sheet is trying
 * to guarantee, and `residualColumns` still needs to exclude all three so the band's contents are
 * not offered again under "Everything else". What changes is that nothing may use it as a set of
 * addressable ids: `alwaysColumnsFor` resolves it against the columns that actually exist.
 */
export const ALWAYS_COLUMNS = ['product', 'sku', 'completeness'] as const

/** The identity block's own column id on MASTER — the one column the grid really has for it. */
export const IDENTITY_COLUMN = 'product'

/**
 * Schema columns the sheet NEVER builds, on either scope: the identity band draws the SKU as its key
 * line (#714), so the schema's `sku` column would be a 220px duplicate beside it. Master reserved it
 * from the start; the channel only ever HID it behind its narrow landing — and the moment the sheet
 * landed on every column (2026-09-05) the duplicate surfaced first in the centre band and cost
 * Amazon·IT two of its seven required columns at 1440 (`npm run layout:v2`, §9.1). One list, both
 * scopes; the parity gate is what keeps them from drifting again.
 */
export const RESERVED_COLUMN_IDS = ['sku'] as const

/**
 * The always-columns the grid can actually address, derived from the live set.
 *
 * 🔴 Derived, not hardcoded to `['product']`. If `completeness` ever returns as a real column, or a
 * scope keeps `sku` as its own column, this starts including it again with no edit here — whereas a
 * trimmed constant would silently stop guaranteeing it. The failure mode of a fixed list is a column
 * that quietly leaves; the failure mode of this is a preset that offers slightly less than intended,
 * which is visible in the dialog.
 */
export function alwaysColumnsFor(addressable: readonly string[]): string[] {
  const have = new Set(addressable)
  return ALWAYS_COLUMNS.filter((k) => have.has(k))
}

/** The #173 rule, as a preset. Was the landing view (`'narrow'`); the id changed with the role. */
export const ESSENTIALS_VIEW_ID = 'essentials'
/** The second fixed set — every column some channel REQUIRES on this product type, filled or not. */
export const REQUIRED_VIEW_ID = 'required'

export interface ViewContext {
  /** What this family actually varies by — `['Colore', 'Taglia']` on the XAVIA jackets. */
  variationAxes: string[]
  locale: string
  /**
   * Column keys carrying a readiness issue on at least one row IN VIEW — rule 4 of Essentials.
   * Passed in rather than derived here because it is a fact about the ROWS, and this module only
   * ever sees columns. Empty is a valid answer and means "nothing is flagged".
   */
  flaggedKeys?: readonly string[]
  requiredKeys?: readonly string[]
}

/**
 * An axis is what the CONTRACT says it is (#711/P11) — never a substring of a localised label.
 *
 * 🔴 The matcher this replaces was wrong in both directions and only looked right. It lowercased
 * the family's `variationAxes` — which hold LOCALISED labels, `['Colore','Taglia']` — and tested
 * them against column keys and labels with `includes`. Measured by PES.5 against the live contract
 * for GALE-JACKET (master·IT): `color` matched **by luck**, because `'colore'.includes('color')`,
 * and `size` never matched at all, because `'taglia'` and `'size'` share no substring. `size` is a
 * real variation axis carrying data on 2 of 20 rows and the default view had been dropping it.
 *
 * `axis` is derived server-side (`sheet-columns.service.ts:115`) from `scope === 'per_variant'` AND
 * an exact, case-insensitive match against the family's axis KEYS — the stored spelling, no label
 * consulted. `/studio/sheet` always sets it; it is optional on the type only because the base
 * column set is built without a family. So `=== true` rather than a truthiness test: `undefined`
 * means "not from this endpoint", which must not silently read as "not an axis".
 */
const isAxisColumn = (c: SheetColumn): boolean => c.axis === true

/**
 * ESSENTIALS — the #173 rule (approved by the Owner 2026-09-01 as the landing view; a preset since
 * 2026-09-04). A RULE, not a column list.
 *
 * 🔴 Why a rule. Measured across 120 rows / 5 families on the live contract: the master scope
 * offers 102–147 columns, **7** carry data on more than one family, and **134 of 155 are never
 * populated in any of them**. The Owner's "I barely see a few columns" had the opposite cause to
 * the one it sounds like — there were never a hundred useful columns; the sheet was spending its
 * width on emptiness and squeezing the seven that carry the product.
 *
 * And a FIXED list cannot work: the required set is per product type. Measured `required.total` per
 * row is 7 (78 rows), 6 (26), 0 (16) — `fabric_type` is required for OUTERWEAR and meaningless on a
 * knee slider. Any fixed list is wrong for most of the catalogue in one direction or the other.
 *
 * The four rules, in order, each earning its place from measurement:
 *
 * 1. **Identity, always** — name, status (+ the pinned SKU/thumbnail and readiness chip, which are
 *    `ALWAYS_COLUMNS` and never leave). 100% populated; the row's handle and its verdict.
 * 2. **Commerce spine, always** — basePrice, totalStock, brand, productType. Measured 100/100/70/87%
 *    populated. `productType` earns it twice: it decides which schema applies to every other column,
 *    and it is itself a readiness warning on 16 of 120 rows.
 * 3. **Every field REQUIRED for this row's product type — filled or not.** The one to defend: this
 *    is an EDITOR, not a report. An empty required cell IS the work, and hiding it hides the job.
 *    The most common row state in the sample is "product_description and bullet_point missing" —
 *    104 of 120 rows — and under this rule they are always on screen. Adds ≤7 columns.
 * 4. **Anything flagged by readiness on a row in view.** Measured: `dsa_responsible_party_address`
 *    and `gpsr_safety_attestation`, 104/120 each — GPSR, and the server's own message says the
 *    listing can be **suppressed on EU marketplaces**. A field that can suppress a listing belongs
 *    on screen without being asked for.
 *
 * Typical output on GALE-JACKET: 14 columns. On a product type with no schema it degrades to rules
 * 1–2 — about 8 — which is correct: there is nothing else to show.
 *
 * The family's variation axes stay in, after the required block: on a family that varies by
 * Colore × Taglia those two columns are how an operator tells one row from another.
 */
const COMMERCE_SPINE = ['basePrice', 'totalStock', 'brand', 'productType'] as const

export function essentialsColumns(columns: SheetColumn[], ctx: ViewContext): string[] {
  const present = new Set(columns.map((c) => c.key))
  const keep = (k: string) => present.has(k)
  const flagged = new Set(ctx.flaggedKeys ?? [])

  const ordered = [
    /* 🔴 §9.3b (#362) — `name` and `status` are NOT identity on a family sheet, and used to sit
       here, in front of everything.

       All 21 rows of a family carry the *identical* parent title, so `name` is 220–380px of column
       that distinguishes no row from any other, and it sat between the identity block and the work.
       Measured at 1440: `389 + 220 + 110 + 910 = 1,629` against a 1,372px viewport, so only 3 of the
       7 required columns were reachable without scrolling. Moved after the required block it is
       `389 + 910 = 1,299` — 73px spare, and 7 of 7. The widths alone did not fix it; both were
       needed.

       The axes used to stay in front on the same argument; #690 measured that they must not — see
       the block below. */
    /* 🔴 REQUIRED BEFORE THE SPINE (§9.2, hub #242). The rules still read identity → spine →
       required, but the ORDER on screen is identity → required → spine, and the inversion is the
       point: it decides whether an operator's eye lands on the WORK or on the done-ness.
       `basePrice` and `totalStock` are populated on 100% of rows — they are the most reassuring
       and least actionable columns on the sheet. `product_description` and `bullet_point` are
       missing on 104 of 120 measured rows. Putting the filled columns first sorted the sheet by
       comfort. */
    // 3 — required for this product type, filled or not
    ...columns.filter((c) => c.requiredBy.length > 0 || ctx.requiredKeys?.includes(c.key)).map((c) => c.key),
    /* 🔴 THE AXES FOLLOW THE REQUIRED BLOCK — they used to lead it (#690, hub-ruled 2026-09-02).
       The argument for leading was sound and the measurement refuted it. `isAxisColumn` fires on
       the MARKET's answer, not the family's: the contract returns `color.scope: 'per_variant'` on
       IT and `'global'` on DE for the same product, so on IT — and only on IT — a 160px `color`
       column was hoisted in front of the seven required ones. Measured on screen at 1440
       (GALE-JACKET, root 1372, fresh context): master·IT 6/7 with `product_description` clipped,
       87px short, and the channel scope the same. Every §9.1 master reading in the programme had
       been taken on DE, where the hoist does not happen, so the rule's own cost had never been
       seen.
       And the hoisted column was EMPTY: `color` is populated on 0 of 21 rows on both scopes, while
       the values that DO tell the rows apart live in `row.axisValues` ({"Size":"XS","Color":"Nero"})
       — 160px of "—" in front of the work. The axes stay IN the view (an operator still reaches
       them without the Customise dialog) and stop outranking the fields the sheet exists to fill. */
    ...columns.filter(isAxisColumn).map((c) => c.key),
    // `name` / `status` land HERE — after the work, in front of the spine (§9.3b). They are still
    // in the view and still early; they are simply no longer between the operator and the fields
    // the sheet exists to fill.
    ...['name', 'status'].filter(keep),
    // 2 — commerce spine, after the work rather than in front of it
    ...COMMERCE_SPINE.filter(keep),
    // 4 — flagged by readiness on some row in view
    ...columns.filter((c) => flagged.has(c.key)).map((c) => c.key),
  ]
  // De-duplicated preserving first appearance: a column can satisfy several rules (brand is spine
  // AND required on 20 rows) and must appear once, in its earliest position.
  return [...new Set(ordered)]
}

/**
 * A column definition's rank, for `columnDefs`.
 *
 * A GROUP ranks as its best-ranked child, rather than falling to the end unranked. The studio sheet
 * does not switch grouping on (`grouped: true` is opt-in, and `marryChildren` draws the group header
 * twice once any child is pinned — see `columns.tsx`), so this branch is defensive rather than
 * exercised in the sheet; it is tested because an untested defensive branch is just a guess with a
 * comment. Note it ranks the groups, NOT the columns inside them: ordering within a group is a
 * different decision and nothing has asked for it.
 */
export function rankOfColumn(
  def: { colId?: string; field?: string; children?: unknown[] },
  rank: Map<string, number>,
): number {
  if (Array.isArray(def.children)) {
    const kids = def.children.map((c) => rankOfColumn(c as Parameters<typeof rankOfColumn>[0], rank))
    return kids.length ? Math.min(...kids) : Number.MAX_SAFE_INTEGER
  }
  return rank.get(String(def.colId ?? def.field ?? '')) ?? Number.MAX_SAFE_INTEGER
}

/**
 * §9.2 — the order the sheet renders EVERY column in, and the order "All attributes" holds.
 *
 * The server arranges attributes in workflow groups, with required fields first INSIDE each group.
 * Preserve that order for the sheet, picker and export. Essentials is a visibility preset; using
 * its ranking here split Content and put Condition ahead of Classification on eBay.
 */
export function orderColumnKeys(columns: SheetColumn[], _ctx: ViewContext): string[] {
  return columns.map((c) => c.key)
}

export interface SheetViewsResult {
  /** "All attributes" first, then Essentials and the task views, then "Everything else". */
  presets: GridViewPreset[]
  /** `server` when PES.5 supplied the task views; `rules` when these fallbacks ran. */
  source: 'server' | 'rules'
}

/**
 * Build the view list for a live column set — the SAME list on every scope.
 *
 * A rule-built view that matches NOTHING is dropped rather than offered: a "Logistics" entry that
 * opens onto identity columns alone tells the operator their catalogue is broken when in fact this
 * product type simply has no logistics attributes.
 */
export function sheetViews(
  columns: SheetColumn[],
  ctx: ViewContext,
  serverViews?: Array<{ id: string; label: string; columnKeys: string[] }>,
): SheetViewsResult {
  const all = allColumnsPreset(orderColumnKeys(columns, ctx))

  if (serverViews && serverViews.length > 0) {
    return {
      source: 'server',
      presets: [all, ...serverViews.map((v) => ({ id: v.id, label: v.label, columns: v.columnKeys }))],
    }
  }

  /* CH.1 (Owner, 2026-09-05 — the converged sheet-chrome recommendation): the sheet offers TWO
     fixed sets, every attribute and the REQUIRED ones, plus whatever the operator saved. The
     per-group presets, Essentials and the Localisation set went with the presets menu: the group
     headers and the Customise dialog already say what the groups are, and "what is required" is
     the one narrowing asked for daily. `essentialsColumns` stays a tested rule, offered nowhere. */
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const requiredKeys = orderColumnKeys(columns, ctx).filter(
    (k) => !ALWAYS_COLUMNS.includes(k as never) && ((byKey.get(k)?.requiredBy.length ?? 0) > 0 || ctx.requiredKeys?.includes(k)),
  )
  const required: GridViewPreset[] = requiredKeys.length > 0
    ? [{ id: REQUIRED_VIEW_ID, label: 'Required', description: 'Applicable requirements for these rows, including active category conditions', columns: requiredKeys }]
    : []

  const focused: GridViewPreset[] = [
    { id: ESSENTIALS_VIEW_ID, label: 'Essentials', description: 'Identity, required facts, variation axes and fields that need attention', columns: essentialsColumns(columns, ctx) },
    { id: 'family-facts', label: 'Family facts', description: 'Attributes declared by this product family', columns: columns.filter(column => column.familyRules).map(column => column.key) },
    { id: 'localized-content', label: 'Localized content', description: `Content for ${ctx.locale}`, columns: columns.filter(column => column.storage === 'localizedContent' || Object.values(column.channels ?? {}).some(facts => facts.store?.kind === 'platformAttributes' && ['_etsyInformationLocales', '_shopifyInformationLocales'].includes(facts.store.path[0]))).map(column => column.key) },
  ].filter(view => view.columns.length > 0)
  return { source: 'rules', presets: [all, ...required, ...focused] }
}

/**
 * Does this row still owe a required field?
 *
 * Reads the server's own `completeness.required.missing`, which is computed from the same
 * applicability rules the readiness pill uses (`@nexus/shared/master-sheet`). Recomputing it here
 * would let the row filter and the pill disagree about the same row.
 */
export function rowIsMissingRequired(row: { completeness?: { required?: { missing?: unknown[] } } }): boolean {
  return (row.completeness?.required?.missing?.length ?? 0) > 0
}

/* Re-exported so consumers keep one import site (#467/D11). */
export { flaggedColumnKeys }
