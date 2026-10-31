/**
 * ONE shared second-ticker for every FloorElapsed on the page (B-W2b-28). A supervisor's screen can show a dozen open
 * help calls: one timer, not twelve. It ticks on the whole second while anything is subscribed and the tab is visible,
 * and not at all otherwise; coming back reads the clock at once so every numeral catches up.
 */

export interface ElapsedClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  hidden(): boolean
  onVisibilityChange(run: () => void): () => void
}

export interface ElapsedTicker {
  /** `notify` runs on every tick. Returns the unsubscribe. */
  subscribe(notify: () => void): () => void
  /** The last reading: fresh when nothing is subscribed, at most one second old otherwise. */
  now(): number
  /** 0 or 1: never one timer per numeral. */
  armed(): number
}

export function createElapsedTicker(clock: ElapsedClock): ElapsedTicker {
  const subscribers = new Set<() => void>()
  let reading = clock.now()
  let handle: unknown = null
  let unwatch: (() => void) | null = null

  const disarm = () => {
    if (handle !== null) clock.clearTimeout(handle)
    handle = null
  }
  const arm = () => {
    disarm()
    if (subscribers.size === 0 || clock.hidden()) return
    // On the next whole second, so every numeral on the page changes together.
    handle = clock.setTimeout(tick, 1000 - (reading % 1000) || 1000)
  }
  function tick() {
    disarm()
    reading = clock.now()
    for (const notify of [...subscribers]) notify()
    arm()
  }

  return {
    subscribe(notify) {
      if (subscribers.size === 0) unwatch = clock.onVisibilityChange(() => (clock.hidden() ? disarm() : tick()))
      subscribers.add(notify)
      reading = clock.now()
      arm()
      return () => {
        subscribers.delete(notify)
        if (subscribers.size === 0) {
          unwatch?.()
          unwatch = null
          disarm()
        }
      }
    },
    now() {
      if (subscribers.size === 0) reading = clock.now()
      return reading
    },
    armed: () => (handle === null ? 0 : 1),
  }
}

const browserClock: ElapsedClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (run) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', run)
    return () => document.removeEventListener('visibilitychange', run)
  },
}

let pageTicker: ElapsedTicker | null = null

/** The page's one ticker, created on first use (never on the server). */
export function elapsedTicker(): ElapsedTicker {
  pageTicker ??= createElapsedTicker(browserClock)
  return pageTicker
}
