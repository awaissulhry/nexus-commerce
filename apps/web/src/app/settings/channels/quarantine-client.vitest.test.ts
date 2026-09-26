import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ scoped: true }))
vi.mock('@/lib/workspaces/paths', () => ({ get WORKSPACES_ENABLED() { return state.scoped } }))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:3212' }))
import { assignQuarantineNotice, readQuarantinePage } from './quarantine-client'
const scope = { connectionId: 'chosen-account', workspaceId: 'chosen-business' }, signal = new AbortController().signal
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { state.scoped = true; vi.stubGlobal('fetch', vi.fn(async () => response({ items: [], nextCursor: null }))) })
afterEach(() => vi.unstubAllGlobals())

it('pins a metadata page to the selected business and account and never caches it', async () => {
  expect(await readQuarantinePage(scope, 'retained-cursor', signal)).toEqual({ items: [], nextCursor: null })
  expect(fetch).toHaveBeenCalledExactlyOnceWith('http://localhost:3212/api/cx/connections/chosen-account/ebay-quarantine?take=20&after=retained-cursor',
    { headers: { 'x-nexus-workspace-id': 'chosen-business' }, credentials: 'include', cache: 'no-store', signal })
})
it('assigns only the selected receipt/account with the captured profile header', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ assigned: true, receiptId: 'retained-receipt' }))
  expect(await assignQuarantineNotice(scope, 'retained-notice', signal)).toBe('retained-receipt')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('http://localhost:3212/api/cx/connections/chosen-account/ebay-quarantine/retained-notice/adopt',
    { method: 'POST', headers: { 'x-nexus-workspace-id': 'chosen-business' }, credentials: 'include', signal })
})
it.each(['read', 'assign'])('makes zero requests without a selected profile for %s', async operation => {
  const work = operation === 'read' ? readQuarantinePage({ connectionId: 'account' }, null, signal) : assignQuarantineNotice({ connectionId: 'account' }, 'notice', signal)
  await expect(work).rejects.toThrow('Choose a business profile')
  expect(fetch).not.toHaveBeenCalled()
})
it.each([{}, null, { assigned: false, receiptId: 'not-confirmed' }, { assigned: true, receiptId: '' }])('does not invent successful assignment from %j', async body => {
  vi.mocked(fetch).mockResolvedValueOnce(response(body))
  await expect(assignQuarantineNotice(scope, 'notice', signal)).rejects.toThrow('Assignment could not be confirmed')
})
it.each([{}, { items: null, nextCursor: null }, { items: [null], nextCursor: null }, { items: [], nextCursor: 1 }])('does not turn malformed metadata into an empty successful page: %j', async body => {
  vi.mocked(fetch).mockResolvedValueOnce(response(body))
  await expect(readQuarantinePage(scope, null, signal)).rejects.toThrow('could not be verified')
})
it('keeps owner-access refusal distinct from an empty quarantine', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'An owner is required.' }, 403))
  await expect(readQuarantinePage(scope, null, signal)).rejects.toMatchObject({ status: 403, message: 'An owner is required.' })
})
it('retains a complete matching metadata row and refuses unsupported topic or invalid time', async () => {
  const row = { id: 'notice-id', externalId: 'provider-id', topic: 'AUTHORIZATION_REVOCATION', environment: 'production',
    receivedAt: '2026-09-23T00:00:00Z', lastReceivedAt: '2026-09-23T00:00:00Z', deliveries: 2, reason: 'owner_unknown' }
  vi.mocked(fetch).mockResolvedValueOnce(response({ items: [row], nextCursor: null }))
  expect((await readQuarantinePage(scope, null, signal)).items).toEqual([row])
  for (const change of [{ topic: 'UNKNOWN' }, { receivedAt: 'invalid' }, { environment: 'unknown' }]) {
    vi.mocked(fetch).mockResolvedValueOnce(response({ items: [{ ...row, ...change }], nextCursor: null }))
    await expect(readQuarantinePage(scope, null, signal)).rejects.toThrow('could not be verified')
  }
})
it('preserves legacy single-profile requests when profile mode is off', async () => {
  state.scoped = false
  await readQuarantinePage({ connectionId: 'legacy-account' }, null, signal)
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: {} }))
})
