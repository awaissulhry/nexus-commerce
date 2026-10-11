import { describe, expect, it, vi } from 'vitest'
import { guardLeaving, type LeaveGuardWindow } from './leaveGuard'

/** An event as the browser hands it to a listener. */
class FakeEvent {
  defaultPrevented = false
  returnValue: unknown = undefined
  constructor(readonly type: string, readonly navigationType = '', readonly cancelable = true) {}
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
}

/** Listeners by type, called in the order added. */
class Target {
  private listeners: Array<{ type: string; fn: (e: Event) => void }> = []
  addEventListener(type: string, fn: (e: Event) => void) { this.listeners.push({ type, fn }) }
  removeEventListener(type: string, fn: (e: Event) => void) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)) }
  count(type: string) { return this.listeners.filter((l) => l.type === type).length }
  dispatch(e: FakeEvent): FakeEvent { for (const l of this.listeners.filter((x) => x.type === e.type)) l.fn(e as unknown as Event); return e }
}

/** A window with the Navigation API (or without), whose Back moves only when its `navigate` event was not cancelled. */
class FakeWindow extends Target implements LeaveGuardWindow {
  readonly navigation: Target | undefined
  at = '/bid?builder=new'
  constructor(withNavigation = true) { super(); this.navigation = withNavigation ? new Target() : undefined }
  /** The Back button: `navigate` first (cancelable within the app after a click or key), then the move. */
  back(cancelable = true) {
    const e = this.navigation?.dispatch(new FakeEvent('navigate', 'traverse', cancelable))
    if (!e?.defaultPrevented) this.at = '/bid'
  }
}

describe('rule builder: browser Back and a tab close / reload', () => {
  it('Back with unsaved changes is held (the address stays) and asks', () => {
    const w = new FakeWindow()
    const ask = vi.fn()
    guardLeaving(w, () => true, ask)
    w.back()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(w.at).toBe('/bid?builder=new')
    w.back()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('Discard: once nothing must be asked, Back leaves', () => {
    const w = new FakeWindow()
    let unsaved = true
    const ask = vi.fn()
    guardLeaving(w, () => unsaved, ask)
    w.back()
    unsaved = false // Discard (or a save) let the person go; the builder goes back for real
    w.back()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(w.at).toBe('/bid')
  })

  it('only a Back or Forward is held: the builder’s own push or replace (a save, Close) goes through', () => {
    const w = new FakeWindow()
    const ask = vi.fn()
    guardLeaving(w, () => true, ask)
    for (const type of ['push', 'replace', 'reload']) {
      const e = w.navigation!.dispatch(new FakeEvent('navigate', type))
      expect(e.defaultPrevented).toBe(false)
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('a Back the browser will not let be cancelled leaves, without a question that could not hold it', () => {
    const w = new FakeWindow()
    const ask = vi.fn()
    guardLeaving(w, () => true, ask)
    w.back(false)
    expect(ask).not.toHaveBeenCalled()
    expect(w.at).toBe('/bid')
  })

  it('no guard installed (nothing changed): Back leaves at once', () => {
    const w = new FakeWindow()
    w.back()
    expect(w.at).toBe('/bid')
  })

  it('a browser without the Navigation API still gets the close / reload prompt', () => {
    const w = new FakeWindow(false)
    expect(() => guardLeaving(w, () => true, () => {})).not.toThrow()
    expect(w.dispatch(new FakeEvent('beforeunload')).defaultPrevented).toBe(true)
  })

  it('a tab close or reload with unsaved changes gets the browser prompt; without, none', () => {
    const w = new FakeWindow()
    let unsaved = true
    guardLeaving(w, () => unsaved, () => {})
    const asked = w.dispatch(new FakeEvent('beforeunload'))
    expect(asked.defaultPrevented).toBe(true)
    expect(asked.returnValue).toBe('')
    unsaved = false
    const free = w.dispatch(new FakeEvent('beforeunload'))
    expect(free.defaultPrevented).toBe(false)
    expect(free.returnValue).toBeUndefined()
  })

  it('the removal takes both listeners away', () => {
    const w = new FakeWindow()
    const ask = vi.fn()
    const off = guardLeaving(w, () => true, ask)
    expect(w.navigation!.count('navigate')).toBe(1)
    expect(w.count('beforeunload')).toBe(1)
    off()
    expect(w.navigation!.count('navigate')).toBe(0)
    expect(w.count('beforeunload')).toBe(0)
    w.back()
    expect(ask).not.toHaveBeenCalled()
    expect(w.at).toBe('/bid')
  })
})
