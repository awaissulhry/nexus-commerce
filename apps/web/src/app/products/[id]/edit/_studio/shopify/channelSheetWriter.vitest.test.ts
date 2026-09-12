import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitChannelRow } from '../sheet/channel/useChannelSheet'
import type { ChannelSheetRow } from '../sheet/channel/types'
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
