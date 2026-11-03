'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { liveMatches } from '../_shared/hooks'
import { problemKey } from '../_shared/model'
import { getCompare, getIncoming, getKpis, getTrend, type Compare, type Dimension, type Incoming, type Kpis, type KpiKey, type Trend } from './api'
import { compareCsvRows, csvName, csvText, incomingCsvRows, kpiCsvRows, LAYOUT_KEY, rangeShown, reportsAddressOf, reportsAddressText, reportsCan, sectionSpecs, trendCsvRows, type CsvWords, type ReportsAddress, type ReportSection } from './model'
import { ReportsView, type Read } from './view/ReportsView'

/**
 * What changes a figure (design "inspection.signed / ncr.closed → KPIs and charts", debounced; AsOf updates): a signed final
 * inspection, a decided in-process or incoming check, an NCR's stage, a CAPA action or closure, a hold placed or released, a
 * lot's lab decision, a correction answered. Each event comes only to whoever may see its record; the page reads again.
 */
const LIVE_TYPES = [
  'quality.inspection_decided',
  'in_process_check.changed',
  'incoming_inspection.decided',
  'ncr.created',
  'ncr.stage_changed',
  'capa.action_changed',
  'capa.stage_changed',
  'quality.hold_placed',
  'quality.hold_released',
  'lot.released',
  'lot.rejected',
  'lot.test_recorded',
  'inspection_amendment.answered',
]

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * `/w/<company>/quality/reports?from=&to=&compare=0&by=&line=` (SCR-147): the top bar's site, the period of the address (else
 * the 30 days up to today) compared with the previous one, four panels each read on its own (a failed one says so and the
 * others stay), live re-reads, Arrange saved per person on this device, a panel's rows as a CSV file, the print tab.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/quality\/reports\/?$/, '')
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const siteId = scope.siteId
  const enabled = can.view && !!siteId

  const [kpis, setKpis] = useState<Read<Kpis>>({ status: 'idle' })
  const [trend, setTrend] = useState<Read<Trend>>({ status: 'idle' })
  const [compare, setCompare] = useState<Read<Compare>>({ status: 'idle' })
  const [incoming, setIncoming] = useState<Read<Incoming>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  const scopeOf = useMemo(() => (siteId ? { siteId, from: address.from, to: address.to } : null), [siteId, address.from, address.to])

  const readKpis = useCallback(async () => {
    if (!enabled || !scopeOf) return
    try {
      const value = await getKpis(api, { ...scopeOf, compare: address.compare })
      setKpis({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setKpis({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scopeOf, address.compare])
  const readTrend = useCallback(async () => {
    if (!enabled || !scopeOf) return
    try {
      setTrend({ status: 'ready', value: await getTrend(api, { ...scopeOf, lineId: address.lineId }) })
    } catch (error) {
      setTrend({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scopeOf, address.lineId])
  const readCompare = useCallback(async () => {
    if (!enabled || !scopeOf) return
    try {
      setCompare({ status: 'ready', value: await getCompare(api, { ...scopeOf, by: address.by }) })
    } catch (error) {
      setCompare({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scopeOf, address.by])
  const readIncoming = useCallback(async () => {
    if (!enabled || !scopeOf) return
    try {
      setIncoming({ status: 'ready', value: await getIncoming(api, scopeOf) })
    } catch (error) {
      setIncoming({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scopeOf])

  useEffect(() => {
    if (!enabled) return setKpis({ status: 'idle' })
    setKpis({ status: 'loading' })
    void readKpis()
  }, [enabled, readKpis])
  useEffect(() => {
    if (!enabled) return setTrend({ status: 'idle' })
    setTrend({ status: 'loading' })
    void readTrend()
  }, [enabled, readTrend])
  useEffect(() => {
    if (!enabled) return setCompare({ status: 'idle' })
    setCompare({ status: 'loading' })
    void readCompare()
  }, [enabled, readCompare])
  useEffect(() => {
    if (!enabled) return setIncoming({ status: 'idle' })
    setIncoming({ status: 'loading' })
    void readIncoming()
  }, [enabled, readIncoming])

  const readAll = useCallback(() => {
    void readKpis()
    void readTrend()
    void readCompare()
    void readIncoming()
  }, [readKpis, readTrend, readCompare, readIncoming])
  const refresh = useCoalesced(readAll, 1500)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = kpis.status === 'ready' ? kpis.value : trend.status === 'ready' ? trend.value : null
  const range = rangeShown(address, answered)

  const exportPanel = (panel: ReportSection, words: CsvWords) => {
    if (panel === 'kpi' && kpis.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, kpiCsvRows(kpis.value, (words.labels ?? {}) as Readonly<Record<KpiKey, string>>, locale)))
    if (panel === 'trend' && trend.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, trendCsvRows(trend.value.weeks, words, locale)))
    if (panel === 'table' && compare.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, compareCsvRows(compare.value.rows, words, locale)))
    if (panel === 'supplier' && incoming.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, incomingCsvRows(incoming.value, words, locale)))
  }

  const retry: Record<ReportSection, () => void> = {
    kpi: () => {
      setKpis({ status: 'loading' })
      void readKpis()
    },
    trend: () => {
      setTrend({ status: 'loading' })
      void readTrend()
    },
    table: () => {
      setCompare({ status: 'loading' })
      void readCompare()
    },
    supplier: () => {
      setIncoming({ status: 'loading' })
      void readIncoming()
    },
  }

  return (
    <ReportsView
      model={{ prefix, scope, can, address, range, kpis, trend, compare, incoming, live, asOf, layout, specs, arranging }}
      actions={{
        onAddress: go,
        onDimension: (by: Dimension) => go({ by }),
        onRetry: (panel) => retry[panel](),
        onArrange: setArranging,
        onArranged: (next) => {
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
        onExport: exportPanel,
      }}
    />
  )
}
