import { describe, expect, it, vi } from 'vitest'
import { createThemeStore } from './theme-store'

describe('one theme state for the page (the top bar and the profile change together)', () => {
  it('reads the saved choice once, then every change reaches every listener, the cookie and <html>', () => {
    const saved: { value?: string } = { value: 'dark' }
    const io = { read: vi.fn(() => saved.value), write: vi.fn((mode: string) => (saved.value = mode)), apply: vi.fn() }
    const store = createThemeStore(io)
    expect(store.get()).toBe('dark')
    expect(store.get()).toBe('dark')
    expect(io.read).toHaveBeenCalledTimes(1)

    const topBar = vi.fn()
    const profile = vi.fn()
    const stop = store.subscribe(topBar)
    store.subscribe(profile)
    store.set('light')
    expect(store.get()).toBe('light')
    expect([topBar.mock.calls.length, profile.mock.calls.length]).toEqual([1, 1])
    expect(io.write).toHaveBeenLastCalledWith('light')
    expect(io.apply).toHaveBeenLastCalledWith('light')

    stop()
    store.set('system')
    expect([topBar.mock.calls.length, profile.mock.calls.length]).toEqual([1, 2])
  })

  it('an unreadable or missing choice is the system\'s', () => {
    expect(createThemeStore({ read: () => undefined, write: () => undefined, apply: () => undefined }).get()).toBe('system')
    expect(createThemeStore({ read: () => 'purple', write: () => undefined, apply: () => undefined }).get()).toBe('system')
  })
})
