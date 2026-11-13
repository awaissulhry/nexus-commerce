'use client'

import { useCallback, type ReactNode } from 'react'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Phrase } from '../model'
import { EXTRAS_NS } from './model'
import './extras.css'

/**
 * The catalogue of the made-to-measure office extras (B-W2b-371: photos, the rider's thread, the list's filters and export, where
 * a template is used, its rule editor): `sales-mtm-office-extras`, added to the page's own. `say` speaks a phrase whose parameter
 * may itself be a key of it (`view.FRONT`) or a day (`2026-11-13`, in the page's date format).
 */
export function ExtrasMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[EXTRAS_NS]}>{children}</WithMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KEY_PARAM = /^(view|verdict|kind|severity|status|lifecycle|review)\.[A-Za-z_]+$/

export function useExtras() {
  const t = useT(EXTRAS_NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && KEY_PARAM.test(value)) params[name] = t(value)
        else if (typeof value === 'string' && DATE.test(value)) params[name] = formatDate(`${value}T12:00:00Z`, { locale })
        else params[name] = value
      }
      return t(phrase.key, params)
    },
    [t, locale],
  )
  const day = useCallback((value: string | null | undefined) => (value ? formatDate(DATE.test(value) ? `${value}T12:00:00Z` : value, { locale }) : '—'), [locale])
  const when = useCallback((value: string | null | undefined) => (value ? formatDateTime(value, { locale }) : '—'), [locale])
  return { t, say, day, when, locale }
}
