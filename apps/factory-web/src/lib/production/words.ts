import { useMemo } from 'react'
import { PROMISE_REASON_WORDS, type PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import { formatDate, formatTime } from '../i18n/format'
import { DEFAULT_LOCALE, type Locale } from '../i18n/locales'
import { CATALOGUE, createTranslator, type Translate } from '../i18n/messages'
import { useLocale } from '../i18n/provider'
import type { Phrase } from './model'

/**
 * F-PR-01 — the production parts' words: the `production` catalogue (`parts.*`, `progress.*`) in the page's language,
 * read straight from the catalogue as `ds-parts` reads `ds-words` (no `WithMessages` needed), so the office and the
 * portal draw the same part the same way. Days and times in the site's zone (`lib/i18n/format`).
 */

const CACHE = new Map<Locale, Translate>()

/** The `production` catalogue's translator for a language (built once per language). */
export function productionWordsFor(locale: Locale): Translate {
  let t = CACHE.get(locale)
  if (!t) {
    const catalogue = CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE]
    t = createTranslator(locale, catalogue.production ?? {})
    CACHE.set(locale, t)
  }
  return t
}

/** A calendar day (`YYYY-MM-DD`, written at noon UTC so no zone moves it) or an instant, as the page writes a day. */
export function dayText(value: string, locale: Locale): string {
  return formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, { locale })
}

export interface ProductionWords {
  readonly locale: Locale
  readonly t: Translate
  /** A phrase of the model, or a caller's written text as it is. */
  readonly say: (words: Phrase | string) => string
  readonly day: (value: string) => string
  readonly time: (value: string) => string
  /** A curated reason in the customer's words (never the office's text). */
  readonly reason: (code: PromiseReasonCode) => string
}

export function wordsFor(locale: Locale): ProductionWords {
  const t = productionWordsFor(locale)
  return {
    locale,
    t,
    say: (words) => (typeof words === 'string' ? words : t(words.key, words.params)),
    day: (value) => dayText(value, locale),
    time: (value) => formatTime(value, { locale }),
    reason: (code) => PROMISE_REASON_WORDS[code][locale],
  }
}

export function useProductionWords(): ProductionWords {
  const locale = useLocale()
  return useMemo(() => wordsFor(locale), [locale])
}
