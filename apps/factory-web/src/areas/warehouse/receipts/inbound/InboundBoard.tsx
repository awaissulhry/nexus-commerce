'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { buyingCan, readProblem, todayIn, writeProblem } from '../../../_shared/buying/model'
import { readInbound, saveDockNote, type InboundCard } from './api'
import { INBOUND_DAYS, readInboundOn, receiveHref, writeInboundOn, type InboundModel } from './model'
import { InboundBoardView } from './view/InboundBoardView'

const TIME_ZONE = 'Europe/Rome'

/**
 * The board's switch on this device (design h.more "Inbound board on / off (W2b)"), read after the first paint: `on` is null
 * until then, so a board switched off never flashes on a reload (and the server's render holds no board).
 */
export function useInboundOn(): { on: boolean | null; toggle: (on: boolean) => void } {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => setOn(readInboundOn()), [])
  const toggle = useCallback((next: boolean) => {
    writeInboundOn(next)
    setOn(next)
  }, [])
  return { on, toggle }
}

/**
 * The inbound board's container (B-W2b-182; SCM-110) on Warehouse › Receipts: ONE read of GET /inventory/receiving/inbound
 * for the top bar's site (every site the person reaches when "All sites"), again on a site switch, on live ship_notice.*,
 * inventory.receipt_* and purchase_order.* events (coalesced) and on reconnect. Receive opens the receiving page filled
 * from the notice; the dock note is a PATCH at the notice's version.
 */
export function InboundBoard({ on, prefix }: { on: boolean; prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const can = buyingCan(session.permissions)
  const [board, setBoard] = useState<InboundModel['board']>({ status: 'loading' })
  const [noting, setNoting] = useState<InboundModel['noting']>(null)
  const readId = useRef(0)
  const key = useRef(newIdempotencyKey())

  const load = useCallback(async () => {
    if (!on) return
    if (!can.stockView) {
      setBoard({ status: 'forbidden' })
      return
    }
    const id = ++readId.current
    try {
      const value = await readInbound(api, { siteId: scope.siteId, days: INBOUND_DAYS })
      if (id === readId.current) setBoard({ status: 'ready', value })
    } catch (error) {
      if (id !== readId.current) return
      setBoard(isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up') ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, on, can.stockView, scope.siteId])

  useEffect(() => {
    setBoard({ status: 'loading' })
    void load()
  }, [load])

  const refresh = useCoalesced(() => void load(), 800)
  useLive(
    (change) => {
      if (change.type.startsWith('ship_notice.') || change.type.startsWith('inventory.receipt_') || change.type.startsWith('purchase_order.')) refresh()
    },
    () => void load(),
    on && can.stockView,
  )

  const saveNote = useCallback(async () => {
    if (!noting?.card.shipNotice) return
    setNoting({ ...noting, saving: true, problem: null })
    try {
      await saveDockNote(api, noting.card.shipNotice.id, { version: noting.card.shipNotice.version, dockNote: noting.text.trim() || null }, key.current)
      key.current = newIdempotencyKey()
      setNoting(null)
      void load()
    } catch (error) {
      key.current = newIdempotencyKey()
      setNoting({ ...noting, saving: false, problem: writeProblem(error).key })
    }
  }, [api, noting, load])

  const model: InboundModel = { prefix, on, board, today: todayIn(TIME_ZONE), canReceive: can.receive, timeZone: TIME_ZONE, noting }
  return (
    <InboundBoardView
      model={model}
      actions={{
        onRetry: () => {
          setBoard({ status: 'loading' })
          void load()
        },
        onReceive: (card: InboundCard) => router.push(receiveHref(prefix, card)),
        onNote: (card) => setNoting(card ? { card, text: card.dockNote ?? '', saving: false, problem: null } : null),
        onNoteText: (text) => setNoting((current) => (current ? { ...current, text } : current)),
        onNoteSave: () => void saveNote(),
      }}
    />
  )
}
