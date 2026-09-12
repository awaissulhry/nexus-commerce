import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep hook state across renders; browser checks cover the real dialog and focus.
const hooks = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0, dependencies: '', cleanup: undefined as (() => void) | undefined,
  workspaces: false,
}))
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.state)) hooks.state[index] = initial
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value }]
  },
  useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => {
    const key = JSON.stringify(dependencies)
    if (key !== hooks.dependencies) { hooks.cleanup?.(); hooks.dependencies = key; hooks.cleanup = effect() }
  },
}))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:8091' }))
vi.mock('@/lib/workspaces/paths', () => ({ get WORKSPACES_ENABLED() { return hooks.workspaces } }))
import { useConnectionReadiness } from './useConnectionReadiness'

function render(channel = 'SHOPIFY', workspaceId?: string) {
  hooks.cursor = 0
  return useConnectionReadiness(channel, workspaceId)
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }) }
beforeEach(() => {
  hooks.state = []; hooks.cursor = 0; hooks.dependencies = ''; hooks.cleanup = undefined; hooks.workspaces = false
  vi.stubGlobal('fetch', vi.fn(async () => response({ ready: true })))
})
afterEach(() => { hooks.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('connection setup before opening provider sign-in', () => {
  it.each(['SHOPIFY', 'ETSY'])('holds %s until the server confirms setup', async channel => {
    expect(render(channel)).toMatchObject({ ready: false, checking: true, error: null })
    await vi.waitFor(() => expect(render(channel).ready).toBe(true))
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`http://localhost:8091/api/cx/connect/${channel.toLowerCase()}/readiness`, expect.objectContaining({ credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('shows missing setup and permits a fresh check after the administrator fixes it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ready: false, error: 'Shopify is not set up on this Nexus server.' }))
    render()
    await vi.waitFor(() => expect(render()).toMatchObject({ ready: false, checking: false, error: 'Shopify is not set up on this Nexus server.' }))
    render().retry()
    expect(render()).toMatchObject({ ready: false, checking: true, error: null })
    await vi.waitFor(() => expect(render().ready).toBe(true))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([response({}, 503), new Response('not JSON', { status: 502 }), response({ ready: false }), response(null)])('keeps Continue disabled for an unavailable or malformed response', async reply => {
    vi.mocked(fetch).mockResolvedValueOnce(reply)
    render()
    await vi.waitFor(() => expect(render()).toMatchObject({ ready: false, checking: false, error: expect.stringContaining('could not check') }))
  })

  it('does not reuse a successful check from another channel', async () => {
    render()
    await vi.waitFor(() => expect(render().ready).toBe(true))
    vi.mocked(fetch).mockResolvedValueOnce(response({ ready: false, error: 'Etsy setup is missing.' }))
    expect(render('ETSY')).toMatchObject({ ready: false, checking: true })
    await vi.waitFor(() => expect(render('ETSY').error).toBe('Etsy setup is missing.'))
  })

  it('waits for a chosen business profile and binds the request to that profile', async () => {
    hooks.workspaces = true
    expect(render()).toMatchObject({ ready: false, checking: false })
    expect(fetch).not.toHaveBeenCalled()
    render('SHOPIFY', 'chosen-business')
    await vi.waitFor(() => expect(render('SHOPIFY', 'chosen-business').ready).toBe(true))
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ headers: { 'x-nexus-workspace-id': 'chosen-business' } }))
    expect(render('SHOPIFY', 'another-business').ready).toBe(false)
  })

  it('aborts on close and ignores a late response', async () => {
    let resolve!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render()
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    hooks.cleanup?.()
    resolve(response({ ready: true }))
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    expect(hooks.state[0]).toBeNull()
  })

  it('times out a stalled check with a retryable message', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    render()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(render()).toMatchObject({ ready: false, checking: false, error: expect.stringContaining('try again') })
  })

  it('leaves other channel flows unchanged', () => {
    expect(render('EBAY')).toMatchObject({ ready: true, checking: false, error: null })
    expect(fetch).not.toHaveBeenCalled()
  })
})
