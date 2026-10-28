/**
 * DS floor kit — idle sign-out (gap G2): a shared tablet signs its operator out when nobody touches it.
 *
 * Three phases. `active`: any touch, key or scan pushes the warning back. `warning`: after `idleMs` without one, the
 * overlay counts `warnMs` down second by second; only an explicit "I am here" (`stay`) ends it — a stray touch on the
 * scrim does not. `expired`: the countdown reached zero; `onExpire` runs once and the timer stops.
 *
 * Cheap on purpose: activity only records the time. One timer is armed at a time; when it fires early (activity
 * arrived meanwhile) it re-arms for the rest. The clock is injected so the scheduling is tested without a browser.
 */

export type IdlePhase = 'active' | 'warning' | 'expired'

export interface IdleSnapshot {
  phase: IdlePhase
  /** Whole seconds left in the warning, rounded up; 0 outside it. */
  secondsLeft: number
}

export interface IdleClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface IdleTimerOptions {
  /** How long without a touch before the warning, ms. */
  idleMs: number
  /** How long the warning counts down before sign-out, ms. */
  warnMs: number
  clock: IdleClock
  /** Runs on every phase change and every second of the warning. */
  onChange?: (snapshot: IdleSnapshot) => void
  /** Runs once, when the countdown reaches zero. */
  onExpire: () => void
}

export interface IdleTimer {
  /** Someone touched, typed or scanned. Ignored during the warning and after expiry. */
  activity(): void
  /** "I am here": ends the warning and starts the idle wait again. */
  stay(): void
  /** Stops every timer (unmount, signed out by other means). */
  stop(): void
  snapshot(): IdleSnapshot
}

const S = 1000

export function createIdleTimer({ idleMs, warnMs, clock, onChange, onExpire }: IdleTimerOptions): IdleTimer {
  let phase: IdlePhase = 'active'
  let lastActivity = clock.now()
  let deadline = 0
  let handle: unknown = null
  let stopped = false

  const secondsLeft = () => (phase === 'warning' ? Math.max(0, Math.ceil((deadline - clock.now()) / S)) : 0)
  const snapshot = (): IdleSnapshot => ({ phase, secondsLeft: secondsLeft() })
  const disarm = () => {
    if (handle !== null) clock.clearTimeout(handle)
    handle = null
  }
  const arm = (ms: number, run: () => void) => {
    disarm()
    if (!stopped) handle = clock.setTimeout(run, Math.max(0, ms))
  }

  const expire = () => {
    disarm()
    phase = 'expired'
    stopped = true
    onChange?.(snapshot())
    onExpire()
  }

  const tick = () => {
    const left = deadline - clock.now()
    if (left <= 0) return expire()
    onChange?.(snapshot())
    // The next whole second of the count, so the numeral steps on time.
    arm(((Math.ceil(left) - 1) % S) + 1, tick)
  }

  const idleCheck = () => {
    const quiet = clock.now() - lastActivity
    if (quiet < idleMs) return arm(idleMs - quiet, idleCheck)
    phase = 'warning'
    deadline = clock.now() + warnMs
    tick()
  }

  arm(idleMs, idleCheck)

  return {
    activity() {
      if (phase === 'active') lastActivity = clock.now()
    },
    stay() {
      if (stopped) return
      phase = 'active'
      lastActivity = clock.now()
      onChange?.(snapshot())
      arm(idleMs, idleCheck)
    },
    stop() {
      stopped = true
      disarm()
    },
    snapshot,
  }
}
