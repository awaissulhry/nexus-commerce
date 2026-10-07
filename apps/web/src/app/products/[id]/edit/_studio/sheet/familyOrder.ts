/**
 * ONE row order for every studio page that lists a family's SKUs (Owner, 2026-10-07, Option A).
 *
 * The Matrix and the Information page (the Shared product page and every market page) order a family's rows with
 * `orderByAxisValues` over the axes `familyAxes` builds from the family read (`/studio/family`): the parent first,
 * then the SHARED variation order the Variation order page stores on the parent listing, else the axis value order;
 * a missing axis value last; then the SKU.
 *
 * 🔴 Before this file the Information page sorted by SKU — `L · M · S · XL · XS · XXL` beside the Matrix's
 * `XS · S · M · L · XL · XXL` for the same family. The order is the family read's (`storedAxisOrder`: the first parent
 * listing that stores one), the SAME on every page; a market page never orders by its own listing's order (Option B
 * was rejected), so no page can disagree with the Matrix.
 *
 * 🔴 Nothing here links to the Variants page (`FamilyVariants.tsx`): the Owner plans to remove it (2026-10-07). This
 * reads only the family read and the pure rules beside it (`variants/family/coverage.ts`, `projections.ts`), which the
 * Matrix already used — keep those files when the Variants page goes.
 *
 * Pure: no React. Tested beside this file.
 */
import { axisSummary, orderByAxisValues, type AxisColumnLike, type AxisSummary, type VariantRowLike } from '../variants/family/coverage'
import { mergeAxisValues, type FamilyProjections } from '../variants/family/projections'

/**
 * The market and language the family read is asked on: the studio scope's, else its first option. The Matrix and the
 * Information page both ask with this, so both read the same family answer.
 */
export function familyReadScope(scope: { market: string | null; locale: string | null; options: { markets: readonly { code: string }[]; locales: readonly { code: string }[] } }): { market: string; locale: string } {
  return { market: scope.market ?? scope.options.markets[0]?.code ?? 'IT', locale: scope.locale ?? scope.options.locales[0]?.code ?? 'it' }
}

/** What the order reads from the family read. */
export type FamilyOrderSource = Pick<FamilyProjections, 'axes' | 'axisValues'>

/** The sheet column fields `familyAxes` reads. `SheetColumn` satisfies it structurally. */
export type FamilyAxisColumn = Pick<AxisColumnLike, 'key' | 'label' | 'options' | 'optionLabels'>

/** A row as the Information page holds it: its own `axisValues` are keyed by COLUMN keys and may be `null`. */
export type FamilyOrderRow = Omit<VariantRowLike, 'axisValues'> & { axisValues?: Record<string, string> | null }

/**
 * A row's axis values: the family read's first, the row's own only as a fallback (`mergeAxisValues` says why).
 * The Matrix merges its rows with this; the Information page orders with it.
 */
export function familyAxisValues(family: FamilyOrderSource, row: { id: string; axisValues?: Record<string, string> | null }): Record<string, string> {
  return mergeAxisValues(family.axes.map((a) => a.key), family.axisValues[row.id], row.axisValues ?? undefined)
}

/**
 * The family's axes — label, values, counts and the stored order — as the Matrix built them (moved here from
 * `MatrixSurface`, unchanged).
 *
 * The values are counted from the ROWS; the server's `axes[].values` supplies only the ORDER. That list is the
 * operator-arranged order stored on the parent listing (`valueOrder`) and it may carry codes no child uses, so
 * membership from the rows keeps the band from disagreeing with the grid under it.
 */
export function familyAxes(family: Pick<FamilyProjections, 'axes'>, columns: readonly FamilyAxisColumn[], rows: readonly VariantRowLike[]): AxisSummary[] {
  const stated = new Map(family.axes.map((a) => [a.key, a]))
  return family.axes.map(({ key }) => {
    const server = stated.get(key)
    const want = [(server?.storedKey ?? key).toLowerCase(), key.toLowerCase()]
    const column = columns.find((c) => want.includes(c.key.toLowerCase()))
    /* `valueOrder` is the operator-arranged order stored on the parent listing (the Variation order page). */
    return { valueOrder: server?.valueOrder, ...axisSummary({ key, label: server?.label ?? column?.label ?? key, storedKey: server?.storedKey, options: server?.values ?? column?.options, optionLabels: column?.optionLabels }, rows) }
  })
}

/**
 * Each product's place in the family order: product id → rank (0 = first).
 *
 * The Information page asks for a RANK, not a sorted copy, because its rows are not one per product: a market page
 * draws the same SKU once under every alias block, and its own sort keeps the blocks. The rank is built from one row
 * per product (the first seen), with that row's axis values merged exactly as the Matrix merges them, and the rows
 * themselves are never changed — their cells, pictures and axis values stay what the page drew before.
 */
export function familyRank(family: FamilyOrderSource, columns: readonly FamilyAxisColumn[], rows: readonly FamilyOrderRow[]): Map<string, number> {
  const seen = new Set<string>()
  const merged: VariantRowLike[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push({ id: row.id, sku: row.sku, isParent: row.isParent, values: row.values, axisValues: familyAxisValues(family, row) })
  }
  const ordered = orderByAxisValues(merged, familyAxes(family, columns, merged))
  return new Map(ordered.map((row, index) => [row.id, index]))
}

/**
 * A market page's rows as the rank reads them: identity only.
 *
 * A channel row's own cells and axis values are that market's values, not the shared ones the Matrix reads. Left in,
 * a child with no shared size and an Amazon `size` of S sat between S and M on the Amazon page and last on the Matrix
 * (reviewer D, 2026-10-07). The family read already carries every shared value (the master cell, then both stores).
 */
export function sharedIdentityRows(rows: readonly FamilyOrderRow[]): FamilyOrderRow[] {
  return rows.map((row) => ({ id: row.id, sku: row.sku, isParent: row.isParent, values: {} }))
}

/**
 * Two rows compared by their family rank. A row the rank does not know (an unsaved new row) goes after every known
 * one; a tie falls back to the SKU, as `orderByAxisValues` does.
 */
export function compareFamilyRank(rank: ReadonlyMap<string, number>, a: { id: string; sku: string }, b: { id: string; sku: string }): number {
  const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
  const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
  return ra !== rb ? ra - rb : a.sku.localeCompare(b.sku)
}

/** Rows in their family order — the Shared product page's order. A new array; the row objects are the same ones. */
export function sortByFamilyRank<T extends { id: string; sku: string }>(rows: readonly T[], rank: ReadonlyMap<string, number>): T[] {
  return [...rows].sort((a, b) => compareFamilyRank(rank, a, b))
}
