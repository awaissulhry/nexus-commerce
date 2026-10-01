import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitChannelRow } from '../sheet/channel/useChannelSheet'
import type { ChannelSheetRow } from '../sheet/channel/types'
import { createShopifyBulkPost, orderShopifyColumnRequests } from './channelSheetWriter'
import { runBulkOperation, type BulkSavePost } from '../sheet/bulkOperation'
import type { SheetWriteRequest } from '@/design-system/grid'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => '' }))
afterEach(() => vi.unstubAllGlobals())
const address = { ownerId: 'gid://shopify/Product/10', fieldId: 'title', token: 'observed', baseline: 'Listed title' }
const row = () => ({ id: 'nexus-root', rowId: 'alias:nexus-root', version: 3, aliasId: 'alias-a', listing: { id: 'listing-a', version: 7 }, shopify: { productId: 'nexus-root', listingId: 'listing-a' }, values: {
  name: { value: 'Draft', writable: true, shopifyWrite: address },
  brand: { value: 'Shared', writable: true, writeField: 'brand', writeTarget: 'master', writeVerb: 'master' },
} }) as unknown as ChannelSheetRow
const coord = { channel: 'SHOPIFY' as const, marketplace: 'GLOBAL', accountId: 'store-b', locale: 'fr' }
describe('common sheet Shopify writer', () => {
  it('batches exact destination cells, chains the cell token and advances only the matching listing version', async () => {
    const current = row(), fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: { name: { ok: true, shopifyWrite: { ...address, token: 'saved' } } }, listing: { id: 'listing-a', version: 8 } })))
    vi.stubGlobal('fetch', fetcher)
    const result = await commitChannelRow({ rowId: current.rowId, row: current, expectedVersion: 3, cells: [{ colId: 'name', value: '', intent: 'set' }] }, coord)
    expect(result.ok).toBe(true)
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/nexus-root/shopify-linked/cells?accountId=store-b&listingId=listing-a&market=GLOBAL&locale=fr')
    expect(JSON.parse(options.body as string).cells[0]).toMatchObject({ ...address, value: '', intent: 'set' })
    expect(current.values.name.shopifyWrite?.token).toBe('saved'); expect(current.listing?.version).toBe(8); expect(current.version).toBe(3)
  })
  it('keeps a native conflict visible when a shared field in the same batch saves', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/bulk') ? { updated: 1, versionOf: 'product', currentVersion: 4 } : { ok: false, cells: { name: { ok: false, reason: 'Another editor changed this cell' } } })))
    vi.stubGlobal('fetch', fetcher)
    const current = row(), result = await commitChannelRow({ rowId: current.rowId, row: current, expectedVersion: 3, cells: [{ colId: 'name', value: 'New', intent: 'set' }, { colId: 'brand', value: 'Shared', intent: 'set' }] }, coord)
    expect(result).toMatchObject({ ok: false, version: 4, cells: { brand: { ok: true }, name: { ok: false } } })
    expect(current.values.name.shopifyWrite?.token).toBe('observed'); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('leaves interrupted requests unconfirmed for common sheet readback recovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection lost') }))
    const current = row(), result = await commitChannelRow({ rowId: current.rowId, row: current, cells: [{ colId: 'name', value: null, intent: 'set' }] }, coord)
    expect(result).toMatchObject({ ok: false, unreachable: true }); expect(current.values.name.shopifyWrite?.token).toBe('observed')
  })
  it('does not acknowledge a successful response for another owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: { name: { ok: true, shopifyWrite: { ...address, ownerId: 'gid://shopify/Product/999' } } } }))))
    const current = row(), result = await commitChannelRow({ rowId: current.rowId, row: current, cells: [{ colId: 'name', value: 'New', intent: 'set' }] }, coord)
    expect(result).toMatchObject({ ok: false, unreachable: true })
    expect(current.values.name.shopifyWrite).toEqual(address)
  })
})

const request = (index: number, extra: Record<string, unknown> = {}): SheetWriteRequest<ChannelSheetRow> => {
  const current = row()
  current.id = `nexus-${index}`; current.rowId = `alias:nexus-${index}`
  current.values.name.shopifyWrite = { ...address, ownerId: `gid://shopify/Product/${index + 10}`, ...extra }
  return { rowId: current.rowId, row: current, cells: [{ colId: 'name', value: `Value ${index}`, intent: 'pin' }] }
}
const successfulCells = (body: { cells: Array<Record<string, unknown>> }) => ({ ok: true, cells: Object.fromEntries(body.cells.map(cell => [cell.receiptKey ?? cell.colId, { ok: true,
  shopifyWrite: { ownerId: cell.ownerId, fieldId: cell.fieldId, baseline: cell.baseline, token: `saved-${cell.ownerId}` } }])) })
const jsonAnswer = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

describe('Shopify Set column through the existing bulk operation', () => {
  it('batches 2001 owners in one column with one stable action ID over both chunk boundaries', async () => {
    const calls: Array<{ operationId: string; cells: Array<Record<string, unknown>> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body)
      return new Response(JSON.stringify(successfulCells(body)))
    }))
    const requests = Array.from({ length: 2001 }, (_, index) => request(index))
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), {
      operationId: 'engine-operation', post: createShopifyBulkPost('stable-column-action'),
    })
    expect(calls.map(call => call.cells.length)).toEqual([1000, 1000, 1])
    expect(new Set(calls.map(call => call.operationId))).toEqual(new Set(['stable-column-action']))
    expect(new Set(calls.flatMap(call => call.cells.map(cell => cell.receiptKey))).size).toBe(2001)
    expect([...results.values()].every(result => result.ok)).toBe(true)
    for (const req of requests) expect(req.row!.values.name.shopifyWrite?.token).toBe(`saved-${req.row!.values.name.shopifyWrite?.ownerId}`)
  })
  it('groups only exact family, listing, account and locale destinations', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => { urls.push(String(url)); return new Response(JSON.stringify(successfulCells(JSON.parse(options.body)))) }))
    const requests = [request(0), request(1), request(2)]
    requests[1].row!.shopify = { productId: 'another-family', listingId: 'another-listing' }
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, ...(req === requests[2] ? { locale: 'it', accountId: 'other-store' } : {}), bulkSend }), { post: createShopifyBulkPost('action-a') })
    expect(urls).toHaveLength(3)
    expect(urls.some(url => url.includes('another-family') && url.includes('listingId=another-listing'))).toBe(true)
    expect(urls.some(url => url.includes('accountId=other-store') && url.includes('locale=it'))).toBe(true)
    expect([...results.values()].every(result => result.ok)).toBe(true)
  })
  it('retains per-owner successes and refusals on the same physical column', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body), result = successfulCells(body)
      result.cells[body.cells[1].receiptKey] = { ok: false, reason: 'A different editor changed this cell' } as any
      result.ok = false
      return new Response(JSON.stringify(result))
    }))
    const requests = [request(0), request(1)]
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: createShopifyBulkPost('action-a') })
    expect(results.get(requests[0].rowId)).toMatchObject({ ok: true, cells: { name: { ok: true } } })
    expect(results.get(requests[1].rowId)).toMatchObject({ ok: false, cells: { name: { ok: false, reason: expect.stringContaining('different editor') } } })
    expect(requests[0].row!.values.name.shopifyWrite?.token).toContain('saved-')
    expect(requests[1].row!.values.name.shopifyWrite?.token).toBe('observed')
  })
  it('forwards ordinary-only requests and their verified retry contract unchanged', async () => {
    const answer = jsonAnswer({ nothingSaved: true, retryable: true, code: 'DATABASE_BUSY' }, 503)
    const ordinary = vi.fn<BulkSavePost>(async () => answer), units = [{ key: 'one', changes: [{ id: 'one', value: 'x' }] }]
    const response = await createShopifyBulkPost('action-a', { postOrdinary: ordinary })('callback-id:3:4', units)
    expect(response).toBe(answer)
    expect(ordinary).toHaveBeenCalledExactlyOnceWith('callback-id:3:4', units)
  })
  it('stops unsent groups on disposal while retaining the in-flight group answer', async () => {
    const controller = new AbortController(), requests = [request(0), request(1)]
    requests[1].row!.shopify = { productId: 'another-family', listingId: 'another-listing' }
    const fetcher = vi.fn(async (_url, options) => { controller.abort(); return new Response(JSON.stringify(successfulCells(JSON.parse(options.body)))) })
    vi.stubGlobal('fetch', fetcher)
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: createShopifyBulkPost('action-a', { signal: controller.signal }) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(results.get(requests[0].rowId)?.ok).toBe(true)
    expect(results.get(requests[1].rowId)).toMatchObject({ ok: false, cells: { name: { ok: false } } })
  })
  it('orders follower detach, source changes and follower attach across the whole column action', () => {
    const source = request(0, { sharing: { sourceOwnerId: 'gid://shopify/Product/10', follows: false } })
    const follower = request(1, { sharing: { sourceOwnerId: 'gid://shopify/Product/10', follows: true } })
    const reset = request(2, { sharing: { sourceOwnerId: 'gid://shopify/Product/10', follows: false } })
    reset.cells[0].intent = 'reset'
    expect(orderShopifyColumnRequests([source, reset, follower])).toEqual([follower, source, reset])
    expect([source, reset, follower].map(req => req.rowId)).toEqual([source.rowId, reset.rowId, follower.rowId])
  })
})

describe('Shopify column actions keep every token valid across both chunk boundaries', () => {
  const label = 'metafield:PRODUCT:custom.label', source = 'gid://shopify/Product/10'
  const shared = (index: number, follows: boolean, intent: 'pin' | 'reset' = 'pin') => {
    const req = request(index, { fieldId: label, token: `f:${index + 10}:0`, sharing: { sourceOwnerId: source, follows } })
    req.cells[0].intent = intent
    return req
  }
  /** A fake cells route with the server's token rule: a follower's token holds the source's current draft version. */
  function sharingServer() {
    const state = { sourceVersion: 0, following: new Set<string>(), calls: [] as Array<{ operationId: string; owners: string[] }> }
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string) as { operationId: string; cells: Array<Record<string, string>> }
      state.calls.push({ operationId: body.operationId, owners: body.cells.map(cell => cell.ownerId) })
      const cells: Record<string, unknown> = {}
      for (const cell of body.cells) {
        const owner = cell.ownerId, number = owner.split('/').at(-1)
        if (owner === source) { state.sourceVersion++; cells[cell.receiptKey] = { ok: true, shopifyWrite: { ownerId: owner, fieldId: label, token: `s:${state.sourceVersion}`, sharing: { sourceOwnerId: source, follows: false } } }; continue }
        if (cell.intent === 'reset') {
          state.following.add(owner)
          cells[cell.receiptKey] = { ok: true, shopifyWrite: { ownerId: owner, fieldId: label, token: `f:${number}:${state.sourceVersion}`, sharing: { sourceOwnerId: source, follows: true } } }
          continue
        }
        cells[cell.receiptKey] = cell.token === `f:${number}:${state.sourceVersion}`
          ? { ok: true, shopifyWrite: { ownerId: owner, fieldId: label, token: `own:${number}`, sharing: { sourceOwnerId: source, follows: false } } }
          : { ok: false, reason: 'Another editor changed this draft cell.' }
      }
      return new Response(JSON.stringify({ ok: Object.values(cells).every(cell => (cell as { ok: boolean }).ok), cells }))
    })
    return { state, fetcher }
  }

  it('detaches 2000 followers before the source moves and attaches the reset follower last, over 1000-cell and 2000-unit chunks', async () => {
    const { state, fetcher } = sharingServer()
    vi.stubGlobal('fetch', fetcher)
    const reset = shared(5000, false, 'reset')
    const sourceRow = request(0, { fieldId: label, token: 's:0', sharing: { sourceOwnerId: source, follows: false } })
    const followers = Array.from({ length: 2000 }, (_, index) => shared(index + 1, true))
    const requests = [reset, sourceRow, ...followers]
    const results = await runBulkOperation(orderShopifyColumnRequests(requests), (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), {
      post: createShopifyBulkPost('stable-action'),
    })
    expect(state.calls.map(call => call.owners.length)).toEqual([1000, 1000, 2])
    expect(state.calls.at(-1)!.owners).toEqual([source, 'gid://shopify/Product/5010'])
    expect(new Set(state.calls.map(call => call.operationId))).toEqual(new Set(['stable-action']))
    expect([...results.values()].filter(result => !result.ok)).toEqual([])
    // The attached follower's returned token holds the source's FINAL version: its next save is not a false conflict.
    expect(reset.row!.values.name.shopifyWrite?.token).toBe(`f:5010:${state.sourceVersion}`)
  })
  it('without the row ordering, a follower in the next 2000-unit chunk is refused (the ordering is load-bearing)', async () => {
    // Inside one post the units are ordered too; only the outer engine boundary depends on the row order.
    for (const ordered of [false, true]) {
      const { fetcher } = sharingServer()
      vi.stubGlobal('fetch', fetcher)
      const requests = [request(0, { fieldId: label, token: 's:0', sharing: { sourceOwnerId: source, follows: false } }), ...Array.from({ length: 2000 }, (_, index) => shared(index + 1, true))]
      const results = await runBulkOperation(ordered ? orderShopifyColumnRequests(requests) : requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: createShopifyBulkPost(`order-${ordered}`) })
      expect([...results.entries()].filter(([, result]) => !result.ok).map(([rowId]) => rowId)).toEqual(ordered ? [] : [requests[2000].rowId])
    }
  })
  it('a lost first answer leaves its rows unconfirmed while the next request of the SAME action still goes', async () => {
    const calls: Array<{ operationId: string; receipts: string[] }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string)
      calls.push({ operationId: body.operationId, receipts: body.cells.map((cell: { receiptKey: string }) => cell.receiptKey) })
      if (calls.length === 1) throw new TypeError('Failed to fetch') // committed on the server, answer lost
      return new Response(JSON.stringify(successfulCells(body)))
    }))
    const requests = Array.from({ length: 1001 }, (_, index) => request(index))
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: createShopifyBulkPost('action-lost') })
    expect(calls.map(call => [call.operationId, call.receipts.length])).toEqual([['action-lost', 1000], ['action-lost', 1]])
    expect(new Set(calls.flatMap(call => call.receipts)).size).toBe(1001)
    expect(requests.slice(0, 1000).every(req => results.get(req.rowId)?.unreachable === true)).toBe(true)
    expect(requests.slice(0, 1000).every(req => req.row!.values.name.shopifyWrite?.token === 'observed')).toBe(true)
    expect(results.get(requests[1000].rowId)).toMatchObject({ ok: true })
  })
  it('a mixed operation keeps the ordinary part on bulk-save with its retry, and never resends Shopify cells', async () => {
    const shopifyCalls = vi.fn(async (_url: string, options: RequestInit) => new Response(JSON.stringify(successfulCells(JSON.parse(options.body as string)))))
    vi.stubGlobal('fetch', shopifyCalls)
    let ordinaryCalls = 0
    const ordinary = vi.fn<BulkSavePost>(async (_id, units) => ++ordinaryCalls === 1
      ? { status: 503, ok: false, retryAfter: '0', json: async () => ({ nothingSaved: true, retryable: true, code: 'DATABASE_BUSY' }) }
      : jsonAnswer({ units: units.map(unit => ({ key: unit.key, status: 200, body: { updated: 1, versionOf: 'product', currentVersion: 4 } })) }))
    const native = request(0), plain = row()
    plain.id = 'nexus-plain'; plain.rowId = 'alias:nexus-plain'
    const requests: SheetWriteRequest<ChannelSheetRow>[] = [native, { rowId: plain.rowId, row: plain, expectedVersion: 3, cells: [{ colId: 'brand', value: 'Shared', intent: 'set' }] }]
    const results = await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: createShopifyBulkPost('mixed', { postOrdinary: ordinary }) })
    expect(ordinary).toHaveBeenCalledTimes(2)
    expect(ordinary.mock.calls.every(([, units]) => units.length === 1 && !('shopifyCells' in units[0]))).toBe(true)
    expect(shopifyCalls).toHaveBeenCalledTimes(1)
    expect(results.get(native.rowId)).toMatchObject({ ok: true })
    expect(results.get(plain.rowId)).toMatchObject({ ok: true })
  })
  it('a group the server partly refused is answered per cell, never as nothing saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string), result = successfulCells(body)
      result.cells[body.cells[0].receiptKey] = { ok: false, reason: 'Shopify needs this field' } as never
      return new Response(JSON.stringify({ ...result, ok: false }))
    }))
    let seen: unknown
    const post = createShopifyBulkPost('partial')
    const spy: BulkSavePost = async (id, units) => { const response = await post(id, units); seen = await response.json(); return { ...response, json: async () => seen } }
    const requests = [request(0), request(1)]
    await runBulkOperation(requests, (req, bulkSend) => commitChannelRow(req, { ...coord, bulkSend }), { post: spy })
    expect(JSON.stringify(seen)).not.toContain('nothingSaved')
    expect((seen as { units: Array<{ status: number; body: { ok: boolean } }> }).units.map(unit => [unit.status, unit.body.ok])).toEqual([[200, false], [200, true]])
  })
  it('keeps the old single-row wire: no receipt keys, no action id, answers keyed by column', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: { name: { ok: true, shopifyWrite: { ...address, token: 'saved', sharing: null } } } })))
    vi.stubGlobal('fetch', fetcher)
    const current = row()
    current.values.name.shopifyWrite = { ...address, sharing: { sourceOwnerId: 'gid://shopify/Product/20', follows: true } }
    expect((await commitChannelRow({ rowId: current.rowId, row: current, cells: [{ colId: 'name', value: 'New', intent: 'set' }] }, coord)).ok).toBe(true)
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(Object.keys(sent)).toEqual(['cells'])
    expect(sent.cells[0]).not.toHaveProperty('receiptKey')
    // Sharing facts are never sent as part of a write.
    expect(sent.cells[0]).not.toHaveProperty('sharing')
  })
})
