import { LOCALES, type Locale } from '../../../lib/i18n/locales'
import type { Loaded, Notice } from '../shared/model'

/**
 * SCR-016 Languages & formats (design 02 admin.languages; PLT-127, PLT-128, PLT-131, PLT-134, PLT-135): which languages
 * the office, the documents and the floor speak, how numbers and dates are written, and how time is kept. In W0 the
 * office and the documents speak Italiano and English (fixed by the product); what a company stores is its language and
 * its time zone, and each site its own zone. The page edits each company's language (EditModeBar, companies.manage); a
 * zone is changed on the company or the site (Companies & sites). Pure: the tests hold every rule.
 */

export interface SiteZone {
  id: string
  name: string
  kind: string
  timezone: string
  status: string
}

export interface CompanyLanguage {
  id: string
  code: string
  legalName: string
  locale: string
  timezone: string
  status: string
  version: number
  sites: readonly SiteZone[]
}

/** The languages a floor worker may read (users/model FLOOR_LOCALES); the floor screens speak `LOCALES` today. */
export const FLOOR_LANGUAGES = ['it', 'en', 'ro', 'sq', 'ar', 'zh', 'ur', 'bn'] as const
export type FloorLanguage = (typeof FLOOR_LANGUAGES)[number]

/** Each floor language named in its own words, never by a flag (A2 §3.1; design 02 admin.languages "Floor languages"). */
export const FLOOR_ENDONYMS: Readonly<Record<(typeof FLOOR_LANGUAGES)[number], string>> = {
  it: 'Italiano',
  en: 'English',
  ro: 'Română',
  sq: 'Shqip',
  ar: 'العربية',
  zh: '中文',
  ur: 'اردو',
  bn: 'বাংলা',
}

export interface LanguagesViewModel {
  prefix: string
  companies: Loaded<CompanyLanguage>
  /** The office people's languages (users.view); null: not the person's to read. */
  people: Loaded<{ locale: string }> | null
  /** Each site's floor languages (sites.view, `GET /org/floor-languages`); null: not the person's to read (absent). */
  floor: Loaded<FloorSite> | null
  /** An open add or remove confirm (the design index shows one); the page keeps it while the person decides. */
  floorDialog?: FloorDialog | null
  /** The last refusal of a site's change, in the page's words. */
  floorProblem?: FloorProblem | null
  floorBusy?: boolean
  /** How much of each interface language is written, in per cent of the keys (the i18n check keeps it at 100). */
  completeness: Readonly<Record<Locale, number>>
  can: { manage: boolean }
  asOf: string | null
  /** Unsaved languages per company (the design index shows an edit in progress). */
  draft?: Readonly<Record<string, string>>
  busy?: boolean
  notice?: Notice | null
}

/** How many of the items speak each language (unknown languages counted under their own code). */
export function localeCounts(items: ReadonlyArray<{ locale: string }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[item.locale] = (out[item.locale] ?? 0) + 1
  return out
}

/** Per cent of a catalogue's keys written in each language (the union of every language's keys is 100 %). */
export function completenessOf(catalogue: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>): Record<Locale, number> {
  const keys = new Set<string>()
  for (const locale of LOCALES) for (const [namespace, words] of Object.entries(catalogue[locale] ?? {})) for (const key of Object.keys(words)) keys.add(`${namespace}:${key}`)
  const out = {} as Record<Locale, number>
  for (const locale of LOCALES) {
    let written = 0
    for (const words of Object.values(catalogue[locale] ?? {})) for (const text of Object.values(words)) if (text.trim() !== '') written += 1
    out[locale] = keys.size === 0 ? 100 : Math.floor((written / keys.size) * 100)
  }
  return out
}

/** The companies whose language the draft changes, with their new language. */
export function changedLanguages(companies: readonly CompanyLanguage[], draft: Readonly<Record<string, string>>): Array<{ company: CompanyLanguage; locale: string }> {
  return companies.flatMap((company) => (draft[company.id] && draft[company.id] !== company.locale ? [{ company, locale: draft[company.id]! }] : []))
}

/** "12.345,50" or "12,345.50": how a number is written in a language (as every screen writes it). */
export const numberSample = (locale: Locale) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(12345.5)

/** "29/10/2026": the day first, in both languages. */
export const dateSample = (locale: Locale) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 29)))

/** The zones in use: each zone with the companies and sites that keep it. */
export function zonesInUse(companies: readonly CompanyLanguage[]): Array<{ zone: string; companies: number; sites: number }> {
  const zones = new Map<string, { companies: number; sites: number }>()
  for (const company of companies.filter((item) => item.status === 'ACTIVE')) {
    const own = zones.get(company.timezone) ?? { companies: 0, sites: 0 }
    own.companies += 1
    zones.set(company.timezone, own)
    for (const site of company.sites.filter((item) => item.status === 'ACTIVE')) {
      const row = zones.get(site.timezone) ?? { companies: 0, sites: 0 }
      row.sites += 1
      zones.set(site.timezone, row)
    }
  }
  return [...zones.entries()].map(([zone, counts]) => ({ zone, ...counts })).sort((a, b) => a.zone.localeCompare(b.zone))
}

// ---- B-W2a-41 (PLT-128): the floor languages of each site ------------------------------------------------------------

/**
 * A site's floor languages as `GET /org/floor-languages` answers them (platform/admin/org floor-languages.ts): the
 * languages its tablets offer, the active workers per language (null: the reader may not see the site's workers), the
 * company's worker notice in force with its languages (null: none in force), and whether the reader may change them.
 */
export interface FloorSite {
  id: string
  companyId: string
  companyCode: string
  companyName: string
  code: string
  name: string
  status: string
  locales: readonly string[]
  version: number
  workers: Readonly<Record<string, number>> | null
  notice: { id: string; label: string; locales: readonly string[] } | null
  canManage: boolean
}

/** The add or remove confirm of one site: the language and the languages the site would offer after it. */
export interface FloorDialog {
  siteId: string
  action: 'add' | 'remove'
  code: string
}

/** A refusal of one site's change: a message key of `admin-languages` (or `admin`) and its words. */
export interface FloorProblem {
  siteId: string
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** A language named in its own words; an unknown code as itself. */
export const endonymOf = (code: string): string => (FLOOR_ENDONYMS as Readonly<Record<string, string>>)[code] ?? code
/** The floor screens have their own words in this language (factory-web's catalogues: Italiano and English). */
export const floorHasWords = (code: string): boolean => (LOCALES as readonly string[]).includes(code)

/** One language a site offers, with what the page says about it and whether it can be removed (and why not). */
export interface FloorRow {
  code: string
  endonym: string
  /** The worker notice in force has this language; null: no notice is in force. */
  inNotice: boolean | null
  /** The floor screens speak it (else they show Italiano or English until its words exist). */
  screens: boolean
  /** Active workers of the site who read it; null: not the reader's to see. */
  workers: number | null
  /** Why it cannot be removed (a message key), or null. */
  removeHeld: { key: string; params?: Readonly<Record<string, string | number>> } | null
}

/** A language the site may add, or one held with the reason. */
export interface FloorChoice {
  code: string
  endonym: string
  /** Why it cannot be added (a message key), or null. */
  held: string | null
}

export interface FloorPlan {
  rows: FloorRow[]
  /** The languages not on the site yet (FLOOR_LANGUAGES order). */
  choices: FloorChoice[]
  /** Why nothing can be added (a message key), or null. */
  addHeld: string | null
}

/**
 * What the Floor languages section shows for one site and what it lets the person do. Adding: only a language the
 * worker notice in force has (the API refuses the rest: GDPR art. 12, a worker reads the notice in a language they
 * understand); removing: never the last one, never one active workers read (the API checks again).
 */
export function floorPlanOf(site: FloorSite): FloorPlan {
  const notice = site.notice ? new Set(site.notice.locales) : null
  const rows: FloorRow[] = site.locales.map((code) => {
    const workers = site.workers ? (site.workers[code] ?? 0) : null
    const removeHeld = !site.canManage
      ? { key: 'langs.floor.held.noRight' }
      : site.locales.length <= 1
        ? { key: 'langs.floor.held.last' }
        : workers !== null && workers > 0
          ? { key: 'langs.floor.held.workers', params: { count: workers } }
          : null
    return { code, endonym: endonymOf(code), inNotice: notice ? notice.has(code) : null, screens: floorHasWords(code), workers, removeHeld }
  })
  const choices: FloorChoice[] = FLOOR_LANGUAGES.filter((code) => !site.locales.includes(code)).map((code) => ({
    code,
    endonym: endonymOf(code),
    held: notice && notice.has(code) ? null : 'langs.floor.held.notInNotice',
  }))
  const addHeld = !site.canManage
    ? 'langs.floor.held.noRight'
    : notice === null
      ? 'langs.floor.held.noNotice'
      : choices.length === 0
        ? 'langs.floor.held.allAdded'
        : choices.every((choice) => choice.held !== null)
          ? 'langs.floor.held.noneInNotice'
          : null
  return { rows, choices, addHeld }
}

/** The site's languages after adding or removing one (the PUT's `locales`, in the site's order). */
export function localesAfter(site: Pick<FloorSite, 'locales'>, dialog: Pick<FloorDialog, 'action' | 'code'>): string[] {
  if (dialog.action === 'add') return site.locales.includes(dialog.code) ? [...site.locales] : [...site.locales, dialog.code]
  return site.locales.filter((code) => code !== dialog.code)
}

/** An API issue as the page reads it: its path and message (the message only for a leading count). */
export interface IssueLike {
  path: string
  message?: string
}

/**
 * A refused change in the page's words (never the API's): `remove/<code>` → active workers read it (their count from
 * the issue); `body/locales/<i>` → the added language is not in the worker notice in force (or none is in force);
 * a conflict without either → the site changed meanwhile. `fallback` is the admin key of anything else.
 */
export function floorRefusalOf(site: FloorSite, dialog: Pick<FloorDialog, 'action' | 'code'>, kind: string, issues: readonly IssueLike[], fallback: string): FloorProblem {
  const language = endonymOf(dialog.code)
  for (const issue of issues) {
    const removed = /^remove\/([a-z]{2,3})$/.exec(issue.path)
    if (removed) {
      // The count the API's sentence starts with (read in the refused command); else the site's own, when shown.
      const parsed = Number.parseInt(issue.message ?? '', 10)
      const count = Number.isFinite(parsed) && parsed > 0 ? parsed : (site.workers?.[removed[1]!] ?? 1)
      return { siteId: site.id, key: 'langs.floor.problem.workers', params: { language: endonymOf(removed[1]!), count } }
    }
    if (/^body\/locales\/\d+$/.test(issue.path)) return { siteId: site.id, key: site.notice ? 'langs.floor.problem.notInNotice' : 'langs.floor.problem.noNotice', params: { language } }
  }
  if (kind === 'conflict') return { siteId: site.id, key: 'langs.floor.problem.changed' }
  return { siteId: site.id, key: fallback }
}
