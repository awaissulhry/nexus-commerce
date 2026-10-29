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
  /** The floor workers' languages (workers.view); null: not the person's to read. */
  workers: Loaded<{ locale: string }> | null
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
