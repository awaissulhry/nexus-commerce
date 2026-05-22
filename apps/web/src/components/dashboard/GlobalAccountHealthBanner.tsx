'use client'

/**
 * RT.16 — Global account-health banner. The most-critical alert in
 * the RT-series: an Amazon account suspension means everything else
 * stops mattering until it's resolved.
 *
 * Subscribes to /api/orders/events for account.health.changed
 * (fired by the SQS poller when ACCOUNT_STATUS_CHANGED lands).
 *
 * Behaviour:
 *   - HEALTHY → banner hidden.
 *   - Any other status → red sticky banner at top of every page,
 *     "Open Seller Central" deep-link, fires a non-collapsible
 *     browser notification.
 *   - State persists in sessionStorage so the banner survives
 *     navigation. NOT dismissible — operator must fix it.
 *
 * Stacks below the DLQ banner when both are active. The DLQ banner
 * also uses sticky top so they layout in mount order.
 */

import { useEffect, useState } from 'react'
import { AlertOctagon, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { fireBrowserNotification } from '@/lib/notifications/browser-notifications'

interface AccountHealthPayload {
  type: 'account.health.changed'
  accountStatus: string
  marketplaceId: string
  message?: string
  ts: number
}

const SESSION_KEY = 'nexus.account.health.latest.v1'

function loadFromSession(): AccountHealthPayload | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as AccountHealthPayload) : null
  } catch {
    return null
  }
}

function statusToTone(status: string): {
  isCritical: boolean
  label: string
  body: string
} {
  const upper = status.toUpperCase()
  if (upper === 'HEALTHY' || upper === 'GOOD' || upper === 'NORMAL') {
    return { isCritical: false, label: 'Healthy', body: 'Account is in good standing.' }
  }
  if (upper === 'DEACTIVATED' || upper === 'SUSPENDED') {
    return {
      isCritical: true,
      label: 'Account suspended',
      body: 'Amazon has deactivated this seller account. Open Seller Central immediately to review.',
    }
  }
  if (upper === 'AT_RISK' || upper === 'WARNING') {
    return {
      isCritical: true,
      label: 'Account at risk',
      body: 'Amazon flagged this account as at-risk. Open Seller Central to review the underlying issue.',
    }
  }
  return {
    isCritical: true,
    label: `Account status: ${status}`,
    body: 'Open Seller Central to review.',
  }
}

export function GlobalAccountHealthBanner() {
  const [payload, setPayload] = useState<AccountHealthPayload | null>(() => loadFromSession())

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
        const data = JSON.parse(e.data) as AccountHealthPayload
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(data))
        setPayload(data)
        const tone = statusToTone(data.accountStatus)
        if (tone.isCritical) {
          fireBrowserNotification('accountHealth', `Nexus — ${tone.label}`, {
            body: data.message ?? tone.body,
            requireInteraction: true,
          })
        }
      } catch {
        /* malformed event — ignore */
      }
    }
    es.addEventListener('account.health.changed', handler)
    return () => {
      try {
        es?.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  if (!payload) return null
  const tone = statusToTone(payload.accountStatus)
  if (!tone.isCritical) return null

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sticky top-0 z-50 bg-rose-100 dark:bg-rose-950/60 border-b-2 border-rose-500 dark:border-rose-700 px-4 py-3 shadow-md"
    >
      <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <AlertOctagon className="w-5 h-5 text-rose-700 dark:text-rose-300 flex-shrink-0 animate-pulse" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-rose-900 dark:text-rose-100">
              {tone.label}
              {payload.marketplaceId && (
                <span className="ml-2 text-xs font-normal text-rose-700 dark:text-rose-300">
                  · {payload.marketplaceId}
                </span>
              )}
            </div>
            <div className="text-xs text-rose-800 dark:text-rose-200">
              {payload.message ?? tone.body}
            </div>
          </div>
        </div>
        <a
          href="https://sellercentral.amazon.com/performance/dashboard"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-rose-700 text-white hover:bg-rose-800 flex-shrink-0"
        >
          Open Seller Central
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  )
}
