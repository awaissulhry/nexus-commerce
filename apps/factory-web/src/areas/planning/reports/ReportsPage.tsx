'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useLive } from '../../_shared/buying/hooks'
import { readProblem } from '../../_shared/stock/model'
import { liveMatches } from '../../quality/_shared/hooks'
import { getAdherence, getAdherenceRows, getCover, getUtilisation, getUtilisationRows, type Adherence, type Cover, type Utilisation } from './api'
import { csvName, csvOf, drillKey, LAYOUT_KEY, LIVE_EVERY_MS, LIVE_TYPES, pointOf, rangeShown, reportsAddressOf, reportsAddressText, reportsCan, romeToday, sectionSpecs, type DrillTarget, type ReportsAddress, type ReportSection } from './model'
import { ReportsView, type DrillState, type Read } from './view/ReportsView'
import { PinDialog } from '../../home/dashboards/pin/view/PinDialog'
import { usePinToDashboard } from '../../home/dashboards/pin/usePinToDashboard'

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** At most one read per `ms` while changes keep coming (design: panels refresh with their own AsOf), the first at once when the last is older. */
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
 * `/w/<company>/planning/reports?from=&to=&lane=&ahead=&weeks=` (SCR-254): the top bar's company and site (planning is per site:
 * with "All sites" the first one, said on the page), the period of the address (else this month so far: the monthly planning
 * review), three panels each read on its own (a failed one says so and the others stay), the work orders behind a bar or a point
 * (the drill, J / K to the next week), live re-reads on a plan run, a board change, a work order or a scan at most once a minute,
 * Arrange saved per person on this device, a panel's rows (or the selected materials) as a CSV file, the print view (SCR-409).
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/planning\/reports\/?$/, '')
  const pin = usePinToDashboard(api, 'planning', prefix)
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const site = scope.site ?? scope.sites[0] ?? null
  const siteId = site?.id ?? null
  const enabled = can.view && can.plans && siteId !== null

  const [adherence, setAdherence] = useState<Read<Adherence>>({ status: 'idle' })
  const [utilisation, setUtilisation] = useState<Read<Utilisation>>({ status: 'idle' })
  const [cover, setCover] = useState<Read<Cover>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [adherenceLine, setAdherenceLine] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrillState | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  const scopeQuery = useMemo(() => (siteId ? { siteId, from: address.from, to: address.to } : null), [siteId, address.from, address.to])

  const readAdherence = useCallback(async () => {
    if (!enabled || !scopeQuery) return
    try {
      const value = await getAdherence(api, scopeQuery)
      setAdherence({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setAdherence({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, scopeQuery])
  const readUtilisation = useCallback(async () => {
    if (!enabled || !scopeQuery) return
    try {
      const value = await getUtilisation(api, scopeQuery, address.ahead)
      setUtilisation({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setUtilisation({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, scopeQuery, address.ahead])
  const readCover = useCallback(async () => {
    if (!enabled || !siteId) return
    try {
      const value = await getCover(api, siteId, address.weeks)
      setCover({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setCover({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, siteId, address.weeks])

  // One read after another (three answers per refresh, never three at once).
  const readAll = useCallback(() => {
    void (async () => {
      await readAdherence()
      await readUtilisation()
      await readCover()
    })()
  }, [readAdherence, readUtilisation, readCover])

  useEffect(() => {
    if (!enabled) return
    setAdherence({ status: 'loading' })
    void readAdherence()
  }, [enabled, readAdherence])
  useEffect(() => {
    if (!enabled) return
    setUtilisation({ status: 'loading' })
    void readUtilisation()
  }, [enabled, readUtilisation])
  useEffect(() => {
    if (!enabled) return
    setCover({ status: 'loading' })
    void readCover()
  }, [enabled, readCover])

  const refresh = useAtMostEvery(readAll, LIVE_EVERY_MS)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = adherence.status === 'ready' ? adherence.value : utilisation.status === 'ready' ? utilisation.value : null
  const today = answered?.today ?? (cover.status === 'ready' ? cover.value.today : romeToday())
  const range = rangeShown(address, answered, today)

  // ---- the drill ----------------------------------------------------------------------------------------------------------
  const readDrill = useCallback(
    async (target: DrillTarget) => {
      if (!scopeQuery) return
      const key = drillKey(target)
      const still = (open: DrillState | null) => open !== null && drillKey(open.target) === key
      if (target.section === 'adherence') {
        setDrill({ target, read: { status: 'loading' } })
        try {
          const value = await getAdherenceRows(api, scopeQuery, { lineId: target.lineKey, week: target.week })
          setDrill((open) => (still(open) ? { target, read: { status: 'ready', value } } : open))
        } catch (error) {
          setDrill((open) => (still(open) ? { target, read: { status: 'error', problem: readProblem(error) } } : open))
        }
        return
      }
      const point = pointOf(target.laneKey)
      if (!point) return
      setDrill({ target, read: { status: 'loading' } })
      try {
        const value = await getUtilisationRows(api, scopeQuery, address.ahead, { ...point, week: target.week })
        setDrill((open) => (still(open) ? { target, read: { status: 'ready', value } } : open))
      } catch (error) {
        setDrill((open) => (still(open) ? { target, read: { status: 'error', problem: readProblem(error) } } : open))
      }
    },
    [api, scopeQuery, address.ahead],
  )
  useEffect(() => setDrill(null), [scopeQuery, address.ahead])

  const retry: Record<ReportSection, () => void> = {
    adherence: () => {
      setAdherence({ status: 'loading' })
      void readAdherence()
    },
    utilisation: () => {
      setUtilisation({ status: 'loading' })
      void readUtilisation()
    },
    cover: () => {
      setCover({ status: 'loading' })
      void readCover()
    },
  }

  return (
    <>
      <ReportsView
        model={{ prefix, can, address, scope, site: site ? { id: site.id, name: site.name } : null, range, today, adherence, utilisation, cover, adherenceLine, live, asOf, layout, specs, arranging, drill, selected }}
        actions={{
          onSaveAsDashboard: pin.open,
          onAddress: go,
          onRetry: (panel) => retry[panel](),
          onArrange: setArranging,
          onArranged: (next) => {
            setLayout(next)
            writeSectionLayout(LAYOUT_KEY, next)
            setArranging(false)
          },
          onExport: (panel, header, rows) => saveCsv(csvName(panel, range), csvOf(header, rows)),
          onAdherenceLine: setAdherenceLine,
          onDrill: (target) => (target ? void readDrill(target) : setDrill(null)),
          onDrillRetry: () => (drill ? void readDrill(drill.target) : undefined),
          onSelected: setSelected,
        }}
      />
      {/* B-W2b-434 (DB1:01): Save as dashboard — this page's panels pinned to a Home dashboard, saved for me on the server. */}
      <PinDialog model={pin.model} actions={pin.actions} />
    </>
  )
}
