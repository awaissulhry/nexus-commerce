/**
 * VT.2 — `AxesPanelEditor` / `AxesPanel`: ONE component, BOTH hosts, one test file (prompt step 4).
 *
 * `ag-grid-react` is mocked so `useGridCellEditor`'s lifecycle object can be READ — the pattern
 * `FormulaCellEditor.vitest.test.ts` established, and the only way to assert `isCancelAfterEnd`
 * without a browser. Everything else renders the real component in Node through `react-dom/server`.
 *
 * What a Node suite CANNOT prove, stated so the report does not claim it: a real keystroke, AG's own
 * Enter/Esc, the popup's geometry on screen and the network request a commit issues. Those are
 * measured in the browser and the numbers go in the ledger — this file proves the LOGIC each of them
 * runs through (`reference_browser_probe_lies` in reverse: a green unit test is not a working screen).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const lifecycle: { isCancelAfterEnd?: () => boolean } = {}
vi.mock('ag-grid-react', () => ({
  useGridCellEditor: (props: { isCancelAfterEnd?: () => boolean }) => {
    lifecycle.isCancelAfterEnd = props.isCancelAfterEnd
  },
}))

import {
  GALE_MASTER,
  GALE_AMAZON_DE_DERIVED,
  GALE_EBAY_IT_OVERRIDDEN,
  GALE_EBAY_DE_UNAVAILABLE,
  GALE_SHOPIFY_DROPPED,
} from '../../../../../../docs/fixtures/vt1/fixtures'
import { SpecificsSection } from '../../../app/products/[id]/edit/_studio/variants/channel/dock/sections'
import {
  AG_POPUP_SELECTOR,
  agPopupHostOf,
  axesCellFromProjection,
  projectionDraftFromAxesCell,
  axesChannelWord,
  axesOrderState,
  axesReorder,
  axesSetAxis,
  axisLockReason,
  AXES_ADD_KEYS,
  AXES_EDITOR_COPY,
  AxesPanel,
  AxesPanelEditor,
  THEME_GROUP_LABEL,
  THEME_GROUP_ORDER,
  axesAddLabel,
  axesEditorScopeLabel,
  axesFilterMatch,
  axesSectionTitle,
  moveHighlight,
  reorderAxes,
  themeGroupOf,
} from './AxesPanelEditor'
import type { VariationThemeCell } from '../renderers/variationTheme'

const panel = (cell: VariationThemeCell, host: 'cell' | 'dock' = 'cell') =>
  renderToStaticMarkup(createElement(AxesPanel, { cell, host, onChange: () => {} }))

const editor = (value: unknown) => renderToStaticMarkup(createElement(AxesPanelEditor, { value } as never))

/* ── the title and the section vocabulary, from the WIRE ──────────────────────────────────── */

describe('the header names the coordinate from the wire, never from a builder parameter', () => {
  it('reads `Shared product` on master and `<Channel> · <Market>` on every coordinate', () => {
    expect(axesEditorScopeLabel(GALE_MASTER)).toBe('Shared product')
    expect(axesEditorScopeLabel(GALE_AMAZON_DE_DERIVED)).toBe('Amazon · DE')
    /* `eBay`, lower-case e — the DS's own `channelDisplayName`, not a local map. A second map is how
       one surface ends up saying `Ebay`. */
    expect(axesEditorScopeLabel(GALE_EBAY_IT_OVERRIDDEN)).toBe('eBay · IT')
    expect(axesEditorScopeLabel(GALE_SHOPIFY_DROPPED)).toBe('Shopify · GLOBAL')
  })

  it('uses the CHANNEL own noun for the section and the add control (Appendix A)', () => {
    expect(axesSectionTitle(GALE_AMAZON_DE_DERIVED)).toBe('Axes on this channel')
    expect(axesSectionTitle(GALE_EBAY_IT_OVERRIDDEN)).toBe('Variation specifics')
    expect(axesSectionTitle(GALE_SHOPIFY_DROPPED)).toBe('Options')
    expect(axesSectionTitle(GALE_MASTER)).toBe('Axes')
    expect(axesAddLabel(GALE_MASTER)).toBe('+ Add axis')
    expect(axesAddLabel(GALE_EBAY_IT_OVERRIDDEN)).toBe('+ Add a specific')
    expect(axesAddLabel(GALE_SHOPIFY_DROPPED)).toBe('+ Add an option')
  })
})

/* ── the theme list ───────────────────────────────────────────────────────────────────────── */

describe('the theme list — three groups, from the wire own flags', () => {
  it('puts a DEPRECATED spelling in the deprecated group even when it covers every axis', () => {
    const items = GALE_AMAZON_DE_DERIVED.candidates!.items
    const legacy = items.find((i) => i.code === 'COLOR_NAME/SIZE_NAME')!
    expect([legacy.coversAll, legacy.deprecated]).toEqual([true, true])
    expect(themeGroupOf(legacy)).toBe('deprecated')
    expect(themeGroupOf(items.find((i) => i.code === 'COLOR/SIZE')!)).toBe('coversAll')
    expect(themeGroupOf(items.find((i) => i.code === 'COLOR/MATERIAL')!)).toBe('drops')
  })

  it('groups all 8 fixture candidates and loses none', () => {
    const items = GALE_AMAZON_DE_DERIVED.candidates!.items
    expect(items).toHaveLength(8)
    const tally = { coversAll: 0, drops: 0, deprecated: 0 }
    for (const i of items) tally[themeGroupOf(i)]++
    expect(tally).toEqual({ coversAll: 2, drops: 3, deprecated: 3 })
    expect(tally.coversAll + tally.drops + tally.deprecated).toBe(items.length)
  })

  it('renders the three group headings with their counts', () => {
    const out = panel(GALE_AMAZON_DE_DERIVED)
    for (const g of THEME_GROUP_ORDER) expect(out).toContain(THEME_GROUP_LABEL[g])
    expect(out).toContain('· 2')
    expect(out).toContain('· 3')
  })

  it('filters on the CODE and on the printed label', () => {
    expect(axesFilterMatch('color', { code: 'COLOR/SIZE', label: 'Farbe / Größe' })).toBe(true)
    expect(axesFilterMatch('größe', { code: 'COLOR/SIZE', label: 'Farbe / Größe' })).toBe(true)
    expect(axesFilterMatch('material', { code: 'COLOR/SIZE', label: 'Farbe / Größe' })).toBe(false)
    expect(axesFilterMatch('  ', { code: 'COLOR/SIZE', label: 'Farbe / Größe' })).toBe(true)
  })
})

/* ── D-VT7: the keys ──────────────────────────────────────────────────────────────────────── */

describe('D-VT7 — `,` and `/` add the highlighted candidate', () => {
  it('declares exactly those two keys, and NOT `+`', () => {
    expect([...AXES_ADD_KEYS]).toEqual([',', '/'])
    /* `+` is a value character (a size can be `2XL+`), so taking it would eat a keystroke. */
    expect(AXES_ADD_KEYS).not.toContain('+')
  })

  it('clamps the highlight at both ends instead of wrapping', () => {
    expect(moveHighlight(0, -1, 5)).toBe(0)
    expect(moveHighlight(4, 1, 5)).toBe(4)
    expect(moveHighlight(2, 1, 5)).toBe(3)
    expect(moveHighlight(2, -1, 5)).toBe(1)
    /* An empty list after a filter must not produce -1 and index nothing. */
    expect(moveHighlight(3, 1, 0)).toBe(0)
  })

  it('advertises the keys on screen — a shortcut nobody can see is not a feature', () => {
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain(AXES_EDITOR_COPY.addsHint)
  })
})

/* ── the report rule ──────────────────────────────────────────────────────────────────────── */

describe('AG 36 — reporting and discarding', () => {
  it('reports NOTHING on mount: the panel renders without calling onChange once', () => {
    const calls: unknown[] = []
    renderToStaticMarkup(createElement(AxesPanel, { cell: GALE_AMAZON_DE_DERIVED, host: 'cell', onChange: (v) => calls.push(v) }))
    /* Reporting on mount ARMS a write — opening a cell to read it would save it. */
    expect(calls).toHaveLength(0)
  })

  it('tells AG to CANCEL an untouched edit', () => {
    editor(GALE_AMAZON_DE_DERIVED)
    expect(typeof lifecycle.isCancelAfterEnd).toBe('function')
    expect(lifecycle.isCancelAfterEnd!()).toBe(true)
  })

  it('renders nothing at all for a CHILD row — the second door, after `editable`', () => {
    expect(editor(null)).toBe('')
  })
})

/* ── both hosts ───────────────────────────────────────────────────────────────────────────── */

describe('two hosts, one panel', () => {
  it('advertises Esc/Enter in the CELL and not in the dock — the dock owns neither key', () => {
    expect(panel(GALE_EBAY_IT_OVERRIDDEN, 'cell')).toContain(AXES_EDITOR_COPY.keys)
    expect(panel(GALE_EBAY_IT_OVERRIDDEN, 'dock')).not.toContain(AXES_EDITOR_COPY.keys)
  })

  /**
   * 🔴 VT.2c REPLACED this case, and the reason is written down rather than left as a diff.
   *
   * It used to assert the popup's four chrome blocks in BOTH hosts. That was right while the dock had
   * not adopted the panel; it is wrong now, and keeping it would have pinned a defect: in the dock
   * this panel IS spec §4.4.1, one section inside a dock that already renders its own header, its own
   * `<h3>` + `2 of 5 used` tag, its own §4.4.4 lock Banner and its own `Cancel · Save mapping`
   * footer. The old assertion would have required a SECOND copy of each of those four.
   *
   * What "one component, two hosts" means is asserted below instead: the ROWS, the two lock states,
   * the reorder rule, the add path and every string are one definition, and the chrome is the host's.
   */
  it('shares the ROWS and the states, and gives each host only its own chrome', () => {
    const cell = panel(GALE_EBAY_IT_OVERRIDDEN, 'cell')
    const dock = panel(GALE_EBAY_IT_OVERRIDDEN, 'dock')
    /* Shared: the rows, from the one `OrderedList`, with the same axis labels in both. */
    for (const out of [cell, dock]) {
      expect(out).toContain('nds-axes-rows')
      expect(out).toContain('nds-ordered-list')
      expect(out).toContain('Color')
      expect(out).toContain('Size')
    }
    /* The popup's chrome is the CELL's — and the dock states each of those four things itself. */
    for (const cls of ['nds-axes-head', 'nds-axes-source', 'nds-axes-foot']) {
      expect(cell).toContain(cls)
      expect(dock).not.toContain(cls)
    }
    expect(cell).toContain('Overridden here')
    expect(dock).not.toContain('Overridden here')
    /* ONE lock banner: the cell's popup renders it, the dock's own `LockBanner` (§4.4.4) does. */
    expect(cell).toContain(GALE_EBAY_IT_OVERRIDDEN.locked!.reason)
    expect(dock).not.toContain('nds-banner')
    /* The dock's row anatomy is §4.4.1's: 92px name · arrow · listbox, and no include checkbox —
       the dock's draft has no `included` field, so a checkbox there would discard every click. */
    expect(dock).toContain('nds-axes-dockname')
    expect(dock).toContain('nds-axes-arrow')
    expect(dock).not.toContain('type="checkbox"')
    expect(cell).toContain('type="checkbox"')
  })

  it('renders the dock own footer node when the dock gives it one (`Save mapping` stays)', () => {
    const out = renderToStaticMarkup(
      createElement(AxesPanel, {
        cell: GALE_EBAY_IT_OVERRIDDEN,
        host: 'dock',
        onChange: () => {},
        footer: createElement('button', { type: 'button' }, 'Save mapping'),
      }),
    )
    expect(out).toContain('Save mapping')
  })
})

/* ── the source row and the three-way candidate state ─────────────────────────────────────── */

describe('the source row shows the SERVER sentence and the right action', () => {
  it('offers `Override` on a derived coordinate and `Use inherited axes` on an overridden one', () => {
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain(AXES_EDITOR_COPY.override)
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain('Derived from the family axes')
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).toContain(AXES_EDITOR_COPY.resetToRule)
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).not.toContain(AXES_EDITOR_COPY.override)
  })

  it('shows master its own strapline and no provenance mark', () => {
    const out = panel(GALE_MASTER)
    expect(out).toContain('every channel projects these')
    expect(out).not.toContain('nds-cell-prov')
  })
})

describe('`candidates.state` is THREE-way — never an empty list that reads as "none"', () => {
  it('shows the server reason as a Banner when the options could not be read', () => {
    expect(GALE_EBAY_DE_UNAVAILABLE.candidates!.state).toBe('unavailable')
    expect(GALE_EBAY_DE_UNAVAILABLE.candidates!.items).toHaveLength(0)
    const out = panel(GALE_EBAY_DE_UNAVAILABLE)
    expect(out).toContain('nds-banner')
    expect(out).toContain('has no category yet')
  })

  it('does NOT show that banner on a coordinate that answered — the discriminating arm', () => {
    expect(GALE_EBAY_IT_OVERRIDDEN.candidates!.state).toBe('ok')
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).not.toContain('has no category yet')
  })

  it('shows a freeform coordinate no aspect list and its own limit', () => {
    expect(GALE_SHOPIFY_DROPPED.candidates!.state).toBe('freeform')
    expect(panel(GALE_SHOPIFY_DROPPED)).toContain('2 of 3')
  })
})

/* ── locks and footers ────────────────────────────────────────────────────────────────────── */

describe('the lock banner and the footer', () => {
  it('shows the lock reason VERBATIM on a live coordinate, and nothing on a draft one', () => {
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).toContain(GALE_EBAY_IT_OVERRIDDEN.locked!.reason)
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain(GALE_AMAZON_DE_DERIVED.locked!.reason)
    expect(GALE_SHOPIFY_DROPPED.locked).toBeNull()
    expect(panel(GALE_SHOPIFY_DROPPED)).not.toContain('Commit opens the plan')
  })

  it('says what master writes, and what a channel collides on', () => {
    expect(panel(GALE_MASTER)).toContain('shared axes')
    expect(panel(GALE_MASTER)).toContain(AXES_EDITOR_COPY.masterFooter)
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain('Collisions have not been evaluated.')
    expect(panel({ ...GALE_AMAZON_DE_DERIVED, collisions: { unresolved: 0, summary: '0 collisions on this coordinate' } })).toContain('0 collisions on this coordinate')
    expect(panel(GALE_SHOPIFY_DROPPED)).toContain(GALE_SHOPIFY_DROPPED.collisions!.summary)
  })

  it('says `order from the theme` on Amazon, where the grips are inert', () => {
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain(AXES_EDITOR_COPY.orderFromTheme)
    /* The arm that proves the hint is conditional: eBay's rows ARE draggable and show a limit tag. */
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).not.toContain(AXES_EDITOR_COPY.orderFromTheme)
    expect(panel(GALE_EBAY_IT_OVERRIDDEN)).toContain('2 of 5')
  })
})

/* ── reorder ──────────────────────────────────────────────────────────────────────────────── */

describe('reorderAxes — ONE reorder rule for both scopes', () => {
  it('applies the given order and keeps an axis the order omits', () => {
    const out = reorderAxes(GALE_SHOPIFY_DROPPED.axes, ['size', 'color'])
    expect(out.map((a) => a.axisKey)).toEqual(['size', 'color', 'style'])
    /* The objects are the SAME objects — a reorder must not rebuild an axis and lose `unbound`. */
    expect(out[2]).toBe(GALE_SHOPIFY_DROPPED.axes[2])
  })

  it('ignores a key that is not an axis rather than inserting an undefined row', () => {
    const out = reorderAxes(GALE_MASTER.axes, ['size', 'nonsense', 'color'])
    expect(out.map((a) => a.axisKey)).toEqual(['size', 'color'])
  })
})


/* ── the DOCK host's adapter (design §3.5's last clause, D-VT4) ───────────────────────────── */

/** A slice of VP.2's real eBay·IT projection page, shaped as the dock hands it over. */
const DOCK_PAGE = {
  version: 18,
  coordinate: { channel: 'EBAY', marketplace: 'IT', channelLabel: 'eBay' },
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  limits: { axes: 5 },
  targetOptions: [
    { code: 'Colore', label: 'Colore' },
    { code: 'Taglia', label: 'Taglia' },
    { code: 'Scollatura', label: 'Scollatura' },
  ],
  freeform: false,
  theme: null,
  locked: { reason: 'Live on eBay IT (item 257584954808) — changing the set relists it. Reordering does not.', externalId: '257584954808', setChangeIs: 'relist' as const, orderChangeAllowed: true },
  axes: [{ key: 'color', label: 'Color' }, { key: 'size', label: 'Size' }],
}
const DOCK_DRAFT = {
  mapping: [
    { axisKey: 'color', axisLabel: 'Color', target: 'Colore', order: 0 },
    { axisKey: 'size', axisLabel: 'Size', target: 'Taglia', order: 1 },
  ],
  split: { mode: 'single' as const },
}

describe('axesCellFromProjection — the dock renders the SAME panel', () => {
  it('carries the coordinate, the vocabulary, the limit and the lock across', () => {
    const cell = axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT)
    expect(cell.vocabulary.sectionTitle).toBe('Variation specifics')
    expect(cell.candidates?.limit).toBe(5)
    expect(cell.candidates?.kind).toBe('aspects')
    expect(cell.locked?.orderChangeAllowed).toBe(true)
    expect(cell.axes.map((a) => [a.axisKey, a.target])).toEqual([['color', 'Colore'], ['size', 'Taglia']])
  })

  it('renders through the panel with the dock chrome and no cell-host key line', () => {
    const out = renderToStaticMarkup(createElement(AxesPanel, { cell: axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT), host: 'dock', onChange: () => {} }))
    /* The section's `aria-label` on the row list is the channel's own title, from the wire. */
    expect(out).toContain('Variation specifics')
    expect(out).not.toContain(AXES_EDITOR_COPY.keys)
    /* 🔴 The count is the DOCK's `<h3>` tag (`2 of 5 used`, §4.4.1) and the panel prints no second
       one — two counts of one fact is how they start disagreeing. */
    expect(out).not.toContain('2 of 5')
  })

  it('names the coordinate from the WIRE even though the dock owns the write', () => {
    const cell = axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT)
    /* 🔴 Measured defect, fixed: with `write: null` every sentence read `The This coordinate
       specific for Color`, because the coordinate lived only inside `write`. */
    expect(cell.write).toBeNull()
    expect(axesChannelWord(cell)).toBe('eBay')
    expect(axesEditorScopeLabel(cell)).toBe('eBay · IT')
    const out = renderToStaticMarkup(createElement(AxesPanel, { cell, host: 'dock', onChange: () => {} }))
    expect(out).toContain('The eBay specific for Color')
    expect(out).not.toContain('This coordinate')
  })

  it('sorts by the draft own `order` rather than trusting array position', () => {
    const shuffled = { ...DOCK_DRAFT, mapping: [{ ...DOCK_DRAFT.mapping[1], order: 0 }, { ...DOCK_DRAFT.mapping[0], order: 1 }] }
    expect(axesCellFromProjection(DOCK_PAGE, shuffled).axes.map((a) => a.axisKey)).toEqual(['size', 'color'])
  })

  it('writes `write: null` — the DOCK owns its own save, and inventing a CAS token here would be a lie', () => {
    expect(axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT).write).toBeNull()
  })

  it('shows an UNMAPPED axis by its own label rather than inventing a channel name', () => {
    const unmapped = { ...DOCK_DRAFT, mapping: [{ axisKey: 'color', axisLabel: 'Color', target: null, order: 0 }] }
    const cell = axesCellFromProjection(DOCK_PAGE, unmapped)
    expect(cell.axes[0]).toMatchObject({ target: null, channelName: 'Color', included: true })
  })
})

describe('projectionDraftFromAxesCell — back to the dock, losing nothing it owns', () => {
  it('round-trips the mapping and RENUMBERS the order', () => {
    const cell = axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT)
    const reordered = { ...cell, axes: [...cell.axes].reverse() }
    const back = projectionDraftFromAxesCell(reordered, DOCK_DRAFT)
    expect(back.mapping).toEqual([
      { axisKey: 'size', axisLabel: 'Size', target: 'Taglia', order: 0 },
      { axisKey: 'color', axisLabel: 'Color', target: 'Colore', order: 1 },
    ])
  })

  it('PRESERVES every draft field the panel knows nothing about', () => {
    /* `split` and `presentationOrder` are the dock's, and a spread that dropped them would silently
       reset a radio the operator had set two sections down. */
    const withExtras = { ...DOCK_DRAFT, presentationOrder: { expectedToken: 'tok', change: { axes: ['color'] } } }
    const back = projectionDraftFromAxesCell(axesCellFromProjection(DOCK_PAGE, withExtras), withExtras)
    expect(back.split).toEqual({ mode: 'single' })
    expect(back.presentationOrder).toEqual({ expectedToken: 'tok', change: { axes: ['color'] } })
  })

  it('is a fixed point when nothing was edited', () => {
    const back = projectionDraftFromAxesCell(axesCellFromProjection(DOCK_PAGE, DOCK_DRAFT), DOCK_DRAFT)
    expect(back.mapping).toEqual(DOCK_DRAFT.mapping)
  })
})


/* ── VT.2c: the TWO states, and the FOUR combinations ─────────────────────────────────────── */

/**
 * The matrix the dock's section 1 carried and the panel did not, so the swap could not happen:
 * (axis locked | not) × (`orderChangeAllowed` true | false).
 *
 * Each row asserts BOTH gates, because they are different questions with different answers and one
 * flag used to answer both: a per-axis lock refuses a TARGET change, order-writability refuses a
 * REORDER, and on eBay the first is `true` while the second is also `true` — reordering a live
 * listing is a revise (§3.5's one exception to a lock), which is precisely the combination a single
 * `locked` boolean cannot express.
 */
const LOCKED_BASE: VariationThemeCell = {
  ...GALE_EBAY_IT_OVERRIDDEN,
  /* No `order` block: this exercises the LOCK rules, not the endpoint's explicit statement. */
  order: undefined,
}
const withLock = (opts: { lockedAxisKeys: string[]; orderChangeAllowed: boolean }): VariationThemeCell => ({
  ...LOCKED_BASE,
  locked: { ...LOCKED_BASE.locked!, lockedAxisKeys: opts.lockedAxisKeys, orderChangeAllowed: opts.orderChangeAllowed },
})

/** One rendered dock row, cut at its own `</li>` — the segment after the last row would otherwise
 *  carry the `+ Add` button, whose held state contains the word this asserts on. */
const dockRows = (html: string): string[] => html.split('nds-axes-row-dock').slice(1).map((part) => part.split('</li>')[0])

const AXIS = GALE_EBAY_IT_OVERRIDDEN.axes[0].axisKey
const OTHER = GALE_EBAY_IT_OVERRIDDEN.axes[1].axisKey
const REASON = GALE_EBAY_IT_OVERRIDDEN.locked!.reason

describe('VT.2c — the four combinations of per-axis lock × order-writability', () => {
  it('1 · axis LOCKED + orderChangeAllowed TRUE — the target is refused, the reorder is a valid commit', () => {
    const cell = withLock({ lockedAxisKeys: [AXIS], orderChangeAllowed: true })
    expect(axisLockReason(cell, AXIS)).toBe(REASON)
    expect(axesSetAxis(cell, AXIS, { target: 'Scollatura' })).toEqual({ ok: false, refused: REASON })
    expect(axesOrderState(cell)).toEqual({ writable: true, reason: null, hint: null })
    const reordered = axesReorder(cell, [OTHER, AXIS])
    expect(reordered.ok).toBe(true)
    expect(reordered.ok && reordered.next.axes.map((a) => a.axisKey)).toEqual([OTHER, AXIS])
  })

  it('2 · axis LOCKED + orderChangeAllowed FALSE — both are refused, each with the server sentence', () => {
    const cell = withLock({ lockedAxisKeys: [AXIS], orderChangeAllowed: false })
    expect(axesSetAxis(cell, AXIS, { target: 'Scollatura' })).toEqual({ ok: false, refused: REASON })
    expect(axesReorder(cell, [OTHER, AXIS])).toEqual({ ok: false, refused: REASON })
    /* The LINE is short and the SENTENCE is the tooltip: an 11px nowrap slot cannot hold the reason. */
    expect(axesOrderState(cell)).toEqual({ writable: false, reason: REASON, hint: AXES_EDITOR_COPY.orderLockedShort })
  })

  it('3 · axis UNLOCKED + orderChangeAllowed TRUE — both are permitted', () => {
    const cell = withLock({ lockedAxisKeys: [], orderChangeAllowed: true })
    expect(axisLockReason(cell, AXIS)).toBeNull()
    const set = axesSetAxis(cell, AXIS, { target: 'Scollatura' })
    expect(set.ok).toBe(true)
    expect(set.ok && set.next.axes.find((a) => a.axisKey === AXIS)!.target).toBe('Scollatura')
    expect(axesReorder(cell, [OTHER, AXIS]).ok).toBe(true)
  })

  it('4 · axis UNLOCKED + orderChangeAllowed FALSE — the target moves, the ORDER does not', () => {
    const cell = withLock({ lockedAxisKeys: [], orderChangeAllowed: false })
    expect(axesSetAxis(cell, AXIS, { target: 'Scollatura' }).ok).toBe(true)
    expect(axesReorder(cell, [OTHER, AXIS])).toEqual({ ok: false, refused: REASON })
  })

  it('an axis NOT in `lockedAxisKeys` is free on the same locked coordinate (the discriminating arm)', () => {
    const cell = withLock({ lockedAxisKeys: [AXIS], orderChangeAllowed: true })
    expect(axisLockReason(cell, OTHER)).toBeNull()
    expect(axesSetAxis(cell, OTHER, { target: 'Scollatura' }).ok).toBe(true)
  })

  it('ABSENT `lockedAxisKeys` is not an empty list — a producer that does not state it locks nothing', () => {
    /* The sheet cell's producer (`variation-rules.service.ts` `lockFor`) carries no per-axis keys, so
       the panel must render the UNLOCKED arm rather than assert a measurement nobody took. */
    expect((GALE_EBAY_IT_OVERRIDDEN.locked as { lockedAxisKeys?: string[] }).lockedAxisKeys).toBeUndefined()
    expect(axisLockReason(GALE_EBAY_IT_OVERRIDDEN, AXIS)).toBeNull()
  })

  it('reports ONLY a permitted change — a refused edit calls onChange zero times', () => {
    /* The panel's `disabled` is one door; this is the other. A report is what arms a write. */
    const cell = withLock({ lockedAxisKeys: [AXIS], orderChangeAllowed: false })
    const permitted = [
      axesSetAxis(cell, OTHER, { target: 'Scollatura' }),
      axesSetAxis(cell, AXIS, { target: 'Scollatura' }),
      axesReorder(cell, [OTHER, AXIS]),
    ]
    expect(permitted.map((e) => e.ok)).toEqual([true, false, false])
  })
})

describe('VT.2c — `axesOrderState`, the four wire rules in their measured order', () => {
  it('3 · the endpoint own statement decides when nothing above it fired', () => {
    const refused: VariationThemeCell = { ...GALE_EBAY_IT_OVERRIDDEN, order: { writableHere: false, reason: 'The order is written in the eBay Variation order editor.' } }
    expect(refused.locked!.orderChangeAllowed).toBe(true)   // so rule 2 does NOT fire here
    expect(axesOrderState(refused)).toEqual({ writable: false, reason: 'The order is written in the eBay Variation order editor.', hint: 'The order is written in the eBay Variation order editor.' })
    expect(axesOrderState({ ...refused, order: { writableHere: true, reason: '' } }).writable).toBe(true)
  })

  it('2 · a LIVE coordinate that cannot revise its order beats its own `order` block', () => {
    /* GALE Amazon·IT, measured: `locked.orderChangeAllowed: false` with `order: {writableHere:false,
       reason:''}`. The adapter reads that empty reason as "we did not look" and would otherwise leave
       the grips live on a live ASIN. */
    const cell: VariationThemeCell = {
      ...GALE_EBAY_IT_OVERRIDDEN,
      locked: { ...GALE_EBAY_IT_OVERRIDDEN.locked!, orderChangeAllowed: false, setChangeIs: 'new-parent' },
      order: { writableHere: true, reason: '' },
    }
    expect(axesOrderState(cell)).toEqual({ writable: false, reason: cell.locked!.reason, hint: AXES_EDITOR_COPY.orderLockedShort })
  })

  it('1 · Amazon THEME order keeps the short measured hint even on a locked coordinate', () => {
    /* Rule 2 above rule 3 on purpose: `GALE_AMAZON_DE_DERIVED` is locked AND `theme-enum`, and the
       canvas hint is `order from the theme`. The long lock sentence is in the Banner, not this slot. */
    expect(GALE_AMAZON_DE_DERIVED.locked?.orderChangeAllowed).toBe(false)
    expect(axesOrderState(GALE_AMAZON_DE_DERIVED)).toEqual({
      writable: false, reason: AXES_EDITOR_COPY.orderFromTheme, hint: AXES_EDITOR_COPY.orderFromTheme,
    })
    expect(panel(GALE_AMAZON_DE_DERIVED)).toContain(AXES_EDITOR_COPY.orderFromTheme)
  })

  it('4 · an unlocked, unstated coordinate is writable — master drags, and nothing says otherwise', () => {
    expect(axesOrderState(GALE_MASTER)).toEqual({ writable: true, reason: null, hint: null })
    expect(axesOrderState(GALE_SHOPIFY_DROPPED).writable).toBe(true)
  })
})

describe('VT.2c — the per-axis lock ON SCREEN, in both hosts', () => {
  const locked = withLock({ lockedAxisKeys: [AXIS], orderChangeAllowed: true })

  it('disables the locked axis target and carries the reason on the element that is hovered', () => {
    for (const host of ['cell', 'dock'] as const) {
      const out = panel(locked, host)
      expect(out).toContain('disabled')
      /* The server's sentence, verbatim, on the control — not only in a banner further up. */
      expect(out).toContain(REASON)
      /* And the locked row is STILL THERE: removing it would hide the axis the banner names. */
      expect(out).toContain(locked.axes[0].label)
    }
  })

  it('keeps the OTHER axis live in the same render — the arm that proves the lock is per-axis', () => {
    const rows = dockRows(panel(locked, 'dock'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('disabled')
    expect(rows[1]).not.toContain('disabled')
  })

  it('fixes the locked axis CHECKBOX in the cell host — a locked axis cannot be dropped either', () => {
    const out = panel(locked, 'cell')
    const boxes = out.match(/<input type="checkbox"[^>]*>/g) ?? []
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toContain('disabled')
    expect(boxes[0]).toContain(REASON)
    expect(boxes[1]).not.toContain('disabled')
  })

  it('makes the grips inert WITH the reason when the order is not writable', () => {
    const out = panel(withLock({ lockedAxisKeys: [], orderChangeAllowed: false }), 'dock')
    /* `OrderedList disabled` renders its grip disabled; the reason is the note beside it, because the
       dock has no one-line hint slot and a truncated reason is one nobody can act on. */
    expect(out).toContain('nds-axes-ordernote')
    expect(out).toContain(REASON)
    expect(panel(withLock({ lockedAxisKeys: [], orderChangeAllowed: true }), 'dock')).not.toContain('nds-axes-ordernote')
  })
})

/* ── VT.2c: the SWAP — the dock's own section 1, rendered here, both hosts in one file ─────── */

/** The dock's `ProjectionPage` slice, with the two states the swap had to preserve. */
const DOCK_PAGE_FULL = {
  ...DOCK_PAGE,
  coordinate: { ...DOCK_PAGE.coordinate, market: 'IT', accountId: null, aliasKey: '', label: 'eBay · IT' },
  limits: { axes: 5, variants: 250, source: { axes: null, variants: null } },
  /* VT.1b's unified lock, as `GET …/studio/projection` answered on GALE eBay·IT (measured 09-13):
     both axes published, a SET change relists, and a REORDER is a revise. */
  locked: { reason: REASON, lockedAxisKeys: ['color'], setChangeIs: 'relist' as const, orderChangeAllowed: true, externalId: '257584954808' },
  order: { axes: ['color', 'size'], valueOrder: {}, editorUrl: '/x', writableHere: false, reason: 'The order is written in the eBay Variation order editor.', token: 'tok' },
  split: { mode: 'single' as const, listings: [], creatable: false },
  children: [],
  mapping: DOCK_DRAFT.mapping,
}

const section = (page: unknown, draft: unknown, onDraft: (d: never) => void = () => {}) =>
  renderToStaticMarkup(createElement(SpecificsSection, { page, draft, onDraft } as never))

describe('VT.2c — the dock section 1 IS the shared panel (prompt step 2)', () => {
  it('renders §4.4.1 line for line: the title, the `2 of 5 used` tag, the hint, the rows, the add', () => {
    const out = section(DOCK_PAGE_FULL, DOCK_DRAFT)
    expect(out).toContain('Variation specifics')
    expect(out).toContain('2 of 5 used')
    expect(out).toContain('Each shared axis becomes one eBay specific. Drag to set the order buyers pick in. eBay allows up to 5.')
    expect(out).toContain('nds-axes-dockname')
    expect(out).toContain('Add a specific')
    /* ONE count, in the dock's `<h3>`: the panel prints no second one. */
    expect(out.match(/of 5/g) ?? []).toHaveLength(1)   // the dock's tag; the hint says `up to 5.`
  })

  it('is the SAME component — the panel class the cell editor renders is in the dock section', () => {
    /* The assertion that would have failed before the swap: `SpecificsSection` rendered
       `nds-vp-dock-specific` rows of its own and nothing from the engine. */
    const out = section(DOCK_PAGE_FULL, DOCK_DRAFT)
    expect(out).toContain('nds-axes-editor-dock')
    expect(out).toContain('nds-axes-rows')
    expect(out).not.toContain('nds-vp-dock-specific')
  })

  it('carries the per-axis lock and the order refusal from the page into the shared panel', () => {
    const out = section(DOCK_PAGE_FULL, DOCK_DRAFT)
    expect(out).toContain(REASON)
    expect(out).toContain('The order is written in the eBay Variation order editor.')
    const rows = dockRows(out)
    expect(rows[0]).toContain('disabled')      // color IS in lockedAxisKeys
    expect(rows[1]).not.toContain('disabled')  // size is not
  })

  it('holds `+ Add a specific` with the reason when every family axis is already a specific', () => {
    /* VT.4's measurement, now the panel's own: the server lists every family axis in `mapping`, so
       the add list is empty on every coordinate of this catalogue — held, never silently inert. */
    const out = section(DOCK_PAGE_FULL, DOCK_DRAFT)
    expect(out).toContain('Every shared axis is already a specific. Add an axis on the shared product first.')
  })
})


describe('VT.2c — `writableHere: false` with no reason is "we did not look"', () => {
  /* The producer reads the presentation order for eBay ONLY; every other channel gets
     `{ writableHere: false, reason: '' }`. Relaying that as a refusal makes the dock's grips inert on
     Amazon and Shopify with NO sentence — the silent disable, on a host whose own Save does write the
     order. Both arms, in one place. */
  const amazonish = { ...DOCK_PAGE_FULL, locked: null, order: { axes: [], valueOrder: {}, editorUrl: '/x', writableHere: false, reason: '' } }

  it('does NOT relay an unstated order block, so the grips stay live', () => {
    const cell = axesCellFromProjection(amazonish, DOCK_DRAFT)
    expect(cell.order).toEqual({ writableHere: true, reason: '' })
    expect(axesOrderState(cell).writable).toBe(true)
    expect(renderToStaticMarkup(createElement(AxesPanel, { cell, host: 'dock', onChange: () => {} }))).not.toContain('nds-axes-ordernote')
  })

  it('DOES relay a stated refusal — the discriminating arm', () => {
    const cell = axesCellFromProjection({ ...DOCK_PAGE_FULL, locked: null }, DOCK_DRAFT)
    expect(cell.order).toEqual({ writableHere: false, reason: 'The order is written in the eBay Variation order editor.' })
    expect(axesOrderState(cell).writable).toBe(false)
  })
})

/* 🔴 VT.F: this block's rule MOVED, and the two arms below now pin the opposite of what they pinned.
 *
 * VT.2c wrote them to hold a measured fact — the dock's `saveMapping` sent `{ expectedVersion, mapping,
 * split }` and silently dropped a picked theme, so a theme picker in the dock would have been a control
 * whose value its own Save discarded. **R-VT-9 closed that from the other end**: the route has always
 * ACCEPTED `theme` (`product-studio.routes.ts:206,225`), so the fix was to put it in the body — which
 * `projectionDraftFromAxesCell` and `saveMapping` now do — rather than to hide the control.
 *
 * The arms are rewritten, not deleted, because the ORIGINAL hazard still has to be impossible: a theme
 * picker whose value never reaches the PATCH. `projectionDraftFromAxesCell` carrying `theme` is asserted
 * here so that hazard cannot return silently. */
describe('R-VT-9 — the dock host carries the theme picker, and its Save sends the theme', () => {
  const amazonDock = {
    ...DOCK_PAGE_FULL,
    coordinate: { ...DOCK_PAGE_FULL.coordinate, channel: 'AMAZON', channelLabel: 'Amazon', label: 'Amazon · IT' },
    theme: { value: 'COLOR_NAME/SIZE_NAME', options: [{ code: 'COLOR_NAME/SIZE_NAME', label: 'Colore / Taglia' }, { code: 'COLOR_NAME', label: 'Colore' }] },
    locked: null,
    order: { axes: [], valueOrder: {}, editorUrl: '/x', writableHere: false, reason: '' },
  }

  it('shows the theme picker in the dock when the WIRE carries a theme enum', () => {
    const cell = axesCellFromProjection(amazonDock, DOCK_DRAFT)
    expect(cell.candidates?.kind).toBe('theme-enum')
    const dock = renderToStaticMarkup(createElement(AxesPanel, { cell, host: 'dock', onChange: () => {} }))
    expect(dock).toContain(AXES_EDITOR_COPY.theme)
    expect(dock).toContain('COLOR_NAME/SIZE_NAME')
    /* Both hosts, one control (design §3.5's last clause, D-VT4). */
    expect(panel(GALE_AMAZON_DE_DERIVED, 'cell')).toContain(AXES_EDITOR_COPY.theme)
    expect(panel(GALE_AMAZON_DE_DERIVED, 'dock')).toContain(AXES_EDITOR_COPY.theme)
  })

  it('🔴 the picked theme REACHES the draft, so the dock save cannot discard it silently', () => {
    const cell = axesCellFromProjection(amazonDock, DOCK_DRAFT)
    const draft: { theme?: string | null } = projectionDraftFromAxesCell(
      { ...cell, theme: { code: 'SIZE/COLOR', label: 'Taglia / Colore', deprecated: false } },
      { ...DOCK_DRAFT, theme: undefined as string | null | undefined },
    )
    expect(draft.theme).toBe('SIZE/COLOR')
  })

  it('🔴 and on a NON-theme-enum coordinate the draft carries NO `theme` key at all', () => {
    /* An explicit `null` in the PATCH body means "clear the theme". An eBay or Shopify reorder must not
       send one, so the key has to be ABSENT rather than null — `in` is the assertion, not `=== undefined`,
       because `JSON.stringify` drops an undefined value but `{theme: undefined}` still fails a caller that
       spreads with `'theme' in draft`. */
    const ebay = axesCellFromProjection(DOCK_PAGE_FULL, DOCK_DRAFT)
    expect(ebay.candidates?.kind).not.toBe('theme-enum')
    expect('theme' in projectionDraftFromAxesCell(ebay, DOCK_DRAFT)).toBe(false)
  })

  it('🔴 an Amazon coordinate whose schema could not be read keeps the ASPECT control, not an empty picker', () => {
    /* The guard is the WIRE carrying options, never `channel === 'AMAZON'`: R-VT-7's whole point is that an
       empty list is not a fact about the channel. */
    const noSchema = { ...amazonDock, theme: { value: null, options: [] } }
    const cell = axesCellFromProjection(noSchema, DOCK_DRAFT)
    expect(cell.candidates?.kind).toBe('aspects')
    expect(renderToStaticMarkup(createElement(AxesPanel, { cell, host: 'dock', onChange: () => {} }))).not.toContain(AXES_EDITOR_COPY.theme)
  })

  it('🔴 R-VT-7 — an EMPTY target list never reads `ok`, and `undefined` from an older server is not `ok` either', () => {
    const bare = { ...DOCK_PAGE_FULL, targetOptions: [], freeform: false, theme: null }
    expect(axesCellFromProjection(bare, DOCK_DRAFT).candidates?.state).toBe('unavailable')
    const said = { ...bare, targetOptionsState: 'no-theme' as const, targetOptionsReason: 'SUIT declares no variation theme on IT.' }
    const cell = axesCellFromProjection(said, DOCK_DRAFT)
    expect(cell.candidates?.state).toBe('no-theme')
    expect(cell.candidates?.unavailableReason).toBe('SUIT declares no variation theme on IT.')
    /* positive control in the same test: a POPULATED list still reads `ok`. */
    expect(axesCellFromProjection(DOCK_PAGE_FULL, DOCK_DRAFT).candidates?.state).toBe('ok')
  })

  it('keeps `+ Add a theme` in the dock on Amazon (it adds a FAMILY axis, as VP.4 section did)', () => {
    const cell = axesCellFromProjection(amazonDock, DOCK_DRAFT)
    expect(renderToStaticMarkup(createElement(AxesPanel, { cell, host: 'dock', onChange: () => {} }))).toContain('nds-axes-add')
  })

  it('🔴 and the grips are NOT live on Amazon: the THEME fixes the segment order (design §3.5)', () => {
    /* This arm is the reverse of VT.2c's, and the reversal is a MEASUREMENT, not a preference: VT.F sent
       a reorder PATCH to `VX-TEST-3AX` AMAZON·IT, got 200 with the version 6 → 7, and the 8 s read-back
       served the ORIGINAL order. Live grips on Amazon were a control whose effect nothing stored.
       🔴 Its CAUSE has since changed and the arm has not: R-VT-13 (VT.F2) made `variationMapping` ORDERED, so
       the order IS stored now and Shopify's grips are live. Amazon's stay held for the reason design §3.5 gives
       and the wire states — the variation THEME fixes the order of its segments — so this expectation is the
       design's, not the storage's. `reference_comment_asserts_property_code_lacks`: the old note claimed a
       property (`a flat map with nowhere to put an order`) the code no longer has. */
    expect(axesOrderState(axesCellFromProjection(amazonDock, DOCK_DRAFT)).writable).toBe(false)
  })
})

/* ── R-VT-8 · the target Listbox's portal container (VT.F item A3) ────────────────────────────────
 *
 * The defect this pins, measured by VT.2c: the DS `Listbox` portals its option panel to
 * `document.body`, so inside an AG popup editor a click on an option is a click OUTSIDE the editor —
 * AG ends the edit and `onChange` never reports. The fix is a DS prop (`Listbox portalTo`) plus this
 * resolver, so no page carries an AG selector of its own.
 *
 * `apps/web` vitest is NODE-ONLY (`reference_test_scoping_and_hidden_assertions`), so the element is
 * injected rather than rendered: what is asserted here is the SELECTOR and the null-safety, and the
 * on-screen arm — a mouse re-point that survives — is in VT.F's screens pass.
 */
describe('R-VT-8 · agPopupHostOf', () => {
  const fake = (match: string | null) => ({
    closest: (selector: string) => (match !== null && selector === AG_POPUP_SELECTOR ? ({ tagName: 'DIV', matched: match } as unknown as Element) : null),
  })

  it('names BOTH AG popup classes, because which one is the ancestor depends on popupParent', () => {
    expect(AG_POPUP_SELECTOR).toBe('.ag-popup-editor, .ag-popup')
  })

  it('returns the AG popup when the panel is inside one', () => {
    expect(agPopupHostOf(fake('.ag-popup-editor'))).not.toBeNull()
  })

  it('returns null in a host with no AG popup — the dock, where document.body is correct', () => {
    expect(agPopupHostOf(fake(null))).toBeNull()
  })

  it('returns null for a ref that has not attached yet, instead of throwing', () => {
    expect(agPopupHostOf(null)).toBeNull()
    expect(agPopupHostOf(undefined)).toBeNull()
  })
})

/* ── A5 · one function feeds both hosts: `lockedAxisKeys` + `addableAxes` on the SHEET cell ───────── */
describe('VT.F A5 · axisLockReason matches an axis across all three of its spellings', () => {
  /* The real payload, copied from the wire (GALE-JACKET eBay·IT, item 257584954808, 2026-09-13):
     `lockedAxisKeys` are the eBay ASPECT names and `axes[].axisKey` is canonical. */
  const cell = {
    axes: [
      { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Colore', target: 'Colore', included: true },
      { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Taglia', target: 'Taglia', included: true },
      { axisKey: 'style', familyKey: 'Stile', label: 'Style', channelName: 'Stile', target: null, included: true },
    ],
    theme: null,
    source: { kind: 'derived' as const, ruleLabel: null, category: null, label: 'Derived from the family axes' },
    candidates: null,
    masterCandidates: null,
    addableAxes: [],
    dropped: [],
    collisions: null,
    locked: {
      reason: 'Live on eBay IT (item 257584954808) — changing the set relists it. Reordering does not.',
      externalId: '257584954808',
      setChangeIs: 'relist' as const,
      orderChangeAllowed: true,
      lockedAxisKeys: ['Colore', 'Taglia'],
    },
    write: null,
    writable: true,
    writeBlockedReason: null,
    vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
    separator: ' · ',
  } as unknown as VariationThemeCell

  it('🔴 matches a CANONICAL axisKey against the channel-spelled published names', () => {
    expect(axisLockReason(cell, 'color')).toContain('257584954808')
    expect(axisLockReason(cell, 'size')).toContain('257584954808')
  })

  it('and leaves an axis that was never published alone — the positive control for the match', () => {
    expect(axisLockReason(cell, 'style')).toBeNull()
  })

  it('an UNLOCKED cell and an EMPTY published list both read null, never the reason', () => {
    expect(axisLockReason({ ...cell, locked: null } as VariationThemeCell, 'color')).toBeNull()
    expect(axisLockReason({ ...cell, locked: { ...cell.locked!, lockedAxisKeys: [] } } as VariationThemeCell, 'color')).toBeNull()
  })

  it('still matches on the FAMILY spelling — the dock host, where axisKey IS the family key', () => {
    const dockShaped = { ...cell, axes: cell.axes.map((a) => ({ ...a, axisKey: a.familyKey })) } as VariationThemeCell
    expect(axisLockReason(dockShaped, 'Colore')).toContain('257584954808')
  })
})


it('held inclusion checkboxes keep their focus and the theme refusal; an editable checkbox remains available', () => {
  const held = [...panel(GALE_AMAZON_DE_DERIVED).matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(m => m[0])
  expect(held.length).toBeGreaterThan(0)
  for (const input of held) {
    expect(input).not.toMatch(/\sdisabled=/)
    expect(input).toContain('aria-disabled="true"')
    expect(input).toContain('aria-description=')
  }
  const editable = [...panel(GALE_SHOPIFY_DROPPED).matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(m => m[0])
  expect(editable.some(input => !input.includes('aria-disabled="true"'))).toBe(true)
})
