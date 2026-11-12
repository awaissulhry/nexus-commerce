'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useLive } from '../../_shared/buying/hooks'
import { readProblem } from '../../_shared/stock/model'
import { liveMatches } from '../../quality/_shared/hooks'
import { getAgeing, getLeather, type Ageing, type Leather, type LeatherMeasure } from './api'
import {
  ageingCsvRows,
  csvName,
  csvOf,
  LAYOUT_KEY,
  leatherCsvRows,
  LIVE_EVERY_MS,
  LIVE_TYPES,
  rangeShown,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  romeToday,
  sectionSpecs,
  type AgeingSeries,
  type CsvWords,
  type ReportsAddress,
  type ReportSection,
} from './model'
import { ReportsView, type Read } from './view/ReportsView'

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * At most one read per `ms` while changes keep coming (design: "at most once a minute"): the first change reads at once when
 * the last read is older than that, else once when the minute is up.
 */
function useAtMostEvery(run: () => void, ms: number): () => void {
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(run)
  latest.current = run
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(() => {
    if (timer.current) return
    const wait = Math.max(0, last.current + ms - Date.now())
    timer.current = setTimeout(() => {
      timer.current = null
      last.current = Date.now()
      latest.current()
    }, wait)
  }, [ms])
}

/**
 * `/w/<company>/warehouse/reports?from=&to=` (SCR-257): the top bar's site (all sites: every one the person sees), the period of
 * the address (else this month so far), two panels each read on its own (a failed one says so and the other stays), live
 * re-reads on stock moves at most once a minute, Arrange saved per person on this device, a panel's rows as a CSV file, the print
 * view (SCR-353) in a new tab.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/reports\/?$/, '')
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const enabled = can.view
  const siteId = scope.siteId

  const [ageing, setAgeing] = useState<Read<Ageing>>({ status: 'idle' })
  const [leather, setLeather] = useState<Read<Leather>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [series, setSeries] = useState<AgeingSeries>('share')
  const [measure, setMeasure] = useState<LeatherMeasure>('received')
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  const query = useMemo(() => ({ siteId, from: address.from, to: address.to }), [siteId, address.from, address.to])

  const readAgeing = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getAgeing(api, query)
      setAgeing({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setAgeing({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, query])
  const readLeather = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getLeather(api, query)
      setLeather({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setLeather({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, query])

  const readAll = useCallback(() => {
    void (async () => {
      await readAgeing()
      await readLeather()
    })()
  }, [readAgeing, readLeather])

  useEffect(() => {
    if (!enabled) return
    setAgeing({ status: 'loading' })
    setLeather({ status: 'loading' })
    readAll()
  }, [enabled, readAll])

  const refresh = useAtMostEvery(readAll, LIVE_EVERY_MS)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = ageing.status === 'ready' ? ageing.value : leather.status === 'ready' ? leather.value : null
  const today = answered?.today ?? romeToday()
  const range = rangeShown(address, answered, today)

  const exportPanel = (panel: ReportSection, words: CsvWords) => {
    if (panel === 'ageing' && ageing.status === 'ready') saveCsv(csvName(panel, range), csvOf(words.header, ageingCsvRows(ageing.value, words)))
    if (panel === 'leather' && leather.status === 'ready') saveCsv(csvName(panel, range), csvOf(words.header, leatherCsvRows(leather.value, words)))
  }

  const retry: Record<ReportSection, () => void> = {
    ageing: () => {
      setAgeing({ status: 'loading' })
      void readAgeing()
    },
    leather: () => {
      setLeather({ status: 'loading' })
      void readLeather()
    },
  }

  return (
    <ReportsView
      model={{ prefix, can, address, scope, range, today, ageing, leather, live, asOf, layout, specs, arranging, series, measure }}
      actions={{
        onAddress: go,
        onRetry: (panel) => retry[panel](),
        onArrange: setArranging,
        onArranged: (next) => {
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
        onExport: exportPanel,
        onSeries: setSeries,
        onMeasure: setMeasure,
      }}
    />
  )
}
