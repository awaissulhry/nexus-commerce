/**
 * MX.P — the Matrix's View-bar chips, as a pure rule (design §3.9): `Pinned` · `Sync held` · `Oversold`
 * · `Sync issues` · `Suppressed` · `Inactive`.
 *
 * Build shape v2 (P12, Owner 2026-10-04): "Paused" is "Sync held" (a held STOCK SYNC — selling words belong to the sheet's
 * Status column), its id stays `matrix-paused` so saved views keep it; `Inactive` (one set of selling words, Owner
 * 2026-10-04; its id stays `matrix-not-selling` so saved views keep it) counts the rows whose listing is Inactive, Mixed
 * or Ended (the Matrix shows the word; the Status column and Publish change it). The surface registers each chip BY ID
 * (`matrixChip`), never by its place in the list.
 *
 * Each chip is a ROW filter that also TINTS the cells that earned the row its place — the same
 * `ViewChip.cells` contract the sheet's chips use, keyed `<coordinateKey>.<kind>` so the toolbar's
 * tint lands on the exact Matrix cell. Counts are taken from the READ, never re-derived: a row is
 * pinned because the resolver said `PINNED`, paused because it said `PAUSED`.
 *
 * 🔴 `count: null` while there is no read. `null` means "nobody has counted"; `0` means "counted,
 * none" — the ViewChip contract's own rule, and the reason this takes `MatrixRead | null` rather
 * than an empty read.
 *
 * Pure: no React, no AG, no fetch — every clause is asserted in `chips.vitest.test.ts`.
 */
import { matrixListingNotSelling } from '@/design-system/grid/renderers/matrixCells'
import type { ViewChip, ViewChipCells } from '../types'
import type { CoordinateKey, MatrixRead } from './contract'

export type MatrixChipId = 'matrix-pinned' | 'matrix-paused' | 'matrix-oversold' | 'matrix-sync-issues' | 'matrix-suppressed' | 'matrix-not-selling'

export const MATRIX_CHIP_IDS: readonly MatrixChipId[] = ['matrix-pinned', 'matrix-paused', 'matrix-oversold', 'matrix-sync-issues', 'matrix-suppressed', 'matrix-not-selling']

interface ChipRule {
  id: MatrixChipId
  label: string
  tone: ViewChip['tone']
  note: string
  /** The cells on ONE coordinate that put this row on the chip — empty when it does not. */
  cells: (cells: NonNullable<MatrixRead['rows'][number]['cells'][string]>) => readonly string[]
}

const INVENTORY = ['syncMode', 'syncQty', 'syncBuffer', 'syncState'] as const

const RULES: readonly ChipRule[] = [
  { id: 'matrix-pinned', label: 'Pinned', tone: 'info', note: 'Variants whose quantity is pinned on at least one coordinate',
    cells: (c) => (c.sync?.kind === 'PINNED' || (c.sync?.kind === 'PAUSED' && c.sync.mode === 'PINNED') ? ['syncMode', 'syncQty'] : []) },
  { id: 'matrix-paused', label: 'Sync held', tone: 'warning', note: 'Variants whose stock sync is held — by the listing or by the channel policy',
    cells: (c) => (c.sync?.kind === 'PAUSED' ? INVENTORY : []) },
  { id: 'matrix-oversold', label: 'Oversold', tone: 'danger', note: 'The channel holds more than the pool can back',
    cells: (c) => (c.sync?.oversold ? ['syncQty'] : []) },
  { id: 'matrix-sync-issues', label: 'Sync issues', tone: 'danger', note: 'A quantity or price push that failed or is dead-lettered',
    cells: (c) => (c.queue?.state === 'failed' || c.queue?.state === 'dead' ? ['syncState'] : []) },
  { id: 'matrix-suppressed', label: 'Suppressed', tone: 'danger', note: 'Listings Amazon has suppressed, or that carry an error',
    cells: (c) => (c.listing?.state === 'suppressed' || c.listing?.state === 'error' ? ['listing'] : []) },
  { id: 'matrix-not-selling', label: 'Inactive', tone: 'warning', note: 'Listings that are Inactive, Mixed or Ended — set Active in the sheet\'s Status column and Publish',
    cells: (c) => (matrixListingNotSelling(c.listing) ? ['listing'] : []) },
]

/**
 * The six chips for a read, narrowed to the coordinates on screen (`visible` = the scope-bar filter's
 * key set; `null` = every coordinate). A chip whose count is `0` is KEPT (`hideWhenZero: false`): on
 * this page "Sync held (0)" is a fact the operator came to check, not noise.
 */
export function matrixChips(read: MatrixRead | null, visible: ReadonlySet<CoordinateKey> | null = null): ViewChip[] {
  return RULES.map((rule) => {
    if (!read) return { id: rule.id, label: rule.label, tone: rule.tone, count: null, hideWhenZero: false, note: 'Counted once the Matrix has loaded', cells: { byRow: {} } }
    const byRow: Record<string, string[]> = {}
    for (const row of read.rows) {
      for (const [key, cells] of Object.entries(row.cells)) {
        if (visible && !visible.has(key)) continue
        const kinds = rule.cells(cells)
        if (kinds.length === 0) continue
        ;(byRow[row.id] ??= []).push(...kinds.map((k) => `${key}.${k}`))
      }
    }
    const cells: ViewChipCells = { byRow }
    return { id: rule.id, label: rule.label, tone: rule.tone, count: { n: Object.keys(byRow).length, unit: 'variants' }, hideWhenZero: false, note: rule.note, cells }
  })
}

/** One chip of a `matrixChips` answer, by its id (null when absent) — the surface registers chips by id, never by place. */
export function matrixChip(chips: readonly ViewChip[], id: MatrixChipId): ViewChip | null {
  return chips.find((chip) => chip.id === id) ?? null
}
