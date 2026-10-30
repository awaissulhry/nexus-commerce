'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { hideRecord, readLedger, stockOverview, type HideRecord as HideRecordValue, type HideRow } from '../../../_shared/stock/api'
import { readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { listHolds } from '../../stock/daily/api'
import { holdsBySubject } from '../../stock/daily/model'
import { useReserve } from '../../stock/daily/useReserve'
import { useWriteOff } from '../../stock/daily/useWriteOff'
import { dailyCan, hidesValue, reserveHides, scrapTarget, type HoldsBySubject } from '../../lots/shared/daily'
import { LOADING, part, PART_LOADING, ready, type Loaded, type Part } from '../../lots/shared/model'
import { LotsMessages, useWords, type MovesPart } from '../../lots/shared/parts'
import { hideTabOf } from '../model'
import { usePrintTags } from '../print/usePrintTags'
import { HideRecordView } from './view/HideRecordView'

/**
 * The hide record container (`/w/<company>/warehouse/hides/<hideId>?tab=overview|cuts|moves`, SCR-200-record): reads the
 * hide with its lot, area balance and cut log (`GET /inventory/hides/:hideId`), on the Moves tab the ledger rows naming
 * it (`GET /inventory/ledger?siteId&itemId&lotId&hideId`, pages of 200), prints its tag, and reads again on its live
 * events (a move, a cut). B-W2a-64: the ACTIVE holds of the hide and of its lot (quality.holds.view) with the HOLD
 * reasons' words, Reserve to a work order and Scrap from the record (the shared every-day dialogs).
 */
export function HideRecord({ hideId }: { hideId: string }) {
  return (
    <LotsMessages>
      <HideRecordContainer hideId={hideId} />
    </LotsMessages>
  )
}

const PAGE = 200

function HideRecordContainer({ hideId }: { hideId: string }) {
  const t = useWords()
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = hideTabOf(params?.get('tab'))
  const [record, setRecord] = useState<Loaded<HideRecordValue>>(LOADING)
  const [moves, setMoves] = useState<Part<MovesPart>>(PART_LOADING)
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [holds, setHolds] = useState<HoldsBySubject>({})
  const [holdReasons, setHoldReasons] = useState<PickerReason[]>([])
  const value = record.status === 'ready' ? record.value : null
  const movesAsked = useRef(false)
  const hideRef = useRef<HideRow | null>(null)
  hideRef.current = value?.hide ?? null

  const load = useCallback(async () => {
    if (!can.stockView) {
      setRecord({ status: 'forbidden' })
      return
    }
    try {
      const read = await hideRecord(api, hideId)
      setRecord(ready(read))
      setAsOf(new Date().toISOString())
      if (daily.holdsView) {
        // The holds of the hide and of its lot (Q3: any record's holds), ACTIVE.
        Promise.all([listHolds(api, { status: 'ACTIVE', subjectType: 'Hide', subjectId: read.hide.id }), listHolds(api, { status: 'ACTIVE', subjectType: 'Lot', subjectId: read.hide.lot.id })])
          .then(([own, lot]) => setHolds(Object.fromEntries(holdsBySubject([...own.holds, ...lot.holds]))))
          .catch(() => setHolds({}))
      }
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setRecord({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setRecord({ status: 'forbidden' })
      else setRecord({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.stockView, daily.holdsView, hideId])

  useEffect(() => {
    if (!daily.holdsView) return
    pickerReasons(api, ['HOLD'])
      .then(setHoldReasons)
      .catch(() => setHoldReasons([]))
  }, [api, daily.holdsView])

  const loadMoves = useCallback(
    async (after: string | null = null) => {
      const hide = hideRef.current
      if (!hide) return
      try {
        const page = await readLedger(api, { siteId: hide.siteId, itemId: hide.item.id, lotId: hide.lot.id, hideId: hide.id, cursor: after, limit: PAGE })
        setMoves((current) => part({ rows: after && current.value ? [...current.value.rows, ...page.moves] : page.moves, closing: after && current.value ? current.value.closing : page.closing, more: page.nextCursor !== null }))
        setCursor(page.nextCursor)
      } catch (error) {
        setMoves({ value: null, problem: readProblem(error) })
      }
    },
    [api],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== 'moves' || !value || movesAsked.current) return
    movesAsked.current = true
    void loadMoves(null)
  }, [tab, value, loadMoves])

  const reread = useCoalesced(() => {
    void load()
    if (movesAsked.current) void loadMoves(null)
  }, 800)
  const live = useLive(
    (change) => {
      const named = change.fields.hideId
      if ((change.type.startsWith('inventory.') || change.type.startsWith('production.cut') || change.type.startsWith('lot.') || change.type.startsWith('quality.hold')) && (named === undefined || named === hideId)) reread()
    },
    () => reread(),
    can.stockView,
  )

  const unitWord = useCallback((uom: HideRow['areaUom']) => t(`stock:uom.${uom}`), [t])
  const hidesOf = useCallback(() => (hideRef.current ? [hideRef.current] : []), [])
  const print = usePrintTags(api, locale, unitWord, hidesOf)
  const reserve = useReserve(api, { workOrders: daily.workOrders, timeZone: TIME_ZONE }, () => void load())
  const writeOff = useWriteOff(api, { withCost: daily.cost, canPhoto: daily.filesUpload, canNcr: daily.ncrRaise, prefix }, () => void load())

  const openScrap = useCallback(async () => {
    const hide = hideRef.current
    if (!hide) return
    let worth: { amount: number; currency: string } | null = null
    if (daily.cost) {
      try {
        const answer = await stockOverview(api, { siteId: hide.siteId, itemId: hide.item.id, hideId: hide.id })
        worth = hidesValue(answer.rows, [hide.id], answer.items.find((entry) => entry.itemId === hide.item.id)?.currency ?? null)
      } catch {
        worth = null
      }
    }
    writeOff.open(scrapTarget([hide], holds, worth))
  }, [api, daily.cost, holds, writeOff])

  return (
    <HideRecordView
      model={{ prefix, can, tab, record, moves, live, asOf, timeZone: TIME_ZONE, print: print.dialog, daily, holds, holdReasons, reserve: reserve.model, writeOff: writeOff.model }}
      actions={{
        onRetry: () => void load(),
        onRetryMoves: () => void loadMoves(null),
        onMoreMoves: () => void loadMoves(cursor),
        print: print.actions,
        onReserve: () => {
          const hide = hideRef.current
          if (hide) reserve.open(hide.siteId, reserveHides([hide], holds, holdReasons, locale))
        },
        onScrap: () => void openScrap(),
        reserve: reserve.actions,
        writeOff: writeOff.actions,
      }}
    />
  )
}
