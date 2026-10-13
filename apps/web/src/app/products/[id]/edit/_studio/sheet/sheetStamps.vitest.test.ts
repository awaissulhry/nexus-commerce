/**
 * Field stamps on the product sheet's writes (2026-10-13): each cell a save sends carries the stamp of the cell the person
 * edited, taken from the sheet READ — never from the grid's edited copy, and never from a cell this page wrote itself
 * since that read. The door that checks them is the API's `services/products/sheet-stamp-door.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sheetCellStamp } from '@nexus/shared/sheet-stamp'
import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { SheetWriter } from '@/design-system/grid/editors/sheetWriter'
import { commitMasterRow, type MasterCommitContext } from './master/masterWrite'
import type { StudioRow, StudioSheet } from './master/types'
import { commitChannelRow } from './channel/useChannelSheet'
import { keepUnsettledCells } from './channel/saveSettle'
import type { ChannelScopePage, ChannelSheetRow } from './channel/types'
import { carrySeenCell, carryShownCell, movedValueOf, readAgainOverRefused, rememberReadCells, seenCell, stampFor } from './sheetStamps'
import { noteEditPrior, SheetUndoHistory, takeEditPrior } from './sheetUndo'

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

/*
 * Review of #611 — "Try again" after a refusal because the field moved. The quiet read gives the row the latest version
 * while the refused cell still shows the person's value; a retry on the version alone then overwrote the other person's
 * value, which the page never showed. Now the mark names the server's value, and the retry replaces exactly that.
 */
describe('a refused cell whose field moved: its mark names the server’s value, and “Try again” replaces exactly that', () => {
  const MASTER = { tier: null, inherited: false, pinned: false, follows: null, layer: 'master' }
  const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'it' }, columns: [
    { key: 'brand', writeField: 'brand', label: 'Brand', group: 'g', requiredBy: [], storage: 'column' },
  ] } as unknown as StudioSheet
  const refusedFor = (value: string) => ({ code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 3, versionOf: 'product',
    current: { brand: { value, from: MASTER } } })

  /** The Shared sheet's writer, as `useMasterSheet` builds it, saving through `commitMasterRow`; every body it sends. */
  function masterSheet(answers: Array<[number, unknown]>) {
    const sent: Array<Record<string, any>> = []
    const tracker = new CellSaveTracker()
    const writer = new SheetWriter<StudioRow>({ tracker, getApi: () => null, flushMs: 1,
      commit: (req) => commitMasterRow(req, { sheet, opts: {}, locale: 'it', market: 'IT',
        bulkSend: async (body) => { sent.push(body); const [status, answer] = answers.shift()!; return json(status, answer) as never } }) })
    return { sent, tracker, writer }
  }
  /** `useMasterSheet`'s quiet read: the server's row, with the refused cell kept (and its mark reworded when it says so). */
  function quietRead(tracker: CellSaveTracker, writer: SheetWriter<StudioRow>, shown: StudioRow, version: number, server: Record<string, unknown>) {
    const fresh = { id: shown.id, version, values: { brand: readCell(server.value, server) } } as unknown as StudioRow
    rememberReadCells([fresh])
    const words = readAgainOverRefused(shown.values.brand, fresh.values.brand)
    if (words) tracker.set(shown.id, 'brand', 'refused', words)
    fresh.values.brand = shown.values.brand
    writer.seed([{ id: fresh.id, version: fresh.version, row: fresh }])
    return fresh
  }

  it('the Shared sheet: the mark says “now Brand X”, and Try again after the quiet read sends the stamp of Brand X — not the version alone', async () => {
    const { sent, tracker, writer } = masterSheet([[409, refusedFor('Brand X')], [200, { updated: 1, currentVersion: 4, versionOf: 'product' }]])
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 2, values: { brand: edit(read, 'Brand Mine') } } as unknown as StudioRow
    writer.seed([{ id: 'p1', version: 2, row }])
    writer.set('p1', 'brand', 'Brand Mine', { row })
    await writer.flush()
    expect(tracker.get('p1', 'brand')).toMatchObject({ state: 'refused', reason: 'Changed elsewhere: now “Brand X”. Try again to replace it.' })
    // The quiet read: the row takes version 3, the refused cell keeps the person's value and its mark.
    quietRead(tracker, writer, row, 3, { value: 'Brand X' })
    expect(tracker.get('p1', 'brand')?.reason).toBe('Changed elsewhere: now “Brand X”. Try again to replace it.')
    expect(writer.retryFailed()).toBe(1)
    await writer.flush()
    expect(sent[1].expectedVersion).toBe(3)
    expect(sent[1].changes[0]).toMatchObject({ field: 'brand', value: 'Brand Mine', column: 'brand', expected: { value: 'Brand X', from: MASTER } })
  })

  it('the field moved once more before the quiet read: the mark names the newer value, and Try again replaces that one', async () => {
    const { sent, tracker, writer } = masterSheet([[409, refusedFor('Brand X')], [200, { updated: 1, currentVersion: 5, versionOf: 'product' }]])
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 2, values: { brand: edit(read, 'Brand Mine') } } as unknown as StudioRow
    writer.seed([{ id: 'p1', version: 2, row }])
    writer.set('p1', 'brand', 'Brand Mine', { row })
    await writer.flush()
    quietRead(tracker, writer, row, 4, { value: 'Brand Y' })
    expect(tracker.get('p1', 'brand')).toMatchObject({ state: 'refused', reason: 'Changed elsewhere: now “Brand Y”. Try again to replace it.' })
    writer.retryFailed()
    await writer.flush()
    expect(sent[1]).toMatchObject({ expectedVersion: 4 })
    expect(sent[1].changes[0].expected).toEqual({ value: 'Brand Y', from: MASTER })
  })

  it('Try again before the quiet read keeps the version it read and sends the stamp of the value the mark named', async () => {
    const { sent, writer } = masterSheet([[409, refusedFor('Brand X')], [409, refusedFor('Brand Z')]])
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 2, values: { brand: edit(read, 'Brand Mine') } } as unknown as StudioRow
    writer.seed([{ id: 'p1', version: 2, row }])
    writer.set('p1', 'brand', 'Brand Mine', { row })
    await writer.flush()
    writer.retryFailed()
    await writer.flush()
    expect(sent[1]).toMatchObject({ expectedVersion: 2 })
    expect(sent[1].changes[0].expected).toEqual({ value: 'Brand X', from: MASTER })
  })

  it('the channel sheet: the mark names the server’s value, a quiet read rewords it when the field moved again, and Try again replaces that', async () => {
    const LISTING = { tier: null, inherited: false, pinned: true, follows: false, layer: 'channel' }
    const channelCell = (value: unknown) => readCell(value, { writeField: 'material', writeTarget: 'channelListing', writeVerb: 'channel', layer: 'channel', pinned: true, follows: false })
    const read = channelCell('Cotone')
    rememberReadCells([{ values: { material: read } }])
    const row = { id: 'p1', rowId: 'primary:p1', rowKind: 'variant', aliasId: null, version: 7, listing: { id: 'l1', version: 82 }, values: { material: edit(read, 'Lana') } } as unknown as ChannelSheetRow
    const sent: Array<Record<string, any>> = []
    const answers: Array<[number, unknown]> = [
      [409, { code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 83, versionOf: 'channelListing', current: { material: { value: 'Seta', from: LISTING } } }],
      [200, { updated: 1, currentVersion: 85, versionOf: 'channelListing' }],
    ]
    const coord = { channel: 'EBAY' as const, marketplace: 'IT', bulkSend: async (body: Record<string, unknown>) => { sent.push(body); const [status, answer] = answers.shift()!; return json(status, answer) as never } }
    const refused = await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 }, coord)
    expect(refused).toMatchObject({ ok: false, conflict: true, cells: { material: { ok: false, reason: 'Changed elsewhere: now “Seta”. Try again to replace it.' } } })
    expect(row.listing?.version).toBe(82)
    // The quiet read (`keepUnsettledCells`): the listing is at 84 and the field moved once more; the refused cell stays.
    const page = { columns: [{ key: 'material' }], rows: [{ ...row, listing: { id: 'l1', version: 84 }, values: { material: channelCell('Lino') } }] } as unknown as ChannelScopePage
    const reworded: Array<[string, string, string]> = []
    const landed = keepUnsettledCells(page, [row], () => 'refused', (rowId, colId, words) => reworded.push([rowId, colId, words]))
    expect(reworded).toEqual([['primary:p1', 'material', 'Changed elsewhere: now “Lino”. Try again to replace it.']])
    const fresh = landed.rows[0] as unknown as ChannelSheetRow
    expect(fresh.values.material).toBe(row.values.material)
    // Try again: the writer sends the refused value once more, on the row the read gave it.
    await commitChannelRow({ rowId: row.rowId, row: fresh, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 }, coord)
    expect(sent[1]).toMatchObject({ expectedVersion: 84, expectedListingId: 'l1' })
    expect(sent[1].changes[0]).toMatchObject({ field: 'material', value: 'Lana', column: 'material', expected: { value: 'Lino', from: LISTING } })
  })

  it('a quiet read rewords nothing for a refused cell no stamped save refused (its retry is what it was)', () => {
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    expect(readAgainOverRefused(edit(read, 'Brand Q'), readCell('Brand X'))).toBeUndefined()
  })
})

/*
 * Re-review of #611 — the refused cell beyond "Try again": a value typed into it, a save of it that is stored, its undo, and
 * a refusal of another cell of the row that names no field.
 */
describe('a cell refused because its field moved: a value typed into it, its stored save, its undo, and the row’s version', () => {
  const MASTER = { tier: null, inherited: false, pinned: false, follows: null, layer: 'master' }
  const sheet = { scope: { kind: 'master', label: 'Shared', locale: 'it' }, columns: [
    { key: 'brand', writeField: 'brand', label: 'Brand', group: 'g', requiredBy: [], storage: 'column' },
    { key: 'color', writeField: 'color', label: 'Colour', group: 'g', requiredBy: [], storage: 'column' },
  ] } as unknown as StudioSheet
  const conflict = (current?: string) => ({ code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 4, versionOf: 'product',
    ...(current ? { current: { brand: { value: current, from: MASTER } } } : {}) })

  /** The Shared sheet's writer and undo, as `useMasterSheetAdapter` wires them; every body it sends. */
  function masterSheet(answers: Array<[number, unknown]>) {
    const sent: Array<Record<string, any>> = []
    const tracker = new CellSaveTracker()
    const history = new SheetUndoHistory()
    const writer = new SheetWriter<StudioRow>({ tracker, getApi: () => null, flushMs: 1,
      commit: (req) => commitMasterRow(req, { sheet, opts: {}, locale: 'it', market: 'IT',
        bulkSend: async (body) => { sent.push(body); const [status, answer] = answers.shift()!; return json(status, answer) as never } }) })
    const read = readCell('Brand P')
    rememberReadCells([{ values: { brand: read } }])
    const row = { id: 'p1', version: 2, values: { brand: read, color: readCell('Rosso', { writeField: 'color' }) } } as unknown as StudioRow
    writer.seed([{ id: 'p1', version: 2, row }])
    /** The person types `value` into the brand cell: the column's value setter, then the save with its undo record. */
    const type = (value: string, before: unknown) => {
      const next = edit(row.values.brand as object, value)
      takeEditPrior(next) // the adapter reads the edit's "before" as it records it
      row.values = { ...row.values, brand: next } as never
      const refused = tracker.get('p1', 'brand')?.state === 'refused'
      const onOutcome = history.edit({ rowId: 'p1', colId: 'brand', before, after: value }, refused, true, () => movedValueOf(row.values.brand))
      writer.set('p1', 'brand', value, { row, onOutcome })
    }
    return { sent, tracker, history, writer, row, type }
  }

  it('a value typed into the refused cell carries the stamp of the value its mark names, and refuses again if that moved', async () => {
    const { sent, tracker, writer, type } = masterSheet([[409, conflict('Brand X')], [409, conflict('Brand Y')], [409, conflict('Brand Y')]])
    type('Mine', 'Brand P')
    await writer.flush()
    expect(tracker.get('p1', 'brand')?.reason).toBe('Changed elsewhere: now “Brand X”. Try again to replace it.')
    // An open editor holds the quiet read back; the person types a new value into the red cell; a third person sets Y.
    type('Mine 2', 'Mine')
    await writer.flush()
    expect(sent[1]).toMatchObject({ expectedVersion: 2 })
    expect(sent[1].changes[0]).toMatchObject({ value: 'Mine 2', column: 'brand', expected: { value: 'Brand X', from: MASTER } })
    expect(tracker.get('p1', 'brand')?.reason).toBe('Changed elsewhere: now “Brand Y”. Try again to replace it.')
    expect(writer.versionOf('p1')).toBe(2)
    writer.retryFailed()
    await writer.flush()
    expect(sent[2]).toMatchObject({ expectedVersion: 2 })
    expect(sent[2].changes[0]).toMatchObject({ value: 'Mine 2', expected: { value: 'Brand Y', from: MASTER } })
  })

  it('undo after a value typed into the refused cell was stored puts back the other person’s value, not the one from before it', async () => {
    const { history, writer, type } = masterSheet([[409, conflict('Brand X')], [200, { updated: 1, currentVersion: 4, versionOf: 'product', writtenAt: 3 }]])
    type('Mine', 'Brand P')
    await writer.flush()
    type('Mine 2', 'Mine')
    await writer.flush()
    const put: unknown[] = []
    history.undo((values) => { put.push(...values.map((v) => v.value)) })
    expect(put).toEqual(['Brand X'])
  })

  it('a stored save ends the refusal: a value typed before the next read is not checked against the server’s old value', async () => {
    const { sent, writer, type } = masterSheet([[409, conflict('Brand X')], [200, { updated: 1, currentVersion: 4, versionOf: 'product', writtenAt: 3 }], [200, { updated: 1, currentVersion: 5, versionOf: 'product' }]])
    type('Mine', 'Brand P')
    await writer.flush()
    writer.retryFailed()
    await writer.flush()
    expect(sent[1].changes[0].expected).toEqual({ value: 'Brand X', from: MASTER })
    type('Mine 3', 'Mine')
    await writer.flush()
    // Made over the person's own stored value: no stamp of Brand X (which would refuse it as "now Mine").
    expect(sent[2].changes[0]).not.toHaveProperty('expected')
  })

  it('a refusal of another cell of the row that names no field hands the row no version while the refused cell shows', async () => {
    const { sent, writer, type, row } = masterSheet([[409, conflict('Brand X')], [409, conflict()]])
    type('Mine', 'Brand P')
    await writer.flush()
    // An unstamped save of another cell (the page wrote it itself): the door checks the version alone and answers v4.
    row.values = { ...row.values, color: readCell('Blu', { writeField: 'color' }) } as never
    writer.set('p1', 'color', 'Blu', { row })
    await writer.flush()
    expect(sent[1].changes[0]).not.toHaveProperty('expected')
    expect(writer.versionOf('p1')).toBe(2)
  })

  it('the channel sheet: the same refusal naming no field leaves the listing version the row read', async () => {
    const LISTING = { tier: null, inherited: false, pinned: true, follows: false, layer: 'channel' }
    const channelCell = (value: unknown, writeField = 'material') => readCell(value, { writeField, writeTarget: 'channelListing', writeVerb: 'channel', layer: 'channel', pinned: true, follows: false })
    const read = channelCell('Cotone')
    rememberReadCells([{ values: { material: read } }])
    const row = { id: 'p1', rowId: 'primary:p1', rowKind: 'variant', aliasId: null, version: 7, listing: { id: 'l1', version: 82 },
      values: { material: edit(read, 'Lana'), finish: channelCell('Opaco', 'finish') } } as unknown as ChannelSheetRow
    const answers: Array<[number, unknown]> = [
      [409, { code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 83, versionOf: 'channelListing', current: { material: { value: 'Seta', from: LISTING } } }],
      [409, { code: 'VERSION_CONFLICT', error: 'Another change landed first', currentVersion: 84, versionOf: 'channelListing' }],
    ]
    const coord = { channel: 'EBAY' as const, marketplace: 'IT', bulkSend: async () => { const [status, answer] = answers.shift()!; return json(status, answer) as never } }
    await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'material', value: 'Lana', intent: 'set' }], expectedVersion: 7 }, coord)
    await commitChannelRow({ rowId: row.rowId, row, cells: [{ colId: 'finish', value: 'Lucido', intent: 'set' }], expectedVersion: 7 }, coord)
    expect(row.listing?.version).toBe(82)
  })
})
