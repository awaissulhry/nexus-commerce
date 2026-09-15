/**
 * PES.3 — the channel scope's row model: alias bands and the child SKUs under them.
 *
 * Layout §1: "Rows = one collapsible group per listing alias (①②③…), each with the SAME child SKUs
 * underneath, sharing one stock pool (qty per-channel, never summed)."
 *
 * ── The total that must not exist ───────────────────────────────────────────────────────────────
 * PES.5 §3.2 is explicit: "Quantity is per alias, never summed. Each alias group carries its own qty
 * cell; the family total is not the sum of its aliases. The contract carries no 'total quantity'
 * field precisely so no client can invent one" (reference_oversell_is_per_channel_not_summed).
 *
 * So this module computes NO quantity totals — not per scope, not per alias. Aliases share their
 * children, so any such sum double-counts units that do not exist and invites an operator to publish
 * stock they do not have. Quantity is read from the alias's own qty CELL, one row at a time, and
 * `assertNoQuantitySummation` below is the standing guard on that promise.
 *
 * Pure: no React, no AG import at runtime. Tested beside this file.
 */

import { writeGate as substrateWriteGate } from '@/design-system/grid/editors/writeGate'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'

import { aliasKeyOf, studioRowId, type AliasGroup, type ChannelSheetRow, type StudioCellValue, type StudioRow } from './types'

/** Keep matching rows and the listing band of each matching variant. Bands can match themselves. */
export function filterRowsWithBands(rows: ChannelSheetRow[], matches: (row: ChannelSheetRow) => boolean): ChannelSheetRow[] {
  const matching = new Set(rows.filter(matches).map(row => row.rowId))
  const aliases = new Set(rows.filter(row => matching.has(row.rowId)).map(row => aliasKeyOf(row.aliasId)))
  return rows.filter(row => matching.has(row.rowId) || (row.rowKind === 'parent' && aliases.has(aliasKeyOf(row.aliasId))))
}

/* 🔴 `aliasBarTone` LIVED HERE and is now the engine's `readyPillTone` (#727), with its four cases
   and two new regression cases beside it in `renderers/readyPillTone.vitest.test.ts`. Deleted only
   after reading that file: for an hour it looked like dead code while the rule it guards was being
   violated by the component that replaced it, and deleting it then would have taken #43's only
   guard with it. The rule moved first; the function went second. */


/**
 * What affordance a cell may offer, from the SERVER's own routing fields (ruling #58).
 *
 * Three rules, and each exists because the honest answer differs from the obvious one:
 *
 * 1. `writable: false` → NOTHING. A row under a non-primary alias has an unproven write path
 *    (PES.5-ii), so it gets no editor and no cascade click. The server's `writeBlockedReason` is
 *    shown verbatim rather than paraphrased into a guess.
 * 2. `writeTarget: 'master'` → **no cascade affordance at all.** `follows` may be TRUE on such a
 *    cell (basePrice is), and it is tempting to offer an un-pin — but this cell can only be written
 *    at master, so "un-pin" would either do nothing or rewrite every channel. Ruled honest, not
 *    contradictory: follows can be SEEN here and not ACTED on. The cell is still editable; the edit
 *    is simply a master edit, which rule 3 makes explicit.
 * 3. `affectsAllChannels: true` → editable, but the operator must be told BEFORE committing that
 *    this changes every channel, not just the one on screen.
 */
export type CellAffordance = 'blocked' | 'masterEdit' | 'cascade'

export function affordanceOf(cell: StudioCellValue | undefined): CellAffordance {
  if (!cell) return 'blocked'
  if (cell.writable === false) return 'blocked'
  if (cell.writeTarget === 'master') return 'masterEdit'
  return 'cascade'
}

/** Only a `cascade` cell may offer the pin/reset click. */
export function offersCascade(cell: StudioCellValue | undefined): boolean {
  return cell?.resettable !== false && affordanceOf(cell) === 'cascade'
}

/** Is this cell editable at all, per the server rather than the column? */
export function isCellEditable(cell: StudioCellValue | undefined): boolean {
  return !!cell && cell.editable !== false && cell.writable !== false
}

/** What a `cellValueChanged` should cause on a CHANNEL scope. */
export type ChannelWriteGate = 'ignore' | 'blocked' | 'acknowledge' | 'write'

export interface ChannelWriteGateInput {
  colId: string | undefined
  /** AG's `source`. */
  source: string | undefined
  /** True while THIS component is putting a declined value back — its own undo, not an edit. */
  selfInflicted: boolean
  cell: StudioCellValue | undefined
  /** Has the operator already been told, for this coordinate, that master writes hit every channel? */
  acknowledged: boolean
}

/**
 * The single decision behind every channel-sheet write, LAYERED over the substrate's.
 *
 * The grid-mechanic conditions — no column, `source: 'data'`, and the self-inflicted revert — belong
 * to PES.2's `writeGate` and are delegated, not copied: they are properties of AG, not of this
 * scope, and two copies of a rule about `setDataValue` re-entrancy is exactly the shape that let the
 * bug exist in the first place.
 *
 * What remains here is genuinely this lane's: PES.5's per-cell routing contract. `writable` gates a
 * cell the server says must not be written at all; `affectsAllChannels` gates a write that would
 * leave this channel and change every other one.
 */
export function channelWriteGate(input: ChannelWriteGateInput): ChannelWriteGate {
  const base = substrateWriteGate({
    colId: input.colId,
    source: input.source,
    selfInflicted: input.selfInflicted,
  })
  if (!base.write) return 'ignore'
  /**
   * 🔴 Gated on the REASON, not only on `writable === false` (#513, SC.1's measurement).
   *
   * Measured across 2,772 cells on both channel scopes: `writable === false` appears **zero**
   * times. The server withholds an edit with `editable: false` instead, which drops the editor
   * before this gate is ever consulted — so the branch that exists to show `writeBlockedReason`
   * verbatim was unreachable, and a cell that could not be edited said nothing about why.
   *
   * ⚠ Inert until PES.5 lands: `writeBlockedReason` is non-null on 0 of those 2,772 cells today.
   * This makes the path CORRECT, it does not make it visible — the visible half arrives with the
   * reasons. Kept `writable === false` alongside it: it costs nothing and is the contract's own
   * stated meaning, so a server that starts sending it still blocks.
   */
  if (!input.cell || input.cell.writable === false || input.cell.writeBlockedReason) return 'blocked'
  if (input.cell.contentAcknowledgement && input.cell.contentAddress === null) return 'acknowledge'
  if (input.cell.affectsAllChannels && !input.cell.contentAcknowledgement && !input.acknowledged) return 'acknowledge'
  return 'write'
}

/**
 * The save-reporter identity for one channel write.
 *
 * 🔴 TWO values, not one (#699). `writeId` is unique per ATTEMPT so overlapping writes count
 * correctly — a fill-down puts forty in flight at once. `subject` is what the write is ABOUT, and
 * the header counts failures per subject: without it a row refused twice reads as "2 changes not
 * saved" when there is one, and a retry that SUCCEEDS never clears the first failure because
 * nothing connects the two attempts. Channel rows also need their account, market and language:
 * the same variant/alias ID can appear in multiple scopes sharing one product save ledger.
 *
 * Extracted rather than left inline in the writer's `commit` closure for the reason `isOperatorEdit`
 * below was: the closure lives in a `.tsx` this suite cannot import, so an inline decision here
 * would be one no test could reach.
 */
export function channelWriteIdentity(rowId: string, seq: number, scope: {
  channel: string; marketplace: string; accountId?: string; locale?: string; instanceId: string
}): { writeId: string; subject: string } {
  const subject = `channel:${JSON.stringify([scope.channel, scope.marketplace, scope.accountId ?? null, scope.locale ?? null, rowId])}`
  // A remounted sheet restarts its counter while earlier requests may still be in flight.
  return { writeId: `${subject}#${scope.instanceId}#${seq}`, subject }
}

/**
 * Is this `cellValueChanged` an OPERATOR edit that should reach the server?
 *
 * 🔴 DENY-list, never an allow-list (PES.2's guard, ruling #53). AG types `source` as
 * `string | undefined` and documents only EXAMPLES (`edit` / `paste` / `undo` / `redo` / `data`), so
 * an allow-list silently drops any edit source nobody predicted — a fill-handle variant, say — and
 * an edit that shows on screen but never reaches the server is exactly the dishonesty this sheet
 * exists to prevent. Saving one source too many is the cheaper mistake.
 *
 * `'data'` is the one source known NOT to be an edit: it is the grid's own data being set. This
 * lane refetches after every cascade pin/reset, so without the guard each refetch would fire a
 * write per cell and the sheet would talk to itself.
 *
 * Extracted rather than left inline so the rule is testable — an inline `if` can be deleted in a
 * refactor and nothing would fail.
 */
export function isOperatorEdit(source: string | undefined): boolean {
  return source !== 'data'
}

/**
 * Attach the grid identity to the server's rows.
 *
 * `StudioRow.id` is the Product id, which is NOT unique across the grid: the same child SKU appears
 * under every alias that lists it. AG's `getRowId` and `getDataPath` need something that is.
 */
export function withRowIdentity(rows: StudioRow[], aliases: AliasGroup[]): ChannelSheetRow[] {
  const positionOf = new Map(aliases.map((a) => [aliasKeyOf(a.id), a.position]))
  return rows.map((r) => ({
    ...r,
    rowId: studioRowId(r.aliasId, r.id),
    aliasPosition: positionOf.get(aliasKeyOf(r.aliasId)) ?? 0,
  }))
}

/**
 * AG `treeData` path: the ALIAS is the group, the child SKU is the leaf.
 *
 * The alias-level row (`rowKind: 'parent'`) IS the group node — it carries the listing's own values,
 * so it is the band rather than a row beneath one.
 */
export function dataPathFor(row: ChannelSheetRow): string[] {
  const key = aliasKeyOf(row.aliasId)
  return row.rowKind === 'parent' ? [key] : [key, row.rowId]
}

export function rowIdOf(row: ChannelSheetRow): string {
  return row.rowId
}

/**
 * Order rows so every alias band is immediately followed by its own children, bands by position
 * (primary, `position: 0`, first). A band separated from its children reads as a bug.
 */
export function orderRows(rows: ChannelSheetRow[]): ChannelSheetRow[] {
  return [...rows].sort((a, b) => {
    if (a.aliasPosition !== b.aliasPosition) return a.aliasPosition - b.aliasPosition
    if (a.rowKind !== b.rowKind) return a.rowKind === 'parent' ? -1 : 1
    return a.sku.localeCompare(b.sku)
  })
}

/** The child rows of one alias group. */
export function variantRowsOf(rows: ChannelSheetRow[], aliasId: string | null): ChannelSheetRow[] {
  const key = aliasKeyOf(aliasId)
  return rows.filter((r) => r.rowKind === 'variant' && aliasKeyOf(r.aliasId) === key)
}

/** The band row of one alias group, when the family root is listed under it. */
export function bandRowOf(rows: ChannelSheetRow[], aliasId: string | null): ChannelSheetRow | undefined {
  const key = aliasKeyOf(aliasId)
  return rows.find((r) => r.rowKind === 'parent' && aliasKeyOf(r.aliasId) === key)
}

/**
 * The DISTINCT child SKUs on this coordinate, however many aliases list them.
 *
 * A count, never a quantity. This is the one cross-alias number that is safe, because a SKU listed
 * three times is still one SKU — whereas its units listed three times are still one pool.
 */
export function distinctVariantCount(rows: ChannelSheetRow[]): number {
  const seen = new Set<string>()
  for (const r of rows) if (r.rowKind === 'variant') seen.add(r.id)
  return seen.size
}

export interface AliasSummary {
  alias: AliasGroup
  /** Child rows drawn under this band. */
  variantRows: number
  /** Distinct child SKUs — equal to `variantRows` unless the server repeated one. */
  variantSkus: number
  /** From `AliasGroup.readiness`, never recomputed here. `null` = nothing to be ready against. */
  percent: number | null
  errors: number
  warnings: number
  rowsMissingRequired: number
  /** True while this alias is still an unadopted `EBAY_LISTING_SHELL`: a real listing with no rows. */
  isUnadoptedShell: boolean
}

export function summariseAlias(rows: ChannelSheetRow[], alias: AliasGroup): AliasSummary {
  const mine = variantRowsOf(rows, alias.id)
  const skus = new Set(mine.map((r) => r.id))
  return {
    alias,
    variantRows: mine.length,
    variantSkus: skus.size,
    percent: clampPct(alias.readiness?.percent),
    errors: alias.readiness?.errors ?? 0,
    warnings: alias.readiness?.warnings ?? 0,
    rowsMissingRequired: alias.readiness?.rowsMissingRequired ?? 0,
    // A live listing (it has a channel id) with nothing under it — the 22 shells measured on prod.
    isUnadoptedShell: mine.length === 0 && !!alias.externalListingId,
  }
}

/**
 * Readiness percentage for the band's bar. Taken from `AliasGroup.readiness.percent` and NOT
 * recomputed: PES.5 owns one readiness definition (§5) so two surfaces cannot disagree about 71%.
 * A missing percent reports 0 rather than inventing 100.
 */
export function aliasReadinessPct(alias: AliasGroup): number | null {
  return clampPct(alias.readiness?.percent)
}

/**
 * 🔴 NULL survives. It does not become 0.
 *
 * The server sends `percent: null` when the schema declares no required field for a coordinate —
 * "nothing to be ready against". Coercing that to 0 draws an empty red bar and tells the operator
 * their listing is 0% ready, which is an invention; coercing to 100 is a more comfortable
 * invention. Both are the same error. Caught by the #129 field-drift scan, having shipped as 0%.
 */
function clampPct(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * The standing guard on §3.2's invariant.
 *
 * Exported and asserted in the tests rather than left as a comment, because "never summed" is the
 * kind of rule a later refactor breaks silently while every screen still looks plausible. If a
 * quantity total is ever needed, it has to come from the server — which deliberately does not
 * provide one.
 */
export function assertNoQuantitySummation(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((k) => /total(quantity|qty|stock|units|pool)/i.test(k.replace(/[^a-z]/gi, '')))
}

/* ── which cell the record was opened FROM (PES.4 §5.4) ───────────────────────────────────── */

/**
 * Re-exported, NOT re-declared (#227/#229). PES.4 lifted this into `drawer/revealCell.ts` beside
 * `isCellCovered` so master and channel share one rule and one `CHROME_COLUMNS` union; keeping a
 * local copy here is how the two sheets would come to disagree about which columns are chrome.
 * A channel-only chrome id goes into THEIR union, never into a set here.
 */
// 🔴 From the MODULE, not the barrel. `../../drawer` re-exports React components, and this file is
// imported by node-env tests that cannot transform JSX — the barrel trap, hit a third time tonight.
export { isRevealAnchor } from '../../drawer/revealCell'

/**
 * Never render a sentence that ends mid-clause.
 *
 * 🔴 Lives HERE, not beside the component that calls it: it is pure, and a node-env test cannot
 * parse the JSX in `AliasPublishControl.tsx`. Fourth time tonight that a pure helper in a `.tsx`
 * made itself untestable — the rule is that pure logic goes in a `.ts` file from the start.
 *
 * Trailing `:` / `,` / `—` / `(` mean the server intended to append something and had nothing to
 * append. Dropping the dangling punctuation leaves a sentence that is true and complete; keeping it
 * asks the operator to look for a list that does not exist.
 */
export function tidyServerMessage(raw: string): string {
  const t = raw.trim().replace(/[\s:,;—-]+$/, '')
  return t.endsWith('.') || t.length === 0 ? t : `${t}.`
}


/* ── the run-level mapping fact, attached where the classifier expects it ─────────────────── */

/**
 * Give a cell the RUN's `productLevelOnly` so `classifyProvenance` can reach `mappedShared`.
 *
 * 🔴 `provenance.ts:146` decides `mappedShared` from a per-cell `mappedProductLevel`, and the wire
 * carries no such field — it carries `meta.mapping.productLevelOnly`, a fact about the RUN. PES.2's
 * framing (#367) is that a run-level fact is the CONSUMER's to supply, and that is this sheet.
 *
 * Measured before the fix, Amazon·IT: 15 cells `mapped`, **0** `mappedShared`, with the run flag
 * `true` — so every cell that should have said "editing one row changes N" said the opposite of
 * what §9.6b intends.
 *
 * Allocates only when the flag is TRUE. It is read per cell per paint inside `cellClassRules`, and
 * when the run is not product-level there is nothing to add, so the common path stays the identity.
 */
export function withMappingRun<T extends object>(cell: T | undefined, productLevelOnly: boolean): T | undefined {
  if (!cell || !productLevelOnly) return cell
  return { ...cell, mappedProductLevel: true }
}

/**
 * What a cell should say about itself on hover — the honesty the sheet owes before an edit (#513).
 *
 * Two things an operator cannot otherwise see:
 *
 *  - **why a cell refuses the editor.** `editable: false` drops the editor silently; the reason the
 *    server gave is the only explanation that exists.
 *  - **where an edit would actually land.** On a channel scope, a cell with `affectsAllChannels`
 *    writes the SHARED master record: 33 of eBay·IT's 35 columns do (`writeTarget: 'master'`), so
 *    an edit made from an eBay tab changes Amazon too. That is the same class as Amazon's shared-EU
 *    quantity, and it must be stated on the cell rather than discovered afterwards.
 *
 * 🔴 Keyed on `affectsAllChannels`, NOT on `writeVerb === 'master'`. eBay·IT's `name` and
 * `description` are `writeVerb: 'master'` yet `writeTarget: 'channelListing'` — genuine per-listing
 * overrides that touch nothing else. Warning on the verb would have put a false cross-market notice
 * on the two fields an operator edits most, which is worse than no notice: it teaches them to
 * ignore it.
 *
 * Returns `null` when there is nothing to say, so a caller renders no tooltip rather than an empty
 * one.
 */
export function cellHoverNote(
  cell: StudioCellValue | undefined,
  scopeLabel: string,
): string | null {
  if (!cell) return null
  if (cell.writeBlockedReason) return cell.writeBlockedReason
  if (cell.editable === false) return null
  if (cell.affectsAllChannels) {
    return `Editing this on ${scopeLabel} changes the shared master record — every channel sees it.`
  }
  return null
}

/**
 * How many of the columns in view write the shared master record — the toolbar's standing notice.
 *
 * A count, not a boolean: "33 of 35 columns" is the fact that makes an operator read the cell
 * notices, and one column behaving this way is a very different surface from thirty-three.
 * Returns 0 when nothing does, so the caller can omit the notice entirely.
 */
export function crossChannelColumnCount(
  row: { values?: Record<string, StudioCellValue> } | undefined,
): number {
  if (!row?.values) return 0
  return Object.values(row.values).filter((c) => c?.affectsAllChannels && c.editable !== false && c.writable !== false).length
}

/** Match the listing band: required fields, using this row's own resolved counts. */
export function rowReadinessPill(row: StudioRow, alias: AliasGroup | undefined) {
  const required = row.completeness?.required
  // An unscorable alias must not inherit a score from filled structural fields.
  const pct = alias?.readiness.percent == null || !required?.total ? null : Math.round(100 * required.filled / required.total)
  const reason = row.readiness.issues.find(issue => issue.label === 'Channel requirements')?.message
  return { pct, state: row.readiness.state, tip: pct === null
    ? `${row.sku} — ${reason ?? (required?.total === 0 ? 'No required attributes are defined for this row.' : 'Readiness cannot be scored until this coordinate’s requirements are available.')}`
    : `${row.sku} — ${required!.filled} of ${required!.total} required channel fields filled · ${readinessMeta(row.readiness.state, 'row').label}` }
}
