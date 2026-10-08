import { describe, expect, it } from 'vitest'

import { buildMatrixColumns, IDENTITY_COL, IDENTITY_COL_W } from './columns'

/**
 * 2026-10-08 (Matrix audit): the Product column is the Information page's — 380 wide at every width, pinned on a wide
 * screen. A phone UNPINS it (`sheet/useNarrowSheet.ts`, the page's own hook) instead of shrinking it to 160, which cut
 * the SKU to "GAL…".
 */
describe('the identity column', () => {
  it('is a fixed 380 slot, pinned left (a phone unpins it through the grid API, not the def)', () => {
    const defs = buildMatrixColumns({ coordinates: [], cellsOf: () => null, rowOf: () => null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
      axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] } } as never)
    // The identity sits inside the PRODUCT group: walk the tree, not the top level.
    const flat = (list: readonly unknown[]): Array<Record<string, unknown>> => list.flatMap((d) => { const r = d as Record<string, unknown>; return Array.isArray(r.children) ? flat(r.children) : [r] })
    expect(flat(defs).find((d) => d.colId === IDENTITY_COL)).toMatchObject({ width: IDENTITY_COL_W, minWidth: IDENTITY_COL_W, maxWidth: IDENTITY_COL_W, pinned: 'left' })
    expect(IDENTITY_COL_W).toBe(380)
  })
})
