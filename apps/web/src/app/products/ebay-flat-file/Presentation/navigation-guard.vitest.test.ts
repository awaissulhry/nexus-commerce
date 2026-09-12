import { describe, expect, it, vi } from 'vitest'
import { installPresentationNavigationGuard } from './usePresentationNavigationGuard'

const tick = async () => { await Promise.resolve(); await Promise.resolve() }
function fixture(answer: boolean | Promise<boolean>) {
  const navigation = Object.assign(new EventTarget(), { traverseTo: vi.fn() })
  const document = new EventTarget()
  const win = Object.assign(new EventTarget(), { navigation, document, location: { href: 'https://fixture.test/products/f1/edit', assign: vi.fn() } })
  const ask = vi.fn(async () => answer)
  const cleanup = installPresentationNavigationGuard(win as unknown as Window, ask)
  const navigate = (type: string, url = 'https://fixture.test/products/f2/edit') => {
    const e = Object.assign(new Event('navigate', { cancelable: true }), { navigationType: type, destination: { url, key: 'previous' } })
    navigation.dispatchEvent(e); return e
  }
  return { win, navigation, ask, navigate, cleanup }
}
describe('presentation drafts on Back and programmatic navigation', () => {
  it('cancels Back and a programmatic push while Keep editing is selected', async () => {
    const f = fixture(false)
    expect(f.navigate('traverse').defaultPrevented).toBe(true); await tick()
    expect(f.navigate('push').defaultPrevented).toBe(true); await tick()
    expect(f.navigation.traverseTo).not.toHaveBeenCalled(); expect(f.win.location.assign).not.toHaveBeenCalled()
    f.cleanup()
  })
  it('resumes only the confirmed history entry', async () => {
    const f = fixture(true); f.navigate('traverse'); await tick()
    expect(f.navigation.traverseTo).toHaveBeenCalledExactlyOnceWith('previous'); f.cleanup()
  })
  it('does not navigate after an editor is replaced during confirmation', async () => {
    let accept!: (answer: boolean) => void
    const f = fixture(new Promise<boolean>(resolve => { accept = resolve }))
    f.navigate('push'); f.cleanup(); accept(true); await tick()
    expect(f.win.location.assign).not.toHaveBeenCalled()
  })
  it('does not interrupt an unchanged URL or another guard’s cancellation', async () => {
    const f = fixture(false); f.navigate('replace', f.win.location.href); await tick()
    expect(f.ask).not.toHaveBeenCalled(); f.cleanup()
  })
})


describe('guard runs before Next dispatches a history restore', () => {
  function nextFixture(answer: boolean | Promise<boolean>) {
    const restoreReact = vi.fn()
    const history = {
      pushState: vi.fn((...args: Parameters<History['pushState']>) => restoreReact(...args)),
      replaceState: vi.fn((...args: Parameters<History['replaceState']>) => restoreReact(...args)),
    }
    const original = { ...history }
    const navigation = Object.assign(new EventTarget(), { traverseTo: vi.fn() })
    const win = Object.assign(new EventTarget(), { history, navigation, document: new EventTarget(), location: { href: 'https://fixture.test/products/f1/edit', assign: vi.fn() } })
    const ask = vi.fn(async () => answer)
    const cleanup = installPresentationNavigationGuard(win as unknown as Window, ask)
    return { history, navigation, original, restoreReact, ask, cleanup }
  }
  it('keeps the draft mounted while a programmatic push or replacement is declined', async () => {
    const f = nextFixture(false)
    f.history.pushState({}, '', '?tab=images')
    await tick()
    f.history.replaceState({}, '', '?account=another')
    await tick()
    expect(f.restoreReact).not.toHaveBeenCalled()
    f.cleanup()
    expect(f.history.pushState).toBe(f.original.pushState)
    expect(f.history.replaceState).toBe(f.original.replaceState)
  })
  it('waits for confirmation before Next sees the exact requested history update', async () => {
    let accept!: (value: boolean) => void
    const f = nextFixture(new Promise<boolean>(resolve => { accept = resolve }))
    const state = { custom: 'preserve' }
    f.history.pushState(state, 'title', '?tab=images')
    expect(f.restoreReact).not.toHaveBeenCalled()
    accept(true); await tick()
    expect(f.original.pushState).toHaveBeenCalledExactlyOnceWith(state, 'title', '?tab=images')
    expect(f.original.pushState.mock.contexts[0]).toBe(f.history)
    f.cleanup()
  })
  it('does not reuse a confirmation when a history change keeps the editor mounted', async () => {
    const f = nextFixture(false)
    f.ask.mockResolvedValueOnce(true)
    f.history.pushState({}, '', '?drawer=details')
    await tick()
    f.history.replaceState({}, '', '?account=another')
    await tick()
    expect(f.ask).toHaveBeenCalledTimes(2)
    expect(f.original.pushState).toHaveBeenCalledOnce()
    expect(f.original.replaceState).not.toHaveBeenCalled()
    f.cleanup()
  })
  it('permits the confirmed native navigate event without asking a second time', async () => {
    const f = nextFixture(true)
    const event = Object.assign(new Event('navigate', { cancelable: true }), {
      navigationType: 'push', destination: { url: 'https://fixture.test/products/f2/edit' },
    })
    f.original.pushState.mockImplementationOnce(() => { f.navigation.dispatchEvent(event) })
    f.history.pushState({}, '', event.destination.url)
    await tick()
    expect(event.defaultPrevented).toBe(false)
    expect(f.ask).toHaveBeenCalledOnce()
    f.cleanup()
  })
  it('drops a queued history change if the editor unmounts before confirmation', async () => {
    let accept!: (value: boolean) => void
    const f = nextFixture(new Promise<boolean>(resolve => { accept = resolve }))
    f.history.replaceState({}, '', '?account=another')
    f.cleanup()
    accept(true); await tick()
    expect(f.restoreReact).not.toHaveBeenCalled()
  })
  it('keeps only the first request while confirmation is pending', async () => {
    let accept!: (value: boolean) => void
    const f = nextFixture(new Promise<boolean>(resolve => { accept = resolve }))
    f.history.pushState({}, '', '?tab=images')
    f.history.replaceState({}, '', '?account=another')
    accept(true); await tick()
    expect(f.ask).toHaveBeenCalledOnce()
    expect(f.original.pushState).toHaveBeenCalledExactlyOnceWith({}, '', '?tab=images')
    expect(f.original.replaceState).not.toHaveBeenCalled()
    f.cleanup()
  })
  it('preserves other wrappers installed later and makes its captured wrapper transparent on unmount', async () => {
    const f = nextFixture(false)
    const captured = f.history.pushState
    const later = vi.fn((...args: Parameters<History['pushState']>) => captured(...args))
    f.history.pushState = later
    f.cleanup()
    expect(f.history.pushState).toBe(later)
    f.history.pushState({}, '', '?tab=images')
    expect(f.original.pushState).toHaveBeenCalledExactlyOnceWith({}, '', '?tab=images')
  })
  it('does not interrupt internal history bookkeeping that keeps the same URL', async () => {
    const f = nextFixture(false)
    f.history.replaceState({ __NA: true }, '', 'https://fixture.test/products/f1/edit')
    expect(f.restoreReact).toHaveBeenCalledOnce()
    f.cleanup()
  })
})
