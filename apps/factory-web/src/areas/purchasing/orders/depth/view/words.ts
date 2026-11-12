'use client'

import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { formatDate } from '../../../../../lib/i18n/format'
import { dayAt, type Phrase } from '../../../../_shared/buying/model'
import { DEPTH } from '../model'

/** The namespaces the depth parts speak (inside the record's and the list's WithMessages). */
export const DEPTH_NAMESPACES = ['buying', 'purchasing-orders', DEPTH, 'lists', 'calendar-kit'] as const

/** A day (YYYY-MM-DD) or an instant in the page's language. */
export function useDay() {
  const locale = useLocale()
  return (value: string | null | undefined): string => (value ? formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? dayAt(value) : value, { locale }) : '—')
}

/**
 * A phrase in words: `buying:` the buying catalogue, `purchasing-orders:` the W2a step's, `purchasing-orders-depth:` this
 * step's; an unprefixed key is `own`'s (this step's for the model's rules; buying's for a write's refusal, writeProblem's).
 * A `date` or `due` param (a day or an instant) is said as a date in the page's language.
 */
export function useDepthSay(own: 'depth' | 'buying' = 'depth') {
  const td = useT(DEPTH)
  const tb = useT('buying')
  const tp = useT('purchasing-orders')
  const day = useDay()
  const dated = (params: Phrase['params']): Phrase['params'] => {
    if (!params) return params
    const out: Record<string, string | number> = { ...params }
    for (const name of ['date', 'due']) if (typeof out[name] === 'string' && out[name]) out[name] = day(String(out[name]))
    return out
  }
  return (words: Phrase | null | undefined): string | null => {
    if (!words) return null
    if (words.key.startsWith('buying:')) return tb(words.key.slice('buying:'.length), words.params)
    if (words.key.startsWith(`${DEPTH}:`)) return td(words.key.slice(DEPTH.length + 1), dated(words.params))
    if (words.key.startsWith('purchasing-orders:')) return tp(words.key.slice('purchasing-orders:'.length), words.params)
    return own === 'buying' ? tb(words.key, words.params) : td(words.key, dated(words.params))
  }
}
