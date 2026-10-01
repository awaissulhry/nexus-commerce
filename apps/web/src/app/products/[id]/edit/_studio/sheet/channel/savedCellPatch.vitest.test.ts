/**
 * P2 (2026-09-30, I4-4) — a confirmed save is settled in place only when the result is exactly what the next full read
 * would show. Ground truth: `savedCellPatch.ground-truth.json` — real saves on a private copy of the database (one eBay IT
 * family, ids and names replaced), each with the sheet read before and after it. Every case runs the real channel commit
 * (`commitChannelRow`) with the recorded answer and compares the grid's rows with the read that followed the save.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitChannelRow } from './useChannelSheet'
import { withRowIdentity } from './rows'
import { optimisticCell, planSavedCellPatch, presentValue } from './savedCellPatch'
import type { ChannelSheetRow, SheetColumn, StudioRow } from './types'

interface Case {
  name: string
  expect: 'patch' | 'read'
  key: string
  value: unknown
  sku: string
  body: Record<string, unknown>
  column: SheetColumn
  before: StudioRow[]
  after: StudioRow[]
}
const CASES: Case[] = JSON.parse(readFileSync(join(__dirname, 'savedCellPatch.ground-truth.json'), 'utf8'))
const THEME = 'variation_theme'

/** Save one cell the way the grid does: the value setter's optimistic cell, then the real commit with the recorded answer. */
async function save(c: Case, body: Record<string, unknown> = c.body) {
  const rows = withRowIdentity(structuredClone(c.before), [])
  const row = rows.find((r) => r.sku === c.sku)!
  row.values = { ...row.values, [c.key]: optimisticCell(row.values[c.key], c.value, row.rowKind) }
  let outcome: { patched: ChannelSheetRow[]; columns: string[] } | { read: string } | undefined
  const result = await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: c.key, value: c.value, intent: 'set' }], expectedVersion: row.version }, {
    channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', locale: 'it', familyRows: () => rows,
    columnOf: (colId) => (colId === c.key ? c.column : undefined),
    onStored: (o) => { outcome = o },
    bulkSend: async () => ({ status: 200, ok: true, json: async () => body }),
  })
  return { rows, row, result, outcome }
}

describe('a save settled in place equals the full read that follows it (recorded ground truth)', () => {
  for (const c of CASES.filter((x) => x.expect === 'patch')) {
    it(`${c.name}: ${c.key} = ${JSON.stringify(c.value)}`, async () => {
      const { rows, result, outcome } = await save(c)
      expect(result.ok).toBe(true)
      expect(outcome && 'patched' in outcome, JSON.stringify(outcome)).toBe(true)
      for (const after of c.after) {
        const row = rows.find((r) => r.id === after.id)!
        // The saved column, on every row the read returned changed (a listing-level value moves on the whole family).
        expect(row.values[c.key], `${after.sku} ${c.key}`).toEqual(after.values[c.key])
        expect(row.listing?.version, `${after.sku} listing version`).toBe(after.listing?.version)
        expect(row.listing?.price, `${after.sku} listing price`).toBe(after.listing?.price)
        expect(row.listing?.follows, `${after.sku} listing follows`).toEqual(after.listing?.follows)
        if ('completeness' in after) expect(row.completeness, `${after.sku} completeness`).toEqual(after.completeness)
        // P2 review 9 — the row's readiness issues (the view's flagged columns) are what the read returns: a patched save
        // never moves them, so the column model has nothing to recompute.
        expect(row.readiness, `${after.sku} readiness`).toEqual(after.readiness)
        // The family row's variation theme carries its listing's version as its write token.
        if (after.values[THEME]) expect((row.values[THEME]?.value as { write?: unknown }).write).toEqual((after.values[THEME].value as { write?: unknown }).write)
      }
    })
  }
})

describe('a save the browser cannot rebuild is read again', () => {
  for (const c of CASES.filter((x) => x.expect === 'read')) {
    it(`${c.name}: ${c.key} = ${JSON.stringify(c.value)}`, async () => {
      const { result, outcome } = await save(c)
      expect(result.ok).toBe(true)
      expect(outcome && 'read' in outcome, JSON.stringify(outcome)).toBe(true)
    })
  }

  const plain = CASES.find((x) => x.name === 'handling-variant')!
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a warning', { ...plain.body, warnings: [{ id: plain.before.find((r) => r.sku === plain.sku)!.id, field: plain.column.writeField, warning: 'Over the limit' }] }],
    ['a cascade', { ...plain.body, cascadeCount: 2 }],
    ['a started draft', { ...plain.body, createdListings: [{ productId: 'p', listingId: 'l', version: 1 }] }],
    ['a value equal to the stored one', { ...plain.body, updated: 0, unchanged: 1 }],
    ['a normalised reference', { ...plain.body, normalizedChanges: [{ id: 'x', field: 'f', value: 'y' }] }],
    // A formula the save fed changed other cells: their values are only on the server (qualified receipts, 2026-10-01).
    ['a recalculated formula', { ...plain.body, recalculated: [{ productId: 'p', fieldKey: 'description', scope: 'channel', value: 'X', error: null, sourceField: 'f' }] }],
    ['a content row the save moved', { ...plain.body, contentVersionReceipts: [{ productId: 'p', tier: 'language', language: 'de',
      before: { ownerVersion: 1, contentVersion: 1 }, after: { ownerVersion: 2, contentVersion: 2 } }] }],
  ]
  for (const [what, body] of cases) {
    it(`an answer with ${what}`, async () => {
      const { outcome } = await save(plain, body)
      expect(outcome && 'read' in outcome, JSON.stringify(outcome)).toBe(true)
    })
  }

  it('a clear, a required first fill, a reset, a category and a formula cell', () => {
    const rows = withRowIdentity(structuredClone(plain.before), [])
    const row = rows.find((r) => r.sku === plain.sku)!
    const plan = (changes: Parameters<typeof planSavedCellPatch>[0]['changes'], column: Partial<SheetColumn> = {}, cell: Record<string, unknown> = {}) => {
      row.values = { ...row.values, [plain.key]: { ...structuredClone(plain.before.find((r) => r.sku === plain.sku)!.values[plain.key]), ...cell } }
      return planSavedCellPatch({ row, body: plain.body, changes, column: () => ({ ...plain.column, ...column }) as SheetColumn }).kind
    }
    const set = (value: unknown) => [{ colId: plain.key, field: plain.column.writeField, value, intent: 'set', target: 'channel' }]
    expect(plan(set(4))).toBe('patch')
    expect(plan(set(null))).toBe('read')
    expect(plan([{ ...set(4)[0], intent: 'reset' }])).toBe('read')
    expect(plan(set(4), { key: 'categoryId' })).toBe('read')
    expect(plan(set(4), { axis: true } as Partial<SheetColumn>)).toBe('read')
    expect(plan(set(4), {}, { formula: '=1' })).toBe('read')
    expect(plan(set(4), {}, { contentVersion: 3 })).toBe('read')
    expect(plan([{ ...set(4)[0], target: 'master' }])).toBe('read')
    row.completeness = { ...row.completeness, required: { filled: 0, total: 1, missing: [{ key: plain.column.key, label: 'x' }] } }
    expect(plan(set(4), {}, { value: null })).toBe('read')
  })
})

describe('presentValue', () => {
  it('reads presence by shape', () => {
    expect([null, '', [], [''], { value: null, unit: 'KILOGRAM' }].map(presentValue)).toEqual([false, false, false, false, false])
    expect([0, false, 'x', ['a'], { value: 0, unit: 'KILOGRAM' }].map(presentValue)).toEqual([true, true, true, true, true])
  })
})

describe('review 2 — an older answer never paints over a newer edit to the same cell', () => {
  it('the operator types again while the first value is on the wire: the save reads, the newer value stays', async () => {
    const c = CASES.find((x) => x.name === 'handling-variant')!
    const rows = withRowIdentity(structuredClone(c.before), [])
    const row = rows.find((r) => r.sku === c.sku)!
    row.values = { ...row.values, [c.key]: optimisticCell(row.values[c.key], c.value, row.rowKind) }
    let outcome: { patched: ChannelSheetRow[]; columns: string[] } | { read: string } | undefined
    const result = await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: c.key, value: c.value, intent: 'set' }], expectedVersion: row.version }, {
      channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1', locale: 'it', familyRows: () => rows,
      columnOf: (colId) => (colId === c.key ? c.column : undefined),
      onStored: (o) => { outcome = o },
      bulkSend: async () => {
        // The next value is typed (the grid's value setter) before the first answer lands.
        row.values = { ...row.values, [c.key]: optimisticCell(row.values[c.key], 9, row.rowKind) }
        return { status: 200, ok: true, json: async () => c.body }
      },
    })
    expect(result.ok).toBe(true)
    expect(outcome && 'read' in outcome, JSON.stringify(outcome)).toBe(true)
    expect(row.values[c.key].value).toBe(9)
  })
})
