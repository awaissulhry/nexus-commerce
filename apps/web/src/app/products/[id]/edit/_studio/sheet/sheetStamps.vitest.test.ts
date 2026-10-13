/**
 * Field stamps on the product sheet's writes (2026-10-13): each cell a save sends carries the stamp of the cell the person
 * edited, taken from the sheet READ — never from the grid's edited copy, and never from a cell this page wrote itself
 * since that read. The door that checks them is the API's `services/products/sheet-stamp-door.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sheetCellStamp } from '@nexus/shared/sheet-stamp'
import { commitMasterRow, type MasterCommitContext } from './master/masterWrite'
import type { StudioRow, StudioSheet } from './master/types'
import { commitChannelRow } from './channel/useChannelSheet'
import type { ChannelSheetRow } from './channel/types'
import { carrySeenCell, carryShownCell, rememberReadCells, seenCell, stampFor } from './sheetStamps'
import { noteEditPrior, takeEditPrior } from './sheetUndo'

/** A cell as the sheet read sends it. */
const readCell = (value: unknown, over: Record<string, unknown> = {}) =>
  ({ value, source: 'master', inherited: false, pinned: false, follows: null, layer: 'master', editable: true, writeField: 'brand', writeTarget: 'master', ...over })
/** What a column's value setter does: a new cell over the one it replaced, noted for the undo. */
const edit = (previous: object, value: unknown) => {
  const next = { ...previous, value, inherited: false }
  noteEditPrior(next, previous)
  return next
}

afterEach(() => vi.unstubAllGlobals())

describe('seenCell — the read cell an edit was made over', () => {
  it('is the read cell for an edit made over one', () => {
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    expect(seenCell(edit(read, 'Brand Q'))).toBe(read)
  })

  it('is nothing for an edit made over this page’s own earlier edit (it was saved, or it is still on its way)', () => {
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const first = edit(read, 'Brand Q')
    takeEditPrior(first) // the undo recorded the first edit: it was sent
    expect(seenCell(edit(first, 'Brand R'))).toBeUndefined()
  })

  it('is the cell itself for a write that left it as the read sent it (a reset from Cell details)', () => {
    const read = readCell('Brand C', { layer: 'variant', pinned: true })
    rememberReadCells([{ values: { brand: read } }])
    expect(seenCell(read)).toBe(read)
  })

  it('is nothing for a cell no read sent (the grid’s own copy, a value settled from a save’s answer)', () => {
    const settled = readCell('Brand Q')
    expect(seenCell(edit(settled, 'Brand R'))).toBeUndefined()
    expect(seenCell(readCell('x'))).toBeUndefined()
  })

  it('follows a Shared/pin answer to the read cell the edit was made over', () => {
    const read = readCell('Titolo', { tier: 'language', follows: true })
    rememberReadCells([{ values: { name: read } }])
    const pending = edit(read, 'Titolo nuovo')
    const answered = { ...pending, contentAcknowledged: true }
    carrySeenCell(pending, answered)
    expect(seenCell(answered)).toBe(read)
  })

  it('a reset is made over the cell the server holds only when the sheet read that cell', () => {
    const read = readCell('Brand C', { layer: 'variant', pinned: true })
    rememberReadCells([{ values: { brand: read } }])
    const shown = { ...read, value: 'Brand P', inherited: true }
    carryShownCell(read, shown)
    expect(seenCell(shown)).toBe(read)
    const ownEdit = edit(read, 'Brand D')
    const shownOverEdit = { ...ownEdit, value: 'Brand P', inherited: true }
    carryShownCell(ownEdit, shownOverEdit)
    expect(seenCell(shownOverEdit)).toBeUndefined()
  })
})

describe('stampFor', () => {
  it('stamps the read cell and names the column the scope’s read keys it by (a Languages column without its language)', () => {
    const read = readCell('Jacke', { tier: 'language' })
    rememberReadCells([{ values: { 'name@de': read } }])
    expect(stampFor(edit(read, 'Jacke neu'), 'name@de', 'set', { locale: 'de' })).toEqual({ expected: sheetCellStamp(read), column: 'name' })
    expect(stampFor(edit(read, 'Jacke neu'), 'brand', 'set', null)).toEqual({ expected: sheetCellStamp(read), column: 'brand' })
  })

  it('sends nothing for a reset of a whole list — it writes every position, a stamp names one', () => {
    const read = readCell(['a'], { tier: 'pin' })
    rememberReadCells([{ values: { bullet_1: read } }])
    expect(stampFor(edit(read, null), 'bullet_1', 'reset-list', null)).toEqual({})
  })
})

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('commitMasterRow — the stamps on the wire', () => {
  it('a save that went ahead over another change keeps the version and text tokens the row was read with', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { updated: 1, currentVersion: 4, versionOf: 'product', writtenAt: 3,
      contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: 6 }] })))
    const read = readCell('Jacke', { tier: 'language', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 5 })
    rememberReadCells([{ values: { name: read } }])
    const row = { id: 'p1', version: 2, values: { name: edit(read, 'Jacke neu') } } as unknown as StudioRow
    const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'de' }, rows: [row], columns: [
      { key: 'name', writeField: 'name', label: 'Title', group: 'g', requiredBy: [], storage: 'localizedContent' },
    ] } as unknown as StudioSheet
    const result = await commitMasterRow({ rowId: 'p1', row, cells: [{ colId: 'name', value: 'Jacke neu', intent: 'set' }], expectedVersion: 2 },
      { sheet, opts: {}, locale: 'de', market: 'IT' })
    expect(result.ok).toBe(true)
    expect(result.version).toBeUndefined()
    expect(row.values.name.contentVersion).toBe(5)
  })

  const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'it' }, columns: [
    { key: 'brand', writeField: 'brand', label: 'Brand', group: 'g', requiredBy: [], storage: 'column' },
  ] } as unknown as StudioSheet
  const ctx = (): MasterCommitContext => ({ sheet, opts: {}, locale: 'it', market: 'IT' })

  it('each edited cell carries the stamp of the read cell it replaced; the row’s version is sent as before', async () => {
    const fetchMock = vi.fn(async () => json(200, { updated: 1, currentVersion: 3, versionOf: 'product' }))
    vi.stubGlobal('fetch', fetchMock)
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 1, values: { brand: edit(read, 'Brand Q') } } as unknown as StudioRow
    const result = await commitMasterRow({ rowId: 'p1', row, cells: [{ colId: 'brand', value: 'Brand Q', intent: 'set' }], expectedVersion: 1 }, ctx())
    expect(result.ok).toBe(true)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.expectedVersion).toBe(1)
    expect(body.changes).toEqual([{ id: 'p1', field: 'brand', value: 'Brand Q', column: 'brand', expected: sheetCellStamp(read) }])
  })

  it('a write without a version (a row the writer was never told about) carries no stamp', async () => {
    const fetchMock = vi.fn(async () => json(200, { updated: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', values: { brand: edit(read, 'Brand Q') } } as unknown as StudioRow
    await commitMasterRow({ rowId: 'p1', row, cells: [{ colId: 'brand', value: 'Brand Q', intent: 'set' }] }, ctx())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.changes[0]).not.toHaveProperty('expected')
  })
})

describe('a refusal because a stamped field moved', () => {
  it('keeps the version the row was read with (the quiet read that follows brings the other change and its version)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 4, versionOf: 'product',
      current: { brand: { value: 'Brand X', from: { tier: null, inherited: false, pinned: false, follows: null, layer: 'master' } } } })))
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 2, values: { brand: edit(read, 'Brand Q') } } as unknown as StudioRow
    const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'it' }, columns: [
      { key: 'brand', writeField: 'brand', label: 'Brand', group: 'g', requiredBy: [], storage: 'column' },
    ] } as unknown as StudioSheet
    const result = await commitMasterRow({ rowId: 'p1', row, cells: [{ colId: 'brand', value: 'Brand Q', intent: 'set' }], expectedVersion: 2 },
      { sheet, opts: {}, locale: 'it', market: 'IT' })
    expect(result).toMatchObject({ ok: false, conflict: true })
    expect(result.version).toBeUndefined()
  })

  it('a refusal without stamps still hands back the server’s version, as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 4, versionOf: 'product' })))
    const row = { id: 'p1', version: 2, values: { brand: readCell('Brand P') } } as unknown as StudioRow
    const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'it' }, columns: [
      { key: 'brand', writeField: 'brand', label: 'Brand', group: 'g', requiredBy: [], storage: 'column' },
    ] } as unknown as StudioSheet
    const result = await commitMasterRow({ rowId: 'p1', row, cells: [{ colId: 'brand', value: 'Brand Q', intent: 'set' }], expectedVersion: 2 },
      { sheet, opts: {}, locale: 'it', market: 'IT' })
    expect(result).toMatchObject({ ok: false, conflict: true, version: 4 })
  })
})

describe('commitChannelRow — the stamps on the wire', () => {
  const channelCell = (value: unknown) => readCell(value, { writeField: 'material', writeTarget: 'channelListing', writeVerb: 'channel', layer: 'channel', pinned: true, follows: false })
  const channelRow = (values: Record<string, unknown>) =>
    ({ id: 'p1', rowId: 'primary:p1', rowKind: 'variant', aliasId: null, version: 7, listing: { id: 'l1', version: 82 }, values }) as unknown as ChannelSheetRow

  it('a listing write carries each cell’s stamp and names the listing the row was read with', async () => {
    const sent: Array<Record<string, any>> = []
    const read = channelCell('Cotone')
    rememberReadCells([{ values: { material: read } }])
    const row = channelRow({ material: edit(read, 'Lana') })
    await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 },
      { channel: 'EBAY', marketplace: 'IT', bulkSend: async (body) => { sent.push(body); return json(200, { updated: 1, currentVersion: 83, versionOf: 'channelListing' }) } })
    expect(sent[0]).toMatchObject({ expectedVersion: 82, expectedListingId: 'l1' })
    expect(sent[0].changes[0]).toMatchObject({ field: 'material', target: 'channel', column: 'material', expected: sheetCellStamp(read) })
  })

  it('a save that went ahead over another change to the row asks for a read instead of settling in place', async () => {
    const read = channelCell('Cotone')
    rememberReadCells([{ values: { material: read } }])
    const row = channelRow({ material: edit(read, 'Lana') })
    const stored: unknown[] = []
    await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 },
      { channel: 'EBAY', marketplace: 'IT', onStored: (outcome) => stored.push(outcome),
        bulkSend: async () => json(200, { updated: 1, currentVersion: 84, versionOf: 'channelListing', writtenAt: 83 }) })
    expect(stored).toEqual([{ read: 'saved over another change to this row' }])
    // The other change is not on screen yet: the row keeps the listing version it read, so its next save is checked again.
    expect(row.listing?.version).toBe(82)
  })

  it('a Shopify cell carries no stamp (its read is Shopify’s own enrichment, which the door does not repeat)', async () => {
    const sent: Array<Record<string, any>> = []
    const read = channelCell('Cotone')
    rememberReadCells([{ values: { material: read } }])
    const row = channelRow({ material: edit(read, 'Lana') })
    await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 },
      { channel: 'SHOPIFY', marketplace: 'GLOBAL', bulkSend: async (body) => { sent.push(body); return json(200, { updated: 1 }) } })
    expect(sent[0].changes[0]).not.toHaveProperty('expected')
    expect(sent[0]).not.toHaveProperty('expectedListingId')
  })
})
