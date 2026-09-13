import { afterEach, expect, it, vi } from 'vitest'
import { loadDrafts } from './api'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://local.test' }))
afterEach(() => vi.unstubAllGlobals())
it('reads each selected language and retains separate draft IDs without a generation call', async () => {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url); requests.push(parsed)
    return { ok: true, json: async () => ({ drafts: [{ id: parsed.searchParams.get('locale') }], counts: { total: 1, pending: 1, failed: 0, stale: 0 } }) }
  }))
  const result = await loadDrafts({ productIds: ['p'], channel: null, marketplace: null, locales: ['de','fr'] })
  expect(requests.map(url => [url.pathname,url.searchParams.get('locale'),url.searchParams.get('channel')])).toEqual([
    ['/api/products/ai/drafts','de','master'],['/api/products/ai/drafts','fr','master'],
  ])
  expect(result.drafts.map(draft => draft.id)).toEqual(['de','fr'])
  expect(result.counts).toEqual({total:2,pending:2,failed:0,stale:0})
})
