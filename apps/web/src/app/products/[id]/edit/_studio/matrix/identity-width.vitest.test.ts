import { describe, expect, it } from 'vitest'

import { buildMatrixColumns, IDENTITY_COL, IDENTITY_COL_W, IDENTITY_MIN_SCROLL_W, IDENTITY_MIN_W, identityWidthFor } from './columns'

/** 2026-09-30 — on a phone the pinned identity column gives way, so a coordinate column can be on screen. */
describe('the pinned identity column on a narrow grid', () => {
  it('a wide grid keeps exactly 380; a phone leaves room for the coordinate columns; it never goes below 160', () => {
    expect(identityWidthFor(1170)).toBe(IDENTITY_COL_W)
    expect(identityWidthFor(540)).toBe(IDENTITY_COL_W)
    // 390px phone: ~322px grid less the ~42px selection column. It used to be 380 pinned → no coordinate column on screen.
    expect(identityWidthFor(280)).toBe(IDENTITY_MIN_W)
    expect(identityWidthFor(400)).toBe(240)
    expect(400 - identityWidthFor(400)).toBe(IDENTITY_MIN_SCROLL_W)
    expect(identityWidthFor(0)).toBe(IDENTITY_COL_W)
    expect(identityWidthFor(Number.NaN)).toBe(IDENTITY_COL_W)
  })
  it('the identity column def takes the width it is given, as a fixed slot', () => {
    const defs = buildMatrixColumns({ coordinates: [], cellsOf: () => null, rowOf: () => null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
      axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] }, identityWidth: 162 } as never)
    // The identity sits inside the PRODUCT group: walk the tree, not the top level.
    const flat = (list: readonly unknown[]): Array<Record<string, unknown>> => list.flatMap((d) => { const r = d as Record<string, unknown>; return Array.isArray(r.children) ? flat(r.children) : [r] })
    expect(flat(defs).find((d) => d.colId === IDENTITY_COL)).toMatchObject({ width: 162, minWidth: 162, maxWidth: 162, pinned: 'left' })
  })
})
