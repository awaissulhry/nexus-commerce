import { describe, expect, it } from 'vitest'

import { heldLimits, isFixedWidth, widthMoved, widthsAsDefaults } from './columnWidths'

describe('widthsAsDefaults — a definition\'s width is where a column starts', () => {
  it('hands width and flex to AG as defaults only, so a rebuild never resets a dragged width', () => {
    const out = widthsAsDefaults([{ colId: 'a', width: 135 }, { colId: 'b' }, { colId: 'c', width: 90, initialWidth: 120 }, { colId: 'd', flex: 2 }])
    expect(out).toEqual([{ colId: 'a', initialWidth: 135 }, { colId: 'b' }, { colId: 'c', initialWidth: 120 }, { colId: 'd', initialFlex: 2 }])
  })

  it('does the same inside a column group', () => {
    const out = widthsAsDefaults([{ groupId: 'language:name', children: [{ colId: 'name@it', width: 200 }] }])
    expect(out).toEqual([{ groupId: 'language:name', children: [{ colId: 'name@it', initialWidth: 200 }] }])
  })

  it('leaves a fixed column\'s width to the page: not resizable, or min = max', () => {
    const locked = { colId: 'product', width: 260, minWidth: 260, maxWidth: 260, resizable: false }
    const pinned = { colId: 'ck', width: 43, minWidth: 43, maxWidth: 43 }
    const off = { colId: 'x', width: 80, resizable: false }
    expect(widthsAsDefaults([locked, pinned, off])).toEqual([locked, pinned, off])
  })

  it('keeps a column that states neither as it is', () => {
    const def = { colId: 'a', minWidth: 90 }
    expect(widthsAsDefaults([def])[0]).toBe(def)
  })
})

describe('isFixedWidth', () => {
  it('is fixed when it cannot be resized or min = max', () => {
    expect(isFixedWidth({ resizable: false })).toBe(true)
    expect(isFixedWidth({ minWidth: 40, maxWidth: 40 })).toBe(true)
    expect(isFixedWidth({ minWidth: 40, maxWidth: 400 })).toBe(false)
    expect(isFixedWidth({})).toBe(false)
  })
})

describe('heldLimits — a fit never moves a column the person sized', () => {
  const col = (id: string, w: number) => ({ getColId: () => id, getActualWidth: () => w })
  it('holds each sized column at its width, and only those', () => {
    expect(heldLimits([col('a', 120), col('b', 300), col('c', 80)], new Set(['b']))).toEqual([{ key: 'b', minWidth: 300, maxWidth: 300 }])
    expect(heldLimits([col('a', 120)], new Set())).toEqual([])
  })
})

describe('widthMoved — only a width change re-fits', () => {
  it('re-fits on the first size and on a real width change', () => {
    expect(widthMoved(null, 800)).toBe(true)
    expect(widthMoved(800, 640)).toBe(true)
  })
  it('does not re-fit when only the height moved, nor at width 0', () => {
    expect(widthMoved(800, 800)).toBe(false)
    expect(widthMoved(800, 800.4)).toBe(false)
    expect(widthMoved(null, 0)).toBe(false)
  })
})
