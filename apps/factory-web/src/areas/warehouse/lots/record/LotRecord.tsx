'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { listHides, lotRecord, readLedger, stockOverview, type LotRecord as LotRecordValue } from '../../../_shared/stock/api'
import { readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { availability, listHolds, listReservations, readTrace, type Trace } from '../../stock/daily/api'
import { holdsBySubject } from '../../stock/daily/model'
import { useWriteOff } from '../../stock/daily/useWriteOff'
import { releaseCheck, type ReleaseChecklist } from '../api'
import { lotTabOf, type LotFigures, type LotHolds } from '../model'
import { dailyCan } from '../shared/daily'
import { useTraceFind } from '../trace/useTraceFind'
import { LOADING, part, PART_LOADING, ready, type Loaded, type Part } from '../shared/model'
import { LotsMessages, type MovesPart } from '../shared/parts'
import { LotRecordView } from './view/LotRecordView'

/**
 * The lot record container (`/w/<company>/warehouse/lots/<lotId>?tab=overview|trace|moves|activity`, SCR-201-record):
 * reads the lot with its stock and trace (`GET /inventory/lots/:lotId`), the release checklist for a viewer with
 * quality.lots.view (`GET /quality/lots/:lotId/release-check`), and on the Moves tab the ledger of the lot
 * (`GET /inventory/ledger?siteId&itemId&lotId`, pages of 200); re-reads on the lot's live events. The decisions are
 * made in Compliance › Tests & substances. B-W2a-64: on the Overview the lot's site figures (`GET /inventory/reservations/
 * availability`: reserved, available) and its ACTIVE reservations; on Quality status the holds of the lot (any status)
 * and of its hides (`GET /quality/holds`, quality.holds.view; the lot's hides from `GET /inventory/hides?lotId`); on
 * Trace the tree (`GET /inventory/trace?kind=LOT`); Write off at a place (a rejected lot's stock); the Trace dialog.
 */
export function LotRecord({ lotId }: { lotId: string }) {
  return (
    <LotsMessages>
      <LotRecordContainer lotId={lotId} />
    </LotsMessages>
  )
}

const PAGE = 200

function LotRecordContainer({ lotId }: { lotId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = lotTabOf(params?.get('tab'))
  const [record, setRecord] = useState<Loaded<LotRecordValue>>(LOADING)
  const [checklist, setChecklist] = useState<Part<ReleaseChecklist> | null>(can.lotsView ? PART_LOADING : null)
  const [moves, setMoves] = useState<Part<MovesPart>>(PART_LOADING)
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const { dockOpen, toggleDock } = useThreadDock('Lot')
  const value = record.status === 'ready' ? record.value : null
  const movesAsked = useRef(false)
  const [figures, setFigures] = useState<Part<LotFigures>>(PART_LOADING)
  const [trace, setTrace] = useState<Part<Trace>>(PART_LOADING)
  const [holds, setHolds] = useState<Part<LotHolds> | null>(daily.holdsView ? PART_LOADING : null)
  const [holdReasons, setHoldReasons] = useState<PickerReason[]>([])
  const asked = useRef({ figures: false, trace: false, holds: false })

  const load = useCallback(async () => {
    if (!can.stockView) {
      setRecord({ status: 'forbidden' })
      return
    }
    try {
      const read = await lotRecord(api, lotId)
      setRecord(ready(read))
      setAsOf(new Date().toISOString())
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setRecord({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setRecord({ status: 'forbidden' })
      else setRecord({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.stockView, lotId])

  const loadChecklist = useCallback(async () => {
    if (!can.lotsView) return
    try {
      setChecklist(part(await releaseCheck(api, lotId)))
    } catch (error) {
      setChecklist({ value: null, problem: readProblem(error) })
    }
  }, [api, can.lotsView, lotId])

  const loadMoves = useCallback(
    async (after: string | null = null) => {
      if (!value) return
      try {
        const page = await readLedger(api, { siteId: value.lot.siteId, itemId: value.lot.item.id, lotId: value.lot.id, cursor: after, limit: PAGE })
        setMoves((current) => part({ rows: after && current.value ? [...current.value.rows, ...page.moves] : page.moves, closing: after && current.value ? current.value.closing : page.closing, more: page.nextCursor !== null }))
        setCursor(page.nextCursor)
      } catch (error) {
        setMoves({ value: null, problem: readProblem(error) })
      }
    },
    [api, value],
  )

  useEffect(() => {
    void load()
    void loadChecklist()
  }, [load, loadChecklist])

  // B-W2a-64: the lot at its site (reserved, available) and who reserved it.
  const loadFigures = useCallback(async () => {
    if (!value) return
    try {
      const lot = value.lot
      const [answer, reserved] = await Promise.all([availability(api, { siteId: lot.siteId, itemId: lot.item.id, itemColourId: lot.colour?.id ?? null }), listReservations(api, { lotId: lot.id, status: ['ACTIVE'], limit: 100 })])
      setFigures(part({ lot: answer.lots.find((entry) => entry.lot.id === lot.id) ?? null, reservations: reserved.reservations }))
    } catch (error) {
      setFigures({ value: null, problem: readProblem(error) })
    }
  }, [api, value])

  const loadTrace = useCallback(async () => {
    try {
      setTrace(part(await readTrace(api, { kind: 'LOT', id: lotId }, 'BOTH')))
    } catch (error) {
      setTrace({ value: null, problem: readProblem(error) })
    }
  }, [api, lotId])

  // The holds that touch the lot: its own (any status) and those of its hides (the site's, kept to the lot's hides).
  const loadHolds = useCallback(async () => {
    if (!value || !daily.holdsView) return
    try {
      const [own, hides, site] = await Promise.all([
        listHolds(api, { status: 'ALL', subjectType: 'Lot', subjectId: value.lot.id }),
        listHides(api, { lotId: value.lot.id, limit: 200 }),
        listHolds(api, { status: 'ALL', subjectType: 'Hide', siteId: value.lot.siteId }),
      ])
      const ids = new Set(hides.hides.map((hide) => hide.id))
      setHolds(part({ lot: own.holds, hides: site.holds.filter((hold) => hold.subjects.some((subject) => ids.has(subject.id))) }))
    } catch (error) {
      setHolds({ value: null, problem: readProblem(error) })
    }
  }, [api, value, daily.holdsView])

  useEffect(() => {
    if (!value) return
    if ((tab === 'overview' || value.lot.qualityStatus === 'REJECTED') && !asked.current.figures) {
      asked.current.figures = true
      void loadFigures()
    }
    if (tab === 'trace' && !asked.current.trace) {
      asked.current.trace = true
      void loadTrace()
    }
    if ((tab === 'quality' || tab === 'overview') && !asked.current.holds && daily.holdsView) {
      asked.current.holds = true
      void loadHolds()
    }
  }, [tab, value, loadFigures, loadTrace, loadHolds, daily.holdsView])

  useEffect(() => {
    if (!daily.holdsView) return
    pickerReasons(api, ['HOLD'])
      .then(setHoldReasons)
      .catch(() => setHoldReasons([]))
  }, [api, daily.holdsView])

  // The Moves tab reads the ledger once the lot is there (and again after a live change).
  useEffect(() => {
    if (tab !== 'moves' || !value || movesAsked.current) return
    movesAsked.current = true
    void loadMoves(null)
  }, [tab, value, loadMoves])

  const reread = useCoalesced(() => {
    void load()
    void loadChecklist()
    if (movesAsked.current) void loadMoves(null)
    if (asked.current.figures) void loadFigures()
    if (asked.current.holds) void loadHolds()
  }, 800)
  const live = useLive(
    (change) => {
      const named = change.fields.lotId
      if ((change.type.startsWith('inventory.') || change.type.startsWith('lot.') || change.type.startsWith('quality.hold')) && (named === undefined || named === lotId)) reread()
    },
    () => reread(),
    can.stockView,
  )

  const writeOff = useWriteOff(api, { withCost: daily.cost, canPhoto: daily.filesUpload, canNcr: daily.ncrRaise, prefix }, () => reread())
  const find = useTraceFind(api, prefix)

  // Write off the lot's stock at one place (design lt-reject: a rejected lot's stock is returned or scrapped).
  const openWriteOff = useCallback(
    async (locationId: string) => {
      const lot = value?.lot
      const place = value?.stock.find((row) => row.location.id === locationId)
      if (!lot || !place) return
      let unitCost: string | null = null
      let currency: string | null = null
      if (daily.cost) {
        try {
          const answer = await stockOverview(api, { siteId: lot.siteId, itemId: lot.item.id, lotId: lot.id, locationId })
          unitCost = answer.rows[0]?.unitCost ?? null
          currency = answer.items.find((entry) => entry.itemId === lot.item.id)?.currency ?? null
        } catch {
          unitCost = null
        }
      }
      const held = holds?.value ? (holdsBySubject(holds.value.lot).get(lot.id) ?? null) : null
      writeOff.open({
        kind: 'quantity',
        siteId: lot.siteId,
        item: { id: lot.item.id, code: lot.item.code, name: lot.item.name, baseUom: lot.item.baseUom },
        colour: lot.colour ? { id: lot.colour.id, code: lot.colour.code } : null,
        lot: { id: lot.id, code: lot.code },
        location: place.location,
        onHand: place.onHand,
        unitCost,
        currency,
        hold: held,
      })
    },
    [api, value, daily.cost, holds, writeOff],
  )

  const panels = value && can.threads ? <RecordPanels record={{ type: 'Lot', id: value.lot.id, companyId: value.lot.companyId, siteId: value.lot.siteId }} title={value.lot.code} /> : null

  return (
    <LotRecordView
      model={{ prefix, can, tab, record, checklist, moves, live, asOf, changed: null, dockOpen, timeZone: TIME_ZONE, daily, figures, trace, holds, holdReasons, writeOff: writeOff.model, find: find.model }}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onRetryChecklist: () => void loadChecklist(),
        onRetryMoves: () => void loadMoves(null),
        onMoreMoves: () => void loadMoves(cursor),
        onReload: () => void load(),
        onDock: toggleDock,
        onRetryFigures: () => void loadFigures(),
        onRetryTrace: () => void loadTrace(),
        onRetryHolds: () => void loadHolds(),
        onWriteOff: (locationId) => void openWriteOff(locationId),
        writeOff: writeOff.actions,
        onTrace: find.open,
        find: find.actions,
      }}
    />
  )
}
