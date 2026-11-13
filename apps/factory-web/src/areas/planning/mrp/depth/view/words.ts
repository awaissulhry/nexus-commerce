'use client'

import { useCallback } from 'react'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity, type Phrase } from '../../../../_shared/buying/model'
import { DEPTH_NAMESPACE } from '../model'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL = /^-?\d+(\.\d+)?$/

/**
 * The W2b parts' words: a phrase of `planning-mrp-depth` with its values said in the person's language — a day as a date
 * of the site's zone, a decimal as a quantity, `unit` as the unit's word (`buying`), a value `field.<name>` as that word.
 */
export function useDepthSay(timeZone?: string): (words: Phrase | null | undefined) => string {
  const t = useT(DEPTH_NAMESPACE)
  const tb = useT('buying')
  const locale = useLocale()
  return useCallback(
    (words: Phrase | null | undefined) => {
      if (!words) return ''
      const params = Object.fromEntries(
        Object.entries(words.params ?? {}).map(([name, value]) => {
          if (typeof value !== 'string') return [name, value]
          if (name === 'unit') return [name, value ? tb(`uom.${value}`) : '']
          if (value.startsWith('field.')) return [name, t(value)]
          if (DAY.test(value)) return [name, formatDate(dayAt(value), { locale, timeZone })]
          if (DECIMAL.test(value) && name !== 'line' && name !== 'number') return [name, quantity(value, locale, 4)]
          return [name, value]
        }),
      )
      return t(words.key, params)
    },
    [t, tb, locale, timeZone],
  )
}
