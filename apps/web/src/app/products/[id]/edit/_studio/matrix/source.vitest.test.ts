import { describe, expect, it } from 'vitest'

import { MATRIX_ENDPOINTS } from './contract'
import { fetchMatrix, parseMatrixRead, patchMatrix } from './source'

const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchOnce = (res: Response | Error, seen: Array<{ url: string; init?: RequestInit }> = []): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push({ url: String(input), init }); if (res instanceof Error) throw res; return res }) as typeof fetch

const LIVE = {
  version: 59, productId: 'p', generatedAt: '2026-09-13T00:00:00Z',
  coordinates: [{ key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', currency: 'EUR', connected: true, cells: ['listing', 'price', 'bogus'], listed: 19, draft: 1 }],
  rows: [{ id: 'r1', sku: 'S1', role: 'variant', stock: { available: 4, uncounted: false, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {} }],
}

describe('parseMatrixRead — the ONE parse boundary refuses half a Matrix', () => {
  it('refuses a body with no coordinates, with a sentence', () => {
    const r = parseMatrixRead({ rows: [] }, 'p')
    expect('problem' in r && r.problem).toMatch(/no `coordinates`/)
  })
  it('refuses a body with no rows', () => {
    const r = parseMatrixRead({ coordinates: [] }, 'p')
    expect('problem' in r && r.problem).toMatch(/no `rows`/)
  })
  it('refuses a non-object and a coordinate without a key', () => {
    expect('problem' in parseMatrixRead(null, 'p')).toBe(true)
    expect('problem' in parseMatrixRead({ coordinates: [{}], rows: [] }, 'p')).toBe(true)
    expect('problem' in parseMatrixRead({ coordinates: [], rows: [{}] }, 'p')).toBe(true)
  })
  it('parses a live body: source is live, unknown cell kinds are dropped, counts stay numbers, absent counts stay null', () => {
    const r = parseMatrixRead(LIVE, 'p')
    if ('problem' in r) throw new Error(r.problem)
    expect(r.read.source).toBe('live')
    expect(r.read.version).toBe(59)
    expect(r.read.coordinates[0]!.cells).toEqual(['listing', 'price'])
    expect(r.read.coordinates[0]!.listed).toBe(19)
    expect(r.read.coordinates[0]!.draft).toBe(1)
    const bare = parseMatrixRead({ ...LIVE, coordinates: [{ key: 'EBAY:IT' }] }, 'p')
    if ('problem' in bare) throw new Error(bare.problem)
    /* 🔴 null, never 0: a count nobody sent has not been counted. */
    expect(bare.read.coordinates[0]!.listed).toBeNull()
    expect(bare.read.coordinates[0]!.channel).toBe('EBAY')
    expect(bare.read.coordinates[0]!.market).toBe('IT')
    expect(bare.read.rows[0]!.role).toBe('variant')
  })
  it('the FBA qty: a number with its locations; null stays null (no FBA row); absent or malformed reads as NOT READ, never 0', () => {
    const rowWith = (fba: unknown) => ({ ...LIVE.rows[0], fba })
    const parse = (rows: unknown[]) => { const r = parseMatrixRead({ ...LIVE, rows }, 'p'); if ('problem' in r) throw new Error(r.problem); return r.read.rows }
    const [counted, zero, none, absent, broken] = parse([
      rowWith({ units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }, { code: 7 }], updatedAt: '2026-01-02T03:04:05.000Z' }),
      rowWith({ units: 0, locations: [{ code: 'AMAZON-EU-FBA', units: 0 }], updatedAt: null }),
      rowWith(null),
      LIVE.rows[0],
      rowWith({ units: 'many' }),
    ])
    expect(counted!.fba).toEqual({ units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }], updatedAt: '2026-01-02T03:04:05.000Z' })
    expect(zero!.fba).toEqual({ units: 0, locations: [{ code: 'AMAZON-EU-FBA', units: 0 }], updatedAt: null })
    expect(none!.fba).toBeNull()
    expect(absent!.fba).toBeUndefined()
    expect(broken!.fba).toBeUndefined()
  })
})

describe('fetchMatrix — live / error decided on the read\'s own status (no preview mode, Owner 2026-10-08)', () => {
  it('200 → live, with credentials and no-store, at the contract endpoint', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const r = await fetchMatrix('p', { baseUrl: 'http://api', accountId: 'acc', locale: 'it', fetchImpl: fetchOnce(ok(LIVE), seen) })
    expect(r.kind).toBe('live')
    expect(seen[0]!.url).toBe(`http://api${MATRIX_ENDPOINTS.read('p')}?accountId=acc&locale=it`)
    expect(seen[0]!.init?.credentials).toBe('include')
    expect(seen[0]!.init?.cache).toBe('no-store')
  })
  it('🔴 404 and 501 → error (the load-error state), never fixture cells — the read answers 404 for a product it cannot find', async () => {
    for (const status of [404, 501]) {
      const r = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(new Response('', { status })) })
      expect(r).toEqual({ kind: 'error', message: `The Matrix read was refused (HTTP ${status})` })
    }
    const said = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ error: 'Product not found' }, 404)) })
    expect(said).toEqual({ kind: 'error', message: 'Product not found' })
  })
  it('any other failing status → error with the server\'s own words; 200 with a half body → error, never preview', async () => {
    const r = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ message: 'Access denied' }, 403)) })
    expect(r).toEqual({ kind: 'error', message: 'Access denied' })
    const half = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ rows: [] })) })
    expect(half.kind).toBe('error')
  })
  it('🔴 a transport failure is an UNKNOWN outcome → error, never a picture of cells', async () => {
    const r = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(new Error('net::ERR_CONNECTION_REFUSED')) })
    expect(r).toEqual({ kind: 'error', message: 'net::ERR_CONNECTION_REFUSED' })
  })
})

describe('patchMatrix — the live write door', () => {
  it('PATCHes the contract endpoint with `{ cells }`, credentials included, and returns the body', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const cells = [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price' as const, value: 9.5, expectedVersion: 3 }]
    const out = await patchMatrix('p', cells, { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ results: [], version: 60 }), seen) })
    expect(out.version).toBe(60)
    expect(seen[0]!.url).toBe(`http://api${MATRIX_ENDPOINTS.write('p')}`)
    expect(seen[0]!.init?.method).toBe('PATCH')
    expect(seen[0]!.init?.credentials).toBe('include')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ cells })
  })
  it('sends the read\'s accountId in the body and each cell\'s expectedListingId (Amazon sheet gaps)', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const cells = [
      { rowId: 'r1', coordinateKey: 'AMAZON:EU', cell: 'syncQty' as const, value: 7, expectedVersion: 4, expectedListingId: 'L-de' },
      { rowId: 'r2', coordinateKey: 'EBAY:IT', cell: 'syncBuffer' as const, value: 2, expectedVersion: 1, expectedListingId: 'L-ebay' },
    ]
    await patchMatrix('p', cells, { accountId: 'acc-1', baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ results: [], version: 60 }), seen) })
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ cells, accountId: 'acc-1' })
  })
  it('no account → no accountId key at all', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    await patchMatrix('p', [], { accountId: null, baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ results: [], version: 1 }), seen) })
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ cells: [] })
  })
  it('a refused write throws the server\'s sentence', async () => {
    await expect(patchMatrix('p', [], { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ message: 'Version conflict' }, 409)) })).rejects.toThrow('Version conflict')
  })
})
