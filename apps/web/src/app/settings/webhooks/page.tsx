'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetch 401'd and
// everyone saw an error banner + empty list in prod. Data MUST load
// client-side where the patched window.fetch adds credentials.

import { useEffect, useState } from 'react'
import { Webhook } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import WebhooksClient, { type WebhookRow } from './WebhooksClient'

export default function WebhooksPage() {
  const [state, setState] = useState<{
    webhooks: WebhookRow[]
    loadError: string | null
  } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      let webhooks: WebhookRow[] = []
      let loadError: string | null = null
      try {
        const res = await fetch(`${getBackendUrl()}/api/settings/webhooks`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { webhooks: WebhookRow[] }
        webhooks = data.webhooks ?? []
      } catch (err: any) {
        loadError = err?.message ?? String(err)
      }
      if (alive) setState({ webhooks, loadError })
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!state) {
    return (
      <div className="max-w-4xl space-y-6" aria-busy="true">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-9 h-9 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
            <Webhook size={16} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Outbound webhooks
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Loading subscriptions…
            </p>
          </div>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    )
  }

  return <WebhooksClient initial={state.webhooks} initialError={state.loadError} />
}
