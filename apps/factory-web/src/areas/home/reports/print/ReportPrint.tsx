'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getAbout, getResults, type ReportAbout, type ReportResults } from '../api'
import { knownFilters, readProblem, reportAddressOf } from '../model'
import { ReportPrintView } from './view/ReportPrintView'

/**
 * `/w/<company>/home/reports/<key>/print?<filters>&group=` (SCR-104 tab:report-print): the run of the address, read once,
 * drawn for paper. Opened in a new tab from the report's Print or Export ▾ › PDF.
 */
export function ReportPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const route = useParams<{ key: string }>()
  const locale = useLocale()
  const key = decodeURIComponent(route.key)
  const address = useMemo(() => reportAddressOf(params), [params])
  const [about, setAbout] = useState<{ value: ReportAbout | null; problem: string | null }>({ value: null, problem: null })
  const [results, setResults] = useState<{ value: ReportResults | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    let live = true
    getAbout(api, key)
      .then(async (value) => {
        if (!live) return
        setAbout({ value, problem: null })
        if (value.state !== 'READY') return
        const run = await getResults(api, key, { filters: knownFilters(value, address.filters), group: 'none', lang: locale === 'it' ? 'it' : 'en' })
        if (live) setResults({ value: run, problem: null })
      })
      .catch((error: unknown) => live && setResults({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, key, address, locale])
  return <ReportPrintView model={{ person: session.user.displayName, about, results }} />
}
