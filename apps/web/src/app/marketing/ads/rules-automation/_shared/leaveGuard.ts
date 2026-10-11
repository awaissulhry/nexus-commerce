/**
 * The rule builder's two ways out that its own buttons do not see (2026-10-11, lane BID-FIX2 — the Owner: no lost work):
 * browser Back, and a tab close or reload. Close, Cancel and Esc already ask "Discard changes?" when something is not
 * saved; installed while there are unsaved changes, this makes Back ask the same question and a close / reload get the
 * browser's own "Leave site?" prompt. Every rule type the shared builder draws goes through it.
 *
 * Back: the browser's `navigate` event (the Navigation API) comes BEFORE the move, and a Back within the app can be
 * cancelled there — the address never changes, the page never hears of it, and the builder asks. Discard then goes back
 * for real (`history.back()`) once `mustAsk()` says no. A `popstate` guard cannot do this: Next's router listens to
 * popstate from the app's start, so it always hears first, and React renders that Back at once — the builder is gone
 * before a later listener runs (seen on the private stack, 2026-10-11).
 *
 * Where the browser will not let a Back be cancelled (no Navigation API, or a second Back with no click or key in
 * between — the browser's own rule against trapping a person), Back leaves as before. Nothing unsaved: no guard is
 * installed, and Back leaves at once.
 */

/** A `navigate` event as the guard reads it. */
interface NavigateLike { navigationType: string; cancelable: boolean; preventDefault(): void }

/** The parts of `window` the guard uses (a stand-in in tests). */
export interface LeaveGuardWindow {
  addEventListener(type: 'beforeunload', fn: (e: Event) => void): void
  removeEventListener(type: 'beforeunload', fn: (e: Event) => void): void
  /** The Navigation API, where the browser has it. */
  readonly navigation?: {
    addEventListener(type: 'navigate', fn: (e: Event) => void): void
    removeEventListener(type: 'navigate', fn: (e: Event) => void): void
  }
}

/**
 * Guard Back and a tab close / reload. `mustAsk` is read when the person leaves (false once Discard or a save let them
 * go); `ask` opens the question after a Back it held. Returns the removal.
 */
export function guardLeaving(win: LeaveGuardWindow, mustAsk: () => boolean, ask: () => void): () => void {
  const onNavigate = (e: Event) => {
    const n = e as unknown as NavigateLike
    if (n.navigationType !== 'traverse' || !n.cancelable || !mustAsk()) return
    n.preventDefault()
    ask()
  }
  const onUnload = (e: Event) => {
    if (!mustAsk()) return
    e.preventDefault()
    // Older browsers show the prompt only for a set returnValue (its text is never shown).
    ;(e as BeforeUnloadEvent).returnValue = ''
  }
  win.navigation?.addEventListener('navigate', onNavigate)
  win.addEventListener('beforeunload', onUnload)
  return () => {
    win.navigation?.removeEventListener('navigate', onNavigate)
    win.removeEventListener('beforeunload', onUnload)
  }
}
