import type { Issue } from '../../core/errors'

/**
 * Session lengths per audience and the step-up rules as company settings (B-W2b-404; PLT-068, PLT-063; design
 * admin.security "Session lengths" and "Actions that ask for a fresh code"), pure. One SecuritySettings row per tenant
 * (id = the tenant's own id, B-W2b-373); no row = these defaults, the fixed values of W0 and A1:
 *
 *   office   idle 8 h (15 min to 24 h), longest 7 days (1 h to 30 days); the idle time never longer than the longest
 *   portal   idle 30 min (5 to 30 min), longest 12 h (1 to 12 h): the database keeps the portal's A1 maximum on every
 *            partner session too, so a tenant can only shorten it
 *   floor    the site's own FloorSettings (idle minutes, shift ends): not here
 *   step-up  the actions switched off (empty: every risky action asks), how many wrong codes in a row lock step-up
 *            (3 to 10, default 5) and for how long (5 min to 24 h, default 15 min)
 *
 * "Longer = wider: fresh code": a change that lengthens a session, switches an action off, allows more wrong codes or
 * shortens the lock is wider, and asks for a fresh code; a stricter one never does. A shorter length applies to every
 * open session at its next request (`liveUntil`); a longer one to new sessions (the idle end at the next slide).
 */

export const SECURITY_DEFAULTS = Object.freeze({
  officeIdleMinutes: 480,
  officeLongestHours: 168,
  portalIdleMinutes: 30,
  portalLongestHours: 12,
  stepUpMaxFailures: 5,
  stepUpLockMinutes: 15,
})

export type SecurityNumber = keyof typeof SECURITY_DEFAULTS

/** The bounds the database keeps too (SecuritySettings_guard). */
export const SECURITY_BOUNDS: Readonly<Record<SecurityNumber, readonly [number, number]>> = Object.freeze({
  officeIdleMinutes: [15, 1440],
  officeLongestHours: [1, 720],
  portalIdleMinutes: [5, 30],
  portalLongestHours: [1, 12],
  stepUpMaxFailures: [3, 10],
  stepUpLockMinutes: [5, 1440],
})

/** At most this many actions switched off (the database's limit). */
export const STEP_UP_OFF_MAX = 50

/** An action key as the database keeps it: dotted lower camel case words, at most 80 characters. */
export const ACTION_KEY = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/

export interface SessionLengths {
  readonly officeIdleMinutes: number
  readonly officeLongestHours: number
  readonly portalIdleMinutes: number
  readonly portalLongestHours: number
}

export interface StepUpRules {
  /** The action keys switched off: they no longer ask for a fresh code. */
  readonly stepUpOff: readonly string[]
  readonly stepUpMaxFailures: number
  readonly stepUpLockMinutes: number
}

export interface SecurityRules extends SessionLengths, StepUpRules {}

/** The rules of a tenant: its row, or the defaults without one. */
export function securityRulesOf(row: (SessionLengths & StepUpRules) | null): SecurityRules {
  if (row === null) return { ...SECURITY_DEFAULTS, stepUpOff: [] }
  return {
    officeIdleMinutes: row.officeIdleMinutes,
    officeLongestHours: row.officeLongestHours,
    portalIdleMinutes: row.portalIdleMinutes,
    portalLongestHours: row.portalLongestHours,
    stepUpOff: [...row.stepUpOff],
    stepUpMaxFailures: row.stepUpMaxFailures,
    stepUpLockMinutes: row.stepUpLockMinutes,
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The lengths in milliseconds, as the authenticators use them. */
export function sessionLengthsMs(rules: SessionLengths) {
  return {
    office: { idleMs: rules.officeIdleMinutes * MINUTE, longestMs: rules.officeLongestHours * HOUR },
    portal: { idleMs: rules.portalIdleMinutes * MINUTE, longestMs: rules.portalLongestHours * HOUR },
  }
}

/** The codes of a refused settings change (paths `body/<field>/<code>`); the web says its own words. */
export const SECURITY_SETTINGS_REFUSALS = Object.freeze({
  range: 'The value is outside what is allowed.',
  idleLongest: 'The idle time cannot be longer than the longest session.',
  unknownAction: 'There is no such action that asks for a fresh code.',
  fixedAction: 'This action always asks for a fresh code: it cannot be switched off.',
  repeated: 'An action is named twice.',
  tooMany: `At most ${STEP_UP_OFF_MAX} actions can be switched off.`,
})
export type SecuritySettingsRefusal = keyof typeof SECURITY_SETTINGS_REFUSALS

const refusal = (field: string, code: SecuritySettingsRefusal): Issue => ({ path: `body/${field}/${code}`, message: SECURITY_SETTINGS_REFUSALS[code] })

function rangeProblems<K extends SecurityNumber>(values: Readonly<Record<K, number>>, keys: readonly K[]): Issue[] {
  return keys.flatMap((key) => {
    const [low, high] = SECURITY_BOUNDS[key]
    const value = values[key]
    return Number.isInteger(value) && value >= low && value <= high ? [] : [refusal(key, 'range')]
  })
}

/** What is wrong with session lengths (empty: fine). */
export function lengthProblems(lengths: SessionLengths): Issue[] {
  const issues = rangeProblems(lengths, ['officeIdleMinutes', 'officeLongestHours', 'portalIdleMinutes', 'portalLongestHours'])
  if (issues.length === 0 && lengths.officeIdleMinutes > lengths.officeLongestHours * 60) issues.push(refusal('officeIdleMinutes', 'idleLongest'))
  if (issues.length === 0 && lengths.portalIdleMinutes > lengths.portalLongestHours * 60) issues.push(refusal('portalIdleMinutes', 'idleLongest'))
  return issues
}

/** What is wrong with step-up rules, given the actions there are and those that may be switched off. */
export function stepUpRuleProblems(rules: StepUpRules, actions: ReadonlyMap<string, { readonly canSwitchOff: boolean }>): Issue[] {
  const issues = rangeProblems(rules, ['stepUpMaxFailures', 'stepUpLockMinutes'])
  if (rules.stepUpOff.length > STEP_UP_OFF_MAX) issues.push(refusal('stepUpOff', 'tooMany'))
  if (new Set(rules.stepUpOff).size !== rules.stepUpOff.length) issues.push(refusal('stepUpOff', 'repeated'))
  rules.stepUpOff.forEach((key, index) => {
    const action = ACTION_KEY.test(key) && key.length <= 80 ? actions.get(key) : undefined
    if (!action) issues.push(refusal(`stepUpOff/${index}`, 'unknownAction'))
    else if (!action.canSwitchOff) issues.push(refusal(`stepUpOff/${index}`, 'fixedAction'))
  })
  return issues
}

/** Longer = wider: some session would last longer after the change. */
export function lengthsWiden(before: SessionLengths, after: SessionLengths): boolean {
  return (
    after.officeIdleMinutes > before.officeIdleMinutes ||
    after.officeLongestHours > before.officeLongestHours ||
    after.portalIdleMinutes > before.portalIdleMinutes ||
    after.portalLongestHours > before.portalLongestHours
  )
}

/** Wider: an action switched off that asked before, more wrong codes allowed, or a shorter lock. */
export function stepUpRulesWiden(before: StepUpRules, after: StepUpRules): boolean {
  return (
    after.stepUpOff.some((key) => !before.stepUpOff.includes(key)) ||
    after.stepUpMaxFailures > before.stepUpMaxFailures ||
    after.stepUpLockMinutes < before.stepUpLockMinutes
  )
}

/** The idle end after a request at `now`: `idleMs` later, never past the session's absolute end. */
export function idleEndAfter(now: Date, absoluteExpiresAt: Date, idleMs: number): Date {
  return new Date(Math.min(now.getTime() + idleMs, absoluteExpiresAt.getTime()))
}

/**
 * Until when a session lives under the tenant's lengths NOW: its stored ends, shortened by a shorter idle time (from its
 * last request) or a shorter longest session (from its start). A shorter length thus ends open sessions at their next
 * request; a longer one never lengthens a stored end.
 */
export function liveUntil(
  session: { readonly createdAt: Date; readonly lastSeenAt: Date; readonly idleExpiresAt: Date; readonly absoluteExpiresAt: Date },
  lengths: { readonly idleMs: number; readonly longestMs: number },
): { readonly idleExpiresAt: Date; readonly absoluteExpiresAt: Date } {
  const absoluteExpiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), session.createdAt.getTime() + lengths.longestMs))
  const idleExpiresAt = new Date(Math.min(session.idleExpiresAt.getTime(), session.lastSeenAt.getTime() + lengths.idleMs, absoluteExpiresAt.getTime()))
  return { idleExpiresAt, absoluteExpiresAt }
}

/** The session is live at `now` under those ends. */
export const isLiveAt = (ends: { readonly idleExpiresAt: Date; readonly absoluteExpiresAt: Date }, now: Date): boolean =>
  ends.idleExpiresAt.getTime() > now.getTime() && ends.absoluteExpiresAt.getTime() > now.getTime()
