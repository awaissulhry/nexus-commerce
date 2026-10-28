/**
 * The interface languages (PLT-127: Italian and English, per person). Plain module: server layouts, client components
 * and Node tests all read it.
 *
 * Which language a page speaks, strongest first: the signed-in person's own (`User.locale`), the language cookie (a
 * choice made on a link page or before sign-in), the browser's Accept-Language, Italian.
 */

export const LOCALES = ['it', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'it'

/** The cookie that keeps a language chosen before sign-in or on a link page. Not secret; readable by the page. */
export const LOCALE_COOKIE = 'factory_locale'

/** Each language named in its own words, never by a flag (A2 §3.1). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { it: 'Italiano', en: 'English' }

/** The `Intl` tag for formatting: English as written in Europe (day first, 24-hour clock). */
export const INTL_LOCALE: Readonly<Record<Locale, string>> = { it: 'it-IT', en: 'en-GB' }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** A language tag (`it-IT`, `EN`, `en_GB`) as one of ours, or null. */
export function localeOf(value: string | null | undefined): Locale | null {
  if (typeof value !== 'string') return null
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return isLocale(base) ? base : null
}

/** The first language of an Accept-Language header we speak, by the header's weights. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      const weight = q ? Number.parseFloat(q.slice(2)) : 1
      return { tag: tag ?? '', weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const entry of ranked) {
    const locale = localeOf(entry.tag)
    if (locale) return locale
  }
  return null
}

export interface LocaleSources {
  /** The signed-in person's language. */
  person?: string | null
  /** The language cookie. */
  cookie?: string | null
  acceptLanguage?: string | null
}

/** The page's language: the person's, else the cookie's, else the browser's, else Italian. */
export function pickLocale({ person, cookie, acceptLanguage }: LocaleSources): Locale {
  return localeOf(person) ?? localeOf(cookie) ?? localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE
}
