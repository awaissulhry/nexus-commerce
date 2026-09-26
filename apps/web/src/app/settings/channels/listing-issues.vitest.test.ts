import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, scoped: true }))
vi.mock('react', () => {
  const same = (left: unknown[], right: unknown[]) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]))
  return {
    useState: (initial: unknown) => {
      const index = h.cursor++; h.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [h.slots[index].value, (value: any) => { h.slots[index].value = typeof value === 'function' ? value(h.slots[index].value) : value }]
    },
    useRef: (initial: unknown) => { const index = h.cursor++; h.slots[index] ??= { current: initial }; return h.slots[index] },
    useCallback: (fn: unknown, deps: unknown[]) => { const index = h.cursor++; if (!same(h.slots[index]?.deps, deps)) h.slots[index] = { deps, fn }; return h.slots[index].fn },
    useEffect: (effect: () => unknown, deps: unknown[]) => {
      const index = h.cursor++
      if (!same(h.slots[index]?.deps, deps)) { h.slots[index]?.cleanup?.(); h.slots[index] = { deps, cleanup: effect() } }
    },
  }
})
vi.mock('@/lib/workspaces/paths', () => ({ get WORKSPACES_ENABLED() { return h.scoped } }))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:3212' }))
import { useListingIssues } from './useListingIssues'
const render = (account = 'account-a', profile: string | null = 'profile-a') => { h.cursor = 0; return useListingIssues(account, profile) }
const page = (connectionId = 'account-a', workspaceId = 'profile-a', ids = ['issue-a'], nextCursor: string | null = null) => ({
  connectionId, workspaceId, channel: 'AMAZON', readAt: '2026-09-25T01:00:00.000Z', nextCursor,
  items: ids.map(id => ({ id, listingId: 'listing', productId: 'product', productSku: id, marketplace: 'IT', externalListingId: null,
    code: '90220', severity: 'ERROR', message: id, attributeNames: ['size'], categories: [], source: 'amazon-feed',
    firstSeenAt: '2026-09-25T00:00:00.000Z', lastSeenAt: '2026-09-25T00:00:00.000Z', occurredAt: null })),
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { h.slots = []; h.cursor = 0; h.scoped = true; vi.stubGlobal('fetch', vi.fn(async () => response(page()))) })
afterEach(() => { for (const slot of h.slots) slot?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })
const tick = async () => { await new Promise(resolve => setImmediate(resolve)) }

it('pins a stored read to the selected profile and never requests before selection', async () => {
  expect(render('account-a', null).page).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  render(); await tick()
  expect(render().page?.items).toHaveLength(1)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/account-a/listing-issues?take=25'), expect.objectContaining({
    headers: { 'x-nexus-workspace-id': 'profile-a' }, credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal),
  }))
})
it.each(['profile', 'account'])('clears old findings immediately and ignores late responses after a %s change', async kind => {
  render(); await tick(); expect(render().page).not.toBeNull()
  const pending: Array<(value: Response) => void> = []
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  void render().reload()
  const nextAccount = kind === 'account' ? 'account-b' : 'account-a', nextProfile = kind === 'profile' ? 'profile-b' : 'profile-a'
  expect(render(nextAccount, nextProfile).page).toBeNull()
  pending[1](response(page(nextAccount, nextProfile, ['new-issue']))); await tick()
  pending[0](response(page())); await tick()
  expect(render(nextAccount, nextProfile).page?.items.map(row => row.id)).toEqual(['new-issue'])
})
it('hides already loaded findings during the first render of a different profile', async () => {
  render(); await tick(); expect(render().page?.items).toHaveLength(1)
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  expect(render('account-a', 'profile-b').page).toBeNull()
})
it.each([
  ['wrong account', () => page('wrong')], ['wrong profile', () => page('account-a', 'wrong')],
  ['missing items', () => ({})], ['bad items', () => ({ ...page(), items: [null] })],
])('shows an error instead of accepting a %s response', async (_name, make) => {
  vi.mocked(fetch).mockResolvedValueOnce(response(make()))
  render(); await tick(); expect(render()).toMatchObject({ page: null, busy: false, error: expect.any(String) })
})
it('keeps an unavailable read distinct from an empty stored result and can retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ ...page(), error: 'private server error' }, 503))
  render(); await tick(); expect(render()).toMatchObject({ page: null, busy: false, error: expect.any(String) })
  expect(render().error).not.toContain('private')
  vi.mocked(fetch).mockResolvedValueOnce(response(page('account-a', 'profile-a', [])))
  await render().reload(); expect(render()).toMatchObject({ page: { items: [], nextCursor: null }, busy: false, error: null })
})
it('appends bounded pages, deduplicates live changes and retains existing findings on load-more failure', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(page('account-a', 'profile-a', ['issue-a'], 'next-token')))
  render(); await tick()
  vi.mocked(fetch).mockResolvedValueOnce(response({}, 503)); await render().loadMore()
  expect(render().page?.items.map(row => row.id)).toEqual(['issue-a']); expect(render().error).toBeTruthy()
  vi.mocked(fetch).mockResolvedValueOnce(response(page('account-a', 'profile-a', ['issue-a', 'issue-b']))); await render().loadMore()
  expect(render().page?.items.map(row => row.id)).toEqual(['issue-a', 'issue-b'])
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('after=next-token'), expect.anything())
})
it('bounds a stalled read and preserves a retry action', async () => {
  vi.useFakeTimers()
  vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
  render(); await vi.advanceTimersByTimeAsync(15_000)
  expect(render()).toMatchObject({ page: null, busy: false, error: expect.any(String) })
})
it('allows the original single-profile deployment without a workspace header', async () => {
  h.scoped = false; vi.mocked(fetch).mockResolvedValueOnce(response(page('account-a', 'nexus_legacy_workspace')))
  render('account-a', null); await tick(); expect(render('account-a', null).page).not.toBeNull()
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: {} }))
})

it('does not duplicate a pending continuation request or fetch past the last page', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(page('account-a', 'profile-a', ['issue-a'], 'next-token')))
  render(); await tick()
  let finish!: (value: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const loading = render().loadMore(); await render().loadMore()
  expect(fetch).toHaveBeenCalledTimes(2)
  finish(response(page('account-a', 'profile-a', ['issue-b']))); await loading
  await render().loadMore(); expect(fetch).toHaveBeenCalledTimes(2)
})
