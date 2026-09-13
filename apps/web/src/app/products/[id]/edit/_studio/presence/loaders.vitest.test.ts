import { afterEach, describe, expect, it, vi } from 'vitest'
import { coordinateQuery, loadAmazonPosture, loadPresence, loadPresenceHistory, loadPresenceOne, PresenceReadError, verifyPresence } from './loaders'
import { presenceRowSchema, type ListingCoordinate } from './types'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://127.0.0.1:1' }))
afterEach(() => vi.unstubAllGlobals())
const at = '2026-09-13T12:00:00.000Z'
const coordinate: ListingCoordinate = { productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: null, aliasKey: '' }
const reportedRow = () => ({
  coordinate, label: 'XAVIA · eBay · IT', sku: 'XAVIA', sellerSku: null, sellerSkuSource: null,
  accountLabel: null, aliasLabel: null, kind: 'listing', listingId: 'listing-1', aliasId: null,
  version: 1, productVersion: 1, externalListingId: null, lastChange: null,
  intent: { value: null, at: null, by: null, reason: null, provisional: null },
  fact: { value: 'UNKNOWN', asOf: null, via: null, detail: null }, verdict: 'unknown', inFlight: false,
  gate: { mode: null, sentence: null, canVerify: false },
  connection: { state: 'unknown', asOf: null, via: null, refusal: null, authStatus: null,
    accessTokenExpiresAt: null, lastErrorAt: null, lastError: null },
  participation: { isParticipating: null, participationStatus: null, checkedAt: null },
  local: { syncPaused: null, variationExcluded: null, offerActive: null, offerActiveHonoured: null,
    offerClosedAt: null, offerClosedBy: null, offerCloseReason: null, lastSyncedAt: null,
    presenceEffectiveFrom: null, presenceUntil: null, scheduleSentence: 'These dates are a note, not an alarm.' },
  verbs: {},
})
const page = () => ({ product: { id: 'p', sku: 'XAVIA', version: 1, deletedAt: null }, readAt: at, freshnessMs: 60000,
  coverage: { scope: 'product', requestedProductId: 'p', rootProductId: 'p', products: [{ id: 'p', sku: 'XAVIA', version: 1, deletedAt: null }], complete: true },
  verifyPolicy: { maxCoordinatesPerCall: 10, maxAttemptsPerWorkspaceHour: 60, sentence: 'Server policy' }, rows: [], sources: [] })
const reply = (body: unknown, status = 200) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher); return fetcher
}
describe('presence reads preserve evidence and absence', () => {
  it('accepts a successfully reported empty list', async () => {
    const fetcher = reply(page()); expect((await loadPresence('p')).rows).toEqual([])
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['rows', 'sources', 'readAt', 'freshnessMs', 'verifyPolicy', 'coverage'])('rejects a missing %s instead of defaulting', async field => {
    const data: Record<string, unknown> = page(); delete data[field]; reply(data)
    await expect(loadPresence('p')).rejects.toMatchObject({ code: 'INVALID_PRESENCE_RESPONSE' })
  })
  it('keeps a binned product and unavailable source explicitly reported', async () => {
    const data = { ...page(), product: { ...page().product, deletedAt: at },
      sources: [{ source: 'connections', status: 'unavailable', asOf: null, refusal: 'Could not load connections' }] }
    reply(data); expect(await loadPresence('p')).toEqual(data)
  })
  it('loads a named family in one request, preserving binned members', async () => {
    const data = page(); data.coverage.scope = 'family'
    const child = { id: 'child', sku: 'XAVIA-CHILD', version: 2, deletedAt: at }
    const body = { ...data, coverage: { ...data.coverage, products: [...data.coverage.products, child] } }
    const fetcher = reply(body)
    expect((await loadPresence('p', { includeFamily: true })).coverage.products).toEqual(body.coverage.products)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0]).endsWith('/p/studio/presence?includeFamily=true')).toBe(true)
  })
  it('cannot substitute a product-only result for a requested family', async () => {
    reply(page())
    await expect(loadPresence('p', { includeFamily: true })).rejects.toMatchObject({ code: 'INVALID_PRESENCE_COVERAGE' })
  })
  it.each(['partial', 'repeated', 'missing-requested', 'missing-root'])('rejects %s coverage instead of claiming a complete set', async problem => {
    const data = page()
    const coverage = { ...data.coverage, scope: 'family', complete: problem !== 'partial',
      rootProductId: problem === 'missing-root' ? 'other' : 'p',
      requestedProductId: problem === 'missing-requested' ? 'other' : 'p',
      products: problem === 'repeated' ? [...data.coverage.products, ...data.coverage.products] : data.coverage.products }
    reply({ ...data, coverage })
    await expect(loadPresence('p', { includeFamily: true })).rejects.toMatchObject({ code: 'INVALID_PRESENCE_RESPONSE' })
  })
  it('preserves the server refusal and 409 current read verbatim', async () => {
    reply({ code: 'version_conflict', refusal: 'This coordinate changed. Read it again.', current: { version: 8 } }, 409)
    await expect(loadPresence('p')).rejects.toMatchObject({ message: 'This coordinate changed. Read it again.', status: 409, current: { version: 8 } })
  })
  it('network failure cannot return a successful empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(loadPresence('p')).rejects.toThrow('Presence could not load. The channel state is not known.')
  })
  it('unknown tokens are a visible contract error, never a guessed state', () => {
    const row = reportedRow()
    expect(presenceRowSchema.safeParse(row).success).toBe(true)
    expect(presenceRowSchema.safeParse({ ...row, fact: { ...row.fact, value: 'NEW_SELLING' } }).success).toBe(false)
  })
})
describe('a coordinate names every level', () => {
  it('keeps explicit null account and empty primary alias distinct from omission', () => {
    expect(coordinateQuery(coordinate).toString()).toBe('channel=EBAY&market=IT&accountId=null&aliasKey=')
    for (const key of Object.keys(coordinate)) {
      const partial = { ...coordinate } as Record<string, unknown>; delete partial[key]
      expect(() => coordinateQuery(partial as unknown as ListingCoordinate), key).toThrow()
    }
  })
  it('retains punctuation without redirecting the address', () => {
    const query = coordinateQuery({ ...coordinate, channelConnectionId: 'a & b', aliasKey: 'x=y' })
    expect(query.get('accountId')).toBe('a & b'); expect(query.get('aliasKey')).toBe('x=y')
  })
  it('one and history send the supplied coordinate and opaque cursor', async () => {
    const fetcher = reply({ ...page(), row: null })
    await expect(loadPresenceOne(coordinate)).rejects.toBeInstanceOf(PresenceReadError)
    expect(String(fetcher.mock.calls[0][0])).toContain('/one?channel=EBAY&market=IT&accountId=null&aliasKey=')
    const history = { coordinate, readAt: at, events: [], identities: [], nextCursor: null }
    reply(history)
    expect(await loadPresenceHistory(coordinate, { cursor: 'opaque+/=', limit: 20 })).toEqual(history)
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    expect(url.searchParams.get('cursor')).toBe('opaque+/=')
  })
  it('accepts the exact coordinate with null intent and unknown fact intact', async () => {
    const body = { readAt: at, freshnessMs: 60000, verifyPolicy: page().verifyPolicy, row: reportedRow() }
    reply(body); expect(await loadPresenceOne(coordinate)).toEqual(body)
  })
  it.each(['productId', 'channel', 'marketplace', 'channelConnectionId', 'aliasKey'])('refuses a one-read naming another %s', async field => {
    const row = reportedRow()
    reply({ readAt: at, freshnessMs: 60000, verifyPolicy: page().verifyPolicy,
      row: { ...row, coordinate: { ...coordinate, [field]: 'different' } } })
    await expect(loadPresenceOne(coordinate)).rejects.toMatchObject({ code: 'INVALID_PRESENCE_COORDINATE' })
  })
  it('rejects a row outside the named family coverage', async () => {
    const data = page(); data.coverage.scope = 'family'
    const row = reportedRow()
    reply({ ...data, rows: [{ ...row, coordinate: { ...coordinate, productId: 'uncovered' } }] })
    await expect(loadPresence('p', { includeFamily: true })).rejects.toMatchObject({ code: 'INVALID_PRESENCE_RESPONSE' })
  })
  it('posture refuses another channel before transport', () => {
    const fetcher = reply({}); expect(() => loadAmazonPosture(coordinate)).toThrow('requires an Amazon coordinate')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('verify sends a deliberate channel read and retains could-not-ask', async () => {
    const data = { readAt: at, results: [{ coordinate, outcome: 'could-not-ask', persisted: false,
      fact: { value: 'UNKNOWN', asOf: null, via: null, detail: null }, refusal: 'The grant expired.', errorCode: 'GRANT_EXPIRED' }] }
    const fetcher = reply(data)
    expect(await verifyPresence('p', [coordinate], 'Operator check')).toEqual(data)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ coordinates: [coordinate], reason: 'Operator check' }) })
    expect(() => verifyPresence('different', [coordinate], 'check')).toThrow('this product')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
