/**
 * P2 (2026-09-30) — `GET /products/:id/studio/sheet?…&cells=compact`: each column's shared cell sent once, each cell as
 * its difference. Opt-in: without the parameter the route answers exactly as before. `&patches=pooled` (2026-10-01) on
 * top sends each repeated patch once; without it the compact answer is byte for byte the same as before. The encoding itself is proven in
 * packages/shared/sheet-cell-wire.vitest.test.ts; this pins the route's contract. Also `GET /readiness?…&only=coordinate`
 * (proven on PostgreSQL in services/pim/readiness-only-coordinate.vitest.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { decodeSheetCells, encodeSheetCells, POOLED_SHEET_CELL_ENCODING, SHEET_CELL_ENCODING } from '@nexus/shared/sheet-cell-wire'

const mocks = vi.hoisted(() => ({ sheet: vi.fn(), readiness: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/pim/studio-sheet.service.js', () => ({
  getStudioSheet: mocks.sheet, UnknownProductError: class extends Error {}, ScopeNotAvailableError: class extends Error {},
}))
vi.mock('../services/pim/scope-readiness.service.js', () => ({ getProductReadiness: mocks.readiness }))
import routes from './product-studio.routes.js'

const ROWS = 21, COLUMNS = 40
/** A channel sheet shaped as studio-sheet.service.ts builds it, with synthetic ids. */
function sheet() {
  const cell = (row: number, column: number) => ({
    value: row % 3 ? `value ${row}-${column}` : null, source: row % 2 ? 'channelExplicit' : 'inherited', inheritedFrom: row % 2 ? null : 'parent',
    inherited: row % 2 === 0,
    mapped: { value: row % 3 ? `value ${row}-${column}` : null, derived: false, sourceOwner: { kind: 'listing', label: 'Listing settings', path: `listing.platformAttributes.f${column}` },
      status: 'mapped', provenance: 'override', sourcePath: null, fallbackPath: null, usesExpression: false, legacySource: 'source', appliedTransforms: [],
      warnings: [], errors: [], mappingErrors: [], autoCorrected: null, requiredByRule: false, overLimit: null },
    layer: 'channel', pinned: row % 2 === 1, follows: false, editable: true, linkGroupId: null, writeField: `attr_f${column}`, writeVerb: 'channel',
    writeTarget: 'channelListing', affectsAllChannels: false, writable: true, writeBlockedReason: null,
    contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } },
  })
  return {
    scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', connectionId: 'account-1' }, family: {}, groups: [], aliases: [],
    columns: Array.from({ length: COLUMNS }, (_, c) => ({ key: `f${c}`, label: `Field ${c}` })),
    rows: Array.from({ length: ROWS }, (_, r) => ({ id: `p${r}`, sku: `SKU-${r}`, version: 1, listing: { id: `l${r}`, version: 3 },
      values: Object.fromEntries(Array.from({ length: COLUMNS }, (_, c) => [`f${c}`, cell(r, c)])) })),
    meta: { tookMs: 5, schemaMissing: [], schemaAge: [] },
  }
}

let app: FastifyInstance
beforeAll(async () => {
  mocks.sheet.mockImplementation(async () => sheet())
  mocks.readiness.mockResolvedValue({ market: 'IT', locale: 'it', scopes: [], matrix: [], computedAt: '2026-09-30T00:00:00.000Z' })
  app = Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
})
afterAll(() => app.close())

describe('the compact sheet read', () => {
  const url = '/products/p/studio/sheet?scope=channel&channel=EBAY&market=IT&accountId=account-1&locale=it'

  it('answers today\'s shape unless the reader asks for the compact one', async () => {
    const plain = await app.inject(url)
    expect(plain.statusCode).toBe(200)
    expect(plain.json().meta.cellEncoding).toBeUndefined()
    expect(plain.json().rows[0].values.f0.contentAddress).toEqual({ tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } })
  })

  it('decodes to the same sheet at ≤ 200 bytes a cell', async () => {
    const plain = await app.inject(url)
    const compact = await app.inject(`${url}&cells=compact`)
    expect(compact.statusCode).toBe(200)
    expect(decodeSheetCells(compact.json())).toEqual(plain.json())
    const cells = ROWS * COLUMNS
    expect(plain.body.length / cells).toBeGreaterThan(700)
    expect(compact.body.length / cells).toBeLessThanOrEqual(200)
  })

  it('answers the compact form byte for byte as before unless the reader also asks for pooled patches', async () => {
    const compact = await app.inject(`${url}&cells=compact`)
    expect(compact.json().meta.cellEncoding).toBe(SHEET_CELL_ENCODING)
    expect(compact.body).toBe(JSON.stringify(encodeSheetCells(sheet())))
    // A value the route does not know is ignored, as an older API ignores the whole parameter.
    expect((await app.inject(`${url}&cells=compact&patches=other`)).body).toBe(compact.body)
    // Pooled patches ride on the compact form only; alone they change nothing.
    const plain = await app.inject(url)
    expect((await app.inject(`${url}&patches=pooled`)).body).toBe(plain.body)
  })

  it('answers pooled patches only to a reader that asks, smaller and decoding to the same sheet', async () => {
    // Repeated patches as real sheets have them: the first row's cells keep their keys in another order.
    mocks.sheet.mockImplementation(async () => reordered())
    const [plain, compact, pooled] = await Promise.all([url, `${url}&cells=compact`, `${url}&cells=compact&patches=pooled`].map(read => app.inject(read)))
      .finally(() => mocks.sheet.mockImplementation(async () => sheet()))
    expect(pooled.statusCode).toBe(200)
    expect(pooled.json().meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    expect(Buffer.byteLength(pooled.body)).toBeLessThan(Buffer.byteLength(compact.body))
    expect(JSON.stringify(decodeSheetCells(pooled.json()))).toBe(plain.body)
    expect(JSON.stringify(decodeSheetCells(compact.json()))).toBe(plain.body)
  })
})

/** `sheet()` with the parent row's cells in another key order than every other row's, as localized content has them. */
function reordered() {
  const read = sheet()
  const first = read.rows[0].values as Record<string, Record<string, unknown>>
  for (const field of Object.keys(first)) first[field] = Object.fromEntries(Object.entries(first[field]).reverse())
  return read
}

describe('the coordinate-only readiness read', () => {
  const url = '/products/p/readiness?market=IT&locale=it&channel=EBAY&accountId=account-1'

  it('asks the service for the named coordinate only when the reader says so', async () => {
    mocks.readiness.mockClear()
    expect((await app.inject(url)).statusCode).toBe(200)
    expect(mocks.readiness).toHaveBeenLastCalledWith(expect.not.objectContaining({ onlyCoordinate: true }))
    expect((await app.inject(`${url}&only=coordinate`)).statusCode).toBe(200)
    expect(mocks.readiness).toHaveBeenLastCalledWith(expect.objectContaining({ productId: 'p', channel: 'EBAY', accountId: 'account-1', onlyCoordinate: true }))
  })

  it('refuses an `only` it does not know instead of answering the whole family', async () => {
    mocks.readiness.mockClear()
    const result = await app.inject(`${url}&only=channel`)
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe('bad_only')
    expect(mocks.readiness).not.toHaveBeenCalled()
  })
})
