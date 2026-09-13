import { describe, expect, it } from 'vitest'

import { MATRIX_ENDPOINTS } from './contract'
import { fetchMatrix, parseMatrixRead, patchMatrix, previewCoordinateInputs, previewRowInputs } from './source'

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
})

describe('fetchMatrix — live / preview / error decided on the probe\'s own status', () => {
  it('200 → live, with credentials and no-store, at the contract endpoint', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const r = await fetchMatrix('p', { baseUrl: 'http://api', accountId: 'acc', locale: 'it', fetchImpl: fetchOnce(ok(LIVE), seen) })
    expect(r.kind).toBe('live')
    expect(seen[0]!.url).toBe(`http://api${MATRIX_ENDPOINTS.read('p')}?accountId=acc&locale=it`)
    expect(seen[0]!.init?.credentials).toBe('include')
    expect(seen[0]!.init?.cache).toBe('no-store')
  })
  it('404 and 501 → preview, naming the status it saw', async () => {
    for (const status of [404, 501]) {
      const r = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(new Response('', { status })) })
      expect(r).toEqual({ kind: 'preview', reason: `The Matrix service answered HTTP ${status}` })
    }
  })
  it('any other failing status → error with the server\'s own words; 200 with a half body → error, never preview', async () => {
    const r = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ message: 'Access denied' }, 403)) })
    expect(r).toEqual({ kind: 'error', message: 'Access denied' })
    const half = await fetchMatrix('p', { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ rows: [] })) })
    expect(half.kind).toBe('error')
  })
  it('🔴 a transport failure is an UNKNOWN outcome → error, never degraded to preview', async () => {
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
  it('a refused write throws the server\'s sentence', async () => {
    await expect(patchMatrix('p', [], { baseUrl: 'http://api', fetchImpl: fetchOnce(ok({ message: 'Version conflict' }, 409)) })).rejects.toThrow('Version conflict')
  })
})

describe('preview projections — real rows, real coordinates, contract order', () => {
  it('previewRowInputs narrows the sheet rows to what the fixture needs', () => {
    expect(previewRowInputs([{ id: 'a', sku: 'A', isParent: true, basePrice: 1, status: 'ACTIVE' }])).toEqual([{ id: 'a', sku: 'A', isParent: true, basePrice: 1, status: 'ACTIVE' }])
  })
  it('🔴 connected FIRST then channel order Amazon · eBay · Shopify · WooCommerce · Etsy; markets in TABLE order inside a channel; unconnected LAST; duplicates dropped; connected is a CHANNEL fact', () => {
    const out = previewCoordinateInputs({
      channels: [{ id: 'EBAY', label: 'eBay', markets: ['IT'] }, { id: 'AMAZON', label: 'Amazon', markets: ['IT', 'DE'] }],
      marketplaces: [
        { channel: 'ETSY', code: 'GLOBAL', name: 'Etsy', connected: false },
        { channel: 'EBAY', code: 'IT', name: 'eBay · IT', connected: true, accounts: [{ id: 'e2', primary: false }, { id: 'e1', primary: true }] },
        /* IT before DE in the table → IT before DE on the page (never re-sorted alphabetically). */
        { channel: 'AMAZON', code: 'IT', name: 'Amazon · IT', connected: true },
        { channel: 'AMAZON', code: 'DE', name: 'Amazon · DE', connected: true },
        { channel: 'AMAZON', code: 'IT', name: 'Amazon · IT (dup)', connected: true },
        /* Configured, flagged connected by the row, but its CHANNEL has no active account → not connected. */
        { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', connected: true },
      ],
    })
    expect(out.map(c => `${c.channel}:${c.market}:${c.connected}`)).toEqual(['AMAZON:IT:true', 'AMAZON:DE:true', 'EBAY:IT:true', 'SHOPIFY:GLOBAL:false', 'ETSY:GLOBAL:false'])
    expect(out.find(c => c.channel === 'EBAY')!.accountId).toBe('e1')
    expect(out.filter(c => c.channel === 'AMAZON' && c.market === 'IT').length).toBe(1)
  })
})
