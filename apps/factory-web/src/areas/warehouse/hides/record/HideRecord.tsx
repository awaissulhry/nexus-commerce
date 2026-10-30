'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { hideRecord, readLedger, type HideRecord as HideRecordValue, type HideRow } from '../../../_shared/stock/api'
import { readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { LOADING, part, PART_LOADING, ready, type Loaded, type Part } from '../../lots/shared/model'
import { LotsMessages, useWords, type MovesPart } from '../../lots/shared/parts'
import { hideTabOf } from '../model'
import { usePrintTags } from '../print/usePrintTags'
import { HideRecordView } from './view/HideRecordView'

/**
 * The hide record container (`/w/<company>/warehouse/hides/<hideId>?tab=overview|cuts|moves`, SCR-200-record): reads the
 * hide with its lot, area balance and cut log (`GET /inventory/hides/:hideId`), on the Moves tab the ledger rows naming
 * it (`GET /inventory/ledger?siteId&itemId&lotId&hideId`, pages of 200), prints its tag, and reads again on its live
 * events (a move, a cut).
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
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = hideTabOf(params?.get('tab'))
  const [record, setRecord] = useState<Loaded<HideRecordValue>>(LOADING)
  const [moves, setMoves] = useState<Part<MovesPart>>(PART_LOADING)
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
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
      setRecord(ready(await hideRecord(api, hideId)))
      setAsOf(new Date().toISOString())
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setRecord({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setRecord({ status: 'forbidden' })
      else setRecord({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.stockView, hideId])

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
      if ((change.type.startsWith('inventory.') || change.type.startsWith('production.cut') || change.type.startsWith('lot.')) && (named === undefined || named === hideId)) reread()
    },
    () => reread(),
    can.stockView,
  )

  const unitWord = useCallback((uom: HideRow['areaUom']) => t(`stock:uom.${uom}`), [t])
  const hidesOf = useCallback(() => (hideRef.current ? [hideRef.current] : []), [])
  const print = usePrintTags(api, locale, unitWord, hidesOf)

  return (
    <HideRecordView
      model={{ prefix, can, tab, record, moves, live, asOf, timeZone: TIME_ZONE, print: print.dialog }}
      actions={{ onRetry: () => void load(), onRetryMoves: () => void loadMoves(null), onMoreMoves: () => void loadMoves(cursor), print: print.actions }}
    />
  )
}
