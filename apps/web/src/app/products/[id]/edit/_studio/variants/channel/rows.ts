/**
 * VP.4 — the grid's rows, as a pure rule.
 *
 * §3.3 (which §4.3 inherits): *"Rows ordered parent first, then by axis-value order (axis 1 values
 * in their defined order, then axis 2 …) — NOT alphabetical SKU."*
 *
 * 🔴 That is not a nicety. On the fixture family the SKUs sort `…-3XL, -4XL, -5XL, -L, -M, -S, -XL,
 * -XS, -XXL, -XXS` — measured, from the live read — which puts 3XL first and XS between XL and XXL.
 * An operator scanning for a size cannot use that order, and no sort control would recover it
 * because the information (`XXS < XS < S < …`) is in the AXIS definition, not in the string.
 *
 * Pure, so the order is a unit test rather than a screenshot.
 */
import type { ProjectionChild, ProjectionPage, ProjectionParent } from './types'
import type { StudioRow } from '../../sheet/master/types'

export interface ProjectionRow {
  /** AG's row id. The product id is unique within a coordinate, so it is the identity. */
  rowId: string
  kind: 'parent' | 'variant'
  parent: ProjectionParent | null
  child: ProjectionChild | null
}

/** Identity menus and selection actions use the same family record coordinates. */
export function projectionActionRow(row: ProjectionRow, page: ProjectionPage): StudioRow {
  const source = row.child ?? row.parent!
  const isParent = row.kind === 'parent'
  return { id: source.id, sku: source.sku, isParent, parentId: isParent ? null : page.parent?.id, childCount: isParent ? page.children.length : 0 } as StudioRow
}

/**
 * Rank a child by its position in each axis's declared value list, most significant axis first.
 * A value the axis does not declare sorts LAST rather than first — an unknown is not a zero.
 */
export function axisRank(page: ProjectionPage, child: ProjectionChild): number[] {
  return (page.axes ?? []).map(axis => {
    const value = child.sharedAxisValues?.[axis.key]
    const at = (axis.valueOrder?.codes ?? axis.values.map(v => v.code)).indexOf(value ?? '')
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  })
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? Number.MAX_SAFE_INTEGER
    const right = b[i] ?? Number.MAX_SAFE_INTEGER
    if (left !== right) return left - right
  }
  return 0
}

export function projectionRows(page: ProjectionPage, parent?: ProjectionParent | null): ProjectionRow[] {
  const ranked = page.children
    .map(child => ({ child, rank: axisRank(page, child) }))
    /* A stable tie-break on SKU, so two children that an axis cannot tell apart still land in a
       fixed order rather than in whatever order the wire happened to send. */
    .sort((a, b) => compareRanks(a.rank, b.rank) || a.child.sku.localeCompare(b.child.sku))
  /* The parent row is OPTIONAL because VP.2's contract does not carry one yet (see
     `ProjectionParent`). With none, the grid is the variants alone rather than a fabricated row —
     an invented parent would be the page asserting a listing identity it has not been told. */
  const head = parent ?? page.parent ?? null
  return [
    ...(head ? [{ rowId: head.id, kind: 'parent' as const, parent: head, child: null }] : []),
    ...ranked.map(({ child }): ProjectionRow => ({ rowId: child.id, kind: 'variant', parent: null, child })),
  ]
}

/** §4.2's chip counts, derived from the page — one rule, so the chips and the grid cannot disagree. */
export interface ProjectionCounts {
  excluded: number
  pinned: number
  mappingErrors: number
  included: number
  total: number
}

/**
 * Derived from `children`, not read from `page.counts`.
 *
 * VP.2 now names the unit on every tally (`pinnedRows` beside `pinnedCells`, after this lane
 * reported a chip printing 40 on a 20-child family), so the two agree. They are still derived here
 * because the chips narrow THIS grid: a number taken from one source and a result produced by
 * another is exactly how a count and its filter come to disagree on screen. The server's numbers
 * stay available on `page.counts` for comparison.
 */
export function projectionCounts(page: ProjectionPage): ProjectionCounts {
  const excluded = page.children.filter(c => !c.included).length
  /* A VARIANT with at least one pinned value, not a count of pinned CELLS: the chip narrows the
     grid to rows, so its number has to be a number of rows or the chip's count and its result
     disagree on screen (the shape §6.2's chip rules exist for). */
  const pinned = page.children.filter(c => Object.values(c.values).some(v => v.source === 'pinned')).length
  /* An axis that is declared on the family but lands on no channel target. `Mapping errors` is
     about the MAPPING, so it does not vary by row — the chip shows the count and selecting it
     narrows to nothing on the grid; the dock is where the error is fixed. */
  const mappingErrors = page.mapping.filter(m => m.target === null).length
  return {
    excluded,
    pinned,
    mappingErrors,
    included: page.children.length - excluded,
    total: page.children.length,
  }
}

/**
 * The CELLS each chip affects — `ViewChip.cells.byRow`, keyed by row id, valued by column id.
 *
 * 🔴 Not decoration. The shared chip renderer derives the number it prints from this map
 * (`viewChipColumnCountLabel`: the union of the column ids), and its hover summary from the cell,
 * column and row counts. A chip that ships `{ byRow: {} }` therefore prints `0 columns` next to a
 * real count — measured on eBay·IT before this existed: `Pinned values 0 columns` on a coordinate
 * with 40 pinned cells. The producer owns the cells; supplying them is what makes the chip true.
 */
export function chipCells(page: ProjectionPage, chipId: 'vp-excluded' | 'vp-pinned'): Record<string, string[]> {
  const byRow: Record<string, string[]> = {}
  for (const child of page.children) {
    if (chipId === 'vp-excluded') {
      if (!child.included) byRow[child.id] = ['__included']
      continue
    }
    const pinned = Object.entries(child.values).filter(([, v]) => v.source === 'pinned').map(([axisKey]) => `axis:${axisKey}`)
    if (pinned.length) byRow[child.id] = pinned
  }
  return byRow
}

/** Which rows a chip narrows the grid to. `null` = the chip does not narrow rows (see above). */
export function chipRowIds(page: ProjectionPage, chipId: string | null): ReadonlySet<string> | null {
  if (chipId === 'vp-excluded') return new Set(page.children.filter(c => !c.included).map(c => c.id))
  if (chipId === 'vp-pinned') return new Set(page.children.filter(c => Object.values(c.values).some(v => v.source === 'pinned')).map(c => c.id))
  return null
}

/** §4.2's search: a SKU or a name, the same two fields the sheet's Find searches. */
export function matchesSearch(row: ProjectionRow, search: string): boolean {
  const term = search.trim().toLowerCase()
  if (!term) return true
  const sku = row.child?.sku ?? row.parent?.sku ?? ''
  const name = row.child?.name ?? row.parent?.name ?? ''
  const axes = row.child ? Object.values(row.child.sharedAxisValues ?? {}).join(' ') : ''
  return `${sku} ${name} ${axes}`.toLowerCase().includes(term)
}
