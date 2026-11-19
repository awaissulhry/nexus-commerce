'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { fetchPriceCheck, priceBodyOf, priceCheckAccessOf, priceDraftOf, priceDraftProblems, priceHeldKeyOf, pricesClosed, saveBrandPrices, type PortalPriceCheck, type PriceDraft } from './price-check'
import type { PriceCheckActions, PriceCheckModel } from './view/PriceCheck'

/**
 * F-CP-143 (customer page plan C3, D2, D3; 11 §3.4): the order page's price check — read for a price holder only (a reader without
 * the price grain is never asked: no call, "Prices are not part of your access."), read again with the order; "Your prices…" opens
 * the window from the check as read, Save sends ONE command at the versions read (one Idempotency-Key per body), a 409 shows the
 * prices as they are now ("Someone changed these prices meanwhile."). The container (OrderPage) passes the model and the actions to
 * the Lines tab's view.
 */
export function usePortalPriceCheck(input: {
  readonly api: ApiClient
  readonly orderId: string
  /** The reader's role sees prices (the customer's Buyer, Finance, Admin). */
  readonly seesPrices: boolean
  /** The order's status as the customer reads it (a cancelled order keeps its prices); null: not read yet. */
  readonly status: string | null
  /** The reader may ask on its orders (portal.salesOrders.ask: the Buyer, the Admin): a refused write is then the order's state. */
  readonly mayAsk: boolean
  readonly preview: boolean
  readonly offline: boolean
  /** Read again whenever the order is (its loadedAt). */
  readonly refreshKey: string
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: 'it' | 'en'
}): { model: PriceCheckModel | null; actions: PriceCheckActions } {
  const { api, orderId, seesPrices, status, mayAsk, preview, offline, refreshKey, t, locale } = input
  const [state, setState] = useState<PriceCheckModel['state']>('loading')
  const [check, setCheck] = useState<PortalPriceCheck | null>(null)
  const [dialog, setDialog] = useState<{ draft: PriceDraft; showProblems: boolean; busy: boolean; failed: string | null; stale: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const keys = useRef<Map<string, string>>(new Map())
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    let key = keys.current.get(text)
    if (!key) {
      key = newIdempotencyKey()
      keys.current.set(text, key)
    }
    return key
  }

  const load = useCallback(
    async (signal?: AbortSignal): Promise<PortalPriceCheck | null> => {
      if (!seesPrices) return null
      try {
        const read = await fetchPriceCheck(api, orderId, signal)
        setCheck(read)
        setState('ready')
        return read
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return null
        setState('error')
        return null
      }
    },
    [api, orderId, seesPrices],
  )

  useEffect(() => {
    if (!seesPrices) return
    const abort = new AbortController()
    void load(abort.signal)
    return () => abort.abort()
  }, [load, seesPrices, refreshKey])

  const access = priceCheckAccessOf(seesPrices, check)
  const allowed = check?.mayWrite.allowed ?? false
  // The API refuses a write for a closed order first, then for a role that reads only: who may ask and is refused reads a closed order.
  const heldKey = priceHeldKeyOf({ allowed, closed: (status !== null && pricesClosed(status)) || (mayAsk && check !== null && !allowed), preview, offline })

  const save = async () => {
    if (!check || !dialog || dialog.busy) return
    const problems = priceDraftProblems(dialog.draft)
    if (Object.keys(problems.lines).length > 0 || problems.note) {
      setDialog({ ...dialog, showProblems: true })
      return
    }
    const body = priceBodyOf(check, dialog.draft)
    if (!body) {
      setDialog(null)
      return
    }
    setDialog({ ...dialog, busy: true, failed: null })
    try {
      const next = await saveBrandPrices(api, orderId, body, keyFor({ orderId, body }))
      setCheck(next)
      setDialog(null)
      setNotice('priceCheck.saved')
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      if (kind === 'conflict') {
        // The prices changed meanwhile: the window shows them as they are now.
        const fresh = await load()
        setDialog({ draft: fresh ? priceDraftOf(fresh, locale) : dialog.draft, showProblems: false, busy: false, failed: null, stale: true })
        return
      }
      setDialog({ ...dialog, busy: false, failed: kind === 'invalid' ? 'priceCheck.refused' : kind === 'forbidden' ? 'priceCheck.readsOnly' : 'priceCheck.notSaved' })
    }
  }

  const model: PriceCheckModel | null =
    access === 'none'
      ? null
      : {
          state,
          check,
          access,
          held: heldKey ? t(heldKey) : null,
          dialog: dialog ? { ...dialog, problems: priceDraftProblems(dialog.draft) } : null,
          notice,
        }

  return {
    model,
    actions: {
      onOpen: () => {
        if (!check || heldKey) return
        setNotice(null)
        setDialog({ draft: priceDraftOf(check, locale), showProblems: false, busy: false, failed: null, stale: false })
      },
      onRetry: () => {
        setState('loading')
        void load()
      },
      dialog: {
        onPrice: (lineId, text) => setDialog((now) => (now ? { ...now, draft: { ...now.draft, prices: { ...now.draft.prices, [lineId]: text } }, failed: null } : now)),
        onNote: (text) => setDialog((now) => (now ? { ...now, draft: { ...now.draft, note: text }, failed: null } : now)),
        onSave: () => void save(),
        onClose: () => setDialog((now) => (now?.busy ? now : null)),
      },
    },
  }
}
