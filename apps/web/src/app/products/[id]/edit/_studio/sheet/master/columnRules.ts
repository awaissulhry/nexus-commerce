/**
 * PES.2 — the master sheet's pure COLUMN decisions, in a `.ts` so the node suite can reach them.
 *
 * 🔴 Why this file exists, and why it is not the whole of `buildMasterColumns`.
 *
 * FE.1's set-scan (hub #348) named `buildMasterColumns()` — weight 268, module scope, no test — as
 * "the largest single unit that becomes testable purely by moving to a `.ts` sibling". It is not:
 * that function returns column definitions whose `cellRenderer`s **are JSX**, so it cannot leave a
 * `.tsx` wholesale. What CAN leave are the decisions it makes before it renders anything, and those
 * are the ones worth testing — a renderer's output is checked by looking at the screen, but a cap,
 * an editability predicate and a source label are silent when wrong.
 *
 * **Nothing here may import `@/design-system/grid`.** That barrel re-exports `NexusGrid.tsx`, and a
 * node test importing anything downstream of a `.tsx` dies at PARSE, before a single test runs.
 * This module depends only on `./types` and `@nexus/shared`. Same constraint that produced
 * `masterWrite.ts` and `design-system/grid/renderers/emptyValue.ts`.
 */
import { refusalWords } from '@/design-system/grid/editors/refusalWords'

import { columnApplies, columnEditableOnRow, columnRequiredByAny, columnRequiredHere, isProductRelationshipColumn } from '@nexus/shared/master-sheet'

/* The provenance VERDICT and its sentence — a pure module (no React), so the node suite still reaches this file. */
import { classifyProvenance, provenanceLabel, provenanceTooltip, type CellProvenance } from '@/design-system/grid/renderers/provenance'
import { fallbackLanguage, languageTextName } from '../languages'
import type { SheetColumn, StudioCellValue, StudioRow } from './types'

export const cellOf = (row: StudioRow, key: string): StudioCellValue | undefined => row.values[key]

/**
 * Can this cell be edited?
 *
 * Three independent vetoes, and the row-level one is the subtle one: a column can be editable in
 * general and still not apply to THIS row (a variation axis a row does not vary by), in which case
 * the cell holds nothing and offering an editor invites a write that has nowhere to land.
 */
export function cellIsEditable(col: SheetColumn, row: StudioRow | undefined): boolean {
  if (!row) return false
  if (!col.editable) return false
  // P1 — the family row also holds a per-variant column's value for its variations (not an axis; `columnEditableOnRow`).
  if (!columnEditableOnRow(col, row)) return false
  // 🔴 `!== false`, not a truthy test: the server states editability per cell, and a cell that
  // simply does not carry the flag is editable. Reading `undefined` as "not editable" would lock
  // most of the sheet on any response that omits it.
  return cellOf(row, col.key)?.editable !== false
}

/**
 * 🔴 WHY A REFUSED CELL MUST SAY SO — the second half of the Owner's ruling on the 2026-09-03 P0:
 * *"If an editor genuinely cannot open (cell not editable), the sheet SAYS so in the cell's own
 * words — never silence."*
 *
 * MEASURED BEFORE THIS EXISTED, on `condition_type` (`editable: false` on the wire, made visible
 * through Customise), master·DE: double-click, Enter, F2 and typing a character each produced
 * **0 editors, 0 toasts, no `title`, and nothing new on screen**. Four gestures, four silences. An
 * operator cannot tell that from a broken sheet — which is exactly how the fill-handle defect went
 * two days without being called a defect.
 *
 * This is the same class the repo already guards in `scripts/check-silent-disabled.mjs` ("a control
 * that refuses must be able to say why"; 28 rule toggles refusing in total silence on prod), and
 * the house remedy stated there is *a handler that answers*.
 *
 * 🔴 IT IS DERIVED FROM `cellIsEditable`, NOT RE-STATED BESIDE IT. A second predicate one line away
 * diverges on the first caller that omits a clause, and then the sheet either refuses silently
 * again (reason `null` where the cell is locked) or explains a refusal that never happened. The
 * test that matters holds the two together: this returns a reason for EXACTLY the cells
 * `cellIsEditable` rejects, over every combination.
 *
 * The words are the CELL's, not a generic apology: each branch names the specific veto, because
 * "cannot edit" tells an operator nothing they had not already worked out.
 */
export function editRefusalReason(col: SheetColumn, row: StudioRow | undefined): string | null {
  // No row means no cell: an empty grid area has nothing to explain, and a toast there would be
  // noise fired by clicks that were never aimed at a cell.
  if (!row) return null
  if (cellIsEditable(col, row)) return null
  if (isProductRelationshipColumn(col.key)) return col.helpText ?? null
  const label = col.label || col.key
  /* 🔴 This function picks WHICH veto; `refusalWords` owns HOW IT IS SAID, so master and the channel
     cannot drift into two sentences for the same refusal. The two scopes genuinely do not share an
     editability predicate — the channel has a `writable` veto master has no concept of — so the
     seam is the reason, not the rule. */
  if (!col.editable) return refusalWords(label, { kind: 'column-read-only' })
  /* The two ways `columnApplies` can say no, told apart, because the remedies differ completely:
     one says "go to a variation row", the other says "this field is not part of this product type".
     Collapsing them into one sentence would send an operator looking for a row that does not exist. */
  if (row.isParent && col.scope === 'per_variant' && !columnEditableOnRow(col, row)) return refusalWords(label, { kind: 'per-variant-on-parent', axis: col.axis === true })
  if (!columnEditableOnRow(col, row)) return refusalWords(label, { kind: 'not-applicable', productType: row.productType })
  // The remaining veto is the per-CELL one: the column is editable and applies, and the server
  // still marked this particular cell locked.
  return refusalWords(label, { kind: 'cell-locked' })
}

/** The family row's value of a per-variant column its variations inherit (P1): editable there, optional, never required. */
export function holdsFamilyValue(col: SheetColumn, row: StudioRow): boolean {
  return row.isParent && !columnApplies(col, row) && columnEditableOnRow(col, row)
}

/** Whether a cell should be validated at all — a column that does not apply cannot be wrong. */
export function validationApplies(col: SheetColumn, row: StudioRow): boolean {
  return columnApplies(col, row)
}

/** Whether THIS row must fill this column — required is per row, never per column. */
export function requiredOnRow(col: SheetColumn, row: StudioRow): boolean {
  return columnApplies(col, row) && columnRequiredByAny(col, row)
}

/**
 * A requirement's name in user words (2026-10-04, Shared Cell details). `requiredBy` names a channel · market by its
 * label ("Amazon · DE") and the Shared record's own requirement as `'Master'` — the API's vocabulary, never a user word.
 * The server's own reading (`readiness-model.ts` `requirementSources`): `'Master'` is the product family's rule when the
 * column carries family rules, and the Shared product's own rule otherwise.
 */
export function requirementLabel(col: Pick<SheetColumn, 'familyRules'>, label: string): string {
  return label === 'Master' ? (col.familyRules ? 'the product family' : 'the Shared product') : label
}

/**
 * Who requires this column ON THIS ROW, in user words — the same disjuncts `columnRequiredByAny` ORs (a family rule, a
 * family `requiredWhen` condition, a channel · market), named instead of collapsed. Empty where the column does not apply.
 */
export function requiredByOnRow(col: SheetColumn, row: StudioRow): string[] {
  if (!columnApplies(col, row)) return []
  const labels = [...new Set(['Master', ...col.requiredBy])]
    .filter((label) => columnRequiredHere(col, label, row.productType, row.familyId, row.values))
  return [...new Set(labels.map((label) => requirementLabel(col, label)))]
}

/**
 * What the ✎ / 🔗 tooltip names as the source.
 *
 * `inheritedFrom` is an id and an operator reads SKUs, so it is resolved against the rows on screen
 * rather than printed as a cuid. `null` when the value is the row's own, and `null` — not the raw
 * id — when the parent is not among the rows: a cuid on screen is not a source label, it is noise
 * that looks like one.
 */
export function sourceLabel(row: StudioRow, key: string, rows: readonly StudioRow[]): string | null {
  const cell = cellOf(row, key)
  // ⚠ EQUIVALENT MUTANT, recorded so nobody reads the green suite as covering it: weakening this to
  // `if (!cell) return null` changes no observable behaviour, because a null `inheritedFrom` matches
  // no row's id and the lookup returns null anyway. The guard stays for intent and for the fast
  // path — but it is not load-bearing, and no test can make it so without inventing a row with a
  // null id, which the contract does not produce.
  if (!cell?.inheritedFrom) return null
  return rows.find((r) => r.id === cell.inheritedFrom)?.sku ?? null
}

/** The members whose mark names where the value comes from — the others (formula, out of date, AI) name nothing. */
const SOURCE_MEMBERS: ReadonlySet<CellProvenance> = new Set<CellProvenance>(['inherited', 'inheritedOverride', 'pinned', 'listingLevel', 'mapped', 'mappedShared'])

/**
 * The mark's source on the Shared scope (2026-10-04, channel cell marks) — the SAME meaning as the channel scopes
 * (`channelCellFrom`): the layer the value follows, came from or no longer follows, read into the mark's one sentence
 * (`provenanceTooltip`), and never the row's own SKU. A parent's own value carries `inheritedFrom` = the parent itself,
 * which drew "Calculated by a formula — GALE-JACKET" and "Out of date — GALE-JACKET" on the parent row: a source that
 * names the row it is on says nothing.
 *
 *   inherited          the row it inherits from ("Inherited from GALE-JACKET — edit to give this row its own value"),
 *                      or the language a fallback shows ("the Italian text")
 *   pinned             the layer the pin no longer follows: a variation's parent ("Pinned on this row — it no longer
 *                      follows GALE-JACKET"). A parent row has nothing above it on this scope — no source, and the
 *                      sentence says "the layer above". Never the row's own SKU: before, a variation's pin named
 *                      nothing, so the mark said a bare "Pinned".
 *   inheritedOverride  the row whose override it inherits
 *   ai · aiStale       "the source text" for a machine translation ("Translated by machine and not reviewed yet",
 *                      "Translated by machine from an older value — the source text has changed since"); nothing for an
 *                      AI draft of this cell, which keeps the AI draft's sentence (`provenanceTooltip` tells them apart
 *                      by the source)
 */
export function markSourceLabel(member: CellProvenance, row: StudioRow, key: string, rows: readonly StudioRow[]): string | null {
  // A machine translation: it came from the source text — of an older version, for `aiStale` (`channelCellFrom` too).
  if (member === 'ai' || member === 'aiStale') return cellOf(row, key)?.translation ? 'the source text' : null
  if (!SOURCE_MEMBERS.has(member)) return null
  const parentSku = () => {
    const parent = row.parentSku ?? (row.parentId ? rows.find((r) => r.id === row.parentId)?.sku : null) ?? null
    return parent && parent !== row.sku ? parent : null
  }
  if (member === 'pinned') return parentSku()
  const cell = cellOf(row, key)
  // A language fallback names the language it shows ("Inherited from the Italian text"), as the channel scopes do.
  const language = member === 'inherited' ? fallbackLanguage(cell) : null
  if (language) return languageTextName(language)
  /* The wire names the row itself when nothing holds a value (`sharedMember`): on a variation that is its parent — the
     row it follows, which holds nothing either — never the row's own SKU. */
  if (cell?.inheritedFrom === row.id) return member === 'inherited' ? parentSku() : null
  const label = sourceLabel(row, key, rows)
  return label && label !== row.sku ? label : null
}

/**
 * The Shared scope's member for a cell, from the DS classifier (`classifyProvenance`, itself unchanged) — less one false
 * claim (2026-10-04): a row does not inherit from ITSELF. Every `buildMasterColumns` caller reads it: the Shared scope
 * and the Variants tab's axis columns. The content resolver answers a field that has no value
 * anywhere as `inherited` with no owner (tier `computed`, `content-resolver.ts`'s last line), and the wire then names the
 * row itself as the source (`content-read.ts`: `inheritedFrom = ownerId ?? productId`). Measured on GALE-JACKET in
 * Italian: the parent row wore 🔗 "Inherited" on 61 such cells (description, bullets, keywords, …).
 *
 * Only that case. The same wire on a VARIATION row is true: a variation with no value of its own follows its parent, and
 * the parent holds nothing either — the Owner-approved muted 🔗 "follows an empty parent" (2026-09-26, `grid.css`), kept.
 * A language fallback is true too: the row shows (or would show) its own text in the source language ("Inherited from
 * the Italian text"). Every other cell keeps the classifier's member, exactly as before.
 */
export function sharedMember(member: CellProvenance, row: Pick<StudioRow, 'id' | 'parentId'>, cell: StudioCellValue | undefined): CellProvenance {
  if (member !== 'inherited' || !cell || cell.inheritedFrom !== row.id) return member
  return row.parentId || fallbackLanguage(cell) ? member : 'own'
}

/* ── ONE function for the mark, the hover and Cell details (2026-10-04, Shared Cell details) ─────────────────────────
   Before, `provOf`, `markFrom` and the hover's notes lived inside `buildMasterColumns` (a `.tsx` closure), so the
   window that explains a cell would have needed a second copy — and two copies of "where does this value come from"
   is how a mark and its explanation come to disagree. The renderer, the AG hover and the window all call these. */

/** PES.8's AI draft for one cell. The sheet RENDERS it; it is never the cell's value (`BuildColumnsOptions.draftFor`). */
export interface AiDraft {
  draftValue: unknown
  baseValue?: unknown
  /** The underlying cell moved since the draft was generated — approving it overwrites an edit. */
  stale?: boolean
  unverified?: boolean
  violations?: string[]
}

/** What the Shared mark reads about a cell besides the wire: a pending AI draft, a stored formula, its refusal. */
export interface SharedCellFacts {
  draft?: AiDraft | null
  /** A stored `CellFormula` makes this value (`exprFor`). */
  formula?: boolean
  /** The server's reason the formula produced nothing (`errorFor`, `CellFormula.lastError`). */
  refusedReason?: string | null
}

/** The column facts the mark reads. `axis`: the server's verdict that this column IS one of the family's variation axes. */
export type SharedMarkColumn = Pick<SheetColumn, 'key'> & { axis?: boolean }

/**
 * A variation's own value of one of the family's variation axes (colour, size …).
 *
 * The wire fact is `SheetColumn.axis`, set by `/studio/sheet` (`studio-sheet.service.ts`: `col.scope === 'per_variant'
 * && family.variationAxes` holds the column key, compared by `canonicalVariantAxis`) — the family's own axes, never a
 * guess from the column's name. `undefined` (a read that did not say) is not an axis.
 */
export function isVariationAxisCell(row: Pick<StudioRow, 'parentId'>, column: SharedMarkColumn): boolean {
  return !!row.parentId && column.axis === true
}

/**
 * The Shared scope's member for a cell — what its mark draws and its tint paints (was `provOf` in `columns.tsx`).
 *
 * A pending AI draft is layered ON TOP of whatever the cell already was. Two corrections over the DS classifier
 * (`classifyProvenance` itself is unchanged): a row never inherits from itself (`sharedMember`), and — Owner decision 2,
 * 2026-10-04 — a variation's own axis value wears NO mark. The wire sends a variation's colour as `pinned`, which drew ✎
 * "Pinned on this row — it no longer follows GALE-JACKET" on every axis cell (40 on GALE-JACKET): false, because an axis
 * value is always the variation's own and never followed the parent. A variation that overrides a family-held value
 * keeps ✎ — that one did follow the family.
 *
 * Both corrections reach every `buildMasterColumns` caller: the Shared scope AND the Variants tab, whose axis columns
 * come from the same factory (`variants/family/columns.tsx`) — its colour and size cells lose the ✎ and the pinned tint
 * too, which is Owner decision 2 there as well.
 */
export function sharedCellMember(row: StudioRow, column: SharedMarkColumn, facts: SharedCellFacts = {}): CellProvenance {
  const cell = cellOf(row, column.key)
  // `sharedMember`: a row never inherits from itself.
  const member = sharedMember(classifyProvenance(
    { ...cell, aiDrafted: !!facts.draft, aiStale: !!facts.draft?.stale, formula: !!facts.formula, refusedReason: facts.refusedReason },
    'master',
  ), row, cell)
  if (!isVariationAxisCell(row, column)) return member
  /* An empty axis value names the variation itself as its source: no parent ever holds an axis value to follow. A
     language fallback names the variation too (an axis stored as text, German asked, its own Italian "Nero" shown), and
     that one IS true — it keeps 🔗 "Inherited from the Italian text". */
  return member === 'pinned' || (member === 'inherited' && cell?.inheritedFrom === row.id && !fallbackLanguage(cell)) ? 'own' : member
}

/**
 * The mark's `from` (was `markFrom`): the server's refusal reason verbatim; nothing over an AI draft; else the source by
 * the rule both scopes share (`markSourceLabel`).
 */
export function sharedCellFrom(member: CellProvenance, row: StudioRow, key: string, rows: readonly StudioRow[], facts: SharedCellFacts = {}): string | null {
  return member === 'refused' ? facts.refusedReason ?? null : facts.draft ? null : markSourceLabel(member, row, key, rows)
}

/**
 * The mark's ONE sentence on the Shared scope — its hover, its accessible name and Cell details' "where it comes from".
 * `''` for a cell with no mark. It is exactly what `ProvenanceMark` draws for the same `from` (no `tooltip` override on
 * this scope), and the channel scopes read the same `provenanceTooltip` — one set of words on both scopes. A machine
 * translation and a PES.8 AI draft are told apart by the source (`markSourceLabel`: "the source text" for a translation,
 * nothing over a draft).
 */
export function sharedCellSentence(member: CellProvenance, from: string | null): string {
  return member === 'own' ? '' : provenanceTooltip(member, from) || provenanceLabel(member)
}

/** The Shared hover's own notes for a cell, as pieces — the hover picks the first that applies, Cell details shows them. */
export interface SharedCellNotes {
  member: CellProvenance
  from: string | null
  /** The mark's sentence (`sharedCellSentence`); `''` for a cell with no mark. */
  source: string
  /** P1 — the family row's value of a per-variant column, which its variations inherit. */
  familyValue: string | null
  /** The column does not apply to this row: why, in the hover's words. */
  notApplicable: string | null
  /** A pending AI draft: the value underneath, what the draft breaks, whether it was checked. */
  draft: string[]
}

export function sharedCellNotes(row: StudioRow, col: SheetColumn, rows: readonly StudioRow[], facts: SharedCellFacts = {}): SharedCellNotes {
  const member = sharedCellMember(row, col, facts)
  const from = sharedCellFrom(member, row, col.key, rows, facts)
  const cell = cellOf(row, col.key)
  const family = holdsFamilyValue(col, row)
  const draft = facts.draft
  const base = draft ? draft.baseValue ?? cell?.value : undefined
  return {
    member, from,
    source: sharedCellSentence(member, from),
    familyValue: family ? 'The family value: each variation without its own value inherits it' : null,
    notApplicable: family || validationApplies(col, row) ? null
      : row.isParent ? col.axis ? 'A variation axis: each variation has its own value' : 'Belongs to each variation, not to the parent'
      : `Not part of ${row.productType ?? 'this product type'}`,
    draft: draft ? [
      base == null || base === '' ? 'The cell is empty now' : `Now: ${String(base)}`,
      draft.violations?.length ? `⚠ ${draft.violations.join(' · ')}` : null,
      draft.unverified ? 'Not verified against the channel' : null,
    ].filter((line): line is string => !!line) : [],
  }
}

/** The hover's first paragraph — ONE note, the most urgent first (the order the hover always had). */
export function sharedHoverNote(validationMessage: string | null | undefined, notes: SharedCellNotes): string {
  if (validationMessage) return validationMessage
  if (notes.familyValue) return notes.familyValue
  if (notes.notApplicable) return notes.notApplicable
  return [notes.source, ...notes.draft].filter(Boolean).join('\n')
}

/**
 * The column's width.
 *
 * Was `SPEC_WIDTHS` — a one-key override forcing `name` to 220 while the contract served 380.
 * **Deleted**: PES.5 now serves 220 on every scope (§9.3c), so the override would be a client
 * re-asserting a value the server already states, and the next person would have to check both
 * places to learn one number. The fallback stays because a column with no declared width still
 * needs one.
 */
export function widthFor(col: SheetColumn, fallback: number): number {
  return col.width ?? fallback
}
