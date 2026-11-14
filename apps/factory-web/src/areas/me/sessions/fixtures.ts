import type { LiveSession } from './api'

/**
 * Made-up live sessions for the design review (B-W2b-413): invented devices, a made-up city, made-up times. Nothing here is a
 * real person's device or place. Design-only.
 */
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const id = (n: number) => `0190f0e2-5e55-7000-8000-${String(n).padStart(12, '0')}`

const session = (n: number, over: Partial<LiveSession>): LiveSession => ({
  id: id(n),
  current: false,
  surface: 'OFFICE',
  deviceKind: 'WINDOWS',
  deviceLabel: 'Windows PC',
  browser: 'Edge 130',
  place: { country: null, city: null },
  startedAt: at(12, 7, 30),
  lastUsedAt: at(13, 16, 5),
  idleExpiresAt: at(14, 0, 5),
  absoluteExpiresAt: at(19, 7, 30),
  ...over,
})

export const DEMO_SESSIONS: LiveSession[] = [
  session(1, { current: true, deviceKind: 'MAC', deviceLabel: 'Mac', browser: 'Firefox 132', place: { country: 'IT', city: 'Milano' }, startedAt: at(13, 7, 58), lastUsedAt: at(13, 9, 41) }),
  session(2, { deviceKind: 'IPHONE', deviceLabel: 'iPhone', browser: 'Safari 18', place: { country: 'IT', city: null }, startedAt: at(11, 18, 2), lastUsedAt: at(12, 21, 14) }),
  session(3, {}),
  session(4, { surface: 'PREVIEW', deviceKind: 'MAC', deviceLabel: 'Mac', browser: 'Firefox 132', place: { country: 'IT', city: 'Milano' }, startedAt: at(13, 8, 40), lastUsedAt: at(13, 8, 52) }),
]

/** Another person's sessions (a record in Admin › Users): none is this browser. */
export const DEMO_PERSON_SESSIONS: LiveSession[] = [
  session(11, { deviceKind: 'ANDROID_PHONE', deviceLabel: 'Android phone', browser: 'Chrome 130', place: { country: 'IT', city: 'Bergamo' }, startedAt: at(13, 6, 50), lastUsedAt: at(13, 9, 30) }),
  session(12, { deviceKind: null, deviceLabel: null, browser: null, startedAt: at(10, 14, 0), lastUsedAt: at(12, 11, 20) }),
]
