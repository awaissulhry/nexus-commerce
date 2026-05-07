'use client'

import { useCallback, useEffect, useState } from 'react'
import en from './messages/en.json'
import it from './messages/it.json'

/**
 * U.15 — minimal i18n shim.
 *
 * Phase-1 scope: a JSON-catalog-based `t()` function and a locale-
 * picker hook backed by localStorage. Deliberately not pulling in
 * next-intl yet — that would require middleware-based locale routing
 * + URL changes (/it/products vs /products?lang=it) which is a bigger
 * architectural decision than U.15 wants to make.
 *
 * Migration path: when the team picks a real i18n library, the
 * `useT()` hook is the single integration point. The JSON catalogs
 * in messages/ are already in a flat-key format that matches what
 * next-intl, react-intl, and lingui all consume.
 *
 * Today: messages flow English by default; users can switch to
 * Italian via LocaleToggle. Strings not yet keyed render their
 * English fallback unchanged. Adoption is opt-in per surface — the
 * goal is to seed the catalogs and infrastructure, not flip every
 * surface to t('key') in one PR.
 */

export type Locale = 'en' | 'it'

const CATALOGS: Record<Locale, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  it: it as unknown as Record<string, string>,
}

const STORAGE_KEY = 'nexus:locale'

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  const v = window.localStorage.getItem(STORAGE_KEY)
  return v === 'en' || v === 'it' ? v : 'en'
}

/**
 * `t('key', { name: 'Awais' })` — looks up `key` in the active
 * catalog, then substitutes `{name}` placeholders. Falls back to the
 * English value, then to the key itself, so missing translations
 * never render as blank text.
 */
function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const localised = CATALOGS[locale]?.[key]
  const fallback = CATALOGS.en?.[key]
  let raw = localised ?? fallback ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      raw = raw.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return raw
}

export function useTranslations() {
  const [locale, setLocaleState] = useState<Locale>('en')

  // Hydrate from localStorage on mount; same SSR-safe pattern as
  // useTheme so the server renders English and the client can switch
  // post-hydrate without a flash.
  useEffect(() => {
    setLocaleState(readStoredLocale())
  }, [])

  // Cross-tab sync: another tab changing locale flips this one too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'en' || e.newValue === 'it')) {
        setLocaleState(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale],
  )

  return { locale, setLocale, t }
}
