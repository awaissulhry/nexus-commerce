import { useMemo } from 'react'
import type { Locale } from '../../../../lib/i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../../../../lib/i18n/messages'
import { useLocale, useReader } from '../../../../lib/i18n/provider'

/**
 * owb-of5 — the order workflow's own office words (messages/<locale>/order-record-flow.json): the band's ONE act, its tags and Back,
 * the Overview's new parts (the mockup, the next box, Restrict, the order as it was written), the Confirm window's promise and open
 * details, and the later tabs' new rows (owb-of6, owb-of7). Read straight from the catalogue as the window frame reads its own
 * (lib/window-shell/words.ts): the order page, the draft page and the Design desk say them without loading the namespace.
 */
export const ORDER_FLOW_NS = 'order-record-flow'

const CACHE = new Map<string, Translate>()

export function flowWordsFor(locale: Locale, reader: Reader): Translate {
  const key = `${locale}:${reader}`
  let words = CACHE.get(key)
  if (!words) {
    words = createTranslator(locale, catalogueFor(locale, ORDER_FLOW_NS, reader))
    CACHE.set(key, words)
  }
  return words
}

/** The flow's words in the page's language. */
export function useFlowWords(): Translate {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => flowWordsFor(locale, reader), [locale, reader])
}
