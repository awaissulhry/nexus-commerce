import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeEditorParamsLikeAg } from '@/design-system/grid/editors/editorParamsMerge'
import { SlotListEditor } from '@/design-system/grid/editors/SlotListEditor'
import { suppressSlotListKeys } from '@/design-system/grid/editors/slotList'
import { CellSaveTracker, FormulaCellEditor } from '@/design-system/grid'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './master/channelColumns'
import { channelWriteGate } from './channel/rows'
import { sheetViews } from './views'
import {
  acknowledgePendingEdits, defaultViewKeys, expandSlotListKeys, queuePendingEdit, revertPendingEdit, slotFanOut, slotKeysHiddenByDefault,
  slotListKeyOfSlot, slotListRefusal, slotListViewNote, withSlotListColumns, type SlotColumnLike,
} from './slotListColumns'
import type { SheetColumn } from './master/types'

/*
 * Step 4.3 #3 (A-52; R-55, R-56) — the studio half of bullets in one cell: placement, what the sheet shows by default,
 * the one cell's edit leaving as slot writes, and BOTH builders returning the same engine ColDef.
 */
const base = { group: 'Content', groupKey: 'content', kind: 'longtext', storage: 'localizedContent', scope: 'global', requiredBy: [], editable: true, defaultVisible: true }
const slot = (i: number, extra: Record<string, unknown> = {}) => ({ ...base, key: `bulletPoints_${i}`, label: `Bullet ${i}`, writeField: `amazon_bulletPoints[${i}]`,
  maxLength: 700, width: 110, localizable: true, slot: { of: 'bulletPoints', index: i, max: 10, label: 'Bullet Point' }, ...(i === 1 ? { requiredBy: ['Amazon · IT'] } : {}), ...extra })
const plain = (key: string, extra: Record<string, unknown> = {}) => ({ ...base, key, label: key, writeField: key, kind: 'text', ...extra })
const COLUMNS = [plain('name'), ...Array.from({ length: 10 }, (_, i) => slot(i + 1)), plain('description')] as unknown as SheetColumn[]
const TEN_KEYS = Array.from({ length: 10 }, (_, i) => `bulletPoints_${i + 1}`)

describe('withSlotListColumns — one cell, immediately before Bullet 1', () => {
  const out = withSlotListColumns(COLUMNS)
  const cell = out.find(c => c.key === 'slots:bulletPoints') as unknown as SheetColumn & SlotColumnLike
  it('inserts slots:bulletPoints right before bulletPoints_1, in the same group, 240px, and keeps the ten', () => {
    expect(out.map(c => c.key)).toEqual(['name', 'slots:bulletPoints', ...TEN_KEYS, 'description'])
    expect(cell).toMatchObject({ label: 'Bullet points', group: 'Content', groupKey: 'content', width: 240, kind: 'text', formulaWritable: false })
    expect(cell.slotGroup).toEqual({ of: 'bulletPoints', max: 10, keys: TEN_KEYS, maxLength: 700 })
  })
  it('is never a write field (no column writes it, and it writes nothing itself)', () => {
    expect(cell.writeField).toBe('')
    expect(out.some(c => c.writeField === 'slots:bulletPoints')).toBe(false)
  })
  it('is idempotent, and returns the columns untouched without a bullets slot group', () => {
    expect(withSlotListColumns(out)).toBe(out)
    const none = [plain('name'), plain('description')] as unknown as SheetColumn[]
    expect(withSlotListColumns(none)).toBe(none)
  })
  it('bullets only: another slotted list (special_feature 1–5) gets no one-cell', () => {
    const features = Array.from({ length: 5 }, (_, i) => ({ ...plain(`special_feature_${i + 1}`), slot: { of: 'special_feature', index: i + 1, max: 5, label: 'Feature' } }))
    expect(withSlotListColumns(features as unknown as SheetColumn[]).map(c => c.key)).toEqual(features.map(f => f.key))
  })
  it('a group with a missing position gets no one-cell (no honest positional view)', () => {
    const gap = COLUMNS.filter(c => c.key !== 'bulletPoints_7')
    expect(withSlotListColumns(gap).some(c => c.key.startsWith('slots:'))).toBe(false)
  })
  it('Languages view: one cell per language, grouped under the field', () => {
    const langs = Array.from({ length: 10 }, (_, i) => ['it', 'de'].map(l => slot(i + 1, { key: `bulletPoints_${i + 1}@${l}`, locale: l, group: `Bullet ${i + 1}`, groupKey: `language:bulletPoints_${i + 1}` }))).flat()
    const cols = withSlotListColumns(langs as unknown as SheetColumn[])
    const cells = cols.filter(c => c.key.startsWith('slots:'))
    expect(cells.map(c => [c.key, c.locale, c.groupKey])).toEqual([
      ['slots:bulletPoints@it', 'it', 'language:slots:bulletPoints'], ['slots:bulletPoints@de', 'de', 'language:slots:bulletPoints']])
    expect(cols.indexOf(cells[0])).toBe(cols.findIndex(c => c.key === 'bulletPoints_1@it') - 1)
  })
})

describe('R-56 — Bullet 1–10 hidden by default, still reachable', () => {
  const cols = withSlotListColumns(COLUMNS)
  const ordered = cols.map(c => c.key)
  it('hidden = exactly the ten, and only when the one cell exists', () => {
    expect(slotKeysHiddenByDefault(cols)).toEqual(TEN_KEYS)
    expect(slotKeysHiddenByDefault(COLUMNS)).toEqual([])
  })
  it('the landing drops the ten, keeps the order, and never edits the full list it was given', () => {
    const copy = [...ordered]
    expect(defaultViewKeys(ordered, cols)).toEqual(['name', 'slots:bulletPoints', 'description'])
    expect(ordered).toEqual(copy)
    expect(defaultViewKeys(ordered, COLUMNS)).toEqual(ordered)
  })
  it('"All attributes" and Text fields leave the ten out and SAY so; Required keeps Bullet 1', () => {
    const ctx = { locale: 'it', variationAxes: [] }
    const views = sheetViews(cols as never, ctx)
    const all = views.presets.find(p => p.id === 'all')!
    expect(all.columns).toEqual(['name', 'slots:bulletPoints', 'description'])
    expect(all.description).toBe(slotListViewNote(cols))
    expect(all.description).toContain('Bullet 1–10')
    // The Languages view is gone (2026-09-27); Text fields took over its column set.
    expect(views.presets.some(p => p.id === 'languages')).toBe(false)
    const text = views.presets.find(p => p.id === 'localized-content')!
    expect(text.columns).toContain('slots:bulletPoints')
    expect(text.columns.some(k => TEN_KEYS.includes(k))).toBe(false)
    expect(views.presets.find(p => p.id === 'required')!.columns).toContain('bulletPoints_1')
  })
  it('without a one cell, "All attributes" is every column and says so', () => {
    const all = sheetViews(COLUMNS as never, { locale: 'it', variationAxes: [] }).presets.find(p => p.id === 'all')!
    expect(all.columns).toEqual(COLUMNS.map(c => c.key))
    expect(all.description).toBe('Every column this sheet has')
  })
  it('useSheetColumns (source read): orderedKeys stays every column; only the landing sites read landingKeys', () => {
    const src = readFileSync(join(__dirname, 'useSheetColumns.ts'), 'utf8')
    expect(src.length).toBeGreaterThan(1000) // positive control: the reader found the hook
    // Every attribute FIELD (2026-09-27: views work on fields; progress columns are not attributes).
    expect(src).toContain('const orderedKeys = useMemo(() => orderColumnKeys(attributeColumns, fieldCtx), [attributeColumns, fieldCtx])')
    // The landing sites: All attributes picked, landed on, re-resolved, and reloaded without a layout.
    expect(src).toContain("activate(all ? { kind: 'all' } : { kind: 'preset', id: preset.id, label: preset.label }, all ? columnsViewPayload(landingKeys) : presetPayload(preset), false)")
    expect(src).toContain("activate({ kind: 'all' }, columnsViewPayload(landingKeys), false)")
    expect(src).toContain("if (active.kind === 'all') { activate(active, columnsViewPayload(landingKeys), false); return }")
    expect(src).toContain('const payload = hasMyLayout(layout) ? layout : columnsViewPayload(landingKeys)')
    expect(src).not.toContain('columnsViewPayload(orderedKeys)')
    expect(src).not.toMatch(/const orderedKeys = [^\n]*defaultViewKeys/)
  })
})

describe('the one cell\'s edit → one slot dispatch per CHANGED position', () => {
  const old = ['one', 'two', '', 'four', 'five', 'six', '', 'eight', 'nine', 'ten']
  it('one position edited → exactly one dispatch, to that slot, with its old and new text', () => {
    const next = [...old]; next[3] = 'FOUR'
    expect(slotFanOut('slots:bulletPoints', old, next, COLUMNS)).toEqual([{ colId: 'bulletPoints_4', oldValue: 'four', newValue: 'FOUR' }])
  })
  it('a cleared position is a null write; a filled hole reports its old value as null', () => {
    const next = [...old]; next[0] = ''; next[2] = 'three'
    expect(slotFanOut('slots:bulletPoints', old, next, COLUMNS)).toEqual([
      { colId: 'bulletPoints_1', oldValue: 'one', newValue: null }, { colId: 'bulletPoints_3', oldValue: null, newValue: 'three' }])
  })
  it('ten edited → ten dispatches, every one a SLOT column, none the one cell', () => {
    const next = old.map((_, i) => `new ${i}`)
    const out = slotFanOut('slots:bulletPoints', old, next, withSlotListColumns(COLUMNS))!
    expect(out.map(d => d.colId)).toEqual(TEN_KEYS)
    expect(out.some(d => d.colId.startsWith('slots:'))).toBe(false)
  })
  it('untouched → nothing; a column that is not a one cell → null (the ordinary path)', () => {
    expect(slotFanOut('slots:bulletPoints', old, [...old], COLUMNS)).toEqual([])
    expect(slotFanOut('bulletPoints_4', 'a', 'b', COLUMNS)).toBeNull()
  })
  it('a slot knows its one cell (the decline repaint)', () => {
    expect(slotListKeyOfSlot('bulletPoints_5', COLUMNS)).toBe('slots:bulletPoints')
    expect(slotListKeyOfSlot('name', COLUMNS)).toBeNull()
  })
})

describe('the channel adapter wires the one cell (source read — the hook cannot run node-only)', () => {
  const src = readFileSync(join(__dirname, 'channel', 'useChannelSheetAdapter.tsx'), 'utf8')
  it('positive control: the reader found the adapter and its change handler', () => {
    expect(src.length).toBeGreaterThan(10000)
    expect(src.indexOf('const onCellValueChanged = useCallback(')).toBeGreaterThan(0)
  })
  it('the fan-out runs BEFORE the gate (a one cell has no cell of its own, so the gate would block it)', () => {
    const handler = src.indexOf('const onCellValueChanged = useCallback(')
    const fan = src.indexOf('const fanOut = slotFanOut(colId, e.oldValue, e.newValue,', handler)
    const gate = src.indexOf('const gate = channelWriteGate({', handler)
    expect(fan).toBeGreaterThan(handler)
    expect(gate).toBeGreaterThan(fan)
    expect(src).toContain('onCellValueChanged({ data: e.data, colDef: { colId: slot.colId }')
  })
  it('the one cell is in the grid columns, says why when locked, and keeps bullets in the displayed-fields export', () => {
    // P2 — the grid columns come from the read's columns, kept by content (`stableColumns`).
    expect(src).toContain('withSlotListColumns(withProductMediaColumn(stableColumns)')
    expect(src).toContain('const stableColumns = useMemo(() => data?.columns ?? [], [columnsKey])')
    expect(src).toContain('refusalReason.current = (key, row) => isSlotListKey(key) ? slotListRefusal(key, row,')
    expect(src).toContain('visibleFields={expandSlotListKeys(sheetColumns.visibleAttributeKeys(), gridColumns)')
    expect(src).toContain('setPendingWrites(prior => queuePendingEdit(prior, next))')
  })
})

describe('import/export and refusals', () => {
  it('"Attributes displayed in the grid": a visible one cell stands for its list (its first slot → the list field)', () => {
    expect(expandSlotListKeys(['name', 'slots:bulletPoints', 'description'], withSlotListColumns(COLUMNS))).toEqual(['name', 'bulletPoints_1', 'description'])
  })
  it('a locked one cell says the first locked position\'s own reason', () => {
    const reasons: Record<string, string> = { bulletPoints_6: 'Bullet 6 is read-only here' }
    expect(slotListRefusal('slots:bulletPoints', {}, COLUMNS, k => reasons[k] ?? null)).toBe('Bullet 6 is read-only here')
    expect(slotListRefusal('slots:bulletPoints', {}, COLUMNS, () => null)).toBeNull()
  })
})

/* ── both builders ─────────────────────────────────────────────────────────────────────────────── */
const wiring = { exprFor: () => null, errorFor: () => null, candidatesFor: () => [], preview: async () => ({ ok: true }),
  functions: () => [], colIdOfRef: () => null, canEditRow: () => true, unavailableReason: () => null }
const channelDefs = (columns: unknown[]) => buildChannelColumns({
  data: { scope: { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' } },
  gridColumns: columns, formulaWiring: wiring,
  openCellDetails: () => {}, productLevelOnly: false, refusedReasonFor: () => null,
  tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] },
  mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
} as unknown as BuildChannelColumnsOptions) as unknown as Array<Record<string, any>>
const masterDefs = (columns: unknown[], withFormulaWiring = true) =>
  buildMasterColumns({ columns: columns as SheetColumn[], tracker: new CellSaveTracker(), locale: 'it', ...(withFormulaWiring ? { formula: wiring as never } : {}) }, { current: [] }) as Array<Record<string, any>>
const ENGINE_KEYS = ['colId', 'cellEditor', 'cellEditorPopup', 'cellEditorParams', 'cellEditorSelector', 'suppressKeyboardEvent', 'suppressFillHandle', 'cellDataType', 'width', 'headerName']

describe('builder parity — both builders return the SAME engine ColDef for the one cell', () => {
  const cols = withSlotListColumns(COLUMNS)
  const channel = channelDefs(cols).find(d => d.colId === 'slots:bulletPoints')!
  const master = masterDefs(cols).find(d => d.colId === 'slots:bulletPoints')!
  it('the channel builder returns the engine def: SlotListEditor, the selector cleared, fill handle off', () => {
    expect(channel.cellEditor).toBe(SlotListEditor)
    expect('cellEditorSelector' in channel).toBe(true)
    expect(channel.cellEditorSelector).toBeUndefined()
    expect(channel.suppressFillHandle).toBe(true)
    expect(channel.suppressKeyboardEvent).toBe(suppressSlotListKeys)
  })
  it('the master builder returns the same engine pieces', () => {
    for (const key of ENGINE_KEYS) expect([key, master[key]]).toEqual([key, channel[key]])
    expect(Object.keys(master).sort()).toEqual(Object.keys(channel).sort())
  })
  it('neither builder emits a one cell without a slot group', () => {
    expect(channelDefs(COLUMNS).some(d => String(d.colId).startsWith('slots:'))).toBe(false)
    expect(masterDefs(COLUMNS).some(d => String(d.colId).startsWith('slots:'))).toBe(false)
  })
  it('channel: a position edited in the one cell is written exactly as a typed slot (pinned on this listing)', () => {
    const row = { rowId: 'r1', id: 'p1', rowKind: 'variant', productType: 'COAT', values: Object.fromEntries(TEN_KEYS.map((k, i) => [k, { value: `b${i + 1}`, editable: true, layer: 'master', pinned: false, inherited: true }])) } as any
    const next = TEN_KEYS.map((_, i) => `b${i + 1}`); next[1] = 'B2'
    expect(channel.valueSetter({ data: row, newValue: next })).toBe(true)
    expect(row.values.bulletPoints_2).toMatchObject({ value: 'B2', layer: 'aliasVariant', pinned: true, inherited: false })
    expect(row.values.bulletPoints_3).toMatchObject({ value: 'b3', inherited: true })
    expect(channel.valueGetter({ data: row })).toEqual(next)
  })
})

describe('Shared bullets — the same editor in list mode', () => {
  const bullets = { ...plain('bulletPoints', { label: 'Bullet points', shape: 'list', cardinality: { min: 0, max: null } }) }
  const asAgOpens = (def: Record<string, any>, eventKey: string | null) => {
    const spec = def.cellEditorSelector({ data: { id: 'p1', values: {} }, eventKey })
    const params: Record<string, unknown> = {}
    mergeEditorParamsLikeAg(params, def.cellEditorParams)
    mergeEditorParamsLikeAg(params, (spec.params ?? null) as never)
    return { component: spec.component, params }
  }
  it('opens SlotListEditor in list mode, its settings namespaced, the two key rules combined', () => {
    for (const key of ['bulletPoints', 'bulletPoints@de']) {
      const [def] = masterDefs([{ ...bullets, key, ...(key.includes('@') ? { locale: 'de' } : {}) }])
      expect(def.cellEditor).toBe(SlotListEditor)
      expect(def.cellEditorParams).toEqual({ slotList: { mode: 'list', max: null, maxLength: null, itemLabel: 'Bullet', label: 'Bullet points' } })
      expect(def.suppressKeyboardEvent).not.toBe(suppressSlotListKeys)
    }
  })
  it('after AG merges the column params: `=` still opens the formula editor with formulas ON; a letter opens the bullets form', () => {
    const [def] = masterDefs([bullets])
    const eq = asAgOpens(def, '=')
    expect(eq.component).toBe(FormulaCellEditor)
    expect(eq.params.formulas).toBe(true)
    const typed = asAgOpens(def, 'a')
    expect(typed.component).not.toBe(FormulaCellEditor)
    expect((typed.params.fallback as { component: unknown }).component).toBe(SlotListEditor)
    expect(typed.params.slotList).toMatchObject({ mode: 'list' })
  })
  it('without formula wiring (the Variants page) the bullets form is the column editor, no selector', () => {
    const [def] = masterDefs([bullets], false)
    expect(def.cellEditor).toBe(SlotListEditor)
    expect(def.cellEditorSelector).toBeUndefined()
  })
})

/* ── LX.14 — each changed following bullet queues its OWN choice (today's mechanism, kept) ──────────── */
describe('two changed bullets that follow shared text → two queued choices; a decline reverts only its own slot', () => {
  it('queues two pending edits through the real gate and reducer, and declining the first leaves the second', () => {
    const cols = withSlotListColumns(COLUMNS)
    const oneCell = channelDefs(cols).find(d => d.colId === 'slots:bulletPoints')!
    const choice = { shared: { label: 'Edit the shared Italian text', address: { tier: 'language', language: 'it' } }, pin: { label: 'Pin on this listing', address: { tier: 'pin' } }, reach: ['Amazon · IT'] }
    const row = { rowId: 'r1', id: 'p1', rowKind: 'variant', productType: 'COAT',
      values: Object.fromEntries(TEN_KEYS.map((k, i) => [k, { value: `b${i + 1}`, editable: true, writable: true, contentAcknowledgement: choice, contentAddress: null, writeField: `amazon_bulletPoints[${i + 1}]` }])) } as any
    const before = oneCell.valueGetter({ data: row })
    const after = [...before]; after[1] = 'NEW 2'; after[4] = 'NEW 5'
    expect(oneCell.valueSetter({ data: row, newValue: after })).toBe(true)
    const dispatches = slotFanOut('slots:bulletPoints', before, oneCell.valueGetter({ data: row }), cols)!
    expect(dispatches.map(d => d.colId)).toEqual(['bulletPoints_2', 'bulletPoints_5'])
    let queue: Array<{ rowId: string; colId: string; value: unknown; row: any; previous: unknown }> = []
    for (const d of dispatches) {
      expect(channelWriteGate({ colId: d.colId, source: 'edit', selfInflicted: false, cell: row.values[d.colId], acknowledged: false })).toBe('acknowledge')
      queue = queuePendingEdit(queue, { rowId: row.rowId, colId: d.colId, value: d.newValue, row, previous: d.oldValue })
    }
    expect(queue.map(q => q.colId)).toEqual(['bulletPoints_2', 'bulletPoints_5'])
    // Decline the head: only bullet 2 goes back; bullet 5 keeps its new text and still awaits its own choice.
    revertPendingEdit(queue[0])
    queue = queuePendingEdit(queue, null)
    expect(row.values.bulletPoints_2.value).toBe('b2')
    expect(row.values.bulletPoints_5.value).toBe('NEW 5')
    expect(queue.map(q => q.colId)).toEqual(['bulletPoints_5'])
  })
})

/* ── P1 (report 2 I-7) — a pasted column asks ONCE: the answer applies to every queued edit ─────────────────────── */
describe('one answer for the whole paste', () => {
  const choice = { shared: { label: 'Edit the shared Italian', address: { tier: 'source' } }, pin: { label: 'Pin on eBay · IT · it', address: { tier: 'pin', language: 'it' } }, reach: ['eBay · IT (it)'] }
  const edit = (id: string, over: Record<string, unknown> = {}) => {
    const row = { values: { name: { value: 'Pasted', contentAcknowledgement: choice, contentAddress: null, ...over } } } as any
    return { rowId: id, colId: 'name', value: 'Pasted', row, previous: 'Before' }
  }
  it('"Pin" pins all three pasted titles, each at its own cell’s pin address', () => {
    const queue = [edit('a'), edit('b'), edit('c')]
    const { apply, keep } = acknowledgePendingEdits(queue, 'pin')
    expect(apply.map(e => e.rowId)).toEqual(['a', 'b', 'c'])
    expect(keep).toEqual([])
    for (const e of apply) expect(e.row.values.name).toMatchObject({ contentAddress: { tier: 'pin', language: 'it' }, contentAcknowledged: true })
  })
  it('"Shared" takes a shared-record write too; "Pin" leaves it for its own question (it has no pin)', () => {
    const master = edit('m', { contentAcknowledgement: null, affectsAllChannels: true })
    expect(acknowledgePendingEdits([edit('a'), master], 'shared').apply.map(e => e.rowId)).toEqual(['a', 'm'])
    const pinned = acknowledgePendingEdits([edit('a'), edit('m', { contentAcknowledgement: null, affectsAllChannels: true })], 'pin')
    expect(pinned.apply.map(e => e.rowId)).toEqual(['a'])
    expect(pinned.keep.map(e => e.rowId)).toEqual(['m'])
  })
  it('the adapter sends the answered edits as ONE save and asks nothing more (source contract)', () => {
    const adapter = readFileSync(join(__dirname, 'channel', 'useChannelSheetAdapter.tsx'), 'utf8')
    expect(adapter).toContain('const { apply, keep } = acknowledgePendingEdits(pendingWrites, tier);')
    expect(adapter).toMatch(/writer\.beginOperation\(\);\s*try \{\s*for \(const edit of apply\)/)
  })
})
