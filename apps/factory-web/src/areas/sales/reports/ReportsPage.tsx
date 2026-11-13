'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useLive } from '../../_shared/buying/hooks'
import { readProblem } from '../../_shared/stock/model'
import { liveMatches } from '../../quality/_shared/hooks'
import { getBacklog, getHeadline, getIntake, getReturns, type Backlog, type Headline, type Intake, type Returns } from './api'
import { csvName, csvOf, LAYOUT_KEY, LIVE_EVERY_MS, LIVE_TYPES, rangeShown, reportsAddressOf, reportsAddressText, reportsCan, romeToday, sectionSpecs, type DrillTarget, type ReportsAddress, type ReportSection } from './model'
import { ReportsView, type Read } from './view/ReportsView'

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** At most one read per `ms` while changes keep coming (design: panels refresh with AsOf), the first at once when the last is older. */
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
 * `/w/<company>/sales/reports?from=&to=&by=&split=&backlog=&also=` (SCR-250): the top bar's company, the period of the address
 * (else this month so far: the monthly sales review), four panels each read on its own (a failed one says so and the others
 * stay), what a tile, a bar or a cell counts (from the panel's own answer; J / K to the next bar), live re-reads on order, quote,
 * return and shipment changes at most once a minute, Arrange saved per person on this device, a panel's rows as a CSV file, the
 * print view (SCR-427) in a new tab.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/reports\/?$/, '')
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const enabled = can.view

  const [headline, setHeadline] = useState<Read<Headline>>({ status: 'idle' })
  const [intake, setIntake] = useState<Read<Intake>>({ status: 'idle' })
  const [backlog, setBacklog] = useState<Read<Backlog>>({ status: 'idle' })
  const [returns, setReturns] = useState<Read<Returns>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  const period = useMemo(() => ({ from: address.from, to: address.to }), [address.from, address.to])
  const companyId = scope.company?.id ?? null

  const readHeadline = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getHeadline(api, period)
      setHeadline({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setHeadline({ status: 'error', problem: readProblem(error) })
    }
    // The company in the top bar is part of every read (the session's company).
  }, [api, enabled, period, companyId])
  const readIntake = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getIntake(api, period, address.by, address.split)
      setIntake({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setIntake({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, period, address.by, address.split, companyId])
  const readBacklog = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getBacklog(api, address.backlog)
      setBacklog({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setBacklog({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, address.backlog, companyId])
  const readReturns = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getReturns(api, period)
      setReturns({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setReturns({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, period, companyId])

  // One read after another (four answers per refresh, never four at once).
  const readAll = useCallback(() => {
    void (async () => {
      await readHeadline()
      await readIntake()
      await readBacklog()
      await readReturns()
    })()
  }, [readHeadline, readIntake, readBacklog, readReturns])

  useEffect(() => {
    if (!enabled) return
    setHeadline({ status: 'loading' })
    void readHeadline()
  }, [enabled, readHeadline])
  useEffect(() => {
    if (!enabled) return
    setIntake({ status: 'loading' })
    void readIntake()
  }, [enabled, readIntake])
  useEffect(() => {
    if (!enabled) return
    setBacklog({ status: 'loading' })
    void readBacklog()
  }, [enabled, readBacklog])
  useEffect(() => {
    if (!enabled) return
    setReturns({ status: 'loading' })
    void readReturns()
  }, [enabled, readReturns])

  const refresh = useAtMostEvery(readAll, LIVE_EVERY_MS)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = headline.status === 'ready' ? headline.value : intake.status === 'ready' ? intake.value : null
  const today = answered?.today ?? (backlog.status === 'ready' ? backlog.value.today : romeToday())
  const range = rangeShown(address, answered, today)
  useEffect(() => setDrill(null), [period, address.by, address.split, address.backlog])

  const retry: Record<ReportSection, () => void> = {
    strip: () => {
      setHeadline({ status: 'loading' })
      void readHeadline()
    },
    intake: () => {
      setIntake({ status: 'loading' })
      void readIntake()
    },
    backlog: () => {
      setBacklog({ status: 'loading' })
      void readBacklog()
    },
    returns: () => {
      setReturns({ status: 'loading' })
      void readReturns()
    },
  }

  return (
    <ReportsView
      model={{ prefix, can, address, scope, range, today, headline, intake, backlog, returns, live, asOf, layout, specs, arranging, drill }}
      actions={{
        onAddress: go,
        onRetry: (panel) => retry[panel](),
        onArrange: setArranging,
        onArranged: (next) => {
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
        onExport: (panel, header, rows) => saveCsv(csvName(panel, range), csvOf(header, rows)),
        onDrill: setDrill,
      }}
    />
  )
}
