import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, scoped: true }))
vi.mock('react', () => {
  const same = (left: unknown[], right: unknown[]) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]))
  return {
    useState: (initial: unknown) => {
      const index = h.cursor++
      h.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
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
import { useAccounts, useAdsConnections } from './channels-data'

function render(profile: string | null, kind = 'accounts') {
  h.cursor = 0
  return kind === 'accounts' ? useAccounts(0, true, profile) : useAdsConnections(0, profile)
}
const accountBody = (id: string) => ({ accounts: [{ id, channel: 'EBAY', managedBy: 'oauth', label: id, labelIsPlaceholder: false }], notConnected: [] })
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
beforeEach(() => { h.slots = []; h.cursor = 0; h.scoped = true; vi.stubGlobal('fetch', vi.fn(async () => response(accountBody('owned-account')))) })
afterEach(() => { for (const slot of h.slots) slot?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('waits for a selected profile and pins the account request to it', async () => {
  expect(render(null).data).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  render('profile-alpha')
  await vi.waitFor(() => expect(render('profile-alpha').data).not.toBeNull())
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/api/accounts?includeDisconnected=1'),
    expect.objectContaining({ headers: { 'x-nexus-workspace-id': 'profile-alpha' }, signal: expect.any(AbortSignal) }))
})

it('hides loaded Alpha accounts immediately when the selected profile changes', async () => {
  render('profile-alpha')
  await vi.waitFor(() => expect(render('profile-alpha').data).not.toBeNull())
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  expect(render('profile-beta')).toMatchObject({ data: null, loading: true, error: null })
})

it.each(['accounts', 'ads'])('ignores a late Alpha %s response even if the transport ignores cancellation', async kind => {
  const pending: Record<string, (value: Response) => void> = {}
  vi.mocked(fetch).mockImplementation((_url, init) => new Promise(resolve => { pending[new Headers(init?.headers).get('x-nexus-workspace-id') ?? 'missing'] = resolve }))
  render('profile-alpha', kind)
  const oldSignal = vi.mocked(fetch).mock.calls[0][1]?.signal
  render('profile-beta', kind)
  expect(oldSignal?.aborted).toBe(true)
  expect(pending['profile-alpha']).toBeTypeOf('function')
  expect(pending['profile-beta']).toBeTypeOf('function')
  const body = (id: string) => kind === 'accounts' ? accountBody(id) : { items: [{ id }] }
  pending['profile-beta'](response(body('beta-account')))
  await vi.waitFor(() => expect(JSON.stringify(render('profile-beta', kind).data)).toContain('beta-account'))
  pending['profile-alpha'](response(body('alpha-account')))
  await new Promise(resolve => setImmediate(resolve))
  expect(JSON.stringify(render('profile-beta', kind).data)).toContain('beta-account')
  expect(JSON.stringify(render('profile-beta', kind).data)).not.toContain('alpha-account')
})

it('does not display missing accounts as an empty verified account list', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({}))
  render('profile-alpha')
  await vi.waitFor(() => expect(render('profile-alpha')).toMatchObject({ data: null, loading: false, error: expect.any(String) }))
})

it('keeps a stalled account request bounded and retryable', async () => {
  vi.useFakeTimers()
  vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
  render('profile-alpha')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(render('profile-alpha')).toMatchObject({ data: null, loading: false, error: expect.any(String) })
})

it('retains single-profile account reads without an explicit workspace header', async () => {
  h.scoped = false
  render(null)
  await vi.waitFor(() => expect(render(null).data).not.toBeNull())
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: {} }))
})
