import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ColumnState } from 'ag-grid-community'
import { AG_AUTO_COL, AG_SELECTION_COL, columnStateToPrefs, operatorLocks, prefsToColumnState, type PrefsBridgeOptions } from './columnPrefs'
import type { PreferencesValue } from '@/design-system/patterns/PreferencesModal'

// The products page's shape: product (locked, tree) · movable… · actions (locked)
const O: PrefsBridgeOptions = {
  columns: [
    { key: 'product', locked: true },
    { key: 'channels' }, { key: 'status' }, { key: 'tags' }, { key: 'available' }, { key: 'price' },
    { key: 'actions', locked: true },
  ],
  treeColumnKey: 'product',
  sortKeyToColumn: { product: 'product', available: 'available', price: 'price' },
}
const P = (over: Partial<PreferencesValue> = {}): PreferencesValue => ({
  visibleColumns: ['channels', 'status', 'tags', 'available', 'price'], lockedColumns: [],
  stickyFirstColumn: false, stickyLastColumn: false, pageSize: 100, sortBy: 'product', sortDir: 'asc', ...over,
})
const ids = (s: ColumnState[]) => s.map((c) => c.colId).join(',')

describe('prefsToColumnState — dialog → grid', () => {
  it('puts the selection column first, locked ends in place, the operator order between', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['price', 'status', 'channels', 'tags', 'available'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},price,status,channels,tags,available,actions`)
  })
  it('hides a togglable column left out of visibleColumns and lists it LAST, never drops it', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['channels', 'price'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},channels,price,actions,status,tags,available`)
    expect(s.filter((c) => c.hide).map((c) => c.colId)).toEqual(['status', 'tags', 'available'])
  })
  it("maps the dialog's product sort onto AG's auto-group column", () => {
    const s = prefsToColumnState(P({ sortBy: 'product', sortDir: 'desc' }), O)
    const auto = s.find((c) => c.colId === AG_AUTO_COL)!
    expect(auto.sort).toBe('desc'); expect(auto.sortIndex).toBe(0)
    expect(s.filter((c) => c.sort).length).toBe(1)
  })
  it('sorts by a movable column when asked', () => {
    const s = prefsToColumnState(P({ sortBy: 'price', sortDir: 'asc' }), O)
    expect(s.find((c) => c.colId === 'price')!.sort).toBe('asc')
    expect(s.find((c) => c.colId === AG_AUTO_COL)!.sort).toBeNull()
  })
  it('pins the locked ends only when the sticky toggles say so', () => {
    const off = prefsToColumnState(P(), O)
    expect(off.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBeNull()
    const on = prefsToColumnState(P({ stickyFirstColumn: true, stickyLastColumn: true }), O)
    expect(on.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBe('left')
    expect(on.find((c) => c.colId === 'actions')!.pinned).toBe('right')
  })
  it('ignores a visibleColumns key that is not a togglable column', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['ghost', 'price'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},price,actions,channels,status,tags,available`)
  })

  /**
   * AG.1-c. `applyColumnState` only changes the properties an entry STATES, so an explicit `null`
   * is a decision to clear. Stating `sort: null` / `pinned: null` on every column turned every view
   * application into a silent reset of the operator's sort and their hand-pinned columns — measured
   * on the studio sheet, and on a view CHIP too, which is not a view change to an operator.
   *
   * These assert the ABSENCE of a key, which is the whole point: `toBeNull()` and `toBeUndefined()`
   * are different outcomes here and only one of them preserves the operator's state.
   */
  describe('says nothing about what it does not decide', () => {
    it('omits `sort` entirely when the dialog names no sort column, so a header sort survives', () => {
      const s = prefsToColumnState(P({ sortBy: '' }), O)
      expect(s.every((c) => !('sort' in c))).toBe(true)
      expect(s.every((c) => !('sortIndex' in c))).toBe(true)
    })
    it('still CLEARS other columns when the dialog does name a sort, so it replaces rather than adds', () => {
      const s = prefsToColumnState(P({ sortBy: 'price', sortDir: 'asc' }), O)
      expect(s.find((c) => c.colId === 'price')!.sort).toBe('asc')
      expect(s.find((c) => c.colId === 'available')!.sort).toBeNull()
      expect(s.filter((c) => c.sort).length).toBe(1)
    })
    /**
     * 🔴 CHANGED 2026-09-05 (the lock contract). This case used to assert that `pinned` was OMITTED on
     * movable columns "so an operator's own pin survives a view change". Under the contract a pin IS
     * a lock: `columnStateToPrefs` reads it back as `lockedColumns`, callers read the grid's locks
     * before every apply, and this function re-states them — so the operator's pin survives by being
     * NAMED, and the column they just unlocked is released by the explicit `null` that omission could
     * never send. Both halves are asserted here.
     */
    it("states `pinned` on every togglable column: 'left' for a lock, null for the rest — a lock survives by being named", () => {
      const s = prefsToColumnState(P({ visibleColumns: ['channels', 'price'], lockedColumns: ['price'] }), O)
      expect(s.find((c) => c.colId === 'price')!.pinned).toBe('left')
      for (const key of ['channels', 'status', 'tags', 'available']) {
        expect(`${key}: ${s.find((c) => c.colId === key)!.pinned}`).toBe(`${key}: null`)
      }
    })
    it('STILL states the locked ends explicitly — the regression that un-pinned the identity block', () => {
      const on = prefsToColumnState(P({ stickyFirstColumn: true, stickyLastColumn: true }), O)
      expect(on.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBe('left')
      expect(on.find((c) => c.colId === 'actions')!.pinned).toBe('right')
      const off = prefsToColumnState(P(), O)
      expect(off.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBeNull()
    })
    it('leaves the selection column to the engine: no pin, no sort stated', () => {
      const sel = prefsToColumnState(P(), O).find((c) => c.colId === AG_SELECTION_COL)!
      expect('pinned' in sel).toBe(false)
      expect('sort' in sel).toBe(false)
      expect(sel.hide).toBe(false)
    })
  })
})

describe('columnStateToPrefs — grid → dialog', () => {
  const state: ColumnState[] = [
    { colId: AG_SELECTION_COL }, { colId: AG_AUTO_COL, pinned: 'left' },
    { colId: 'price', sort: 'desc', sortIndex: 0 }, { colId: 'status', hide: true }, { colId: 'channels' },
    { colId: 'tags' }, { colId: 'available', sort: 'asc', sortIndex: 1 }, { colId: 'actions' },
  ]
  it("reads the operator's live order and visibility, dropping the locked ends and AG's own columns", () => {
    const p = columnStateToPrefs(state, P(), O)
    expect(p.visibleColumns).toEqual(['price', 'channels', 'tags', 'available'])
  })
  it('reports the FIRST sort key through the dialog vocabulary and the pinned ends as sticky', () => {
    const p = columnStateToPrefs(state, P(), O)
    expect(p.sortBy).toBe('price'); expect(p.sortDir).toBe('desc')
    expect(p.stickyFirstColumn).toBe(true); expect(p.stickyLastColumn).toBe(false)
  })
  it('maps a sort on the auto-group column back to "product"', () => {
    const p = columnStateToPrefs([{ colId: AG_AUTO_COL, sort: 'asc', sortIndex: 0 }, { colId: 'price' }], P({ sortBy: 'price' }), O)
    expect(p.sortBy).toBe('product'); expect(p.sortDir).toBe('asc')
  })
  it('keeps the previous sort when the grid has none, and carries pageSize through', () => {
    const p = columnStateToPrefs([{ colId: 'price' }, { colId: 'channels' }], P({ sortBy: 'available', sortDir: 'desc', pageSize: 500 }), O)
    expect(p.sortBy).toBe('available'); expect(p.sortDir).toBe('desc'); expect(p.pageSize).toBe(500)
  })
  it('🔴 does NOT carry a stale lockedColumns through — the grid is the truth about pins', () => {
    // `tags` is not pinned on the grid, so it is not locked, whatever the previous draft said.
    const p = columnStateToPrefs([{ colId: 'price' }, { colId: 'channels' }, { colId: 'tags' }], P({ lockedColumns: ['tags'] }), O)
    expect(p.lockedColumns).toEqual([])
  })
  it('round-trips: dialog → grid → dialog is the identity on what the dialog owns', () => {
    const start = P({ visibleColumns: ['tags', 'price', 'channels'], sortBy: 'available', sortDir: 'desc', stickyLastColumn: true })
    const back = columnStateToPrefs(prefsToColumnState(start, O), start, O)
    expect(back.visibleColumns).toEqual(start.visibleColumns)
    expect(back.sortBy).toBe('available'); expect(back.sortDir).toBe('desc')
    expect(back.stickyFirstColumn).toBe(false); expect(back.stickyLastColumn).toBe(true)
    expect(back.lockedColumns).toEqual([])
  })
})

/**
 * The LOCK contract (2026-09-05): a locked column is frozen left, always visible, in a block right
 * after the structural lead columns, in the order the operator locked them; the grid's pins ARE
 * the lock set and read back as such.
 */
describe('operator locks — dialog → grid', () => {
  it('places the locked block right after the lead, in lockedColumns order, all pinned left and visible', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['channels', 'status', 'tags', 'available', 'price'], lockedColumns: ['tags', 'channels'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},tags,channels,status,available,price,actions`)
    expect(s.find((c) => c.colId === 'tags')!.pinned).toBe('left')
    expect(s.find((c) => c.colId === 'channels')!.pinned).toBe('left')
    expect(s.find((c) => c.colId === 'status')!.pinned).toBeNull()
  })
  it('🔴 a lock implies visible — a locked column left out of visibleColumns is still shown, never hidden', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['price'], lockedColumns: ['tags'] }), O)
    const tags = s.find((c) => c.colId === 'tags')!
    expect(tags.hide).toBe(false)
    expect(tags.pinned).toBe('left')
    expect(s.filter((c) => c.hide).map((c) => c.colId)).toEqual(['channels', 'status', 'available'])
  })
  it('unlocking emits an explicit `pinned: null`, so the column is released — omission could never do that', () => {
    const s = prefsToColumnState(P({ lockedColumns: [] }), O)
    expect(s.find((c) => c.colId === 'tags')!.pinned).toBeNull()
  })
  it('a structural or unknown key in lockedColumns is not an operator lock', () => {
    expect(operatorLocks({ lockedColumns: ['product', 'ghost', 'price', 'price'] }, O)).toEqual(['price'])
    const s = prefsToColumnState(P({ lockedColumns: ['product', 'ghost'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},channels,status,tags,available,price,actions`)
  })
  it('hidden columns state `pinned: null` too, so an unlock of a hidden column leaves nothing frozen', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['price'] }), O)
    expect(s.find((c) => c.colId === 'channels')!.pinned).toBeNull()
  })
})

describe('operator locks — grid → dialog', () => {
  it('🔴 derives lockedColumns from the pinned-left togglable columns, in displayed order — a header-menu pin IS a lock', () => {
    const state: ColumnState[] = [
      { colId: AG_SELECTION_COL, pinned: 'left' }, { colId: AG_AUTO_COL, pinned: 'left' },
      { colId: 'price', pinned: 'left' }, { colId: 'channels' }, { colId: 'tags', pinned: 'left' }, { colId: 'status', hide: true }, { colId: 'available' },
      { colId: 'actions', pinned: 'right' },
    ]
    const p = columnStateToPrefs(state, P(), O)
    expect(p.lockedColumns).toEqual(['price', 'tags'])
    // structural and engine columns never enter the list
    expect(p.lockedColumns).not.toContain('product')
    expect(p.lockedColumns).not.toContain(AG_AUTO_COL)
    // and a locked column is among the visible ones
    expect(p.visibleColumns).toEqual(['price', 'channels', 'tags', 'available'])
  })
  it('a caller that never opted into locks gets no lockedColumns field back', () => {
    const { lockedColumns: _drop, ...noLocks } = P()
    const p = columnStateToPrefs([{ colId: 'price', pinned: 'left' }], noLocks as PreferencesValue, O)
    expect('lockedColumns' in p).toBe(false)
  })
  it('round-trips the lock set: dialog → grid → dialog', () => {
    const start = P({ visibleColumns: ['tags', 'price', 'channels'], lockedColumns: ['price', 'tags'] })
    const back = columnStateToPrefs(prefsToColumnState(start, O), start, O)
    expect(back.lockedColumns).toEqual(['price', 'tags'])
    expect(back.visibleColumns).toEqual(['price', 'tags', 'channels'])
  })
})

describe('row grouping and aggregation — column state, both ways', () => {
  const COLS = [{ key: 'product', locked: true }, { key: 'brand' }, { key: 'status' }, { key: 'sales' }, { key: 'units' }, { key: 'actions', locked: true }]
  const O = { columns: COLS, treeColumnKey: 'product' }
  const base = { visibleColumns: ['brand', 'status', 'sales', 'units'], lockedColumns: [], stickyFirstColumn: false, stickyLastColumn: false, pageSize: 100, sortBy: '', sortDir: 'asc' as const }
  it('a grouped column carries rowGroup in order and hides; an aggregated one carries aggFunc', () => {
    const state = prefsToColumnState({ ...base, rowGroups: ['status', 'brand'], aggregations: { sales: 'sum', units: 'max' } }, O)
    const by = Object.fromEntries(state.map((s) => [s.colId, s]))
    expect(by.status).toMatchObject({ rowGroup: true, rowGroupIndex: 0, hide: true })
    expect(by.brand).toMatchObject({ rowGroup: true, rowGroupIndex: 1, hide: true })
    expect(by.sales).toMatchObject({ rowGroup: false, rowGroupIndex: null, aggFunc: 'sum', hide: false })
    expect(by.units.aggFunc).toBe('max'); expect(by['ag-Grid-AutoColumn'].aggFunc).toBeNull()
  })
  it('no grouping asked ⇒ every column says so explicitly, so a previous grouping is cleared', () => {
    const state = prefsToColumnState(base, O)
    expect(state.every((s) => s.rowGroup === false && s.rowGroupIndex === null && s.aggFunc === null)).toBe(true)
  })
  it('reads grouping and aggregation back, and keeps a grouped (hidden) column among the visible ones', () => {
    const state = prefsToColumnState({ ...base, rowGroups: ['brand'], aggregations: { sales: 'avg' } }, O)
    const prefs = columnStateToPrefs(state, { ...base, rowGroups: [], aggregations: {} }, O)
    expect(prefs.rowGroups).toEqual(['brand']); expect(prefs.aggregations).toEqual({ sales: 'avg' })
    expect(prefs.visibleColumns).toEqual(['brand', 'status', 'sales', 'units'])
  })
  it('a caller that never asked for grouping gets no grouping fields back', () => {
    const prefs = columnStateToPrefs(prefsToColumnState(base, O), base, O)
    expect('rowGroups' in prefs).toBe(false); expect('aggregations' in prefs).toBe(false)
  })
})

/**
 * #759 — a ticked key the bridge cannot address is REFUSED, never swallowed.
 *
 * The `.filter` that drops it is correct (no column, no entry) and the silence was not: measured on
 * the live studio contract, `visibleColumns` with an unknown key produced 99 entries — exactly the
 * same 99 — with no error, so the dialog and the grid disagreed with nothing on screen saying so.
 * Same class as a reveal reporting `distance 0` when it could not measure.
 */
describe('an unaddressable ticked key is reported, not dropped silently', () => {
  it('🔴 calls back with the key, and still emits every key it CAN address', () => {
    const seen: string[][] = []
    const state = prefsToColumnState(P({ visibleColumns: ['channels', 'not_a_column', 'price'] }), {
      ...O,
      onUnaddressable: (keys) => seen.push([...keys]),
    })
    expect(seen).toEqual([['not_a_column']])
    const by = Object.fromEntries(state.map((c) => [c.colId, c]))
    expect(by.channels).toMatchObject({ hide: false })
    expect(by.price).toMatchObject({ hide: false })
    // and nothing is invented for the key that has no column
    expect(state.some((c) => c.colId === 'not_a_column')).toBe(false)
  })

  it('🔴 the CONTROL: a fully addressable list reports nothing', () => {
    // Without this the case above passes on a callback that fires for everything, which is the
    // shape that would make the refusal noise rather than information.
    const seen: string[][] = []
    prefsToColumnState(P(), { ...O, onUnaddressable: (keys) => seen.push([...keys]) })
    expect(seen).toEqual([])
  })

  /**
   * 🔴 The UNHANDLED path, spied rather than inspected (#763).
   *
   * The callback arm above was tested and this one was only read, which is the asymmetry that let
   * the fallback ship unexercised. It is not decoration: with no `onUnaddressable` wired, this
   * `console.error` is the ONLY thing that reports the disagreement — and on the fresh dev server it
   * fired sixteen times from master's `applyPreset`, naming `sku, completeness`, keys whose columns
   * became the identity band and the readiness pill. The message text is therefore load-bearing:
   * someone read it out of a log to find the caller, so the prefix and the key list are asserted,
   * not just the fact of a call.
   */
  afterEach(() => vi.restoreAllMocks())

  it('🔴 with NO callback wired, it says so on the console — naming the keys', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    prefsToColumnState(P({ visibleColumns: ['channels', 'gone_a', 'price', 'gone_b'] }), O)
    expect(spy).toHaveBeenCalledTimes(1)
    const [prefix, keys] = spy.mock.calls[0] as [string, string]
    expect(prefix).toContain('[columnPrefs]')
    expect(prefix).toContain('cannot address')
    // Both keys, in the order the operator's list carried them — a partial report sends the reader
    // hunting for the second one.
    expect(keys).toBe('gone_a, gone_b')
  })

  it('🔴 the CONTROL: nothing on the console when every key is addressable', () => {
    // Without this the case above passes on a `console.error` that fires unconditionally, which
    // would bury the real report in noise — the failure mode a loud refusal is supposed to avoid.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    prefsToColumnState(P(), O)
    expect(spy).not.toHaveBeenCalled()
  })

  it('🔴 the callback SUPPRESSES the console — one report, not two', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[][] = []
    prefsToColumnState(P({ visibleColumns: ['channels', 'gone_a'] }), { ...O, onUnaddressable: (k) => seen.push([...k]) })
    expect(seen).toEqual([['gone_a']])
    expect(spy).not.toHaveBeenCalled()
  })

  it('a LOCKED key is addressable — it is chrome, not a missing column', () => {
    // `product` and `actions` are locked, so they are absent from `togglable` but present in the
    // bridge. Reporting them would cry wolf on every save.
    const seen: string[][] = []
    prefsToColumnState(P({ visibleColumns: ['product', 'channels', 'actions'] }), {
      ...O,
      onUnaddressable: (keys) => seen.push([...keys]),
    })
    expect(seen).toEqual([])
  })
})
