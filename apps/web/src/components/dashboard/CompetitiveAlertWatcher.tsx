'use client'

/**
 * RT.13 + RT.14 — Global watcher for competitive + listing alerts.
 *
 * Subscribes to /api/orders/events and listens for:
 *   - competitive.buyBoxLost (RT.13) — ANY_OFFER_CHANGED showed we
 *     lost the buy box on an ASIN where we have a live offer.
 *   - listing.suppressed (RT.14) — LISTINGS_ITEM_STATUS_CHANGE
 *     showed one of our listings entered a suppressed / non-buyable
 *     state.
 *
 * Behaviour:
 *   - Fires a browser desktop notification per alert (if permission
 *     was previously granted via GlobalDlqBanner's "Notify me" or
 *     the future settings page).
 *   - Tag-collapsed by ASIN so back-to-back changes on the same
 *     ASIN don't pile multiple notifications.
 *   - Logs every alert to console with a [BuyBox] / [Suppressed]
 *     prefix so an operator with devtools open can see the history.
 *
 * Visual UI is intentionally minimal in this phase — RT.17 / RT.19
 * will add the dedicated alerts panel. These phases just prove the
 * push paths end-to-end + provide immediate operator notification.
 */

import { useEffect } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { fireBrowserNotification } from '@/lib/notifications/browser-notifications'

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

        // RT.17 — routed through the shared helper which checks the
        // operator's opt-in config + permission state before firing.
        fireBrowserNotification('buyBoxLost', 'Nexus — Buy Box lost', {
          body: `${data.asin}: us ${formatPrice(
            data.ourPrice,
            data.currency,
          )}, winner ${formatPrice(data.winnerPrice, data.currency)}${deltaLabel}`,
          tagSuffix: data.asin,
        })
      } catch {
        /* malformed event — ignore */
      }
    }

    es.addEventListener('competitive.buyBoxLost', handler)

    // RT.14 — listing.suppressed handler. Same notification pattern,
    // different copy + tag.
    const suppressedHandler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          asin: string
          sku: string
          marketplaceId: string
          status: string
        }
        // eslint-disable-next-line no-console
        console.warn(
          `[Suppressed] ${data.sku || data.asin} on ${data.marketplaceId} → ${data.status}`,
          data,
        )
        fireBrowserNotification(
          'listingSuppressed',
          'Nexus — Listing suppressed',
          {
            body: `${data.sku || data.asin} on ${data.marketplaceId}: ${data.status}. Open Nexus to investigate the cause.`,
            tagSuffix: data.asin,
          },
        )
      } catch {
        /* ignore */
      }
    }
    es.addEventListener('listing.suppressed', suppressedHandler)

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
