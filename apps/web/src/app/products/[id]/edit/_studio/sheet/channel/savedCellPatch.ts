/**
 * P2 (2026-09-30, I4-4) — a confirmed save updates the cells it saved in place, without reading the whole sheet again.
 *
 * Every save used to be followed by a full `/studio/sheet` read (84 KB–690 KB compressed) that replaced every row object,
 * so AG re-rendered every visible cell 3–3.6 times. The save's answer carries only versions, and the server's cell
 * (provenance, mapping, listing-level marks, row completeness) cannot be rebuilt in the browser in every case. So the
 * cell is patched here ONLY in the cases measured against the server (ground truth: `savedCellPatch.vitest.test.ts`,
 * recorded from real saves), and every other save still reads the sheet once, exactly as before:
 *
 *  - an explicit value (`set`) on a cell that writes its own row's listing, not a variation axis, not a content
 *    (translation) cell, not a formula, a Shopify, a linked or a listing-snapshot cell;
 *  - the value stays present: a first fill is patched only for an OPTIONAL field the row counts as missing (its
 *    completeness moves by one, exactly as the server counts it); a required field, a clear or an emptied list reads;
 *  - an eBay listing-level item specific only when the family row already supplies it (the value then changes on every
 *    row, nothing else does); a value supplied by a variation reads (the whole family's provenance moves);
 *  - the cell had no mapping problem, and the answer names none: no refusal, no warning, no cascade, no started draft,
 *    no normalised reference, no recalculated formula.
 */
import { saveWarningFor } from '../saveWarnings'
import type { ChannelSheetRow, SheetColumn, StudioCellValue } from './types'

/** The server's fold of an explicit listing value (`studio-sheet.service.ts` `layerFor`). */
const explicitLayer = (row: ChannelSheetRow) => (row.aliasId != null ? 'alias' : 'channel') as StudioCellValue['layer']

/* ── the cell as the server last sent it ─────────────────────────────────────────────────────────────────────────── */

/**
 * The value setter replaces a cell object with an optimistic copy; this remembers the server's cell it started from,
 * through any number of edits before the save, so the patch can compare against what the server said.
 */
const pristine = new WeakMap<object, StudioCellValue>()
export function rememberPristine(next: StudioCellValue, previous: StudioCellValue): void {
  pristine.set(next, pristine.get(previous) ?? previous)
}
export function pristineOf(cell: StudioCellValue): StudioCellValue {
  return pristine.get(cell) ?? cell
}

/**
 * The cell the grid shows the moment a value is typed, before the server answers: pinned at this row's layer — except an
 * eBay listing-level value (P1), which is the listing's, so its value changes and its source does not (P2 ground truth).
 * Remembers the server's cell it started from.
 */
export function optimisticCell(previous: StudioCellValue, value: unknown, rowKind: ChannelSheetRow['rowKind']): StudioCellValue {
  const next: StudioCellValue = previous.mapped?.listingLevel ? { ...previous, value }
    : { ...previous, value, layer: rowKind === 'parent' ? 'alias' : 'aliasVariant', pinned: true, inherited: false }
  rememberPristine(next, previous)
  return next
}

/** Present by the cell's shape: an empty list, a measure without a number, `''` and `null` are no value. */
export function presentValue(value: unknown): boolean {
  if (value == null || value === '') return false
  if (Array.isArray(value)) return value.some((item) => item != null && item !== '')
  if (typeof value === 'object') {
    const measure = value as { value?: unknown }
    return 'value' in measure ? measure.value != null && measure.value !== '' : Object.keys(value).length > 0
  }
  return true
}

/** The FOLLOW flags the server keys on a column (`FOLLOW_BY_KEY`); only price is patched, and only on its listing. */
const FOLLOW_KEYS = new Set(['title', 'name', 'item_name', 'description', 'product_description', 'price', 'basePrice', 'quantity', 'bulletPoints', 'bullet_point'])

/** A category field decides which columns the sheet has: its save always reads. */
const CATEGORY_KEYS = new Set(['categoryId', 'productType', 'taxonomy_id'])

export interface SavedChange { colId: string; field: string; value: unknown; intent?: string; target?: string }

export type PatchPlan =
  | { kind: 'patch'; apply: () => ChannelSheetRow[] }
  | { kind: 'read'; reason: string }

interface PlanInput {
  row: ChannelSheetRow
  changes: readonly SavedChange[]
  column: (colId: string) => SheetColumn | undefined
  /** The save's answer (a 200). */
  body: unknown
  /** The cells as the save was sent (`ChannelWriteCoord.sentCells`). */
  sent?: ReadonlyMap<string, StudioCellValue | undefined>
}

const read = (reason: string): PatchPlan => ({ kind: 'read', reason })

/**
 * Decide, BEFORE the answer's other effects are applied, whether this save can be settled in place; `apply` then
 * patches the saved row (and returns every row it changed). The listing versions, the family's listing-level values
 * (`adoptFamilyListings`) and the answer's warnings are applied by the writer as before.
 */
export function planSavedCellPatch({ row, changes, column, body, sent }: PlanInput): PatchPlan {
  const answer = (body ?? {}) as Record<string, unknown>
  if (Array.isArray(answer.errors) && answer.errors.length) return read('the answer refused a cell')
  // A value equal to the stored one is not stored again: the cell keeps the source it had.
  if (Number(answer.unchanged ?? 0) > 0 || !(Number(answer.updated ?? 0) >= 1)) return read('the answer stored nothing new')
  if (Number(answer.cascadeCount ?? 0) > 0 || Number(answer.affectedChildren ?? 0) > 0) return read('the save cascaded')
  if (Array.isArray(answer.createdListings) && answer.createdListings.length) return read('the save started a draft')
  if (Array.isArray(answer.normalizedChanges) && answer.normalizedChanges.length) return read('the server normalised a value')
  // Audit A02 — a formula that reads a saved field was recomputed (its new value, or its refusal) or could not be: those
  // cells, on this row or its family, are only in the next read.
  if (Array.isArray(answer.recalculated) && answer.recalculated.length || answer.recalcError) return read('a dependent formula was recalculated')
  if (answer.versionOf !== 'channelListing' || typeof answer.currentVersion !== 'number' || !row.listing) return read('no listing version in the answer')
  if (!changes.length) return read('nothing stored')
  const rootId = row.parentId ?? row.id
  const steps: Array<() => void> = []
  for (const change of changes) {
    const col = column(change.colId)
    const cell = row.values[change.colId]
    if (!col || !cell) return read(`${change.colId}: no column or cell`)
    // P2 review 2 — the operator edited this cell again while this save was on the wire: its newer value is queued, and
    // this older answer must not paint over it. The read that follows the last save settles it.
    if (sent && sent.get(change.colId) !== cell) return read(`${change.colId}: a newer edit to this cell is on its way`)
    const before = pristineOf(cell)
    if (change.intent !== 'set' || change.target !== 'channel') return read(`${change.colId}: not an explicit listing value`)
    if (saveWarningFor(body, row.id, [change.field, change.colId])) return read(`${change.colId}: stored with a warning`)
    if ((col as { axis?: boolean }).axis || col.kind === 'variationTheme' || col.slot || col.managedBy || col.shopifyField) return read(`${change.colId}: axis, theme, slot, media or Shopify column`)
    if (FOLLOW_KEYS.has(col.key) && col.key !== 'price') return read(`${change.colId}: follows a Master field`)
    if (CATEGORY_KEYS.has(col.key)) return read(`${change.colId}: a category decides the columns`)
    if (before.writeTarget !== 'channelListing' || before.contentVersion !== undefined || before.contentAcknowledgement || before.shopifyWrite ||
        before.nexusDraft || before.translation || before.linkGroupId != null || before.layer === 'linked' || before.source === 'channelSnapshot' ||
        (before as { formula?: unknown }).formula || (before as { formulaError?: unknown }).formulaError) return read(`${change.colId}: not a plain listing cell`)
    const m = before.mapped
    if (m && (m.status !== 'mapped' || m.errors.length || m.warnings.length || (m.mappingErrors?.length ?? 0) || m.autoCorrected || m.overLimit ||
        m.appliedTransforms.length || m.supplyingRule)) return read(`${change.colId}: the cell had a mapping note`)
    if (row.readiness?.issues?.some((issue) => issue.key === col.key)) return read(`${change.colId}: the row names an issue on it`)
    if (!presentValue(change.value)) return read(`${change.colId}: a clear`)

    const level = m?.listingLevel
    if (level) {
      // One value per eBay listing: it moves on every row of the family; the provenance does not.
      if (level.productId !== rootId || !presentValue(before.value)) return read(`${change.colId}: listing-level value not supplied by the family row`)
      steps.push(() => {
        row.values = { ...row.values, [change.colId]: { ...before, value: change.value, mapped: before.mapped ? { ...before.mapped, value: change.value } : before.mapped } }
      })
      continue
    }

    const missing = row.completeness?.optional?.missing?.some((entry) => entry.key === col.key)
    const required = row.completeness?.required?.missing?.some((entry) => entry.key === col.key)
    if (required) return read(`${change.colId}: fills a required field`)
    if (presentValue(before.value) === !!missing) return read(`${change.colId}: the row's count disagrees with the cell`)
    if (col.key === 'price' && (!row.listing.follows || typeof change.value !== 'number')) return read('price without its listing flags')

    steps.push(() => {
      row.values = { ...row.values, [change.colId]: {
        ...before, value: change.value, source: 'channelExplicit', inheritedFrom: null, inherited: false,
        layer: explicitLayer(row), pinned: true, follows: false,
        mapped: before.mapped ? { ...before.mapped, value: change.value, derived: false, provenance: 'override', legacySource: 'source' } : before.mapped,
      } }
      if (col.key === 'price' && row.listing) row.listing = { ...row.listing, price: change.value as number, follows: { ...row.listing.follows, followMasterPrice: false } }
      if (missing) fillOptional(row, col)
    })
  }
  return {
    kind: 'patch',
    apply: () => {
      for (const step of steps) step()
      return [row]
    },
  }
}

/** A first value in an optional field the row counted as missing: the server's `computeMasterCompleteness`, by one. */
function fillOptional(row: ChannelSheetRow, col: SheetColumn): void {
  const c = row.completeness as (ChannelSheetRow['completeness'] & { byGroup?: Array<{ group: string; filled: number; total: number }> }) | undefined
  if (!c?.optional || !c.overall) return
  const filled = c.overall.filled + 1
  row.completeness = {
    ...c,
    overall: { ...c.overall, filled, pct: c.overall.total > 0 ? Math.round((filled / c.overall.total) * 100) : 100 },
    optional: { ...c.optional, filled: c.optional.filled + 1, missing: c.optional.missing.filter((entry) => entry.key !== col.key) },
    ...(c.byGroup ? { byGroup: c.byGroup.map((g) => (g.group === col.group ? { ...g, filled: g.filled + 1 } : g)) } : {}),
  }
}

/**
 * The family row's variation theme names the listing version its writer sends (`value.write.expectedVersion`): when a
 * save moved that listing, the theme's token moves with it, or the next theme save would conflict with ourselves.
 */
export function followListingVersion(row: ChannelSheetRow, from: number | undefined, to: number | undefined): boolean {
  if (from === undefined || to === undefined || from === to) return false
  let changed = false
  for (const [key, cell] of Object.entries(row.values)) {
    const write = (cell?.value as { write?: { endpoint?: unknown; expectedVersion?: unknown } } | null)?.write
    if (!write || write.endpoint !== 'projection' || write.expectedVersion !== from) continue
    row.values = { ...row.values, [key]: { ...cell, value: { ...(cell.value as object), write: { ...write, expectedVersion: to } } } }
    changed = true
  }
  return changed
}
