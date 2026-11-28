import { useMemo } from 'react'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'

/**
 * owb-b4 w4.2 — the department parts' own words (`messages/<locale>/department.json`: the fixed table's names, the bar's and the strip's
 * words), read straight from the catalogue as `lib/order-cells/words.ts` reads its own (no provider needed: the office, the portal and
 * the floor draw the same chip the same way), as its reader reads them. Department names come from the server once it answered.
 */

export const DEPARTMENT_NS = 'department'

const CACHE = new Map<string, Translate>()

/** The department catalogue's translator in a language, as `reader` reads it (built once per language and reader). */
export function departmentWordsFor(locale: Locale, reader: Reader = 'office'): Translate {
  const key = `${locale}:${reader}`
  let t = CACHE.get(key)
  if (!t) {
    t = createTranslator(locale, catalogueFor(locale, DEPARTMENT_NS, reader))
    CACHE.set(key, t)
  }
  return t
}

/** The department words of the page's language and reader. */
export function useDepartmentWords(): Translate {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => departmentWordsFor(locale, reader), [locale, reader])
}
