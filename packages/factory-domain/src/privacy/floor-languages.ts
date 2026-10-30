import type { Issue } from '../core/errors'

/**
 * The floor languages of a site (B-W2a-41; PLT-128; design admin.languages "Floor languages"; GDPR art. 12 and 13):
 * the languages its tablets offer workers, kept in Site.floorLocales (default Italian and English). Pure; the API
 * (platform/admin/org/floor-languages.ts) gathers the facts.
 *
 *   - a language is its ISO 639 code, lower case (`it`, `en`, `ro`), once, and a site keeps at least one;
 *   - a language is ADDED only when the worker notice of the site's company is in force (published) with that language
 *     (its text or its PDF): a worker reads what the floor records about them in a language they understand. No notice
 *     in force, or none in that language: refused in words, with where to add it (Admin › Privacy);
 *   - a language is REMOVED only when no active worker of the site reads it: change their language first;
 *   - the floor screens have their own words for Italian and English only (factory-web's messages); another language
 *     the notice has is offered, and the screens say they show Italian or English until its words exist (each new
 *     language needs the Owner's list, Q23, and the privacy consultant's notice text: GATE-PRIVACY).
 */

const CODE = /^[a-z]{2,3}$/
export const MAX_FLOOR_LANGUAGES = 12

export interface FloorLanguageFacts {
  /** The site's languages now. */
  readonly current: readonly string[]
  /** The languages of the company's worker notice in force; null: no worker notice is in force. */
  readonly noticeLanguages: readonly string[] | null
  /** Active workers of the site per language they read. */
  readonly workersByLanguage: Readonly<Record<string, number>>
}

export interface FloorLanguagePlan {
  readonly locales: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly problems: readonly Issue[]
}

/** What the change does, and what stops it (issues at `body/locales/<i>` or `body/locales`). */
export function planFloorLanguages(wanted: readonly string[], facts: FloorLanguageFacts): FloorLanguagePlan {
  const problems: Issue[] = []
  const locales = wanted.map((code) => code.trim().toLowerCase())
  locales.forEach((code, index) => {
    if (!CODE.test(code)) problems.push({ path: `body/locales/${index}`, message: 'A language is its ISO 639 code in lower case, for example it, en or ro.' })
    else if (locales.indexOf(code) !== index) problems.push({ path: `body/locales/${index}`, message: `${code} is listed twice.` })
  })
  if (locales.length === 0) problems.push({ path: 'body/locales', message: 'A site keeps at least one floor language.' })
  if (locales.length > MAX_FLOOR_LANGUAGES) problems.push({ path: 'body/locales', message: `A site offers at most ${MAX_FLOOR_LANGUAGES} floor languages.` })
  const added = locales.filter((code, index) => CODE.test(code) && locales.indexOf(code) === index && !facts.current.includes(code))
  const removed = facts.current.filter((code) => !locales.includes(code))
  for (const code of added) {
    const index = locales.indexOf(code)
    if (facts.noticeLanguages === null) {
      problems.push({ path: `body/locales/${index}`, message: `No worker notice is in force for this company: publish it in ${code} first (Admin › Privacy), then add the language.` })
    } else if (!facts.noticeLanguages.includes(code)) {
      problems.push({ path: `body/locales/${index}`, message: `The worker notice in force has no ${code} text or PDF: add it to the notice (Admin › Privacy), then add the language.` })
    }
  }
  for (const code of removed) {
    const workers = facts.workersByLanguage[code] ?? 0
    if (workers > 0) problems.push({ path: `remove/${code}`, message: `${workers} active worker${workers === 1 ? '' : 's'} of the site read${workers === 1 ? 's' : ''} ${code}: give them another language first (Admin › Users › Floor workers).` })
  }
  return { locales, added, removed, problems }
}
