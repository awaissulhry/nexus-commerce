/**
 * The clock port: adapters, verifiers and the gateway take a Clock instead of reading the time, so a test never waits
 * for, or depends on, the real time. The one definition is core/time.ts (systemClock, fixedClock live there too).
 */
export type { Clock } from '../core/time'
