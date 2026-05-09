/**
 * L.23.0 — Server-component i18n.
 *
 * The client-side `useTranslations` hook reads localStorage to pick
 * 'en' vs 'it'. Server components can't access localStorage, so they
 * read from a cookie that the client mirrors on every setLocale()
 * call (see use-translations.ts).
 *
 * Usage in a server page:
 *
 *   import { getServerT } from '@/lib/i18n/server'
 *
 *   export default async function Page() {
 *     const t = await getServerT()
 *     return <PageHeader title={t('syncLogs.hub.title')} ... />
 *   }
 *
 * Falls back to English when:
 *   - the cookie is missing (first visit, before client toggles)
 *   - the cookie value is unrecognised
 *   - a key is missing from the active catalog
 */

import { cookies } from 'next/headers'
import en from './messages/en.json'
import it from './messages/it.json'

export type Locale = 'en' | 'it'

const STORAGE_KEY = 'nexus:locale'

const CATALOGS: Record<Locale, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  it: it as unknown as Record<string, string>,
}

export async function getServerLocale(): Promise<Locale> {
  // next/headers' cookies() is async on Next.js 15+ and sync on
  // earlier versions. await is safe in both — sync cookies() returns
  // the cookie store directly which await passes through.
  const store = await cookies()
  const v = store.get(STORAGE_KEY)?.value
  return v === 'it' || v === 'en' ? v : 'en'
}

/**
 * Translate a key with optional `{var}` placeholders. Mirrors the
 * client-side translate() shim so the same catalog keys work on
 * both sides.
 */
function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const raw =
    CATALOGS[locale]?.[key] ?? CATALOGS.en[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => {
    const v = vars[name]
    return v === undefined ? m : String(v)
  })
}

/**
 * Resolve the server-side locale once and return a bound translator
 * for the rest of the page render.
 */
export async function getServerT() {
  const locale = await getServerLocale()
  return (key: string, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)
}
