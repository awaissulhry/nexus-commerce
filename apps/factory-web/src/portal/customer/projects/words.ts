'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from './model'

/** The words of a project in the portal (`portal-projects`, B-TH-253), the frame's (`portal`: a record type's name) and its writers. */
export interface ProjectWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly portal: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`), written at noon UTC so no zone moves it. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
}

export function projectWordsFor(t: ProjectWords['t'], portal: ProjectWords['portal'], locale: Locale): ProjectWords {
  return {
    t,
    portal,
    locale,
    day: (iso) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' }),
    at: (iso) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
  }
}

export function useProjectWords(): ProjectWords {
  const t = useT(NS)
  const portal = useT('portal')
  const locale = useLocale()
  return useMemo(() => projectWordsFor(t, portal, locale), [t, portal, locale])
}
