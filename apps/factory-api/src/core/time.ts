import { systemClock, type Clock } from '@nexus/factory-domain/core/time'

/**
 * The API's clock (feature PLT-084): server time in UTC with milliseconds, never a device's. Code that needs "now"
 * takes a Clock (the app passes `serverClock`; tests pass `fixedClock` from @nexus/factory-domain/core/time), so a
 * test never waits for, or depends on, the real time. The business-date helpers (Europe/Rome) live in the domain.
 */

// ---- th3b follow-up 6 (threads plan TH-3; the golden harness's one clock): `serverClock` reads the clock in force, the system's
// unless a test sets another. A golden flow whose portal is dated by the harness clock (it moves 30 s at every two-factor step) and
// whose office closes on this one sets the harness clock here too (golden-flow/testing/world.ts oneClock), so both sides of a
// request read ONE clock and no flow waits for real time to catch up. In the app nothing sets it: it is the system clock.
let inForce: Clock = systemClock

export const serverClock: Clock = { now: () => inForce.now() }

/** Test only: the clock `serverClock` reads (`undefined`: the system clock again). */
export function useServerClock(clock: Clock | undefined): void {
  inForce = clock ?? systemClock
}
// ---- end th3b follow-up 6

export type { Clock }
