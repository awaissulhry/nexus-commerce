import { describe, expect, it, vi } from 'vitest'

import { actionContextMenu, actionMenuItems, keepClipboardItems } from './menuAdapters'
import { actionLabel, AVAILABLE, HIDDEN, ROW, SELECTION, contextOf, disabled, type GridAction } from './registry'

interface Row { id: string; isParent: boolean }
const row: Row = { id: 'c1', isParent: false }
const parent: Row = { id: 'p', isParent: true }

const act = (over: Partial<GridAction<Row>> & Pick<GridAction<Row>, 'id'>): GridAction<Row> => ({
  label: over.id, scope: ROW, available: () => AVAILABLE, run: async () => ({ ok: true }), ...over,
})

const ACTIONS: GridAction<Row>[] = [
  act({ id: 'open' }),
  act({ id: 'delete', danger: true, available: (r) => (r[0]?.isParent ? disabled('A parent is removed by demoting it') : AVAILABLE) }),
  act({ id: 'promote', available: (r) => (r[0]?.isParent ? HIDDEN : AVAILABLE) }),
  act({ id: 'unlink', scope: SELECTION }),
  act({ id: 'add-variation', scope: contextOf('product-family') }),
]

const opts = (over: Partial<Parameters<typeof actionMenuItems<Row>>[0]> = {}) => ({
  actions: ACTIONS, onSelect: vi.fn(), ...over,
})

describe('the ⋯ column adapter', () => {
  /**
   * 🔴 A right-clicked row is a SELECTION OF ONE. This adapter first filtered on ROW alone — which
   * passed eleven tests and nine mutations, and rendered an empty menu on the only grid that uses
   * it, because every family verb is `selection` or `context`. "Unlink this variation" is the same
   * verb from the bulk bar with one row ticked as from the row's own menu.
   */
  it('offers row AND selection verbs — a right-clicked row is a selection of one', () => {
    expect(actionMenuItems(opts())(row).map((i) => i.id)).toEqual(['open', 'delete', 'promote', 'unlink'])
  })

  /** …but never a CONTEXT verb: the container is not a row, and that isolation still holds. */
  it('a family verb can never reach a row menu', () => {
    expect(actionMenuItems(opts())(row).map((i) => i.id)).not.toContain('add-variation')
    expect(actionContextMenu(opts())({ node: { data: row }, defaultItems: [] } as never)
      .map((i) => (typeof i === 'string' ? i : i.name))).not.toContain('add-variation')
  })

  it('drops a hidden verb and keeps a disabled one', () => {
    const ids = actionMenuItems(opts())(parent).map((i) => i.id)
    expect(ids).toContain('delete')
    expect(ids).not.toContain('promote')
  })

  /**
   * 🔴 The DS `MenuItemDef` has no tooltip slot, so a disabled entry would be grey and SILENT —
   * the trap where a missing permission, a wrong selection and a bug look identical. The reason
   * goes into the label rather than being dropped.
   */
  /**
   * 🔴 In the DS's `title` slot, not appended to the label. This adapter appended it at first,
   * because `Menu.d.ts` omits `title` — the declaration was stale and `Menu.tsx` has had it all
   * along. Appended, the menu measured ~900px here and 1059px on the channel sheet.
   */
  it('a disabled entry carries its reason in the TITLE, leaving the label clean', () => {
    const item = actionMenuItems(opts())(parent).find((i) => i.id === 'delete')!
    expect(item.label).toBe('delete')
    expect(item.title).toBe('A parent is removed by demoting it')
    expect(item.description).toBe(item.title)
    expect(item.disabled).toBe(true)
    expect(item.onSelect).toBeUndefined()
  })

  it('a runnable entry carries no title — there is nothing to explain', () => {
    expect(actionMenuItems(opts())(row).find((i) => i.id === 'open')!.title).toBeUndefined()
  })

  it('a runnable entry runs the verb against its own row', () => {
    const o = opts()
    actionMenuItems(o)(row).find((i) => i.id === 'open')!.onSelect!()
    expect(o.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'open' }), [row])
  })

  /** A group row or family footer is not a record; "Delete" on one would act on an id that is not one. */
  it('a non-record row gets no verbs at all', () => {
    expect(actionMenuItems(opts({ isRecord: (r) => r.id !== 'c1' }))(row)).toEqual([])
  })
})

describe('the right-click adapter', () => {
  const params = (data: Row | undefined, defaults: unknown[] = ['copy', 'export']) =>
    ({ node: data ? { data } : null, defaultItems: defaults } as never)

  /**
   * 🔴 Updated for #327: `export` is no longer among AG's kept defaults. These two tests asserted
   * that AG's entries pass through untouched — which was true, and which is exactly how the
   * dishonest exporter sat one right-click from the honest one. See `KEPT_AG_MENU_ITEMS`.
   */
  it('puts the lane’s verbs above AG’s CLIPBOARD entries, separated by a rule', () => {
    const items = actionContextMenu(opts())(params(row))
    expect(items.map((i) => (typeof i === 'string' ? i : i.name))).toEqual(['open', 'delete', 'promote', 'unlink', 'separator', 'copy'])
  })

  /** The operator keeps the clipboard, and loses the entries that lied. */
  it('keeps AG’s clipboard entries alone when the row is not a record', () => {
    expect(actionContextMenu(opts({ isRecord: () => false }))(params(row))).toEqual(['copy'])
    expect(actionContextMenu(opts())(params(undefined))).toEqual(['copy'])
  })

  it('🔴 drops AG’s export entry even when AG offers it and the row has no verbs', () => {
    // The one that matters: a row with nothing of its own must not fall back to AG's exporter.
    expect(actionContextMenu(opts({ isRecord: () => false }))(params(row, ['copy', 'export', 'csvExport']))).toEqual(['copy'])
  })

  it('adds no separator when AG offered nothing', () => {
    expect(actionContextMenu(opts())(params(row, [])).map((i) => (typeof i === 'string' ? i : i.name))).toEqual(['open', 'delete', 'promote', 'unlink'])
  })

  /**
   * 🔴 The reason rides AG's `tooltip`, not its `name`. Appending it to the name read correctly and
   * measured ~900px wide on screen — three permission sentences inline turn a context menu into a
   * paragraph over the grid. The entry must still never be silent.
   */
  it('a disabled verb keeps its reason in the TOOLTIP, so the menu stays a menu', () => {
    const item = actionContextMenu(opts())(params(parent)).find((i) => typeof i !== 'string' && i.name === 'delete') as { name: string; tooltip?: string; disabled?: boolean; action?: unknown }
    expect(item.name).toBe('delete')
    expect(item.tooltip).toBe('A parent is removed by demoting it')
    expect(item.disabled).toBe(true)
    expect(item.action).toBeUndefined()
  })

  it('a runnable verb carries no tooltip — there is nothing to explain', () => {
    const item = actionContextMenu(opts())(params(row)).find((i) => typeof i !== 'string' && i.name === 'open') as { tooltip?: string }
    expect(item.tooltip).toBeUndefined()
  })

  /**
   * 🔴 AG takes `name: string`, not a node. A verb labelled with an element would render as
   * "[object Object]"; the id is visible and wrong-looking, which beats invisible and wrong.
   */
  it('falls back to the id rather than rendering an element as a string', () => {
    const withNode = [act({ id: 'fancy', label: { type: 'span' } as never })]
    const items = actionContextMenu({ actions: withNode, onSelect: vi.fn() })(params(row, []))
    expect((items[0] as { name: string }).name).toBe('fancy')
  })

  /** Same verbs, same order, same enabled/disabled — only WHERE the reason renders differs. */
  it('both surfaces read the SAME list — a right-click and a ⋯ never disagree', () => {
    const o = opts()
    const dots = actionMenuItems(o)(parent)
    const right = actionContextMenu(o)(params(parent, [])) as { name: string; disabled?: boolean; tooltip?: string }[]
    expect(right.map((i) => i.name)).toEqual(dots.map((i) => i.id))
    expect(right.map((i) => !!i.disabled)).toEqual(dots.map((i) => !!i.disabled))
    // Both carry the reason in a tooltip — AG's `tooltip`, the DS's `title`. Labels stay clean.
    expect(right.find((i) => i.name === 'delete')!.tooltip).toBe('A parent is removed by demoting it')
    expect(dots.find((i) => i.id === 'delete')!.title).toBe('A parent is removed by demoting it')
    expect(dots.map((i) => String(i.label))).toEqual(right.map((i) => i.name))
  })
})

/**
 * SR.1 measured 10 items on the studio row menu, 6 of them AG's — including an `Export ›` submenu
 * that offers the exporter `export/gridCsv.ts` exists to refuse, and `Copy with Group Headers` on a
 * sheet whose column groups AG.1-d removed.
 */
describe('AG default items — the clipboard, and nothing else', () => {
  const ALL_DEFAULTS = [
    'autoSizeAll', 'expandAll', 'contractAll', 'copy', 'copyWithHeaders', 'copyWithGroupHeaders',
    'cut', 'paste', 'separator', 'export', 'csvExport', 'excelExport', 'chartRange', 'pivotChart',
    'resetColumns', 'columnChooser',
  ] as const

  it('keeps exactly copy / copyWithHeaders / cut / paste', () => {
    expect(keepClipboardItems(ALL_DEFAULTS as never)).toEqual(['copy', 'copyWithHeaders', 'cut', 'paste'])
  })

  it('🔴 drops every export entry — AG exports the rows the GRID holds, which is a silent subset', () => {
    const kept = keepClipboardItems(ALL_DEFAULTS as never)
    for (const banned of ['export', 'csvExport', 'excelExport']) expect(kept).not.toContain(banned)
  })

  it('🔴 drops copyWithGroupHeaders — the studio sheets have no column groups to copy', () => {
    expect(keepClipboardItems(ALL_DEFAULTS as never)).not.toContain('copyWithGroupHeaders')
  })

  it('drops grid-shape verbs that belong in the COLUMN menu, not a row menu', () => {
    const kept = keepClipboardItems(ALL_DEFAULTS as never)
    for (const banned of ['autoSizeAll', 'expandAll', 'contractAll', 'resetColumns', 'columnChooser', 'chartRange', 'pivotChart']) {
      expect(`${banned}: ${kept.includes(banned as never)}`).toBe(`${banned}: false`)
    }
  })

  it('drops separators too — a rule with nothing on one side separates nothing', () => {
    expect(keepClipboardItems(['separator', 'copy', 'separator'] as never)).toEqual(['copy'])
  })

  it('drops AG object items as well as strings, so a future default cannot slip through', () => {
    expect(keepClipboardItems([{ name: 'Something AG added' }, 'copy'] as never)).toEqual(['copy'])
  })

  it('answers empty for an empty menu rather than throwing', () => {
    expect(keepClipboardItems([] as never)).toEqual([])
  })
})

/*
 * The allowlist itself (#327). I appended these after my two older tests went red against the new
 * contract — and the tests were already corrected by the lane that made the change, so what this
 * block adds is coverage of `keepClipboardItems` DIRECTLY rather than only through the adapter.
 *
 * 🔴 I first wrote the reason for dropping `export` as "the toolbar owns export". That is not the
 * reason and it is far too weak: AG's own exporter walks the rows the GRID is holding, so under
 * SSRM it writes the loaded blocks rather than the result set — a file that is a silent subset of
 * what the operator filtered to, plus any layout rows a page injected. The entry is refused because
 * it puts a dishonest export one right-click from the honest one with nothing to tell them apart.
 * Reasons get copied into the next person's head, so a weak one is a real defect.
 */
describe('KEPT_AG_MENU_ITEMS — the row menu keeps the clipboard and nothing else', () => {
  it('🔴 refuses `export` — AG exports the rows the GRID holds, not the result set', () => {
    expect(keepClipboardItems(['copy', 'export', 'csvExport', 'excelExport'])).toEqual(['copy'])
  })

  it('drops the entries that are about the GRID rather than the row', () => {
    expect(keepClipboardItems(['autoSizeAll', 'expandAll', 'contractAll', 'chartRange'])).toEqual([])
  })

  it('keeps the whole clipboard — copy, copyWithHeaders, cut, paste', () => {
    // `copyWithHeaders` earns its place: `sheetPasteProcessor` matches a pasted block back onto
    // columns BY HEADER NAME, so copying without headers would break the Excel round-trip this
    // engine was built for.
    expect(keepClipboardItems(['copy', 'copyWithHeaders', 'cut', 'paste']))
      .toEqual(['copy', 'copyWithHeaders', 'cut', 'paste'])
  })

  it('drops copyWithGroupHeaders — it copies a header row that no longer exists', () => {
    // The column-group strip was removed from the studio sheets, so its output is a blank line.
    expect(keepClipboardItems(['copy', 'copyWithGroupHeaders'])).toEqual(['copy'])
  })
})

/*
 * #363 — a verb that words itself from the rows.
 *
 * PES.3 collapsed Pause/Activate into one `offer-toggle`, and a fixed `label: string` could not say
 * "Pause 3 offers" / "Activate 2 offers": `available()` returns an availability, not a name. The
 * registry already guaranteed every surface RUNS the same verb; this extends the guarantee to what
 * every surface CALLS it — which is the half an operator actually reads.
 */
describe('actionLabel — the callable label (#363)', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('returns a plain string label unchanged — every existing verb is untouched', () => {
    expect(actionLabel({ label: 'Delete' }, rows)).toBe('Delete')
    expect(actionLabel({ label: 'Delete' }, [])).toBe('Delete')
  })

  it('calls a function label with the rows in scope', () => {
    const label = (r: { id: string }[]) => `Pause ${r.length} offers`
    expect(actionLabel({ label }, rows)).toBe('Pause 3 offers')
    expect(actionLabel({ label }, [])).toBe('Pause 0 offers')
  })

  it('🔴 gives the verb the ROWS, not a count — a mixed selection is a different sentence', () => {
    // Only the verb knows whether "3 offers" or "2 to pause, 1 to activate" is the honest wording,
    // and it cannot know from a number.
    const mixed = [{ id: 'a', live: true }, { id: 'b', live: false }, { id: 'c', live: true }]
    const label = (r: { live: boolean }[]) => `Pause ${r.filter((x) => x.live).length} of ${r.length}`
    expect(actionLabel({ label }, mixed)).toBe('Pause 2 of 3')
  })

  it('hands the verb a COPY — a label must not be able to mutate the selection it describes', () => {
    const seen: unknown[] = []
    const label = (r: { id: string }[]) => { r.push({ id: 'injected' }); seen.push(r.length); return 'x' }
    actionLabel({ label }, rows)
    expect(seen).toEqual([4])
    expect(rows).toHaveLength(3) // the caller's array is intact
  })

  it('the ⋯ menu resolves it for the row that menu belongs to', () => {
    const acts = [{ id: 'toggle', label: (r: Row[]) => `Toggle ${r.length}`, scope: ROW, available: () => ({ kind: 'enabled' as const }), run: async () => ({ ok: true }) }]
    const items = actionMenuItems({ actions: acts as never, onSelect: () => {} })(row)
    expect(String(items[0].label)).toBe('Toggle 1')
  })

  it('the right-click menu resolves it too, and AG still gets a plain string', () => {
    const acts = [{ id: 'toggle', label: (r: Row[]) => `Toggle ${r.length}`, scope: ROW, available: () => ({ kind: 'enabled' as const }), run: async () => ({ ok: true }) }]
    const p = { node: { data: row }, defaultItems: ['copy'] } as never
    const items = actionContextMenu({ actions: acts as never, onSelect: () => {} })(p)
    const first = items[0] as { name: string }
    expect(first.name).toBe('Toggle 1')
    expect(typeof first.name).toBe('string')
  })
})


describe('danger tone preserves four-surface declaration order', () => {
  it('the DS gets a React glyph and AG gets an SVG string, with the same danger meaning', () => {
    const dots = actionMenuItems(opts())(row)
    const right = actionContextMenu(opts())({ node: { data: row }, defaultItems: [] } as never)
    expect(dots.map(i => i.id)).toEqual(['open', 'delete', 'promote', 'unlink'])
    expect(dots[1].tone).toBe('danger'); expect(dots[1].icon).toBeTruthy()
    expect(dots[0].tone).toBeUndefined()
    const danger = right[1] as { cssClasses: string[]; icon: string }
    expect(danger.cssClasses).toEqual(['nds-menu-danger'])
    expect(typeof danger.icon).toBe('string'); expect(danger.icon).toContain('<svg')
  })
})
