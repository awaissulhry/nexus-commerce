'use client'

/**
 * PD.1 — publish-mode indicator. A gated/dry-run publish silently looked like a
 * successful one for 30 days; this surfaces the live truth wherever you publish.
 * Reads GET /api/listings/publish-readiness. Renders nothing until it knows the
 * mode (so it never flashes a wrong state).
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

type PublishMode = 'live' | 'dry-run' | 'sandbox' | 'gated'

const STYLE: Record<PublishMode, { label: string; cls: string; title: string }> = {
  live: { label: 'LIVE', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300', title: 'Publishes reach the channel.' },
  'dry-run': { label: 'DRY-RUN', cls: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300', title: 'Validated only — nothing is actually published.' },
  sandbox: { label: 'SANDBOX', cls: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300', title: 'Sandbox endpoint — not production.' },
  gated: { label: 'GATED · OFF', cls: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-300', title: 'Publishing is disabled — nothing is sent to the channel.' },
}

export function PublishModeBadge({ channel = 'amazon', className = '' }: { channel?: 'amazon' | 'ebay'; className?: string }) {
  const [mode, setMode] = useState<PublishMode | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/listings/publish-readiness`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.[channel]?.mode) setMode(d[channel].mode as PublishMode) })
      .catch(() => { /* badge is advisory — never block the page */ })
    return () => { alive = false }
  }, [channel])

  if (!mode) return null
  const s = STYLE[mode] ?? { label: String(mode), cls: 'bg-slate-100 text-slate-700 border-slate-300', title: '' }
  return (
    <span
      title={s.title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${s.cls} ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      {channel.toUpperCase()} {s.label}
    </span>
  )
}
