'use client'

/**
 * MB.1 — Client-side status loader for the Brand Brain dashboard.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so /api/brand-brain/status MUST load
 * client-side where the fetch patch adds credentials. Server-side this
 * fetch 401'd into "pgvector unavailable" + zero embeddings for everyone.
 *
 * `refreshToken` comes from the server page render (Date.now() under
 * force-dynamic): BrandBrainActionsClient calls router.refresh() after an
 * ingest (and from its Refresh button), which re-renders the server page,
 * mints a new token, and re-triggers this fetch — preserving the original
 * refresh semantics.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface BrainStatus {
  totalEmbeddings: number
  byEntityType: Array<{ entityType: string; count: number }>
  pgvectorAvailable: boolean
}

const ENTITY_LABEL: Record<string, string> = {
  BRAND_KIT: 'Brand Kits',
  BRAND_VOICE: 'Brand Voice rules',
  APLUS_CONTENT: 'A+ Content',
}

async function fetchStatus(): Promise<BrainStatus> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/brand-brain/status`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as BrainStatus
  } catch {
    return { totalEmbeddings: 0, byEntityType: [], pgvectorAvailable: false }
  }
}

export function BrandBrainStatusClient({ refreshToken }: { refreshToken: number }) {
  const [status, setStatus] = useState<BrainStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  if (!status) {
    return (
      <div aria-busy="true">
        <div className="mb-4 h-9 animate-pulse rounded-md border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-md border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* pgvector health */}
      <div
        className={`mb-4 flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
          status.pgvectorAvailable
            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-900'
            : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-900'
        }`}
      >
        {status.pgvectorAvailable ? (
          <CheckCircle2 className="h-4 w-4 shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0" />
        )}
        <span>
          {status.pgvectorAvailable
            ? 'pgvector extension active — vector search available'
            : 'pgvector unavailable — run the migration or check the Neon connection'}
        </span>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Total embeddings" value={status.totalEmbeddings} />
        {status.byEntityType.map((r) => (
          <Stat
            key={r.entityType}
            label={ENTITY_LABEL[r.entityType] ?? r.entityType}
            value={r.count}
          />
        ))}
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
    </div>
  )
}
