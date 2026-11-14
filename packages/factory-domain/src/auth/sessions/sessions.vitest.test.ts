import { describe, expect, it } from 'vitest'
import { DEVICE_LABELS, deviceKindOf, deviceOf, placeOf } from './device'
import { idleEndAfter, isLiveAt, lengthProblems, lengthsWiden, liveUntil, SECURITY_DEFAULTS, securityRulesOf, sessionLengthsMs, stepUpRuleProblems, stepUpRulesWiden } from './lengths'
import { failuresLeft, stepUpLockedUntil, type StepUpTry } from './step-up'

const at = (iso: string) => new Date(iso)
const MIN = 60_000

describe('session lengths per audience (PLT-068)', () => {
  it('has the W0 defaults without a row', () => {
    expect(securityRulesOf(null)).toEqual({ officeIdleMinutes: 480, officeLongestHours: 168, portalIdleMinutes: 30, portalLongestHours: 12, stepUpOff: [], stepUpMaxFailures: 5, stepUpLockMinutes: 15 })
    expect(sessionLengthsMs(SECURITY_DEFAULTS)).toEqual({ office: { idleMs: 8 * 60 * MIN, longestMs: 7 * 24 * 60 * MIN }, portal: { idleMs: 30 * MIN, longestMs: 12 * 60 * MIN } })
  })

  it('keeps the bounds and the idle time within the longest session, with codes', () => {
    expect(lengthProblems(SECURITY_DEFAULTS)).toEqual([])
    expect(lengthProblems({ ...SECURITY_DEFAULTS, officeIdleMinutes: 10, portalIdleMinutes: 45 }).map((issue) => issue.path)).toEqual(['body/officeIdleMinutes/range', 'body/portalIdleMinutes/range'])
    expect(lengthProblems({ ...SECURITY_DEFAULTS, officeIdleMinutes: 600, officeLongestHours: 8 }).map((issue) => issue.path)).toEqual(['body/officeIdleMinutes/idleLongest'])
    expect(lengthProblems({ ...SECURITY_DEFAULTS, officeLongestHours: 1.5 }).map((issue) => issue.path)).toEqual(['body/officeLongestHours/range'])
  })

  it('calls a longer session wider, a shorter one never', () => {
    expect(lengthsWiden(SECURITY_DEFAULTS, { ...SECURITY_DEFAULTS, officeIdleMinutes: 240 })).toBe(false)
    expect(lengthsWiden(SECURITY_DEFAULTS, { ...SECURITY_DEFAULTS, officeLongestHours: 336 })).toBe(true)
    expect(lengthsWiden({ ...SECURITY_DEFAULTS, portalIdleMinutes: 10 }, SECURITY_DEFAULTS)).toBe(true)
  })

  it('ends an open session at once under a shorter length, never lengthens a stored end', () => {
    const session = { createdAt: at('2026-11-01T08:00:00Z'), lastSeenAt: at('2026-11-01T09:00:00Z'), idleExpiresAt: at('2026-11-01T17:00:00Z'), absoluteExpiresAt: at('2026-11-08T08:00:00Z') }
    const shorter = liveUntil(session, { idleMs: 60 * MIN, longestMs: 24 * 60 * MIN })
    expect(shorter).toEqual({ idleExpiresAt: at('2026-11-01T10:00:00Z'), absoluteExpiresAt: at('2026-11-02T08:00:00Z') })
    expect(isLiveAt(shorter, at('2026-11-01T09:59:59Z'))).toBe(true)
    expect(isLiveAt(shorter, at('2026-11-01T10:00:00Z'))).toBe(false)
    expect(liveUntil(session, { idleMs: 24 * 60 * MIN, longestMs: 30 * 24 * 60 * MIN })).toEqual({ idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt })
    expect(idleEndAfter(at('2026-11-08T02:00:00Z'), session.absoluteExpiresAt, 480 * MIN)).toEqual(session.absoluteExpiresAt)
    expect(idleEndAfter(at('2026-11-07T20:00:00Z'), session.absoluteExpiresAt, 480 * MIN)).toEqual(at('2026-11-08T04:00:00Z'))
  })
})

describe('step-up rules (PLT-063)', () => {
  const actions = new Map([
    ['bankDetails.change', { canSwitchOff: true }],
    ['access.change', { canSwitchOff: false }],
  ])
  const rules = { stepUpOff: [] as string[], stepUpMaxFailures: 5, stepUpLockMinutes: 15 }

  it('switches off only known actions that may be, once each', () => {
    expect(stepUpRuleProblems({ ...rules, stepUpOff: ['bankDetails.change'] }, actions)).toEqual([])
    expect(stepUpRuleProblems({ ...rules, stepUpOff: ['access.change', 'nope.nope', 'bankDetails.change', 'bankDetails.change'] }, actions).map((issue) => issue.path)).toEqual([
      'body/stepUpOff/repeated',
      'body/stepUpOff/0/fixedAction',
      'body/stepUpOff/1/unknownAction',
    ])
    expect(stepUpRuleProblems({ ...rules, stepUpMaxFailures: 2, stepUpLockMinutes: 2000 }, actions).map((issue) => issue.path)).toEqual(['body/stepUpMaxFailures/range', 'body/stepUpLockMinutes/range'])
  })

  it('calls an action switched off, more wrong codes or a shorter lock wider', () => {
    expect(stepUpRulesWiden(rules, { ...rules, stepUpOff: ['bankDetails.change'] })).toBe(true)
    expect(stepUpRulesWiden({ ...rules, stepUpOff: ['bankDetails.change'] }, rules)).toBe(false)
    expect(stepUpRulesWiden(rules, { ...rules, stepUpMaxFailures: 6 })).toBe(true)
    expect(stepUpRulesWiden(rules, { ...rules, stepUpMaxFailures: 3, stepUpLockMinutes: 60 })).toBe(false)
    expect(stepUpRulesWiden(rules, { ...rules, stepUpLockMinutes: 5 })).toBe(true)
  })
})

describe('the step-up lock (the database keeps the same rule)', () => {
  const lock = { maxFailures: 3, lockMinutes: 15 }
  const tries = (...entries: [string, StepUpTry['result']][]): StepUpTry[] => entries.map(([iso, result]) => ({ at: at(iso), result }))

  it('locks at the n-th wrong or reused code in the window, until the oldest of them plus the lock', () => {
    const history = tries(['2026-11-01T10:00:00Z', 'WRONG_CODE'], ['2026-11-01T10:01:00Z', 'REUSED_CODE'])
    expect(stepUpLockedUntil(history, at('2026-11-01T10:02:00Z'), lock)).toBeNull()
    expect(failuresLeft(history, at('2026-11-01T10:02:00Z'), lock)).toBe(1)
    const third = [...history, ...tries(['2026-11-01T10:02:00Z', 'WRONG_CODE'])]
    expect(stepUpLockedUntil(third, at('2026-11-01T10:03:00Z'), lock)).toEqual(at('2026-11-01T10:15:00Z'))
    expect(failuresLeft(third, at('2026-11-01T10:03:00Z'), lock)).toBe(0)
    // LOCKED tries do not count; the lock ends by itself.
    const locked = [...third, ...tries(['2026-11-01T10:05:00Z', 'LOCKED'])]
    expect(stepUpLockedUntil(locked, at('2026-11-01T10:14:59Z'), lock)).toEqual(at('2026-11-01T10:15:00Z'))
    expect(stepUpLockedUntil(locked, at('2026-11-01T10:15:00Z'), lock)).toBeNull()
    expect(failuresLeft(locked, at('2026-11-01T10:15:00Z'), lock)).toBe(1)
  })

  it('counts only what came after the last success, and ignores later tries', () => {
    const history = tries(['2026-11-01T10:00:00Z', 'WRONG_CODE'], ['2026-11-01T10:01:00Z', 'WRONG_CODE'], ['2026-11-01T10:02:00Z', 'SUCCESS'], ['2026-11-01T10:03:00Z', 'WRONG_CODE'])
    expect(stepUpLockedUntil(history, at('2026-11-01T10:04:00Z'), lock)).toBeNull()
    expect(failuresLeft(history, at('2026-11-01T10:04:00Z'), lock)).toBe(2)
    expect(stepUpLockedUntil(history, at('2026-11-01T10:01:30Z'), lock)).toBeNull()
  })
})

describe('where a session runs (PLT-064)', () => {
  it('reads the device and the browser from the user agent', () => {
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toEqual({ deviceLabel: 'Mac', browser: 'Chrome 130' })
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0')).toEqual({ deviceLabel: 'Windows PC', browser: 'Firefox 132' })
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68')).toEqual({ deviceLabel: 'Windows PC', browser: 'Edge 130' })
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1')).toEqual({ deviceLabel: 'iPhone', browser: 'Safari 17' })
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toEqual({ deviceLabel: 'Android phone', browser: 'Chrome 130' })
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toEqual({ deviceLabel: 'Android tablet', browser: 'Chrome 130' })
    expect(deviceOf('lightMyRequest')).toEqual({ deviceLabel: null, browser: null })
    expect(deviceOf(undefined)).toEqual({ deviceLabel: null, browser: null })
  })

  it('answers the kind of a stored label (a code the web words)', () => {
    expect(deviceKindOf(DEVICE_LABELS.ANDROID_TABLET)).toBe('ANDROID_TABLET')
    expect(deviceKindOf('Toaster')).toBeNull()
    expect(deviceKindOf(null)).toBeNull()
  })

  it('keeps the place an edge proxy gives: a country we know, its city only with it', () => {
    expect(placeOf({ country: 'it', city: 'Seedville' })).toEqual({ ipCountry: 'IT', ipCity: 'Seedville' })
    expect(placeOf({ country: 'XX', city: 'Seedville' })).toEqual({ ipCountry: null, ipCity: null })
    expect(placeOf({ city: 'Seedville' })).toEqual({ ipCountry: null, ipCity: null })
    expect(placeOf({ country: 'DE', city: 'a\nb' })).toEqual({ ipCountry: 'DE', ipCity: null })
  })
})
