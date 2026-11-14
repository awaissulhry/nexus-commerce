'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useLive } from '../../_shared/buying/hooks'
import { readProblem } from '../../_shared/stock/model'
import { liveMatches } from '../../quality/_shared/hooks'
import { getChasePreview, getLate, getSpend, getSpendLines, postChase, type Late, type LateRow, type Spend } from './api'
import { csvName, csvOf, defaultMeasure, drillCsvRows, LAYOUT_KEY, lateCsvRows, LIVE_EVERY_MS, LIVE_TYPES, measuresFor, rangeShown, reportsAddressOf, reportsAddressText, reportsCan, romeToday, sectionSpecs, spendCsvRows, type ChaseGroup, type ReportsAddress, type ReportSection, type SpendMeasure } from './model'
import { ReportsView, type ChaseResult, type ChaseState, type DrillState, type Read } from './view/ReportsView'
import { PinDialog } from '../../home/dashboards/pin/view/PinDialog'
import { usePinToDashboard } from '../../home/dashboards/pin/usePinToDashboard'

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** At most one read per `ms` while changes keep coming (design: "at most once a minute"), the first at once when the last is older. */
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

/** A refused chase in words (a key of purchasing-reports). */
function chaseProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'chase.problem.send'
  if (error.kind === 'conflict') return 'chase.problem.changed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'chase.problem.forbidden'
  if (error.kind === 'invalid') return 'chase.problem.nothing'
  if (error.kind === 'unavailable') return 'chase.problem.offline'
  return 'chase.problem.send'
}

/**
 * `/w/<company>/purchasing/reports?from=&to=&by=&reason=` (SCR-255): the top bar's company and site, the period of the address
 * (else this month so far: the monthly buying review), two panels each read on its own (a failed one says so and the other stays),
 * the POs behind a bar (the drill, J / K to the next bar), the late lines with what they block (the chain of the chosen line), a
 * chase of one order or of the selected lines (one per order), live re-reads on purchase order changes and receipts at most once
 * a minute, Arrange saved per person on this device, a panel's rows as a CSV file, the print view (SCR-372) in a new tab.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/purchasing\/reports\/?$/, '')
  const pin = usePinToDashboard(api, 'purchasing', prefix)
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const enabled = can.view
  const siteId = scope.siteId
  const companyId = scope.company?.id ?? null

  const [spend, setSpend] = useState<Read<Spend>>({ status: 'idle' })
  const [late, setLate] = useState<Read<Late>>({ status: 'idle' })
  const [lateMore, setLateMore] = useState<LateRow[]>([])
  const [lateCursor, setLateCursor] = useState<string | null>(null)
  const [lateMoreBusy, setLateMoreBusy] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [measure, setMeasure] = useState<SpendMeasure>(defaultMeasure(can.cost))
  const [drill, setDrill] = useState<DrillState | null>(null)
  const [chainLine, setChainLine] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [chase, setChase] = useState<ChaseState | null>(null)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])
  useEffect(() => {
    if (!measuresFor(can.cost).includes(measure)) setMeasure(defaultMeasure(can.cost))
  }, [can.cost, measure])

  const query = useMemo(() => ({ siteId, from: address.from, to: address.to }), [siteId, address.from, address.to])
  const lateQuery = useMemo(() => ({ companyId, siteId, reason: address.reason }), [companyId, siteId, address.reason])

  const readSpend = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getSpend(api, query, address.by)
      setSpend({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setSpend({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, query, address.by])
  const readLate = useCallback(async () => {
    if (!enabled) return
    if (!can.orders) {
      setLate({ status: 'error', problem: 'problem.forbidden' })
      return
    }
    try {
      const value = await getLate(api, lateQuery)
      setLate({ status: 'ready', value })
      setLateMore([])
      setLateCursor(value.nextCursor)
      setAsOf(new Date().toISOString())
    } catch (error) {
      setLate({ status: 'error', problem: readProblem(error) })
    }
  }, [api, enabled, can.orders, lateQuery])

  const readAll = useCallback(() => {
    void (async () => {
      await readSpend()
      await readLate()
    })()
  }, [readSpend, readLate])

  useEffect(() => {
    if (!enabled) return
    setSpend({ status: 'loading' })
    void readSpend()
  }, [enabled, readSpend])
  useEffect(() => {
    if (!enabled) return
    setLate({ status: 'loading' })
    void readLate()
  }, [enabled, readLate])

  const refresh = useAtMostEvery(readAll, LIVE_EVERY_MS)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = spend.status === 'ready' ? spend.value : null
  const today = answered?.today ?? romeToday()
  const range = rangeShown(address, answered, today)

  // ---- the drill ----------------------------------------------------------------------------------------------------------
  const drillKey = drill?.key ?? null
  const readDrill = useCallback(
    async (key: string) => {
      setDrill({ key, read: { status: 'loading' } })
      try {
        const value = await getSpendLines(api, query, address.by, key)
        setDrill((open) => (open?.key === key ? { key, read: { status: 'ready', value } } : open))
      } catch (error) {
        setDrill((open) => (open?.key === key ? { key, read: { status: 'error', problem: readProblem(error) } } : open))
      }
    },
    [api, query, address.by],
  )
  useEffect(() => setDrill(null), [address.by, query])

  // ---- the late lines -----------------------------------------------------------------------------------------------------
  const more = async () => {
    if (!lateCursor || lateMoreBusy) return
    setLateMoreBusy(true)
    try {
      const value = await getLate(api, { ...lateQuery, cursor: lateCursor })
      setLateMore((rows) => [...rows, ...value.rows])
      setLateCursor(value.nextCursor)
    } catch {
      // The rows read stay; "Show more" can be pressed again.
    } finally {
      setLateMoreBusy(false)
    }
  }

  // ---- the chase ----------------------------------------------------------------------------------------------------------
  const openChase = async (groups: readonly ChaseGroup[] | null) => {
    if (!groups || groups.length === 0) {
      setChase(null)
      return
    }
    setChase({ groups, preview: groups.length === 1 ? { status: 'loading' } : null, message: '', busy: false, results: null })
    if (groups.length === 1) {
      try {
        const value = (await getChasePreview(api, groups[0]!.orderId)).chase
        setChase((open) => (open && open.groups[0]?.orderId === value.orderId ? { ...open, preview: { status: 'ready', value } } : open))
      } catch (error) {
        setChase((open) => (open ? { ...open, preview: { status: 'error', problem: readProblem(error) } } : open))
      }
    }
  }
  const sendChase = async () => {
    if (!chase || chase.busy) return
    setChase({ ...chase, busy: true })
    const results: ChaseResult[] = []
    for (const group of chase.groups) {
      const version = chase.preview?.status === 'ready' && chase.preview.value.orderId === group.orderId ? chase.preview.value.version : group.version
      try {
        const sent = (await postChase(api, group.orderId, { version, lineIds: group.lineIds, message: chase.message.trim() || null }, newIdempotencyKey())).chase
        results.push({ orderId: group.orderId, number: group.number, ok: true, words: sent.to })
      } catch (error) {
        results.push({ orderId: group.orderId, number: group.number, ok: false, words: chaseProblemOf(error) })
      }
    }
    setChase((open) => (open ? { ...open, busy: false, results } : open))
    setSelected([])
    void readLate()
  }

  const retry: Record<ReportSection, () => void> = {
    spend: () => {
      setSpend({ status: 'loading' })
      void readSpend()
    },
    late: () => {
      setLate({ status: 'loading' })
      void readLate()
    },
  }

  return (
    <>
      <ReportsView
        model={{ prefix, can, address, scope, range, today, spend, late, lateMore, lateMoreBusy, lateCursor, live, asOf, layout, specs, arranging, measure, drill, chainLine, selected, chase }}
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
          onExportSpend: (words, total) => {
            if (spend.status === 'ready') saveCsv(csvName('spend', range), csvOf(words.header, spendCsvRows(spend.value, words, total)))
          },
          onExportLate: (rows, header, reason) => saveCsv(csvName('late', range), csvOf(header, lateCsvRows(rows, { reason }))),
          onMeasure: setMeasure,
          onDrill: (key) => (key ? void readDrill(key) : setDrill(null)),
          onDrillRetry: () => (drillKey ? void readDrill(drillKey) : undefined),
          onDrillExport: (header, words) => {
            if (drill?.read.status === 'ready') saveCsv(csvName('drill', range), csvOf(header, drillCsvRows(drill.read.value, words)))
          },
          onChain: setChainLine,
          onSelected: setSelected,
          onLateMore: () => void more(),
          onChase: (groups) => void openChase(groups),
          onChaseMessage: (text) => setChase((open) => (open ? { ...open, message: text } : open)),
          onChaseSend: () => void sendChase(),
        }}
      />
      {/* B-W2b-434 (DB1:01): Save as dashboard — this page's panels pinned to a Home dashboard, saved for me on the server. */}
      <PinDialog model={pin.model} actions={pin.actions} />
    </>
  )
}
