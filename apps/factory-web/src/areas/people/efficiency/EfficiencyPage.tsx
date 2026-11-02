'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { liveMatches } from '../../quality/_shared/hooks'
import { whatYouSee } from '../_shared/api'
import { csvText, TIME_ZONE } from '../_shared/model'
import type { SightState } from '../_shared/parts'
import { decide, getOperation, getOperations, getOverview, getReview, getTrend, type Operations, type OperationRow, type Overview, type ReviewEntry, type ReviewQueue, type Trend } from './api'
import { efficiencyAddressOf, efficiencyAddressText, efficiencyCan, efficiencyProblem, LAYOUT_KEY, linesCsvRows, operationLabel, operationsRange, privacyFirst, sectionSpecs, type DecisionChoice, type EfficiencyAddress, type EfficiencyProblem } from './model'
import { usePersonDialog } from './use-person'
import { useReviewDetail } from './use-review'
import { EfficiencyView, type BulkState, type CsvWords, type EfficiencyNotice, type OperationPop, type Read } from './view/EfficiencyView'

const SCANS = ['production.scan_recorded']
const DECISIONS = ['standard_review.decided']
const OWN_MS = 5000

type Ref = { id: string; code: string; name: string }

/** The refs seen so far, kept across a narrowed read: a chosen line or style stays offered. */
const merged = (current: readonly Ref[], seen: readonly Ref[]): Ref[] => {
  const all = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of seen) all.set(entry.id, entry)
  return [...all.values()].sort((a, b) => a.code.localeCompare(b.code))
}

/**
 * `/w/<company>/people/efficiency?from=&to=&line=&style=&compare=1&day=&open=` (SCR-161): the privacy rules of the top bar's
 * site come FIRST, and nothing else is read until they are on the screen (what-you-see says what the page shows before a
 * figure exists). Then the figures, each read on its own so one failure never empties the others: tiles and lines, lines
 * over time, planned against actual, the review queue. Lines and operations only. One person's figures are the dialog's
 * state (`use-person.ts`): never here, never in the address. Live scans wait behind "N updates · Show"; a decision of
 * someone else re-reads the queue.
 */
export function EfficiencyPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/people\/efficiency\/?$/, '')
  const can = useMemo(() => efficiencyCan(session.permissions), [session.permissions])
  const address = useMemo(() => efficiencyAddressOf(params), [params])
  const siteId = scope.siteId

  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const [overview, setOverview] = useState<Read<Overview>>({ status: 'idle' })
  const [trend, setTrend] = useState<Read<Trend>>({ status: 'idle' })
  const [operations, setOperations] = useState<Read<Operations>>({ status: 'idle' })
  const [review, setReview] = useState<Read<ReviewQueue>>({ status: 'idle' })
  const [lines, setLines] = useState<Ref[]>([])
  const [styles, setStyles] = useState<Ref[]>([])
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<EfficiencyNotice | null>(null)
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [sending, setSending] = useState(false)
  const [pop, setPop] = useState<OperationPop | null>(null)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  const [arranging, setArranging] = useState(false)
  const generation = useRef(0)
  const ownUntil = useRef(0)

  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  // Said before anything is read: the rules of the site, then the figures.
  const readSight = useCallback(() => {
    if (!can.view) return () => undefined
    if (!siteId) {
      setSight({ status: 'allSites' })
      return () => undefined
    }
    let live = true
    setSight({ status: 'loading' })
    whatYouSee(api, siteId)
      .then((answer) => live && setSight({ status: 'ready', sight: answer }))
      .catch(() => live && setSight({ status: 'failed' }))
    return () => {
      live = false
    }
  }, [api, can.view, siteId])
  useEffect(() => readSight(), [readSight])

  const sightReady = sight.status === 'ready'

  const readReview = useCallback(async () => {
    if (!siteId) return
    try {
      setReview({ status: 'ready', value: await getReview(api, siteId) })
    } catch (error) {
      setReview({ status: 'error', problem: efficiencyProblem(error) })
    }
  }, [api, siteId])

  // The scope's terms one by one: opening the review's detail changes the address, not the figures.
  const { from, to, lineId, styleId, compare, day } = address
  const readFigures = useCallback(async () => {
    if (!siteId) return
    const turn = ++generation.current
    const scopeOf = { siteId, from, to, lineId }
    const settle = <T,>(set: (read: Read<T>) => void, reading: Promise<T>) =>
      reading.then(
        (value) => turn === generation.current && set({ status: 'ready', value }),
        (error: unknown) => turn === generation.current && set({ status: 'error', problem: efficiencyProblem(error) }),
      )
    setUpdates(0)
    await Promise.all([
      settle(setOverview, getOverview(api, { ...scopeOf, compare })),
      settle(setTrend, getTrend(api, scopeOf)),
      settle(setOperations, getOperations(api, { ...scopeOf, ...operationsRange({ from, to, day }), styleId })),
      readReview(),
    ])
  }, [api, siteId, from, to, lineId, styleId, compare, day, readReview])

  useEffect(() => {
    if (!can.view || !sightReady) {
      generation.current += 1
      setOverview({ status: 'idle' })
      setTrend({ status: 'idle' })
      setOperations({ status: 'idle' })
      setReview({ status: 'idle' })
      return
    }
    setOverview({ status: 'loading' })
    setTrend({ status: 'loading' })
    setOperations({ status: 'loading' })
    setReview({ status: 'loading' })
    void readFigures()
  }, [can.view, sightReady, readFigures])

  useEffect(() => {
    setLines([])
    setStyles([])
  }, [siteId])
  useEffect(() => {
    if (overview.status === 'ready') setLines((current) => merged(current, overview.value.lines.flatMap((row) => (row.line ? [row.line] : []))))
  }, [overview])
  useEffect(() => {
    if (operations.status === 'ready') setStyles((current) => merged(current, operations.value.operations.map((row) => row.style)))
  }, [operations])

  const later = useCoalesced(() => setUpdates((count) => count + 1), 1000)
  const refreshQueue = useCoalesced(() => void readReview(), 1000)
  useLive(
    (change) => {
      if (liveMatches(change, SCANS)) later()
      else if (liveMatches(change, DECISIONS) && Date.now() > ownUntil.current) refreshQueue()
    },
    () => void readFigures(),
    can.view && sightReady,
  )

  const go = (change: Partial<EfficiencyAddress>) => router.replace(`${pathname}${efficiencyAddressText({ ...address, ...change })}`)

  const queue = review.status === 'ready' ? review.value : null
  const detail = useReviewDetail(api, siteId, address.open, () => {
    ownUntil.current = Date.now() + OWN_MS
    void readReview()
  })
  const person = usePersonDialog(api, siteId, { from: address.from, to: address.to }, can.people, () => void readFigures())

  const download = (words: CsvWords) => {
    if (overview.status !== 'ready') return
    const value = overview.value
    const text = csvText(words.header, linesCsvRows(value.lines, { noLine: words.noLine, tooFew: words.tooFew }, locale))
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' }))
    link.download = `line-efficiency-${value.from}-${value.to}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  /** Each operation one command, as a person would send it; the last decision is read first (`basedOn`). */
  const sendToReview = async (rows: readonly OperationRow[]): Promise<boolean> => {
    if (!siteId || sending) return false
    setSending(true)
    setNotice(null)
    ownUntil.current = Date.now() + OWN_MS
    let sent = 0
    const refused: { label: string; problem: EfficiencyProblem }[] = []
    for (const row of rows) {
      try {
        const current = await getOperation(api, row.routingOperationId, { siteId })
        await decide(api, row.routingOperationId, { siteId, decision: 'SEND', reason: null, proposedMinutes: null, basedOn: current.review.lastDecision?.id ?? null })
        sent += 1
      } catch (error) {
        refused.push({ label: operationLabel(row), problem: efficiencyProblem(error) })
      }
    }
    setSending(false)
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'sent.done', params: { count: sent }, refused })
    await readReview()
    return refused.length === 0
  }

  const decideMany = async (decision: Extract<DecisionChoice, 'KEEP' | 'INVESTIGATE'>, rows: readonly ReviewEntry[], reason: string) => {
    if (!siteId) return
    setBulk((current) => current && { ...current, busy: true })
    ownUntil.current = Date.now() + OWN_MS
    let done = 0
    const refused: { label: string; problem: EfficiencyProblem }[] = []
    for (const row of rows) {
      try {
        await decide(api, row.routingOperationId, { siteId, decision, reason: reason.trim(), proposedMinutes: null, basedOn: row.lastDecision?.id ?? null })
        done += 1
      } catch (error) {
        refused.push({ label: operationLabel(row), problem: efficiencyProblem(error) })
      }
    }
    setBulk(null)
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: `bulk.done.${decision}`, params: { count: done }, refused })
    await readReview()
  }

  const openPop = (row: OperationRow | null) => {
    if (!row || !siteId) return setPop(null)
    setPop({ id: row.routingOperationId, detail: { status: 'loading' } })
    const range = operationsRange(address)
    getOperation(api, row.routingOperationId, { siteId, ...range })
      .then((value) => setPop((current) => (current?.id === row.routingOperationId ? { ...current, detail: { status: 'ready', value } } : current)))
      .catch((error: unknown) => setPop((current) => (current?.id === row.routingOperationId ? { ...current, detail: { status: 'error', problem: efficiencyProblem(error) } } : current)))
  }

  const arrange = (order: string[]) => {
    const next = { ...layout, order: privacyFirst(order) }
    setLayout(next)
    writeSectionLayout(LAYOUT_KEY, next)
    setArranging(false)
  }

  return (
    <EfficiencyView
      model={{
        prefix,
        scope,
        can,
        address,
        sight,
        overview,
        trend,
        operations,
        review,
        lines,
        styles,
        updates,
        notice,
        bulk,
        sending,
        pop,
        layout,
        specs,
        arranging,
        timeZone: TIME_ZONE,
        detail: address.open ? { ...detail.state, ids: queue?.queue.map((row) => row.routingOperationId) ?? [], id: address.open } : null,
        person: person.state,
      }}
      actions={{
        onAddress: go,
        onRetrySight: () => void readSight(),
        onRetry: () => void readFigures(),
        onRetryReview: () => void readReview(),
        onShowUpdates: () => void readFigures(),
        onDismissNotice: () => setNotice(null),
        onExport: download,
        onSend: sendToReview,
        onPop: openPop,
        onBulk: (decision, rows) => setBulk({ decision, rows, reason: '', busy: false }),
        onBulkReason: (reason) => setBulk((current) => current && { ...current, reason }),
        onBulkCancel: () => setBulk(null),
        onBulkApply: () => bulk && void decideMany(bulk.decision, bulk.rows, bulk.reason),
        onArrange: setArranging,
        onArranged: arrange,
        review: detail.actions,
        person: person.actions,
      }}
    />
  )
}
