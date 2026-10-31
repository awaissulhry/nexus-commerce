'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { getAbout, getResults, getSchedule, type ReportAbout, type ReportResults, type ReportSchedule, type ResultRow } from './api'
import { csvName, csvOf, knownFilters, markOpened, readProblem, reportAddressOf, reportHref, reportsCanOf, type ReportAddress } from './model'
import { safeStorage } from './ReportsPage'
import { ReportView } from './view/ReportView'

/**
 * `/w/<company>/home/reports/<key>?tab=results|schedule|about&<filters>&group=` (SCR-104, a report): reads what the report
 * counts (GET /reports/:key), then the run of the address's filters (GET …/results) or its schedule (GET …/schedule).
 * Filters and grouping live in the address; a row opens its record; Export ▾ › CSV writes the rows the person sees (the
 * API sent only what their rights reach); "last opened by me" is remembered in this browser.
 */
export function ReportPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = useParams<{ key: string }>()
  const locale = useLocale()
  const key = decodeURIComponent(route.key)
  const prefix = pathname.replace(/\/home\/reports\/[^/]+\/?$/, '')
  const can = useMemo(() => reportsCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => reportAddressOf(params), [params])
  const [about, setAbout] = useState<{ value: ReportAbout | null; problem: string | null }>({ value: null, problem: null })
  const [results, setResults] = useState<{ value: ReportResults | null; problem: string | null; reading: boolean }>({ value: null, problem: null, reading: false })
  const [schedule, setSchedule] = useState<{ value: ReportSchedule | null; problem: string | null }>({ value: null, problem: null })
  const [selected, setSelected] = useState<string[]>([])
  const asked = useRef<string>('')

  const loadAbout = useCallback(async () => {
    if (!can.view) return
    try {
      setAbout({ value: await getAbout(api, key), problem: null })
    } catch (error) {
      setAbout({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, key])

  useEffect(() => {
    void loadAbout()
  }, [loadAbout])

  const runKey = `${key}|${locale}|${JSON.stringify(address.filters)}|${address.group ?? ''}`
  const loadResults = useCallback(async () => {
    const current = about.value
    if (!current || current.state !== 'READY') return
    asked.current = runKey
    setResults((value) => ({ ...value, problem: null, reading: true }))
    try {
      const value = await getResults(api, key, { filters: knownFilters(current, address.filters), group: address.group, lang: locale === 'it' ? 'it' : 'en' })
      if (asked.current !== runKey) return
      setResults({ value, problem: null, reading: false })
      setSelected([])
      markOpened(safeStorage(), key, value.asOf)
    } catch (error) {
      if (asked.current === runKey) setResults((value) => ({ value: value.value, problem: readProblem(error), reading: false }))
    }
  }, [about.value, api, key, address, locale, runKey])

  const loadSchedule = useCallback(async () => {
    const current = about.value
    if (!current || current.state !== 'READY') return
    try {
      setSchedule({ value: await getSchedule(api, key), problem: null })
    } catch (error) {
      setSchedule({ value: null, problem: readProblem(error) })
    }
  }, [about.value, api, key])

  useEffect(() => {
    if (address.tab === 'results') void loadResults()
    if (address.tab === 'schedule') void loadSchedule()
  }, [address.tab, loadResults, loadSchedule])

  const go = (next: ReportAddress) => router.replace(reportHref(prefix, key, next), { scroll: false })
  const rowHrefs = useMemo(
    () => Object.fromEntries((results.value?.rows ?? []).filter((row) => row.record).map((row) => [row.id, `${prefix}${recordAddress(row.record!, OFFICE_PAGES)}`])),
    [results.value, prefix],
  )
  // The file's words come from the report's own catalogue (the page's provider holds only the shell's).
  const t = useMemo(() => createTranslator(locale, messagesFor(locale, ['home-reports'])['home-reports'] ?? {}), [locale])
  const download = (ids: readonly string[] | null) => {
    const value = results.value
    if (!value) return
    const rows = ids ? value.rows.filter((row) => ids.includes(row.id)) : value.rows
    const blob = new Blob([csvOf(key, value.columns, rows, t, locale)], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = csvName(t(`report.${key}.title`), value.today)
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <ReportView
      model={{ can, prefix, key, address, about, results, schedule, rowHrefs, selected }}
      actions={{
        onFilter: (filter, value) => {
          const filters = { ...address.filters }
          if (value === null) delete filters[filter]
          else filters[filter] = value
          go({ ...address, filters })
        },
        onGroup: (group) => go({ ...address, group: group ?? null }),
        onRetry: (part) => void (part === 'about' ? loadAbout() : part === 'results' ? loadResults() : loadSchedule()),
        onOpenRow: (row: ResultRow) => {
          const href = rowHrefs[row.id]
          if (href) router.push(href)
        },
        onSelect: setSelected,
        onExport: download,
      }}
    />
  )
}
