/**
 * DS — the time left until a moment, as pure rules plus ONE shared timer (gap G7, the approvals grid, 2026-10-05).
 *
 * A request approved a moment ago "Runs in 14 s"; a waiting one "expires in 3 h". The text counts seconds under a
 * minute and steps in minutes, hours and days above it. The rules here are tested; `Countdown.tsx` draws them.
 *
 * 🔴 One timer for every countdown on the page, not one per instance: a grid can show 50 rows. The ticker keeps a
 * single `setTimeout`, armed for the soonest moment any visible text can change — about 1 s while some row is under
 * a minute, up to 30 s otherwise — and none at all while the tab is hidden or nothing is counting.
 */

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

/** At or under this many milliseconds the text counts seconds ("59 s"); above it, minutes ("1 min"). */
export const COUNTDOWN_SECONDS_UNDER = 59 * S
/** The longest wait between two ticks while every countdown is above a minute. */
export const COUNTDOWN_SLOW_TICK = 30 * S

/**
 * The time left, in words: "14 s", "3 min", "3 h", "2 d". Seconds round UP, so the text never reads "0 s" while time
 * is left; the larger units round to the nearest. Zero or less (or not a number) is "0 s" — the host shows its own
 * done words then.
 */
export function countdownText(msLeft: number): string {
  if (!(msLeft > 0)) return '0 s'
  if (msLeft <= COUNTDOWN_SECONDS_UNDER) return `${Math.ceil(msLeft / S)} s`
  if (msLeft < 59.5 * M) return `${Math.max(1, Math.round(msLeft / M))} min`
  if (msLeft < 23.5 * H) return `${Math.round(msLeft / H)} h`
  return `${Math.round(msLeft / D)} d`
}

/**
 * How long until this countdown's text may change, in ms; null once it reached zero (nothing left to tick).
 * Under a minute: the next whole second. Above it: at most 30 s, and never past the moment it drops under a minute,
 * so the second-by-second count starts on time.
 */
export function countdownNextTick(msLeft: number): number | null {
  if (!(msLeft > 0)) return null
  if (msLeft <= COUNTDOWN_SECONDS_UNDER) return ((Math.ceil(msLeft) - 1) % S) + 1
  return Math.max(1, Math.min(COUNTDOWN_SLOW_TICK, Math.ceil(msLeft - COUNTDOWN_SECONDS_UNDER)))
}

/**
 * The step a screen reader hears, polite, never every second: 60 s, 30 s, 10 s and zero. Above a minute there is no
 * step (null) — a long wait is read when the user reaches it, not announced.
 */
export type CountdownStep = 60 | 30 | 10 | 0

export function countdownStep(msLeft: number): CountdownStep | null {
  if (!(msLeft > 0)) return 0
  if (msLeft <= 10 * S) return 10
  if (msLeft <= 30 * S) return 30
  if (msLeft <= 60 * S) return 60
  return null
}

/** What a countdown shows at one moment. */
export interface CountdownView {
  done: boolean
  /** "14 s" — "0 s" once done. */
  text: string
  step: CountdownStep | null
}

/**
 * The view as ONE string — the store snapshot. It changes only when the words or the announcement step change, so a
 * row three hours away does not re-render on every 1 s tick some other row needs.
 */
export function countdownSnapshot(msLeft: number): string {
  if (!(msLeft > 0)) return 'done'
  return `${countdownStep(msLeft) ?? '-'}|${countdownText(msLeft)}`
}

export function readCountdownSnapshot(snapshot: string): CountdownView {
  if (snapshot === 'done') return { done: true, text: countdownText(0), step: 0 }
  const bar = snapshot.indexOf('|')
  const step = snapshot.slice(0, bar)
  return { done: false, text: snapshot.slice(bar + 1), step: step === '-' ? null : (Number(step) as CountdownStep) }
}

/** The moment, from an ISO string or epoch milliseconds; NaN when it is neither. */
export function countdownTarget(to: string | number): number {
  return typeof to === 'number' ? to : Date.parse(to)
}

/* ── the shared timer ─────────────────────────────────────────────────────────────────────────────── */

/** What the ticker needs from the outside world — injected so the scheduling is tested without a browser. */
export interface CountdownClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** True while the page is not visible. */
  hidden(): boolean
  /** Call back on every visibility change; returns the unsubscribe. */
  onVisibilityChange(run: () => void): () => void
}

export interface CountdownTicker {
  /** Count down to `target` (epoch ms); `notify` runs whenever the shared clock moves. Returns the unsubscribe. */
  subscribe(target: number, notify: () => void): () => void
  /** The shared clock's last reading. Fresh when nothing is subscribed, at most one tick old otherwise. */
  now(): number
  /** How many timers are armed right now: 0 or 1, never one per countdown. */
  armed(): number
}

export function createCountdownTicker(clock: CountdownClock): CountdownTicker {
  const subscribers = new Map<number, { target: number; notify: () => void }>()
  let reading = clock.now()
  let handle: unknown = null
  let seq = 0
  let unwatch: (() => void) | null = null

  const disarm = () => {
    if (handle !== null) clock.clearTimeout(handle)
    handle = null
  }
  const arm = () => {
    disarm()
    if (subscribers.size === 0 || clock.hidden()) return
    let soonest: number | null = null
    for (const s of subscribers.values()) {
      const next = countdownNextTick(s.target - reading)
      if (next !== null && (soonest === null || next < soonest)) soonest = next
    }
    if (soonest !== null) handle = clock.setTimeout(tick, soonest)
  }
  function tick() {
    // Called by the timer AND directly (a newcomer, the tab coming back): a direct call must replace the armed timer,
    // never leave it running beside a new one — that is how 50 rows would end up with 50 timers.
    disarm()
    reading = clock.now()
    for (const s of [...subscribers.values()]) s.notify()
    arm()
  }

  return {
    subscribe(target, notify) {
      const id = ++seq
      if (subscribers.size === 0) {
        // A hidden tab arms nothing; coming back reads the clock once and catches every countdown up.
        unwatch = clock.onVisibilityChange(() => (clock.hidden() ? disarm() : tick()))
      }
      subscribers.set(id, { target, notify })
      // A newcomer must not render from a reading up to 30 s old: read the clock now and let everyone catch up.
      tick()
      return () => {
        subscribers.delete(id)
        if (subscribers.size === 0) {
          unwatch?.()
          unwatch = null
        }
        arm()
      }
    },
    now() {
      if (subscribers.size === 0) reading = clock.now()
      return reading
    },
    armed: () => (handle === null ? 0 : 1),
  }
}

const browserClock: CountdownClock = {
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

let pageTicker: CountdownTicker | null = null

/** The page's one ticker, created on first use (never on the server). */
export function countdownTicker(): CountdownTicker {
  pageTicker ??= createCountdownTicker(browserClock)
  return pageTicker
}
