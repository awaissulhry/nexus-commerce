import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }))
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => () => void) => { lifecycle.cleanups.push(fn()) },
}))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'https://nexus.example.test' }))

import { useConnectPopup } from './useConnectPopup'

describe('channel sign-in bridge', () => {
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }
  let timers: Array<() => void>
  let messageHandler: ((event: MessageEvent) => void) | undefined

  beforeEach(() => {
    timers = []
    messageHandler = undefined
    popup = { closed: false, close: vi.fn(), location: { href: '' } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authUrl: 'https://provider.example.test/sign-in' })))
    vi.stubGlobal('BroadcastChannel', class { close() {} })
    vi.stubGlobal('window', {
      location: { origin: 'https://nexus.example.test', href: 'https://nexus.example.test/settings/channels' },
      open: vi.fn(() => popup),
      addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
        if (type === 'message') messageHandler = handler
      }),
      removeEventListener: vi.fn(),
      setInterval: (fn: () => void) => { timers.push(fn); return timers.length },
      clearInterval: vi.fn(),
    })
  })

  afterEach(() => {
    for (const cleanup of lifecycle.cleanups.splice(0)) cleanup()
    vi.unstubAllGlobals()
  })

  it('reports which channel was cancelled when its popup closes silently', async () => {
    const closed = vi.fn()
    const bridge = useConnectPopup(vi.fn(), closed)
    await bridge.start('AMAZON_SP', { region: 'EU' })
    popup.closed = true
    timers.forEach((poll) => poll())
    expect(closed).toHaveBeenCalledExactlyOnceWith('AMAZON_SP')
  })

  it('completes a private Amazon import without navigating the blank popup', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      success: true,
      completed: {
        type: 'nexus:channel-connected',
        channel: 'AMAZON',
        channelKey: 'AMAZON_SP',
        placement: 'adopt',
      },
    }))
    const connected = vi.fn()
    const bridge = useConnectPopup(connected)
    await bridge.start('AMAZON_SP', { targetConnectionId: 'amazon-env', region: 'EU' })
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.href).toBe('')
    expect(connected).toHaveBeenCalledWith(expect.objectContaining({ channelKey: 'AMAZON_SP' }))
  })

  it('accepts only the callback state for the active channel attempt', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      authUrl: 'https://provider.example.test/sign-in',
      state: 'expected-state',
    }))
    const connected = vi.fn()
    const bridge = useConnectPopup(connected)
    await bridge.start('AMAZON_SP', { region: 'EU' })
    const source = { postMessage: vi.fn() }

    messageHandler?.({
      origin: 'https://nexus.example.test',
      data: { type: 'nexus:channel-connected', channel: 'AMAZON', channelKey: 'AMAZON_SP', state: 'wrong-state' },
      source,
    } as unknown as MessageEvent)
    expect(connected).not.toHaveBeenCalled()

    messageHandler?.({
      origin: 'https://nexus.example.test',
      data: { type: 'nexus:channel-connected', channel: 'AMAZON', channelKey: 'AMAZON_SP', state: 'expected-state' },
      source,
    } as unknown as MessageEvent)
    expect(connected).toHaveBeenCalledOnce()
    expect(source.postMessage).toHaveBeenCalledWith(
      { type: 'nexus:ack', state: 'expected-state' },
      'https://nexus.example.test',
    )
  })
})
