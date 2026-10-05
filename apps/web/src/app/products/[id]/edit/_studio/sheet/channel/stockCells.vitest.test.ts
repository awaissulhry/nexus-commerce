/**
 * Amazon sheet gaps (gaps 4–5) — the product sheet's Mode / Qty / Buffer edits leave through the Matrix door: the write
 * cell they send, how each answer lands on the cell, the versions every row adopts (Amazon EU: each row its own), the
 * one Matrix read that refreshes only the rows that changed, and the batch — one `patchMatrix` per family per tick.
 */
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COPY, MATRIX_ENDPOINTS, type MatrixCells, type MatrixCoordinate, type MatrixRead, type MatrixWriteCell, type MatrixWriteOutcome, type MatrixWriteResult } from '../../matrix/contract'
import { patchMatrix } from '../../matrix/source'
import {
  adoptListingVersions, applyStockValue, commitStockCells, createStockWriteBatcher, knownListingVersions, patchStockRows, stockEditPending,
  stockOutcomeResult, stockWriteCell, STOCK_READ_FAILED, type StockWriteDeps,
} from './stockCells'
import type { ChannelSheetRow } from './types'

const EU: MatrixCoordinate = {
  key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU', label: 'Amazon EU · Inventory · IT DE FR', region: 'EU', alias: null,
  accountId: 'acc-1', currency: 'EUR', connected: true, listed: null, draft: null, cells: ['syncMode', 'syncQty', 'syncBuffer'], absent: [],
  sharedInventoryWith: ['IT', 'DE', 'FR'], inventoryOn: null, vocabulary: { fulfilment: null },
}

function cells(over: Partial<MatrixCells> = {}): MatrixCells {
  return {
    listingId: 'L-IT-1', version: 7,
    listing: { state: 'listed', externalId: 'B0IT000001', detail: null, published: true },
    fulfilment: null,
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 12, held: 12, buffer: 2, poolAvailable: 14, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: null, price: null, sale: null,
    writable: { syncMode: true, syncQty: true, syncBuffer: true },
    writeBlockedReason: {},
    ...over,
  }
}

const value = (v: unknown, writable = true, reason: string | null = null) => ({ value: v, editable: writable, writable, writeBlockedReason: reason })

/** A DE sheet row: its own listing is the DE one; its stock cells are the EU group's (the IT listing carries them). */
function row(id: string, over: Partial<ChannelSheetRow> & { n?: number } = {}): ChannelSheetRow {
  const n = over.n ?? 1
  const c = cells({ listingId: `L-IT-${n}` })
  return {
    rowId: `primary:${id}`, id, parentId: 'root', isParent: false, aliasId: null, sku: `SKU-${n}`,
    listing: { id: `L-DE-${n}`, version: 3, externalListingId: `B0DE00000${n}`, listingStatus: 'ACTIVE', isPublished: true },
    values: { stock_mode: value('FOLLOW'), stock_qty: value(12), stock_buffer: value(2), listing_asin: value(`B0DE00000${n}`, false) },
    stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: c, coordinate: EU },
    ...over,
  } as unknown as ChannelSheetRow
}

function readOf(rows: Array<{ id: string; cells: Record<string, MatrixCells> }>): MatrixRead {
  return {
    version: 1, productId: 'root', source: 'live', generatedAt: '2026-10-03T00:00:00.000Z', coordinates: [EU], policies: [],
    rows: rows.map((r) => ({ id: r.id, sku: r.id, role: 'variant', stock: { available: 14, uncounted: false, locations: [] }, basePrice: null, status: 'ACTIVE', cells: r.cells })),
  }
}

const applied = (c: MatrixWriteCell, listings: MatrixWriteOutcome['listings'] = [], version = c.expectedVersion + 1): MatrixWriteOutcome =>
  ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'applied', version, listings })

/** Deps whose batch leaves only when the test says so (`flush()`), so several rows can join one batch. */
function deps(answer: (cells: readonly MatrixWriteCell[]) => MatrixWriteOutcome[], read: () => MatrixRead | null = () => null) {
  const runs: Array<() => void> = []
  const d: StockWriteDeps & { flush: () => void } = {
    patch: vi.fn(async (_id: string, cs: readonly MatrixWriteCell[]): Promise<MatrixWriteResult> => ({ results: answer(cs), version: 1 })),
    read: vi.fn(async () => { const r = read(); return r ? { kind: 'live' as const, read: r } : { kind: 'error' as const, message: 'down' } }),
    schedule: (run) => { runs.push(run) },
    announce: vi.fn(),
    flush: () => { for (const run of runs.splice(0)) run() },
  }
  return d
}

const req = (r: ChannelSheetRow, cellsSent: Array<{ colId: string; value: unknown }>) => ({ rowId: r.rowId, row: r, cells: cellsSent.map((c) => ({ ...c, intent: 'set' as const })) })

describe('stockWriteCell — the Matrix write cell, exactly what the Matrix tab sends', () => {
  it('carries the row, the coordinate, the cell, the coerced value, the version and the listing the sheet saw', () => {
    const r = row('v1')
    expect(stockWriteCell(r, 'stock_qty', 'syncQty', '10')).toEqual({
      send: true, cell: { rowId: 'v1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 10, expectedVersion: 7, expectedListingId: 'L-IT-1' },
    })
    expect(stockWriteCell(r, 'stock_mode', 'syncMode', 'PINNED')).toMatchObject({ send: true, cell: { cell: 'syncMode', value: 'PINNED' } })
    expect(stockWriteCell(r, 'stock_buffer', 'syncBuffer', 3)).toMatchObject({ send: true, cell: { cell: 'syncBuffer', value: 3 } })
  })
  it('a held row says the server\'s sentence; a held cell the wire\'s; a bad value the rule; an unchanged one sends nothing', () => {
    const held = row('v1', { stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: null, coordinate: EU } } as never)
    held.values.stock_qty = value(null, false, MATRIX_COPY.accountMismatch) as never
    expect(stockWriteCell(held, 'stock_qty', 'syncQty', 4)).toEqual({ send: false, ok: false, reason: MATRIX_COPY.accountMismatch })
    const fba = row('v1')
    fba.stock!.cells = cells({ writable: { syncQty: false }, writeBlockedReason: { syncQty: MATRIX_COPY.amazonManaged } })
    expect(stockWriteCell(fba, 'stock_qty', 'syncQty', 4)).toEqual({ send: false, ok: false, reason: MATRIX_COPY.amazonManaged })
    expect(stockWriteCell(row('v1'), 'stock_qty', 'syncQty', -1)).toEqual({ send: false, ok: false, reason: 'A quantity is a whole number, zero or more' })
    expect(stockWriteCell(row('v1'), 'stock_qty', 'syncQty', 12)).toEqual({ send: false, ok: true })
  })
  it('compares the edit with the STORED cells, not the copy the grid typed into', () => {
    const r = row('v1')
    const stored = r.stock!.cells
    applyStockValue(r, 'syncQty', 10)
    expect(r.stock!.cells).not.toBe(stored)
    expect(stored!.sync!.intended).toBe(12)
    expect(stockEditPending(r)).toBe(true)
    expect(stockWriteCell(r, 'stock_qty', 'syncQty', 10)).toMatchObject({ send: true, cell: { value: 10, expectedVersion: 7 } })
  })
  it('an unchanged value touches nothing — no copy, nothing pending', () => {
    const r = row('v1')
    const stored = r.stock!.cells
    applyStockValue(r, 'syncQty', 12)
    expect(r.stock!.cells).toBe(stored)
    expect(stockEditPending(r)).toBe(false)
  })
})

describe('stockOutcomeResult — each door answer on its cell', () => {
  const base = { rowId: 'v1', coordinateKey: 'AMAZON:EU', cell: 'syncQty' as const, version: 7 }
  it('applied and noop are saved; refused says the door\'s sentence verbatim; conflict says "Changed elsewhere — reloaded"', () => {
    expect(stockOutcomeResult({ ...base, outcome: 'applied' })).toEqual({ ok: true })
    expect(stockOutcomeResult({ ...base, outcome: 'noop' })).toEqual({ ok: true })
    expect(stockOutcomeResult({ ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged })).toEqual({ ok: false, reason: 'Amazon-managed' })
    expect(stockOutcomeResult({ ...base, outcome: 'conflict' })).toEqual({ ok: false, reason: 'Changed elsewhere — reloaded' })
  })
})

describe('adoptListingVersions — Amazon EU: every row takes its OWN listing\'s version', () => {
  it('the DE row\'s listing takes the DE version; its EU stock cells take the IT listing\'s; an untouched row stays', () => {
    const de = row('v1'), other = row('v2', { n: 2 })
    const changed = adoptListingVersions([de, other], [
      { listingId: 'L-IT-1', productId: 'v1', version: 8 }, { listingId: 'L-DE-1', productId: 'v1', version: 4 }, { listingId: 'L-FR-1', productId: 'v1', version: 11 },
    ])
    expect(changed).toEqual([de])
    expect(de.listing!.version).toBe(4)
    expect(de.stock!.cells!.version).toBe(8)
    expect(other.listing!.version).toBe(3)
    expect(other.stock!.cells!.version).toBe(7)
  })
  it('never moves a version backwards', () => {
    const de = row('v1')
    expect(adoptListingVersions([de], [{ listingId: 'L-DE-1', productId: 'v1', version: 1 }])).toEqual([])
    expect(de.listing!.version).toBe(3)
  })
})

describe('patchStockRows — one Matrix read, only the rows that changed', () => {
  it('patches the changed row\'s stock cells, values and ASIN; leaves an equal row alone; reports another listing', () => {
    const a = row('v1'), b = row('v2', { n: 2 }), c = row('v3', { n: 3 })
    const pinned = cells({ listingId: 'L-IT-1', version: 8, sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 10 }, writable: { syncMode: true, syncQty: true, syncBuffer: false }, writeBlockedReason: { syncBuffer: 'A pinned listing ignores its buffer' } })
    const read = readOf([
      { id: 'v1', cells: { 'AMAZON:EU': pinned, 'AMAZON:DE': cells({ listingId: 'L-DE-1', listing: { state: 'listed', externalId: 'B0DE00000X', detail: null, published: true } }) } },
      { id: 'v2', cells: { 'AMAZON:EU': cells({ listingId: 'L-IT-2' }), 'AMAZON:DE': cells({ listingId: 'L-DE-2', listing: { state: 'listed', externalId: 'B0DE000002', detail: null, published: true } }) } },
      { id: 'v3', cells: { 'AMAZON:EU': cells({ listingId: 'L-IT-OTHER' }) } },
    ])
    const result = patchStockRows([a, b, c], read)
    expect(result.changed).toEqual([a])
    expect(result.mismatched).toEqual([c])
    expect(a.stock!.cells).toEqual(pinned)
    expect(a.stock!.cells).not.toBe(pinned)
    expect(a.values.stock_mode).toMatchObject({ value: 'PINNED', writable: true, writeBlockedReason: null })
    expect(a.values.stock_qty).toMatchObject({ value: 10, writable: true })
    expect(a.values.stock_buffer).toMatchObject({ value: 2, writable: false, editable: false, writeBlockedReason: 'A pinned listing ignores its buffer' })
    expect(a.values.listing_asin.value).toBe('B0DE00000X')
    expect(a.listing!.externalListingId).toBe('B0DE00000X')
    expect(b.stock!.cells!.version).toBe(7)
  })
  it('eBay (Item ID control): a moved Item ID refreshes its cell only on a listing the Matrix reads selling or ended', () => {
    const ebay = (state: 'listed' | 'closed' | 'ended' | 'draft' | 'error') => {
      const r = row('v1', {
        listing: { id: 'L-EB-1', version: 3, externalListingId: '520000000001', listingStatus: 'ACTIVE', isPublished: true },
        values: { stock_mode: value('FOLLOW'), stock_qty: value(12), stock_buffer: value(2), listing_item_id: value('520000000001') },
        stock: { key: 'EBAY:IT', marketKey: 'EBAY:IT', cells: cells({ listingId: 'L-EB-1' }), coordinate: EU },
      } as never)
      patchStockRows([r], readOf([{ id: 'v1', cells: { 'EBAY:IT': cells({ listingId: 'L-EB-1', listing: { state, externalId: '520000000002', detail: null, published: true } }) } }]))
      return r
    }
    for (const state of ['listed', 'closed', 'ended'] as const) expect(ebay(state).values.listing_item_id.value).toBe('520000000002')
    for (const state of ['draft', 'error'] as const) {
      const r = ebay(state)
      expect(r.values.listing_item_id.value).toBeNull()
      expect(r.listing!.externalListingId).toBe('520000000002') // the cell then reads "Not confirmed" with the held id
    }
  })
  it('a held row stays held, and a skipped row is reported, not patched', () => {
    const held = row('v1', { stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: null, coordinate: EU } } as never)
    const busy = row('v2', { n: 2 })
    const read = readOf([{ id: 'v1', cells: { 'AMAZON:EU': cells() } }, { id: 'v2', cells: { 'AMAZON:EU': cells({ listingId: 'L-IT-2', version: 9 }) } }])
    const result = patchStockRows([held, busy], read, (r) => r === busy)
    expect(held.stock!.cells).toBeNull()
    expect(result).toEqual({ changed: [], mismatched: [], skipped: [busy] })
    expect(busy.stock!.cells!.version).toBe(7)
  })
})

describe('commitStockCells — one row through the door', () => {
  it('applied: adopts the EU versions onto every row, reads the Matrix ONCE, repaints only the OTHER changed rows, settles in place, announces', async () => {
    const de1 = row('v1'), de2 = row('v2', { n: 2 }), de3 = row('v3', { n: 3 })
    const pinned = cells({ version: 8, sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 10 } })
    const moved2 = cells({ listingId: 'L-IT-2', version: 7, sync: { ...cells().sync!, poolAvailable: 9, intended: 7 } })
    const d = deps((cs) => cs.map((c) => applied(c, [{ listingId: 'L-IT-1', productId: 'v1', version: 8 }, { listingId: 'L-DE-1', productId: 'v1', version: 4 }])),
      () => readOf([{ id: 'v1', cells: { 'AMAZON:EU': pinned } }, { id: 'v2', cells: { 'AMAZON:EU': moved2 } }, { id: 'v3', cells: { 'AMAZON:EU': cells({ listingId: 'L-IT-3' }) } }]))
    const onFamilyChanged = vi.fn(), onStored = vi.fn()
    applyStockValue(de1, 'syncQty', 10)
    const done = commitStockCells(req(de1, [{ colId: 'stock_qty', value: 10 }]), { familyRows: () => [de1, de2, de3], onFamilyChanged, onStored }, d)
    d.flush()
    expect(await done).toEqual({ ok: true, cells: { stock_qty: { ok: true } } })
    expect(d.patch).toHaveBeenCalledTimes(1)
    expect(d.patch).toHaveBeenCalledWith('root', [{ rowId: 'v1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 10, expectedVersion: 7, expectedListingId: 'L-IT-1' }], { accountId: 'acc-1' })
    expect(d.read).toHaveBeenCalledTimes(1)
    expect(de1.listing!.version).toBe(4)
    expect(de1.stock!.cells!.version).toBe(8)
    expect(de1.stock!.cells!.sync!.mode).toBe('PINNED')
    expect(stockEditPending(de1)).toBe(false)
    expect(onFamilyChanged).toHaveBeenCalledWith([de2], ['stock_mode', 'stock_qty', 'stock_buffer', 'listing_asin', 'listing_item_id'])
    expect(onStored).toHaveBeenCalledWith({ patched: [de1], columns: ['stock_qty', 'stock_mode', 'stock_buffer', 'listing_asin'] })
    expect(d.announce).toHaveBeenCalledWith('root', [{ listingId: 'L-IT-1', productId: 'v1', version: 8 }, { listingId: 'L-DE-1', productId: 'v1', version: 4 }], ['quantityMode', 'quantity'])
    // The sheet's own echo: every listing the write moved is already known.
    expect(knownListingVersions([de1]).get('L-IT-1')).toBe(8)
  })

  it('refused: the door\'s sentence verbatim, nothing re-read, and the cell shows the stored value again', async () => {
    const r = row('v1')
    const stored = r.stock!.cells
    const d = deps((cs) => cs.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'refused', reason: 'Shared stock — this SKU sells from Moto Lender\'s stock', version: 7 })))
    applyStockValue(r, 'syncQty', 10)
    const done = commitStockCells(req(r, [{ colId: 'stock_qty', value: 10 }]), {}, d)
    d.flush()
    expect(await done).toEqual({ ok: false, cells: { stock_qty: { ok: false, reason: 'Shared stock — this SKU sells from Moto Lender\'s stock' } }, reason: 'Shared stock — this SKU sells from Moto Lender\'s stock' })
    expect(d.read).not.toHaveBeenCalled()
    expect(d.announce).not.toHaveBeenCalled()
    expect(r.stock!.cells).toBe(stored)
    expect(stockEditPending(r)).toBe(false)
  })

  it('conflict: "Changed elsewhere — reloaded", marked a conflict, the current version adopted, then the Matrix re-read', async () => {
    const r = row('v1')
    const fresh = cells({ version: 9, sync: { ...cells().sync!, intended: 30 } })
    const d = deps((cs) => cs.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: 9 })),
      () => readOf([{ id: 'v1', cells: { 'AMAZON:EU': fresh } }]))
    const done = commitStockCells(req(r, [{ colId: 'stock_buffer', value: 5 }]), {}, d)
    d.flush()
    expect(await done).toEqual({ ok: false, conflict: true, cells: { stock_buffer: { ok: false, reason: 'Changed elsewhere — reloaded' } }, reason: 'Changed elsewhere — reloaded' })
    expect(d.read).toHaveBeenCalledTimes(1)
    expect(r.stock!.cells).toEqual(fresh)
    expect(d.announce).not.toHaveBeenCalled()
  })

  it('applied but the Matrix read failed: the sheet owes its quiet read', async () => {
    const r = row('v1')
    const d = deps((cs) => cs.map((c) => applied(c, [{ listingId: 'L-IT-1', productId: 'v1', version: 8 }])), () => null)
    const onStored = vi.fn()
    const done = commitStockCells(req(r, [{ colId: 'stock_mode', value: 'PINNED' }]), { onStored }, d)
    d.flush()
    expect((await done).ok).toBe(true)
    expect(onStored).toHaveBeenCalledWith({ read: STOCK_READ_FAILED })
    expect(r.stock!.cells!.version).toBe(8)
  })

  it('a lost answer is unreachable, never a refusal', async () => {
    const d = deps(() => { throw new Error('Failed to fetch') })
    const done = commitStockCells(req(row('v1'), [{ colId: 'stock_qty', value: 3 }]), {}, d)
    d.flush()
    expect(await done).toMatchObject({ ok: false, unreachable: true })
  })
})

describe('the batch — every row of one tick, ONE patchMatrix, each answer back to its row', () => {
  it('three rows → one call with three cells; each row hears its own outcome', async () => {
    const rows = [row('v1'), row('v2', { n: 2 }), row('v3', { n: 3 })]
    const d = deps((cs) => cs.map((c) => (c.rowId === 'v2'
      ? { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'refused' as const, reason: MATRIX_COPY.amazonManaged, version: c.expectedVersion }
      : applied(c))), () => readOf([]))
    const results = rows.map((r) => commitStockCells(req(r, [{ colId: 'stock_qty', value: 5 }]), { familyRows: () => rows }, d))
    d.flush()
    const answers = await Promise.all(results)
    expect(d.patch).toHaveBeenCalledTimes(1)
    expect((d.patch as ReturnType<typeof vi.fn>).mock.calls[0][1].map((c: MatrixWriteCell) => c.rowId)).toEqual(['v1', 'v2', 'v3'])
    expect(answers.map((a) => a.cells?.stock_qty)).toEqual([{ ok: true }, { ok: false, reason: 'Amazon-managed' }, { ok: true }])
    expect(d.read).toHaveBeenCalledTimes(1)
  })

  it('two cells on the same listing: the second follows in a next round at the version the first answered with', async () => {
    const r = row('v1')
    const sent: MatrixWriteCell[][] = []
    const d = deps((cs) => { sent.push([...cs]); return cs.map((c) => applied(c)) }, () => readOf([]))
    const done = commitStockCells(req(r, [{ colId: 'stock_mode', value: 'PINNED' }, { colId: 'stock_qty', value: 9 }]), {}, d)
    d.flush()
    expect((await done).ok).toBe(true)
    expect(sent.map((round) => round.map((c) => [c.cell, c.expectedVersion]))).toEqual([[['syncMode', 7]], [['syncQty', 8]]])
  })

  it('a conflict on the first cell answers the second without sending it', async () => {
    const d = deps((cs) => cs.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'conflict' as const, reason: MATRIX_COPY.changedElsewhere, version: 9 })), () => readOf([]))
    const done = commitStockCells(req(row('v1'), [{ colId: 'stock_mode', value: 'PINNED' }, { colId: 'stock_qty', value: 9 }]), {}, d)
    d.flush()
    const answer = await done
    expect(d.patch).toHaveBeenCalledTimes(1)
    expect(answer.cells).toEqual({ stock_mode: { ok: false, reason: 'Changed elsewhere — reloaded' }, stock_qty: { ok: false, reason: 'Changed elsewhere — reloaded' } })
  })

  it('the batch goes to the Matrix\'s own endpoint: PATCH /api/products/<family>/studio/matrix with the cells and the account', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ results: [], version: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const batcher = createStockWriteBatcher({
      patch: (id, cs, opts) => patchMatrix(id, cs, { ...opts, baseUrl: '', fetchImpl: fetchImpl as unknown as typeof fetch }),
      read: async () => ({ kind: 'error', message: 'unused' }),
      schedule: (run) => run(),
      announce: () => {},
    })
    const cell: MatrixWriteCell = { rowId: 'v1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 4, expectedVersion: 7, expectedListingId: 'L-IT-1' }
    await batcher.send('root', 'acc-1', [cell])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(MATRIX_ENDPOINTS.write('root'))
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ cells: [cell], accountId: 'acc-1' })
  })
})
