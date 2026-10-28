import { describe, expect, it, vi } from 'vitest'
import type { GridApi } from 'ag-grid-community'

import { actionsRowWidth, grownWidth, joinActionsFit, refitActionsColumns, verbsThatFit, type ActionsGeometry } from './actionsFit'

/** The live Approvals row, measured 2026-10-23: Approve 76, Reject 62, ⋯ 28, 6px gaps, 13px padding + 1px border a side. */
const approvals: ActionsGeometry = { verbs: [76, 62], menu: 28, hasItems: true, gap: 6, chrome: 28 }

describe('actionsRowWidth — what a row needs', () => {
  it('every verb, the ⋯, the gaps and the cell chrome: 206 for Approve · Reject · ⋯ — the 200 px column cut it', () => {
    expect(actionsRowWidth(approvals)).toBe(206)
    expect(actionsRowWidth(approvals)).toBeGreaterThan(200)
  })
  it('folded verbs leave a ⋯ even when the row has no items of its own', () => {
    expect(actionsRowWidth(approvals, 1)).toBe(76 + 6 + 28 + 28)
    expect(actionsRowWidth(approvals, 0)).toBe(28 + 28)
    const phone: ActionsGeometry = { verbs: [76], menu: 28, hasItems: false, gap: 6, chrome: 28 }
    expect(actionsRowWidth(phone)).toBe(104)
    expect(actionsRowWidth(phone, 0)).toBe(56)
  })
  it('no buttons at all needs only the chrome, and part pixels round up', () => {
    expect(actionsRowWidth({ verbs: [], menu: 28, hasItems: false, gap: 6, chrome: 28 })).toBe(28)
    expect(actionsRowWidth({ verbs: [44.2], menu: 28, hasItems: false, gap: 6, chrome: 28 })).toBe(73)
  })
})

describe('verbsThatFit — the fold on a narrow grid', () => {
  it('all verbs when they fit, else the most that fit beside a ⋯, else only the ⋯', () => {
    expect(verbsThatFit(approvals, 206)).toBe(2)
    expect(verbsThatFit(approvals, 205)).toBe(1)
    expect(verbsThatFit(approvals, 138)).toBe(1)
    expect(verbsThatFit(approvals, 137)).toBe(0)
    expect(verbsThatFit(approvals, Number.POSITIVE_INFINITY)).toBe(2)
  })
  it('a row with no verbs has nothing to fold', () => {
    expect(verbsThatFit({ verbs: [], menu: 28, hasItems: true, gap: 6, chrome: 28 }, 10)).toBe(0)
  })
})

describe('grownWidth — grow-only', () => {
  it('a wider row grows the column, a narrower one never shrinks it', () => {
    expect(grownWidth(0, 205.2)).toBe(206)
    expect(grownWidth(206, 138)).toBe(206)
  })
})

describe('the coordinator — one fitted width per grid and column', () => {
  /** The queued width checks run (they are microtasks). */
  const flush = () => Promise.resolve()

  function fakeGrid(start = 200) {
    let width = start
    const listeners: Record<string, (event: unknown) => void> = {}
    const setColumnWidths = vi.fn((widths: Array<{ key: string; newWidth: number }>) => { width = widths[0].newWidth })
    const api = {
      isDestroyed: () => false,
      getColumn: () => ({ getActualWidth: () => width }),
      setColumnWidths,
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener },
    } as unknown as GridApi
    const column = { getColId: () => 'actions' }
    return {
      api, setColumnWidths, width: () => width,
      /** Something else sets the width (a saved layout, a view) and AG says so. */
      resize: (to: number) => { width = to; listeners.columnResized?.({ columns: [column] }) },
      gridSizeChanged: () => listeners.gridSizeChanged?.({}),
    }
  }

  it('sets the column to the widest row, once per task, and only grows while the grid lives', async () => {
    const grid = fakeGrid()
    const a = joinActionsFit(grid.api, 'actions', () => {})
    const b = joinActionsFit(grid.api, 'actions', () => {})
    a.report(172)
    b.report(206)
    await flush()
    expect(grid.setColumnWidths).toHaveBeenCalledTimes(1)
    expect(grid.width()).toBe(206)
    a.report(138)
    await flush()
    expect(grid.width()).toBe(206)
    expect(grid.setColumnWidths).toHaveBeenCalledTimes(1)
  })

  it('a width set by anything else — a saved layout of 104, a view — is put straight back', async () => {
    const grid = fakeGrid()
    joinActionsFit(grid.api, 'actions', () => {}).report(206)
    await flush()
    grid.resize(104)
    await flush()
    expect(grid.width()).toBe(206)
  })

  it('a refit (density, grid width) measures the mounted rows again and may shrink; a row that left is not asked', async () => {
    const grid = fakeGrid()
    let need = 206
    const stays = joinActionsFit(grid.api, 'actions', () => stays.report(need))
    const leaves = joinActionsFit(grid.api, 'actions', () => leaves.report(400))
    stays.report(need)
    await flush()
    leaves.leave()
    need = 190
    refitActionsColumns(grid.api)
    await flush()
    expect(grid.width()).toBe(190)
    need = 180
    grid.gridSizeChanged()
    await flush()
    expect(grid.width()).toBe(180)
  })

  it('no row measured yet: the column keeps its first-paint width', async () => {
    const grid = fakeGrid(120)
    joinActionsFit(grid.api, 'actions', () => {})
    grid.resize(120)
    await flush()
    expect(grid.setColumnWidths).not.toHaveBeenCalled()
  })
})
