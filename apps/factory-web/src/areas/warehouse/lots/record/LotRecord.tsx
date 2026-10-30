'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { lotRecord, readLedger, type LotRecord as LotRecordValue } from '../../../_shared/stock/api'
import { readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { releaseCheck, type ReleaseChecklist } from '../api'
import { lotTabOf } from '../model'
import { LOADING, part, PART_LOADING, ready, type Loaded, type Part } from '../shared/model'
import { LotsMessages, type MovesPart } from '../shared/parts'
import { LotRecordView } from './view/LotRecordView'

/**
 * The lot record container (`/w/<company>/warehouse/lots/<lotId>?tab=overview|trace|moves|activity`, SCR-201-record):
 * reads the lot with its stock and trace (`GET /inventory/lots/:lotId`), the release checklist for a viewer with
 * quality.lots.view (`GET /quality/lots/:lotId/release-check`), and on the Moves tab the ledger of the lot
 * (`GET /inventory/ledger?siteId&itemId&lotId`, pages of 200); re-reads on the lot's live events. Nothing is written
 * here: the decisions are made in Compliance › Tests & substances.
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
  }, 800)
  const live = useLive(
    (change) => {
      const named = change.fields.lotId
      if ((change.type.startsWith('inventory.') || change.type.startsWith('lot.')) && (named === undefined || named === lotId)) reread()
    },
    () => reread(),
    can.stockView,
  )

  const panels = value && can.threads ? <RecordPanels record={{ type: 'Lot', id: value.lot.id, companyId: value.lot.companyId, siteId: value.lot.siteId }} title={value.lot.code} /> : null

  return (
    <LotRecordView
      model={{ prefix, can, tab, record, checklist, moves, live, asOf, changed: null, dockOpen, timeZone: TIME_ZONE }}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onRetryChecklist: () => void loadChecklist(),
        onRetryMoves: () => void loadMoves(null),
        onMoreMoves: () => void loadMoves(cursor),
        onReload: () => void load(),
        onDock: toggleDock,
      }}
    />
  )
}
