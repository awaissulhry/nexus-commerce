'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { countWorkOrders, getSiteWip, listWorkOrders, type SiteWip, type WorkOrderCounts, type WorkOrderRow } from '../_shared/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem } from '../_shared/model'
import { getLines, type LinesOverview } from '../reports/api'
import { lineScopeOf, stepLine } from '../reports/model'
import type { LineHours } from './api'
import { bundleHref, floorBoardsCan, lineTvHref, stuckCsv, targetDraft, tvLine } from './model'
import { useFloorBoards } from './use-floor-boards'
import type { HeatCellPick, HeatPanelModel } from './view/HeatPanel'
import { FloorNowView, type FloorNowModel } from './view/FloorNowView'
import type { TargetsDialogModel } from './view/TargetsDialog'

/**
 * `/w/<company>/production/floor` (SCR-073): reads the open work orders' WIP at the person's sites (GET
 * /production/scans/wip), the tiles' counts, the late work orders and (B-W2a-38) each line at a glance (GET
 * /production/reports/lines), and reads them again when the floor reports (a burst of scans is one read). A line card
 * sets the line scope in the address (`?line=<id>`); [ and ] step to the previous and next line. Nothing per person is
 * asked for: the API serves none (per station only "nobody signed in" and machines down, Owner F2). B-W2b-66: hour by hour,
 * the heat map, the stuck bundles and the line TV (`use-floor-boards.ts`); t opens the line TV.
 */
export function FloorNowPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/floor\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const lineScope = useMemo(() => lineScopeOf(params), [params])
  const [wip, setWip] = useState<{ value: SiteWip | null; problem: string | null }>({ value: null, problem: null })
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [late, setLate] = useState<{ items: WorkOrderRow[] | null; problem: string | null }>({ items: null, problem: null })
  const [lines, setLines] = useState<{ value: LinesOverview | null; problem: string | null }>({ value: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)
  // B-W2b-66.
  const boardsCan = useMemo(() => floorBoardsCan(session.permissions), [session.permissions])
  const boards = useFloorBoards(api, boardsCan)
  const [cell, setCell] = useState<HeatPanelModel['cell']>(null)
  const [targets, setTargets] = useState<(TargetsDialogModel & { lineId: string; day: string }) | null>(null)

  const loadLines = useCallback(() => {
    getLines(api)
      .then((value) => setLines({ value, problem: null }))
      .catch((error: unknown) => setLines({ value: null, problem: readProblem(error) }))
  }, [api])

  const load = useCallback(async () => {
    getSiteWip(api)
      .then((value) => {
        setWip({ value, problem: null })
        setAsOf(new Date().toISOString())
      })
      .catch((error: unknown) => setWip({ value: null, problem: readProblem(error) }))
    countWorkOrders(api)
      .then(setCounts)
      .catch(() => setCounts(null))
    listWorkOrders(api, { late: true, limit: 20 })
      .then((page) => setLate({ items: page.workOrders, problem: null }))
      .catch((error: unknown) => setLate({ items: null, problem: readProblem(error) }))
    loadLines()
  }, [api, loadLines])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 1500)
  const live = useLive(
    (change) => {
      if (liveTouches(change)) reread()
      boards.onLive(change)
    },
    () => {
      void load()
      boards.load()
    },
  )

  const setScope = useCallback(
    (lineId: string | null) => router.replace(`${prefix}/production/floor${lineId ? `?line=${encodeURIComponent(lineId)}` : ''}`, { scroll: false }),
    [router, prefix],
  )

  // [ and ] (design production.floor keyboard): the previous / next line; t (B-W2b-66) the line TV; not while typing.
  const cards = lines.value?.lines ?? null
  useEffect(() => {
    if (!cards || cards.length === 0) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !['[', ']', 't'].includes(event.key)) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (event.key === 't') {
        if (!boardsCan.boards || document.querySelector('[role="dialog"]')) return
        window.open(lineTvHref(prefix, tvLine(cards, lineScope) ?? cards[0]!.id), '_blank', 'noopener')
        return
      }
      const next = stepLine(cards, lineScope, event.key === ']' ? 1 : -1)
      if (next) {
        event.preventDefault()
        setScope(next)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [cards, lineScope, setScope, boardsCan.boards, prefix])

  const openCell = useCallback(
    (pick: HeatCellPick) => {
      setCell({ pick, bundles: null, problem: null })
      boards.readCell({ siteId: pick.siteId, lineId: pick.lineId, code: pick.code })
        .then((answer) => setCell({ pick, bundles: answer.bundles, problem: null }))
        .catch((error: unknown) => setCell({ pick, bundles: null, problem: readProblem(error) }))
    },
    [boards.readCell],
  )

  const openTargets = useCallback(
    (line: LineHours['line']) => {
      setTargets({ line, lineId: line.id, day: '', rows: null, problem: null })
      boards.readTargets(line.id)
        .then((answer) => setTargets({ line, lineId: line.id, day: answer.day, rows: targetDraft(answer), problem: null }))
        .catch((error: unknown) => setTargets({ line, lineId: line.id, day: '', rows: null, problem: readProblem(error) }))
    },
    [boards.readTargets],
  )

  const model: FloorNowModel = { prefix, can, wip, counts, late, asOf, live, lines, lineScope, boards: { ...boards.state, can: boardsCan, cell, targets } }
  return (
    <FloorNowView
      model={model}
      actions={{
        onRetry: () => void load(),
        onLine: setScope,
        onRetryLines: loadLines,
        onRetryBoards: boards.load,
        onSaveReason: boards.saveReason,
        onSetTargets: openTargets,
        onCloseTargets: () => setTargets(null),
        onSaveTargets: (changes) => (targets ? boards.saveTargets({ lineId: targets.lineId, date: targets.day, hours: changes }) : Promise.resolve(null)),
        onCell: openCell,
        onCloseCell: () => setCell(null),
        onOpenBundle: (row) => router.push(bundleHref(prefix, row)),
        onExportStuck: (rows, head) => downloadText('stuck-bundles.csv', stuckCsv(rows, head)),
      }}
    />
  )
}
