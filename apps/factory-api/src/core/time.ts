import { systemClock, type Clock } from '@nexus/factory-domain/core/time'

/**
 * The API's clock (feature PLT-084): server time in UTC with milliseconds, never a device's. Code that needs "now"
 * takes a Clock (the app passes `serverClock`; tests pass `fixedClock` from @nexus/factory-domain/core/time), so a
 * test never waits for, or depends on, the real time. The business-date helpers (Europe/Rome) live in the domain.
 */

export const serverClock: Clock = systemClock

export type { Clock }
