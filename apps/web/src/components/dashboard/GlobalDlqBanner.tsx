'use client'

/**
 * RT.2 — Global DLQ alert banner.
 *
 * Mounted in app/layout.tsx so it surfaces on every page. Watches the
 * Amazon SP-API SQS dead-letter-queue depth via two channels:
 *
 *   1. SSE — subscribes to /api/orders/events and listens for the
 *      `sync.dlq.threshold` event fired by the dlq-monitor cron
 *      (5min). This is the fast path: an operator sees the banner
 *      within seconds of the threshold breach.
 *   2. Poll — fetches /api/admin/push-health every 60s as a backstop
 *      for reconnecting tabs that missed the SSE event, and to
 *      auto-hide the banner once the DLQ drains.
 *
 * Behaviour:
 *   - Hidden by default (dlqDepth === 0 or null).
 *   - On first breach: requests browser notification permission (if
 *     not already decided) and fires a notification.
 *   - Banner is dismissible per session (sessionStorage). Auto-restores
 *     if the depth grows or a new breach event lands.
 *   - "View in AWS Console" deep-link if region + arn are known.
 *
 * Why session-scoped dismissal (not localStorage)?
 *   The DLQ is an ops-critical alert. We don't want a dismissal on
 *   one day to suppress the same alert tomorrow when it might be a
 *   brand-new incident.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X, ExternalLink, Bell } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  fireBrowserNotification,
  requestBrowserNotificationPermission as requestPerm,
} from '@/lib/notifications/browser-notifications'

interface PushHealthSlim {
  summary: { dlqDepth: number | null }
  sqs: { dlqDepth: number | null; region: string | null }
}

interface DlqEventPayload {
  type: 'sync.dlq.threshold'
  depth: number
  threshold: number
  queueArn: string | null
  ts: number
}

const SESSION_DISMISS_KEY = 'nexus.dlq.dismissedDepth'
const NOTIF_PROMPTED_KEY = 'nexus.dlq.notifPrompted'

function consoleUrlForArn(arn: string | null, region: string | null): string | null {
  // arn:aws:sqs:us-east-1:084164016829:nexus-sp-api-dlq
  if (!arn) return null
  const parts = arn.split(':')
  if (parts.length < 6) return null
  const r = region ?? parts[3]
  const queueName = parts[5]
  // SQS console URL format
  return `https://${r}.console.aws.amazon.com/sqs/v3/home?region=${r}#/queues/https%3A%2F%2Fsqs.${r}.amazonaws.com%2F${parts[4]}%2F${queueName}`
}

export function GlobalDlqBanner() {
  const [depth, setDepth] = useState<number | null>(null)
  const [region, setRegion] = useState<string | null>(null)
  const [queueArn, setQueueArn] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const sseRef = useRef<EventSource | null>(null)
  const lastDepthRef = useRef<number>(0)

  // Poll backstop — every 60s. Also runs immediately on mount so
  // banner state is reasonable before the first SSE event.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/admin/push-health`, {
          credentials: 'include',
          cache: 'no-store',
        })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as PushHealthSlim
        if (cancelled) return
        const d = data.summary?.dlqDepth ?? data.sqs?.dlqDepth ?? 0
        setDepth(d)
        setRegion(data.sqs?.region ?? null)
        // Auto-clear session dismissal once depth drops to zero so the
        // next breach gets a fresh banner.
        if (d === 0 && typeof window !== 'undefined') {
          sessionStorage.removeItem(SESSION_DISMISS_KEY)
        }
        lastDepthRef.current = d
      } catch {
        // network down — keep last known state
      }
    }
    void load()
    const id = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // SSE fast path — listen for sync.dlq.threshold from the cron.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = `${getBackendUrl()}/api/orders/events`
    const es = new EventSource(url, { withCredentials: true } as any)
    sseRef.current = es
    es.addEventListener('sync.dlq.threshold', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as DlqEventPayload
        setDepth(data.depth)
        setQueueArn(data.queueArn)
        // Fresh breach (depth grew) clears any prior session dismissal.
        if (data.depth > lastDepthRef.current) {
          sessionStorage.removeItem(SESSION_DISMISS_KEY)
          setDismissed(false)
          fireBrowserNotificationOnce(data)
        }
        lastDepthRef.current = data.depth
      } catch {
        /* ignore malformed event */
      }
    })
    return () => {
      es.close()
      sseRef.current = null
    }
  }, [])

  // Restore dismissal state across re-mounts within the session, but
  // only if the dismissed depth matches the current depth.
  useEffect(() => {
    if (typeof window === 'undefined' || depth === null) return
    const dismissedDepth = sessionStorage.getItem(SESSION_DISMISS_KEY)
    setDismissed(dismissedDepth !== null && Number(dismissedDepth) >= depth)
  }, [depth])

  const handleDismiss = () => {
    if (depth !== null) {
      sessionStorage.setItem(SESSION_DISMISS_KEY, String(depth))
    }
    setDismissed(true)
  }

  if (depth === null || depth === 0 || dismissed) return null

  const consoleUrl = consoleUrlForArn(queueArn, region)

  return (
    <div
      role="alert"
      aria-live="polite"
      className="sticky top-0 z-40 bg-rose-50 dark:bg-rose-950/50 border-b-2 border-rose-300 dark:border-rose-800 px-4 py-2.5 shadow-sm"
    >
      <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-semibold text-rose-900 dark:text-rose-200">
              Push pipeline dead-letter queue is non-empty
            </span>
            <span className="text-xs text-rose-700 dark:text-rose-300 ml-2 tabular-nums">
              {depth} message{depth === 1 ? '' : 's'} stuck — Amazon push notifications are
              silently failing for these orders
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {consoleUrl && (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 dark:text-rose-300 hover:text-rose-900 dark:hover:text-rose-100 underline underline-offset-2"
            >
              View in AWS Console
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button
            type="button"
            onClick={() => void requestBrowserNotificationPermission()}
            className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 dark:text-rose-300 hover:text-rose-900 dark:hover:text-rose-100"
            title="Enable browser notifications for future DLQ alerts"
          >
            <Bell className="w-3 h-3" />
            Notify me
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="p-1 rounded hover:bg-rose-100 dark:hover:bg-rose-900/50 text-rose-700 dark:text-rose-300"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * RT.17 — routed through the shared helper which respects the
 * operator's per-class opt-in config on /settings/notifications.
 */
function fireBrowserNotificationOnce(payload: DlqEventPayload): void {
  fireBrowserNotification('dlq', 'Nexus — DLQ alert', {
    body: `${payload.depth} stuck message${payload.depth === 1 ? '' : 's'} in the Amazon push DLQ. Open Nexus to investigate.`,
  })
}

async function requestBrowserNotificationPermission(): Promise<void> {
  const result = await requestPerm()
  if (result === 'denied') {
    alert(
      'Browser notifications are blocked. Open your browser site settings and allow notifications for this domain, then click "Notify me" again.',
    )
    return
  }
  if (result === 'granted') {
    sessionStorage.setItem(NOTIF_PROMPTED_KEY, '1')
  }
}
