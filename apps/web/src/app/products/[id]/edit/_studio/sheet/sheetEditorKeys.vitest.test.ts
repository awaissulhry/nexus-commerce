/**
 * P3 guardrail 0 (2026-09-30) — every popup editor the product sheet can mount commits on Enter and on Tab, through a path
 * AG cannot pre-empt.
 *
 * The defect (measured in production 2026-09-29, fixed in P0): Enter and Tab closed every list with its OLD value. AG's
 * popup listener ends the edit with whatever the editor last reported, and it runs BEFORE React's bubble handlers, where the
 * list chose. The 105 tests on that path were green: they called `onCommit` themselves, or read a function's presence.
 *
 * THIS FILE, in two halves:
 *   1. The editors are ENUMERATED from the sheet's two column builders (`buildMasterColumns`, `buildChannelColumns`), not
 *      listed by hand: a synthetic column of every kind, shape and special key is built through both, and every editor
 *      their static `cellEditor` or `cellEditorSelector` can return is collected (formula wiring on and off, `=` typed,
 *      formulas unavailable). An editor with no case below FAILS, so a new editor cannot ship without one.
 *   2. Each editor is MOUNTED for real (the editor, the DS panel inside it, everything below it; `sheetEditorHarness.ts`),
 *      the operator's choice is made through its own handlers, and Enter or Tab is replayed in the browser's order around
 *      AG's listener: capture handlers → AG (unless the column's `suppressKeyboardEvent` hands the key over) → bubble.
 *      The assertion is on what the GRID ends the edit with, not on what a handler was called with.
 *
 * A case may be `na` with a reason: an editor that never holds a value (it hands off to a dialog, or only explains).
 * Prove-by-removal (P3 report): with `onKeyDownCapture` taken off `ListboxPanel`, the SelectPanelEditor and MeasureEditor
 * cases fail on Enter and Tab.
 */
import * as React from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ag = vi.hoisted(() => ({ lifecycle: {} as { isCancelAfterEnd?: () => boolean } }))
vi.mock('react', async (original) => (await import('./sheetEditorHarness')).mockedReact(await original<Record<string, unknown>>()))
vi.mock('ag-grid-react', () => ({ useGridCellEditor: (callbacks: { isCancelAfterEnd?: () => boolean }) => { Object.assign(ag.lifecycle, callbacks) } }))

/* The DS primitives render as the host element they wrap, so the editors' own handlers and refs land on nodes the harness
   can target. `TagInput` stays real: the list editor's free-text draft path runs through it. */
vi.mock('@/design-system/primitives', async (original) => {
  const real = await original<Record<string, unknown>>()
  const { createElement, forwardRef } = await import('react')
  const host = (tag: string) => forwardRef((props: Record<string, unknown>, ref) => {
    const { leadingIcon, trailingIcon, size, variant, tone, asChild, ...rest } = props
    if (asChild) return props.children as React.ReactElement
    return createElement(tag, { ...rest, ref })
  })
  const wrap = ({ children }: { children?: React.ReactNode }) => createElement('span', null, children)
  return {
    ...real,
    Input: host('input'), Textarea: host('textarea'), Select: host('select'), Button: host('button'), ToolbarButton: host('button'),
    TooltipPortalProvider: ({ children }: { children?: React.ReactNode }) => children, InfoTip: wrap, Spinner: wrap, Tag: wrap,
    AxisChip: wrap, MappingChip: wrap,
  }
})
// Next's router context is not mounted here; the category editor's "Manage categories" link only needs to render.
vi.mock('@/lib/workspaces/Link', async () => {
  const { createElement, forwardRef } = await import('react')
  return { default: forwardRef((props: Record<string, unknown>, ref) => createElement('a', { ...props, ref })) }
})
vi.mock('./referenceOptions', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadReferenceChoices: async () => ({
    options: [{ value: 'theme_a', label: 'Theme A' }, { value: 'theme_b', label: 'Theme B' }, { value: 'theme_c', label: 'Theme C' }],
    labels: { theme_a: 'Theme A', theme_b: 'Theme B', theme_c: 'Theme C' },
  }),
}))
vi.mock('./categoryOptions', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The channel's search, as the API answers it: the categories whose name matches the query.
  loadCategoryOptions: async (_channel: string, _market: string, query: string) =>
    [{ value: '9001', label: 'Coats' }, { value: '9002', label: 'Cowls' }, { value: '9003', label: 'Capes' }].filter((o) => o.label.toLowerCase().includes(query.toLowerCase())),
}))
vi.mock('./ebayPolicies', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadEbayPolicies: async () => ({
    fulfillmentPolicies: [{ id: 'fp_1', name: 'Courier' }, { id: 'fp_2', name: 'Post' }],
    returnPolicies: [{ id: 'rp_1', name: '30 days' }], paymentPolicies: [{ id: 'pp_1', name: 'Managed' }],
  }),
}))

import { editSession, fakeDocument, gridKey, harnessGlobals, mount, type EditSession, type HostNode, type Mounted } from './sheetEditorHarness'
import { mergeEditorParamsLikeAg } from '@/design-system/grid/editors/editorParamsMerge'
import { CellSaveTracker } from '@/design-system/grid'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './master/channelColumns'
import type { SheetColumn } from './master/types'

/* ── 1. the editors the builders can mount ─────────────────────────────────────────────────────────────────── */

const LONG = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima']
const col = (key: string, extra: Record<string, unknown> = {}) => ({
  key, label: key, writeField: key, group: 'Details', groupKey: 'details', kind: 'text', storage: 'column', scope: 'global',
  requiredBy: [], editable: true, defaultVisible: true, width: 180, ...extra,
})
/** One column per branch of the editor decision tree in both builders. */
const COLUMNS = [
  col('title'), col('description', { kind: 'longtext' }), col('price', { kind: 'number' }), col('fixedCode', { formulaWritable: false }),
  col('longNote', { kind: 'longtext', formulaWritable: false }), col('count', { kind: 'number', formulaWritable: false }),
  col('size', { kind: 'select', options: LONG, mode: 'strict' }), col('fit', { kind: 'select', options: ['Slim', 'Regular', 'Loose'], mode: 'strict' }),
  col('brand', { kind: 'select', options: LONG, mode: 'open' }), col('waterproof', { kind: 'boolean' }),
  col('colours', { shape: 'list', options: LONG }), col('keywords', { shape: 'list' }),
  col('weight', { kind: 'number', shape: 'measure', unitOptions: ['kg', 'g', 'lb'] }),
  col('protection', { kind: 'text', validation: { recordFields: [{ key: 'zone', label: 'Zone' }, { key: 'level', label: 'Level', kind: 'select', options: [{ value: '1', label: '1' }, { value: '2', label: '2' }] }] } }),
  col('impactProtectors'), col('descriptionThemeId'), col('bulletPoints', { shape: 'list', kind: 'longtext' }),
  col('variation_theme', { kind: 'variationTheme', shape: 'axes' }),
  col('categoryId'), col('productType'), col('taxonomy_id', { kind: 'number' }), col('fulfillmentPolicyId'),
  ...Array.from({ length: 3 }, (_, i) => col(`bulletPoints_${i + 1}`, { kind: 'longtext', slot: { of: 'bulletPoints', index: i + 1, max: 3, label: 'Bullet' } })),
  col('slots:bulletPoints', { slotGroup: { of: 'bulletPoints', max: 3, keys: ['bulletPoints_1', 'bulletPoints_2', 'bulletPoints_3'], maxLength: 500 }, formulaWritable: false }),
  col('shopifyTitle', { shopifyField: { id: 'title', type: 'single_line_text_field' } }),
  col('productMedia', { formulaWritable: false }),
] as unknown as SheetColumn[]

const wiring = (unavailable = false) => ({
  exprFor: () => null, errorFor: () => null, candidatesFor: () => [], preview: async () => ({ ok: true }), functions: () => [],
  colIdOfRef: () => null, canEditRow: () => true, unavailableReason: unavailable ? () => 'Loading formulas…' : undefined, retry: () => {},
})
type Def = Record<string, any>
type Spec = { component: unknown; params?: Record<string, unknown>; popup?: boolean }
interface Mountable { editor: unknown; wrapper?: unknown; spec: Spec; def: Def; builder: string; column: string }

const nameOf = (c: unknown): string =>
  typeof c === 'string' ? c : typeof c === 'function' ? (c as { displayName?: string; name: string }).displayName || (c as { name: string }).name
    : (c as { render?: { name?: string }; displayName?: string })?.displayName || (c as { render?: { name?: string } })?.render?.name || String(c)

function editorsOf(def: Def, builder: string, rows: unknown[]): Mountable[] {
  const out: Mountable[] = []
  const add = (spec: Spec) => {
    const params = spec.params as { fallback?: Spec } | undefined
    if (nameOf(spec.component) === 'FormulaAwareEditor' && params?.fallback) out.push({ editor: params.fallback.component, wrapper: spec.component, spec, def, builder, column: def.colId })
    else out.push({ editor: spec.component, spec, def, builder, column: def.colId })
  }
  if (typeof def.cellEditorSelector === 'function') {
    for (const data of rows) for (const eventKey of [null, 'a', '=']) {
      const spec = def.cellEditorSelector({ data, eventKey })
      if (spec) add(spec)
    }
  } else if (def.cellEditor) add({ component: def.cellEditor, params: def.cellEditorParams, popup: def.cellEditorPopup })
  return out
}

function allMountable(): Mountable[] {
  const out: Mountable[] = []
  const masterRow = { id: 'p1', rowId: 'p1', isParent: false, productType: null, values: {} }
  for (const [label, formula] of [['master', wiring()], ['master · formulas loading', wiring(true)], ['master · no formula wiring', undefined]] as const) {
    const defs = buildMasterColumns({ columns: COLUMNS.filter((c) => !c.key.startsWith('bulletPoints_')), tracker: new CellSaveTracker(), locale: 'it', market: 'IT', formula: formula as never }, { current: [] })
    for (const def of defs as Def[]) out.push(...editorsOf(def, label, [masterRow]))
  }
  for (const channel of ['EBAY', 'AMAZON', 'ETSY', 'SHOPIFY'] as const) {
    for (const [label, formula] of [[channel, wiring()], [`${channel} · formulas loading`, wiring(true)]] as const) {
      const defs = buildChannelColumns({
        data: { scope: { channel, marketplace: 'IT', label: `${channel} · IT`, connectionId: 'conn_e2e' } },
        gridColumns: COLUMNS, formulaWiring: formula, accountId: 'conn_e2e', productLevelOnly: false,
        refusedReasonFor: () => null, tracker: new CellSaveTracker(), activeCellsRef: { current: null },
        viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] }, mediaEditor: { open: () => {}, actions: {} },
        shopifyEditor: { open: () => {}, closed: () => {} }, shopifySchema: channel === 'SHOPIFY' ? { fields: [] } : null, auth: { has: () => true },
      } as unknown as BuildChannelColumnsOptions)
      const row = { id: 'p1', rowId: 'p1', rowKind: 'variant', isParent: false, productType: null, values: {} }
      for (const def of defs as Def[]) out.push(...editorsOf(def, label, [row]))
    }
  }
  return out
}

/* ── 2. the cases ──────────────────────────────────────────────────────────────────────────────────────────── */

interface KeyCase {
  /** The stored value the cell opens on (from the mounted spec where the column decides it, e.g. its options). */
  value: unknown | ((spec: Spec) => unknown)
  /** Extra params the builder does not supply (a record column's fields, a slot list's settings). */
  params?: (spec: Spec) => Record<string, unknown>
  /** Loaded choices, debounce timers: whatever must settle before the operator can choose. */
  ready?: (m: Mounted) => Promise<void>
  /** The operator's choice, through the editor's own handlers. Returns what the grid must end the edit with. */
  choose: (m: Mounted, spec: Spec) => unknown | Promise<unknown>
  /** The editor commits the moment the choice is made (a native select): Enter and Tab must not undo it. */
  commitsOnChoice?: boolean
  /** What the column's own setter does to the committed value before it is written (compared after this). */
  normalize?: (value: unknown) => unknown
}
type Case = KeyCase | { na: string }

const labelled = (m: Mounted, label: string) => m.all().find((n) => n.props['aria-label'] === label)
const focusedIn = (m: Mounted): HostNode => {
  const active = fakeDocument.activeElement?.host
  if (active && m.root.el.contains(active.el)) return active
  return m.find((n) => n.type === 'input' || n.type === 'textarea') ?? m.find((n) => n.props.role === 'listbox') ?? m.root.children[0]
}
/** The params the column gave the editor itself — under the formula-aware wrapper they travel as its `fallback`. */
const ownParams = (spec: Spec) =>
  ((nameOf(spec.component) === 'FormulaAwareEditor' ? (spec.params?.fallback as Spec | undefined)?.params : spec.params) ?? {}) as Record<string, unknown>
const optionsOf = (spec: Spec) => ownParams(spec).options as Array<{ value: string }>

const CASES: Record<string, Case> = {
  SelectPanelEditor: {
    value: (spec: Spec) => optionsOf(spec)[0].value,
    // ↓ from the stored value (row 1): row 2. Long lists search (focus stays in the field); short ones move focus.
    choose: (m, spec) => {
      m.press(focusedIn(m), 'ArrowDown')
      return optionsOf(spec)[1].value
    },
  },
  MeasureEditor: {
    value: { value: 10, unit: 'kg' },
    // The unit list is a ListboxPanel inside the editor: ↓ then Enter/Tab must carry the unit.
    choose: (m) => {
      const units = m.find((n) => n.props.role === 'listbox')!
      units.el.focus()
      m.press(units, 'ArrowDown')
      return { value: 10, unit: 'g' }
    },
  },
  ListPanelEditor: {
    value: ['Alpha'],
    choose: (m, spec) => {
      if (optionsOf(spec)?.length) {
        const box = m.all().find((n) => n.type === 'input' && n.props.type === 'checkbox' && n.parent && n.parent.el.textContent.includes('Charlie'))!
        m.change(box, 'on', { checked: true })
        return ['Alpha', 'Charlie']
      }
      // Free text: a typed value not yet a chip is part of the value (the draft), so Enter saves it.
      const field = m.find((n) => n.type === 'input' && n.props.type === 'text')!
      m.change(field, 'Delta')
      return ['Alpha', 'Delta']
    },
  },
  ReferenceSelectEditor: {
    value: 'theme_a',
    ready: (m) => m.flush(),
    choose: (m) => {
      m.change(m.find((n) => n.type === 'input')!, 'Theme B')
      return 'theme_b'
    },
  },
  ChannelCategoryEditor: {
    value: '9001',
    // A search the channel answers after the editor's debounce; its first match is highlighted.
    choose: async (m, spec) => {
      m.change(m.find((n) => n.type === 'input')!, 'Cow')
      await vi.advanceTimersByTimeAsync(300)
      await m.flush()
      // Etsy's taxonomy id is a number in the cell; eBay's category id is text.
      return ownParams(spec).channel === 'ETSY' ? 9002 : '9002'
    },
  },
  EbayPolicyEditor: {
    value: 'fp_1',
    ready: (m) => m.flush(),
    commitsOnChoice: true,
    choose: (m) => {
      m.change(m.find((n) => n.type === 'select')!, 'fp_2')
      return 'fp_2'
    },
  },
  StructuredAttributeEditor: {
    value: [{ zone: 'Back', level: '1' }],
    choose: (m) => {
      m.change(m.find((n) => n.type === 'input')!, 'Shoulder')
      return [{ zone: 'Shoulder', level: '1' }]
    },
  },
  ImpactProtectorsEditor: {
    value: [{ zone: 'Back', standard: 'EN 1621-2', level: '1' }],
    choose: (m) => {
      m.change(labelled(m, 'Protector 1 level')!, '2')
      return [{ zone: 'Back', standard: 'EN 1621-2', level: '2' }]
    },
  },
  SlotListEditor: {
    value: ['First', 'Second'],
    // List mode reports its one trailing empty position; the column's setter drops blanks on write.
    normalize: (value) => (Array.isArray(value) ? value.filter((item) => item !== '') : value),
    choose: (m) => {
      m.change(labelled(m, 'Bullet 2')!, 'Second, edited')
      return ['First', 'Second, edited']
    },
  },
  FormulaCellEditor: {
    value: 'Old',
    choose: (m, spec) => {
      const field = m.find((n) => n.type === 'input' || n.type === 'textarea')!
      const number = ownParams(spec).commitKind === 'number'
      m.change(field, number ? '42' : 'New')
      return number ? 42 : 'New'
    },
  },
  AxesPanelEditor: { na: 'The variation theme editor reports every change through onValueChange (AxesPanelEditor.vitest.test.ts, "AG 36 — reporting and discarding") and owns Tab through suppressAxesPanelKeys; its value is a whole family projection that this harness does not build. The commit sweep also abstains; whole-family axis gestures need a separate browser fixture.' },
  FormulaUnavailableEditor: { na: 'Shown while this cell\'s formula state is loading: a message with Retry and Close. It holds no value and always cancels.' },
  Gateway: { na: 'The Shopify cell: cancels the grid edit on open and hands off to the Shopify value dialog, which owns its keys.' },
  MediaEditorGateway: { na: 'The product media cell: cancels the grid edit on open and hands off to the media dialog, which owns its keys.' },
  agLargeTextCellEditor: { na: 'AG\'s own long-text editor: AG reads its value directly, so nothing sits between the key and the value.' },
  agTextCellEditor: { na: 'AG\'s own text editor (a selector fallback that the studio always replaces with the value editor).' },
  agNumberCellEditor: { na: 'AG\'s own number editor: AG reads its value directly, so nothing sits between the key and the value. The stock Qty and Buffer cells mount it; elsewhere it is a selector fallback the studio replaces with the value editor.' },
}

/* ── 3. the run ────────────────────────────────────────────────────────────────────────────────────────────── */

const MOUNTABLE = (() => {
  // Built once: the builders are pure, and the list is the table of contents for everything below.
  let cached: Mountable[] | null = null
  return () => (cached ??= allMountable())
})()

beforeAll(() => { for (const [name, value] of Object.entries(harnessGlobals)) vi.stubGlobal(name, value) })
beforeEach(() => { for (const key of Object.keys(ag.lifecycle)) delete (ag.lifecycle as Record<string, unknown>)[key] })

/** One mounted editor per (editor, the params its column gives it): distinct specs, not every column that shares one. */
function distinctCases() {
  const seen = new Map<string, Mountable>()
  for (const m of MOUNTABLE()) {
    const params = { ...(typeof m.def.cellEditorParams === 'object' ? m.def.cellEditorParams : {}), ...(m.spec.params ?? {}) } as Record<string, unknown>
    const fallback = params.fallback as Spec | undefined
    const shape = JSON.stringify({
      // Both builders, always: two column builders drift when only one is checked (reference_two_column_builders_drift).
      builder: m.builder.startsWith('master') ? 'master' : 'channel', editor: nameOf(m.editor), wrapped: !!m.wrapper, options: optionsOf(m.spec)?.length ?? 0, allowCustom: params.allowCustom ?? (fallback?.params as Record<string, unknown> | undefined)?.allowCustom,
      commitKind: params.commitKind, multiline: params.multiline, formulas: params.formulas, channel: params.channel, suppress: nameOf(m.def.suppressKeyboardEvent),
    })
    if (!seen.has(shape)) seen.set(shape, m)
  }
  return [...seen.values()]
}

async function open(m: Mountable, key: KeyCase): Promise<{ mounted: Mounted; session: EditSession }> {
  const value = typeof key.value === 'function' ? (key.value as (spec: Spec) => unknown)(m.spec) : key.value
  const session = editSession(value, {}, ag.lifecycle)
  const staticParams = typeof m.def.cellEditorParams === 'function' ? m.def.cellEditorParams(session.params) : m.def.cellEditorParams
  // AG's own order: grid params ← the column's cellEditorParams ← the selector's params.
  const params: Record<string, unknown> = { ...session.params }
  mergeEditorParamsLikeAg(params, staticParams ?? {})
  mergeEditorParamsLikeAg(params, m.spec.params ?? {})
  Object.assign(params, key.params?.(m.spec) ?? {})
  session.params = params
  const component = (m.wrapper ?? m.editor) as React.ElementType
  const mounted = mount(React.createElement(component, params))
  await key.ready?.(mounted)
  return { mounted, session }
}

describe('the sheet mounts only editors this file has a case for', () => {
  it('both builders, every branch: each editor has a key case or a written reason', () => {
    const missing = [...new Set(MOUNTABLE().filter((m) => !(nameOf(m.editor) in CASES)).map((m) => `${nameOf(m.editor)} (${m.builder} · ${m.column})`))]
    expect(missing, 'A popup editor the sheet can mount has no Enter/Tab case in sheetEditorKeys.vitest.test.ts').toEqual([])
  })
  it('the enumeration reaches the editors that carry a choice (a builder change that hides one fails here)', () => {
    const names = new Set(MOUNTABLE().map((m) => nameOf(m.editor)))
    for (const expected of ['SelectPanelEditor', 'MeasureEditor', 'ListPanelEditor', 'ReferenceSelectEditor', 'ChannelCategoryEditor', 'EbayPolicyEditor',
      'StructuredAttributeEditor', 'ImpactProtectorsEditor', 'SlotListEditor', 'FormulaCellEditor', 'AxesPanelEditor']) expect(names).toContain(expected)
  })
})

describe.each(['Enter', 'Tab'] as const)('%s commits the operator\'s choice, whatever AG does first', (key) => {
  const cases = () => distinctCases().filter((m) => !('na' in (CASES[nameOf(m.editor)] ?? { na: '' })))
  it.each(distinctCases().filter((m) => !('na' in (CASES[nameOf(m.editor)] ?? { na: '' }))).map((m) => [
    `${nameOf(m.editor)}${m.wrapper ? ' (inside the formula-aware wrapper)' : ''} · ${m.builder} · ${m.column}`, m,
  ]))('%s', async (_label, m) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const keyCase = CASES[nameOf(m.editor)] as KeyCase
      const { mounted, session } = await open(m, keyCase)
      const expected = await keyCase.choose(mounted, m.spec)
      expect(expected, 'the case chose nothing').not.toBeUndefined()
      let ended = gridKey(mounted, session, focusedIn(mounted), key, m.def.suppressKeyboardEvent)
      // Tab may walk the editor's own fields first (bullets, value → unit); Tab past the last one must end the edit.
      for (let walk = 0; key === 'Tab' && !ended && walk < 12; walk++) ended = gridKey(mounted, session, focusedIn(mounted), key, m.def.suppressKeyboardEvent)
      expect(ended, `${key} did not end the edit`).not.toBeNull()
      expect(ended!.cancel, `${key} cancelled the edit`).toBe(false)
      expect(keyCase.normalize ? keyCase.normalize(ended!.value) : ended!.value).toEqual(expected)
      if (!keyCase.commitsOnChoice) expect(session.reported.length, 'the editor reported its choice through onValueChange').toBeGreaterThan(0)
      mounted.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
  it('covers at least one mounted case per editor with a choice', () => {
    expect(new Set(cases().map((m) => nameOf(m.editor))).size).toBeGreaterThanOrEqual(10)
  })
})
