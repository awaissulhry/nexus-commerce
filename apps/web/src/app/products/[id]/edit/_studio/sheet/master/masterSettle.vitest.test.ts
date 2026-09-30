import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { commitMasterRow, type MasterCommitContext } from './masterWrite'
import { masterRowSettle, planMasterSettle, type MasterSettle } from './masterSettle'
import { rememberPriorCell } from '../sheetUndo'
import type { SheetColumn, StudioCellValue, StudioRow, StudioSheet } from './types'

/**
 * Audit B27 — a confirmed Master save used to read the whole sheet again (every row replaced, every column rebuilt:
 * bulk-save → GET /studio/sheet → GET /readiness per edit). The answer now settles the saved cell in place when it
 * describes the result, and the sheet reads once only when it cannot (a reset, a family row, a content cell…).
 */
const col = (key: string, over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key, label: key, group: 'g', requiredBy: [], storage: 'categoryAttributes', writeField: key, kind: 'text', scope: 'per_variant', ...over }) as SheetColumn
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue =>
  ({ value: 'Nero', source: 'variant', inheritedFrom: null, inherited: false, layer: 'variant', pinned: true, editable: true, writeField: 'attr_colour', writeTarget: 'master', ...over }) as StudioCellValue
const completeness = (optionalMissing: string[] = [], requiredMissing: string[] = []) => ({
  overall: { filled: 8, total: 10, pct: 80 },
  required: { filled: 5, total: 5 + requiredMissing.length, missing: requiredMissing.map(key => ({ key, label: key })) },
  optional: { filled: 3, total: 5, missing: optionalMissing.map(key => ({ key, label: key })) },
})
const variation = (values: Record<string, StudioCellValue>, over: Partial<StudioRow> = {}) =>
  ({ id: 'v1', sku: 'GALE-L', parentId: 'p1', isParent: false, childCount: 0, version: 3, values, completeness: completeness(), readiness: { state: 'ready', issues: [] }, ...over }) as unknown as StudioRow
const ok = { updated: 1, currentVersion: 4, versionOf: 'product', errors: [] }
const plan = (row: StudioRow, body: unknown = ok, change: { colId?: string; value?: unknown; intent?: string } = {}, column = col('attr_colour')): MasterSettle =>
  planMasterSettle({ row, body, column: key => (key === column.key ? column : undefined),
    changes: [{ colId: change.colId ?? column.key, field: column.writeField ?? column.key, value: 'value' in change ? change.value : 'Rosso', intent: change.intent ?? 'set' }] })
/** The cell as the value setter leaves it: a new object that remembers the one it replaced. */
const typed = (previous: StudioCellValue, value: unknown) => { const next = { ...previous, value, inherited: false, pinned: true, layer: 'variant' as const }; rememberPriorCell(next, previous); return next }

describe('planMasterSettle — which Master saves settle in place', () => {
  it('a variation’s own value, typed over its own value: patched, nothing to read', () => {
    const row = variation({ attr_colour: typed(cell(), 'Rosso') })
    expect(plan(row).kind).toBe('patch')
  })

  it('a first value in an optional field: patched, and the row’s progress moves by one exactly as the server counts it', () => {
    const row = variation({ attr_colour: typed(cell({ value: null, inherited: false, pinned: false }), 'Rosso') }, { completeness: completeness(['attr_colour']) } as never)
    const p = plan(row)
    expect(p.kind).toBe('patch')
    if (p.kind === 'patch') p.apply()
    expect(row.completeness.optional?.missing).toEqual([])
    expect(row.completeness.overall).toEqual({ filled: 9, total: 10, pct: 90 })
  })

  it.each<[string, () => MasterSettle]>([
    ['a reset (A04: only a read knows what it inherits)', () => plan(variation({ attr_colour: cell() }), ok, { intent: 'reset', value: null })],
    ['a clear', () => plan(variation({ attr_colour: typed(cell(), null) }), ok, { value: null })],
    ['a family row with variations', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }, { isParent: true, parentId: null, childCount: 3 } as never))],
    ['a content cell (other languages fall back to it)', () => plan(variation({ attr_colour: typed(cell({ tier: 'source' } as never), 'Rosso') }))],
    ['a language column', () => plan(variation({ 'title@de': typed(cell(), 'Rosso') }), ok, { colId: 'title@de' }, col('title@de', { locale: 'de' }))],
    ['a formula cell', () => plan(variation({ attr_colour: typed(cell({ formula: 'upper($brand)' } as never), 'Rosso') }))],
    ['the product type', () => plan(variation({ productType: typed(cell(), 'JACKET') }), ok, { colId: 'productType' }, col('productType'))],
    ['a required field filled', () => plan(variation({ attr_colour: typed(cell({ value: null }), 'Rosso') }, { completeness: completeness([], ['attr_colour']) } as never))],
    ['a count that disagrees with the cell', () => plan(variation({ attr_colour: typed(cell({ value: 'Nero' }), 'Rosso') }, { completeness: completeness(['attr_colour']) } as never))],
    ['an issue the row names on the column', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }, { readiness: { state: 'errors', issues: [{ key: 'attr_colour', label: 'Colour', message: 'Off the list', severity: 'error' }] } } as never))],
    ['a refused cell in the answer', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }), { ...ok, errors: [{ id: 'v1', field: 'attr_colour', error: 'no' }] })],
    ['a warning on the value', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }), { ...ok, warnings: [{ id: 'v1', field: 'attr_colour', warning: 'Over the limit' }] })],
    ['a value equal to the stored one', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }), { ...ok, updated: 0, unchanged: 1 })],
    ['a cascade', () => plan(variation({ attr_colour: typed(cell(), 'Rosso') }), { ...ok, cascadeCount: 1 })],
  ])('reads the sheet once for %s', (_name, run) => {
    expect(run().kind).toBe('read')
  })
})

describe('masterRowSettle — every sent cell must be covered', () => {
  it('a part that reports nothing (the variation theme) makes the row read', () => {
    const save = masterRowSettle([{ colId: 'attr_colour' }, { colId: 'variation_theme' }])
    save.onStored(['attr_colour'], { kind: 'patch', apply: () => undefined })
    expect(save.inPlace(true)).toBeNull()
  })
  it('a refused save never settles in place', () => {
    const save = masterRowSettle([{ colId: 'attr_colour' }])
    save.onStored(['attr_colour'], { kind: 'patch', apply: () => undefined })
    expect(save.inPlace(false)).toBeNull()
  })
})

describe('commitMasterRow — reports how each stored part settles', () => {
  const sheet = { scope: { kind: 'master' }, columns: [col('attr_colour')] } as unknown as StudioSheet
  const ctx = (onStored: MasterCommitContext['onStored'], body: unknown): MasterCommitContext => ({ sheet, opts: {}, locale: 'it', market: 'IT', onStored,
    bulkSend: async () => ({ status: 200, ok: true, json: async () => body }) })
  it('a plain value on a variation: settled in place from the answer (no follow-up read)', async () => {
    const row = variation({ attr_colour: typed(cell(), 'Rosso') })
    const save = masterRowSettle([{ colId: 'attr_colour' }])
    const result = await commitMasterRow({ rowId: 'v1', row, cells: [{ colId: 'attr_colour', value: 'Rosso', intent: 'set' }], expectedVersion: 3 }, ctx((ids, p) => save.onStored(ids, p), ok))
    expect(result).toMatchObject({ ok: true, version: 4 })
    expect(save.inPlace(result.ok)).toEqual(['attr_colour'])
  })
  it('a reset: one follow-up read', async () => {
    const row = variation({ attr_colour: cell() })
    const save = masterRowSettle([{ colId: 'attr_colour' }])
    const result = await commitMasterRow({ rowId: 'v1', row, cells: [{ colId: 'attr_colour', value: null, intent: 'reset' }], expectedVersion: 3 }, ctx((ids, p) => save.onStored(ids, p), ok))
    expect(result.ok).toBe(true)
    expect(save.inPlace(result.ok)).toBeNull()
    expect(save.readReason).toMatch(/reset/)
  })
})

/** The hook's wiring, which a node suite cannot render: the read after a save is owed only when the save did not settle. */
describe('useMasterSheet — a save reads the sheet only when it could not settle in place', () => {
  const src = readFileSync(join(__dirname, 'useMasterSheet.ts'), 'utf8')
  it('owes the follow-up read only for a save not settled in place, and reads through the one FollowUpRead', () => {
    expect(src).toMatch(/const settled = save\.inPlace\(result\.ok\)/)
    expect(src).toMatch(/\} else if \(result\.ok\) followUp\.owe\(\)/)
    expect(src).toMatch(/if \(info\.ok && writer\.pending === 0\) followUp\.settle\(\)/)
  })
  it('🔴 A04 — a refused cell elsewhere does not hold the read back (the quiet read keeps what it shows)', () => {
    expect(src).not.toMatch(/hasUnconfirmedChanges/)
    expect(src).toMatch(/BUSY_STATES: ReadonlySet<string> = new Set\(\['refused', 'unknown', 'saving', 'waiting', 'pending'\]\)/)
  })
  it('B34 — the recovery reads ask for the compact wire form and decode it', () => {
    for (const name of ['readBackBatch:', 'readBack:']) {
      const at = src.indexOf(name)
      const body = src.slice(at, src.indexOf('recoverSheetRow', at))
      expect(body, name).toMatch(/compactSheetUrl\(/)
      expect(src.slice(at, src.indexOf('\n        },', at) + 1), name).toMatch(/decodeRecoveryRead\(/)
    }
  })
})

/** B27 — neither a sheet read with the same columns nor a readiness answer rebuilds the attribute ColDefs. */
describe('useMasterSheetAdapter — the column model is keyed on column content', () => {
  const src = readFileSync(join(__dirname, 'useMasterSheetAdapter.tsx'), 'utf8')
  const depsOf = (name: string) => {
    const at = src.indexOf(`const ${name} = useMemo`)
    if (at === -1) throw new Error(`${name} not found — the guard cannot read it`)
    const end = src.indexOf(');\n', at)
    return src.slice(src.lastIndexOf('[', end), end)
  }
  it('attribute columns depend on the stable attribute schema, never on the sheet object or the readiness-fed schema', () => {
    expect(depsOf('attributeColumns')).toContain('attributeSchema')
    expect(depsOf('attributeColumns')).not.toMatch(/\bsheet\b|schemaColumns/)
    expect(depsOf('attributeSchema')).toBe('[stableColumns]')
    expect(src).toMatch(/const stableColumns = useMemo\(\(\) => sheet\?\.columns \?\? \[\], \[columnsKey\]\)/)
  })
})
