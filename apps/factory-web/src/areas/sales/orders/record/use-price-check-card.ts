'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLive } from '../hooks'
import { readProblem, type OrderAbilities, type Phrase } from '../model'
import { priceCheckSchema, readPriceCheck, type PriceCheck } from '../price-check/api'
import { usePriceCheck, type PriceCheckDialogActions, type PriceCheckDialogModel } from '../price-check/use-price-check'
import { asksPriceCheck, BRAND_PRICE_EVENT, takeOverRefusalOf, type PriceCheckCardActions, type PriceCheckCardModel, type PriceCheckRead } from './price-check-card'

/**
 * F-CP-142 (customer page plan C2d, C3; design 11-money §3.3; review A3) — the container of the order page's Money › "Price check"
 * card: it reads `GET /sales/orders/:orderId/price-check` while Money shows, for a price holder only (anyone else: the card is one
 * line of words and nothing is asked), again when the order moves on (its version: our prices changed), on the live
 * `sales_order.brand_price_changed` of this order (the rows keep their place: the read replaces the check in one go, the old one
 * stays on screen until it arrives) and on Try again. "Customer's price…" opens the ONE window (so/price-check usePriceCheck, F-CP-114
 * — the Work tab's door is the other); its save hands the new check to the card and says so in the page's one notice. "Take them over"
 * posts the request's prices (one Idempotency-Key per try); a refusal reads the card again and says why on it. Mounted by
 * OrderRecord.tsx, which hands what it returns to the view as plain props (a view never imports it).
 */
export function usePriceCheckCard(input: {
  readonly api: ApiClient
  readonly orderId: string
  readonly can: Pick<OrderAbilities, 'price'>
  readonly tab: string
  /** The order's version as read (a change of our lines reads the check again). */
  readonly version: number | null
  readonly permissions: readonly string[]
  /** The page's ONE notice (a save, a take-over). */
  readonly setNotice: (notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null) => void
}): { model: PriceCheckCardModel; actions: PriceCheckCardActions; dialog: { model: PriceCheckDialogModel | null; actions: PriceCheckDialogActions } } {
  const { api, orderId, can, tab, version, permissions, setNotice } = input
  const asks = asksPriceCheck(can, tab)
  const [read, setRead] = useState<PriceCheckRead>(asks ? { state: 'loading' } : { state: 'held' })
  const seq = useRef(0)
  const takeKey = useRef<{ readonly requestId: string; readonly key: string } | null>(null)
  const notice = useRef(setNotice)
  notice.current = setNotice

  const load = useCallback(
    (after?: { readonly stale?: boolean; readonly problem?: Phrase | null }) => {
      const mine = ++seq.current
      // The check on screen stays until the fresh one arrives (no flash, rows in place); only a first read shows the skeleton.
      setRead((current) => (current.state === 'ready' ? current : { state: 'loading' }))
      readPriceCheck(api, orderId).then(
        (check) => mine === seq.current && setRead({ state: 'ready', check, stale: after?.stale ?? false, taking: false, problem: after?.problem ?? null }),
        (error: unknown) => mine === seq.current && setRead({ state: 'failed', problem: readProblem(error) }),
      )
    },
    [api, orderId],
  )

  useEffect(() => {
    if (!asks) {
      seq.current++
      setRead({ state: 'held' })
      return
    }
    load()
  }, [asks, load, version])

  // Live: the customer's prices of THIS order changed (here, in the portal, on the Work tab); a break reads again too.
  useLive(
    (change) => {
      if (change.type === BRAND_PRICE_EVENT && change.fields.orderId === orderId) load()
    },
    () => load(),
    asks,
  )

  // ---- the ONE customer's-price window (F-CP-114): its save is the card's new check, said in the page's one notice ----
  const editor = usePriceCheck(api, {
    onSaved: (check: PriceCheck) => {
      seq.current++
      setRead({ state: 'ready', check, stale: false, taking: false, problem: null })
      notice.current({ tone: 'success', words: { key: 'priceCheck.saved', params: { number: check.number } } })
    },
  })

  const takeOver = async (requestId: string) => {
    if (read.state !== 'ready' || read.taking) return
    setRead({ ...read, taking: true, problem: null })
    if (takeKey.current?.requestId !== requestId) takeKey.current = { requestId, key: newIdempotencyKey() }
    try {
      const check = await api.post(`/sales/orders/${encodeURIComponent(orderId)}/brand-prices/from-request`, { body: { requestId }, schema: priceCheckSchema, idempotencyKey: takeKey.current.key })
      takeKey.current = null
      seq.current++
      setRead({ state: 'ready', check, stale: false, taking: false, problem: null })
      notice.current({ tone: 'success', words: { key: 'priceCheck.card.takenOver', params: { number: check.number } } })
    } catch (error) {
      takeKey.current = null
      const refusal = takeOverRefusalOf(error)
      if (refusal.reread) return load({ stale: refusal.words.key === 'priceCheck.stale', problem: refusal.words.key === 'priceCheck.stale' ? null : refusal.words })
      setRead((current) => (current.state === 'ready' ? { ...current, taking: false, problem: refusal.words } : current))
    }
  }

  // Without the price grain the card is held in words whatever was read; a price holder arriving on Money sees the skeleton, never the held line.
  const shown: PriceCheckRead = !can.price ? { state: 'held' } : read.state === 'held' ? { state: 'loading' } : read
  const model = useMemo<PriceCheckCardModel>(() => ({ read: shown, canHistory: permissions.includes('audit.read') }), [shown, permissions])
  const actions: PriceCheckCardActions = {
    onEdit: () => {
      if (read.state === 'ready') editor.open({ orderId, number: read.check.number })
    },
    onTakeOver: (requestId) => void takeOver(requestId),
    onRetry: () => load(),
  }
  return { model, actions, dialog: { model: editor.model, actions: editor.actions } }
}
