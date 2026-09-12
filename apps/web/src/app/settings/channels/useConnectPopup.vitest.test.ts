import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the bridge's browser effects in Node; UI/focus is checked in the browser fixture.
const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }))
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => () => void) => { lifecycle.cleanups.push(fn()) },
}))
vi.mock('@/lib/workspaces/paths', () => ({ WORKSPACES_ENABLED: true, browserWorkspaceId: () => 'page-business' }))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'https://nexus.example.test/backend' }))
import { useConnectPopup } from './useConnectPopup'

describe('profile-aware sign-in bridge', () => {
  let onMessage: (event: unknown) => void
  let fetchMock: ReturnType<typeof vi.fn>
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; location: { href: string } }
  let timers: Map<number, () => void>
  let sequence: number
  beforeEach(() => {
    onMessage = () => {}; sequence = 0; timers = new Map()
    popup = { closed: false, close: vi.fn(), focus: vi.fn(), location: { href: '' } }
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ authUrl: 'https://provider.example.test/sign-in', state: 'attempt-1' })))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('BroadcastChannel', class { close() {} })
    vi.stubGlobal('window', {
      location: { origin: 'https://nexus.example.test', href: 'https://nexus.example.test/w/page-business/settings/channels' },
      open: vi.fn(() => popup),
      addEventListener: (_name: string, handler: typeof onMessage) => { onMessage = handler },
      removeEventListener: vi.fn(),
      setInterval: (fn: () => void) => { const id = ++sequence; timers.set(id, fn); return id },
      clearInterval: (id: number) => { timers.delete(id) },
    })
  })
  afterEach(() => { for (const cleanup of lifecycle.cleanups.splice(0)) cleanup(); vi.unstubAllGlobals() })

  it('starts in the chosen profile and consumes only its matching callback once', async () => {
    const connected = vi.fn(), closed = vi.fn(), ack = vi.fn()
    const bridge = useConnectPopup(connected, closed)
    expect(await bridge.start('EBAY', { workspaceId: 'chosen-business', region: 'GLOBAL' })).toBe(true)
    expect(fetchMock.mock.calls[0]).toEqual(['https://nexus.example.test/backend/api/cx/connect/ebay/start', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'x-nexus-workspace-id': 'chosen-business' },
      body: JSON.stringify({ intent: 'connect', region: 'GLOBAL' }),
    })])
    expect(popup.location.href).toBe('https://provider.example.test/sign-in')
    const data = { type: 'nexus:channel-connected', channel: 'EBAY', channelKey: 'EBAY', workspaceId: 'chosen-business', state: 'attempt-1' }
    const event = { origin: 'https://nexus.example.test', source: { postMessage: ack }, data }
    onMessage({ ...event, data: { ...data, workspaceId: 'page-business' } })
    onMessage({ ...event, data: { ...data, state: 'other-attempt' } })
    onMessage({ ...event, origin: 'https://foreign.example.test' })
    expect(connected).not.toHaveBeenCalled()
    onMessage(event); onMessage(event)
    expect(connected).toHaveBeenCalledExactlyOnceWith(data)
    expect(ack).toHaveBeenCalledExactlyOnceWith({ type: 'nexus:ack', state: 'attempt-1' }, event.origin)
    expect(timers.size).toBe(0)
    expect(closed).not.toHaveBeenCalled()
    // A previous popup's close poll cannot clear this new attempt.
    expect(await bridge.start('EBAY', { workspaceId: 'chosen-business' })).toBe(true)
    expect(timers.size).toBe(1)
  })

  it('keeps reconnect identity and explicit destination on the shared route, even for legacy URL callers', async () => {
    const bridge = useConnectPopup(vi.fn())
    await bridge.start('AMAZON_ADS', { workspaceId: 'chosen-business', targetConnectionId: 'account-1', intent: 'reconnect', url: 'https://legacy.example.test/connect' })
    expect(fetchMock.mock.calls[0]).toEqual(['https://nexus.example.test/backend/api/cx/connect/amazon_ads/start', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'x-nexus-workspace-id': 'chosen-business' },
      body: JSON.stringify({ intent: 'reconnect', targetConnectionId: 'account-1' }),
    })])
    expect(await bridge.start('EBAY')).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('closes the blank popup on a refused start and permits a new attempt', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Your permission has changed.' }), { status: 403 }))
    const bridge = useConnectPopup(vi.fn())
    expect(await bridge.start('EBAY', { workspaceId: 'chosen-business' })).toBe(false)
    expect(popup.close).toHaveBeenCalledOnce()
    expect(timers.size).toBe(0)
    expect(await bridge.start('EBAY', { workspaceId: 'chosen-business' })).toBe(true)
  })

  it('reports which shared-flow attempt was cancelled when its popup closes silently', async () => {
    const closed = vi.fn()
    const bridge = useConnectPopup(vi.fn(), closed)
    await bridge.start('AMAZON_SP', { workspaceId: 'chosen-business', region: 'EU' })
    popup.closed = true
    for (const poll of [...timers.values()]) poll()
    expect(closed).toHaveBeenCalledExactlyOnceWith({ channelKey: 'AMAZON_SP', workspaceId: 'chosen-business', state: 'attempt-1' })
  })

  it.each(['SHOPIFY', 'ETSY'])('does not navigate the main tab if the %s window is closed during start', async channel => {
    fetchMock.mockImplementationOnce(async () => {
      popup.closed = true
      return new Response(JSON.stringify({ authUrl: 'https://provider.example.test/sign-in', state: 'attempt-1' }))
    })
    const originalUrl = window.location.href
    const connected = vi.fn()
    const bridge = useConnectPopup(connected)
    expect(await bridge.start(channel)).toBe(false)
    expect(window.location.href).toBe(originalUrl)
    expect(connected).not.toHaveBeenCalled()
    expect(timers.size).toBe(0)
  })

  it('uses the same tab when the browser blocks the popup', async () => {
    vi.mocked(window.open).mockReturnValueOnce(null)
    const bridge = useConnectPopup(vi.fn())
    expect(await bridge.start('ETSY')).toBe(true)
    expect(window.location.href).toBe('https://provider.example.test/sign-in')
  })
})
