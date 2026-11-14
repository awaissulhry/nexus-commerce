import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Translate } from '../../../lib/i18n/messages'
import type { LiveSession } from './api'

/**
 * Live sessions in words (B-W2b-413; design shell.profile "Where I'm signed in" and admin.users "Signed in now"), pure: the
 * order (this browser first, then the last used), the device and browser, the place, and a refusal as a message key of
 * `admin-security-depth`. My profile and a person's record in Admin › Users share these. Never a figure about a person:
 * the rows say where a session runs, nothing counts what anyone did.
 */

/** A read of the sessions: loading, the rows, or a problem (a message key). */
export type SessionsRead = { state: 'loading' } | { state: 'ok'; sessions: readonly LiveSession[] } | { state: 'failed'; problem: string }

/** This browser first, then the most recently used. */
export function sessionRows(sessions: readonly LiveSession[]): LiveSession[] {
  return [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id))
}

/** The sessions "Sign out everywhere else" ends: every one but this browser's. */
export const othersOf = (sessions: readonly LiveSession[]): number => sessions.filter((session) => !session.current).length

/** The device in words: its kind in the person's language, else the label kept on the session, else "Unknown device". */
export function deviceWords(session: Pick<LiveSession, 'deviceKind' | 'deviceLabel' | 'browser'>, t: Translate): string {
  const device = session.deviceKind ? t(`session.device.${session.deviceKind}`) : session.deviceLabel?.trim() ? session.deviceLabel.trim() : t('session.device.unknown')
  // A browser is a name and a version ("Firefox 132"): said the same in every language.
  return session.browser ? t('session.deviceBrowser', { device, browser: session.browser }) : device
}

/** A country's name in the person's language (ISO 3166-1 alpha-2), or the code itself when the browser cannot name it. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The place in words: "Milan, Italy", "Italy", or "Unknown place" (no edge proxy told it). */
export function placeWords(place: LiveSession['place'], locale: string, t: Translate): string {
  if (!place.country) return t('session.place.unknown')
  const country = countryName(place.country, locale)
  return place.city ? t('session.place.cityCountry', { city: place.city, country }) : country
}

/** A refused or failed session call as a message key (the API's English never shows). */
export function sessionProblem(error: unknown): string {
  if (!isApiError(error)) return 'session.problem.failed'
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict' && paths.includes('sessions/current')) return 'session.problem.current'
  if (error.kind === 'conflict' && paths.includes('sessions/self')) return 'session.problem.self'
  if (error.kind === 'not_found') return 'session.problem.gone'
  if (error.kind === 'forbidden') return 'session.problem.forbidden'
  if (error.kind === 'signed_out') return 'session.problem.signedOut'
  if (error.kind === 'unavailable') return 'session.problem.unavailable'
  return 'session.problem.failed'
}
