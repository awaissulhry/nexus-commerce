'use client'

/**
 * RT.13 — Global watcher for Buy-Box-loss alerts.
 *
 * Subscribes to /api/orders/events and listens for the
 * competitive.buyBoxLost event the SQS poller fires when an Amazon
 * ANY_OFFER_CHANGED notification shows our seller is no longer the
 * buy-box winner on an ASIN where we hold an offer.
 *
 * Behaviour:
 *   - Fires a browser desktop notification per alert (if permission
 *     was previously granted via GlobalDlqBanner's "Notify me" or
 *     the future settings page).
 *   - Tag-collapsed by ASIN so back-to-back changes on the same
 *     ASIN don't pile multiple notifications.
 *   - Logs every alert to console with a [BuyBox] prefix so an
 *     operator with devtools open can see the history.
 *
 * Visual UI is intentionally minimal in this phase — RT.17 / RT.19
 * will add the dedicated competitive-alerts panel. RT.13 just
 * proves the push path end-to-end + provides immediate operator
 * notification.
 */

import { useEffect } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface BuyBoxLostPayload {
  type: 'competitive.buyBoxLost'
  asin: string
  marketplaceId: string
  ourPrice: number | null
  winnerPrice: number | null
  currency: string
  winnerSellerId: string | null
  winnerFulfillmentType: string | null
  ts: number
}

function formatPrice(amount: number | null, currency: string): string {
  if (amount == null) return '—'
  const sym =
    currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

export function CompetitiveAlertWatcher() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`, {
        withCredentials: true,
      } as any)
    } catch {
      return
    }

    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as BuyBoxLostPayload
        const delta =
          data.ourPrice != null && data.winnerPrice != null
            ? data.ourPrice - data.winnerPrice
            : null
        const deltaLabel =
          delta != null && delta > 0
            ? ` (we're ${formatPrice(delta, data.currency)} higher)`
            : ''
        // eslint-disable-next-line no-console
        console.info(
          `[BuyBox] lost on ASIN ${data.asin} — us ${formatPrice(
            data.ourPrice,
            data.currency,
          )}, winner ${formatPrice(data.winnerPrice, data.currency)}${deltaLabel}`,
          data,
        )

        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification('Nexus — Buy Box lost', {
              body: `${data.asin}: us ${formatPrice(
                data.ourPrice,
                data.currency,
              )}, winner ${formatPrice(data.winnerPrice, data.currency)}${deltaLabel}`,
              icon: '/favicon.ico',
              tag: `nexus-buybox-${data.asin}`, // collapse same-ASIN repeats
            })
          } catch {
            /* notification rejected outside user gesture — ignore */
          }
        }
      } catch {
        /* malformed event — ignore */
      }
    }

    es.addEventListener('competitive.buyBoxLost', handler)

    return () => {
      try {
        es?.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  return null // no visual UI — RT.17/RT.19 add the dedicated panel
}
