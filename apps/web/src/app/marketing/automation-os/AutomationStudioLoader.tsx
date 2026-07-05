'use client'

/**
 * UM-series (P6) — Client-side data loader for the Automation studio.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so rules MUST load client-side where
 * the fetch patch adds credentials. Server-side this fetch 401'd into an
 * empty rule list for everyone. page.tsx stays a server component because
 * it exports metadata. Post-load updates come from AutomationStudioClient's
 * own SSE + mutation refetches.
 */

import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationStudioClient, type MarketingRule } from './AutomationStudioClient'

export function AutomationStudioLoader() {
  const [rules, setRules] = useState<MarketingRule[] | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let items: MarketingRule[] = []
      try {
        const res = await fetch(`${getBackendUrl()}/api/marketing/os/rules`, { cache: 'no-store' })
        if (res.ok) items = (await res.json()).items ?? []
      } catch {
        // empty
      }
      if (!cancelled) setRules(items)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!rules) {
    return (
      <div className="p-4 sm:p-6 max-w-[1200px] mx-auto" aria-busy="true">
        <header className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Zap size={20} className="text-violet-500" />
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Automation studio</h1>
          </div>
        </header>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      </div>
    )
  }

  return <AutomationStudioClient initialRules={rules} />
}
