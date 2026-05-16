'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw, Search, Zap } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface BrainResult {
  id: string
  entityType: string
  entityId: string
  field: string
  snippet: string
  distance: number
}

export function BrandBrainActionsClient() {
  const router = useRouter()
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestResult, setIngestResult] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [queryResults, setQueryResults] = useState<BrainResult[] | null>(null)

  async function triggerIngest() {
    setIngestBusy(true)
    setIngestResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/brand-brain/ingest`, {
        method: 'POST',
      })
      const json = (await res.json()) as {
        ok: boolean
        summary: { brandKits: number; brandVoices: number; aplusContents: number; errors: number }
      }
      if (json.ok) {
        const s = json.summary
        setIngestResult(
          `Indexed: ${s.brandKits} brand kits · ${s.brandVoices} brand voices · ${s.aplusContents} A+ docs · ${s.errors} errors`,
        )
      } else {
        setIngestResult('Ingest failed')
      }
      router.refresh()
    } finally {
      setIngestBusy(false)
    }
  }

  async function runQuery() {
    if (!query.trim()) return
    setQueryBusy(true)
    setQueryResults(null)
    try {
      const url = new URL(`${getBackendUrl()}/api/brand-brain/query`)
      url.searchParams.set('q', query)
      url.searchParams.set('limit', '5')
      const res = await fetch(url.toString())
      const json = (await res.json()) as { results: BrainResult[] }
      setQueryResults(json.results)
    } finally {
      setQueryBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Ingest trigger */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={triggerIngest}
          disabled={ingestBusy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-violet-300 dark:ring-violet-700 bg-white dark:bg-slate-900 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40"
        >
          {ingestBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          Re-index all content
        </button>
        <button
          type="button"
          onClick={() => router.refresh()}
          disabled={ingestBusy}
          className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {ingestResult && (
          <span className="text-xs text-slate-600 dark:text-slate-400">{ingestResult}</span>
        )}
      </div>

      {/* Query test */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <input
            type="text"
            placeholder="Test retrieval query (e.g. 'motorcycle helmet safety comfort')"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runQuery()}
            className="flex-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
          />
          <button
            type="button"
            onClick={runQuery}
            disabled={queryBusy || !query.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-950/40 disabled:opacity-40"
          >
            {queryBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </button>
        </div>

        {queryResults !== null && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
            {queryResults.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-500 text-center">
                No results — run the ingester first to populate the index.
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {queryResults.map((r) => (
                  <li key={r.id} className="px-3 py-2">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900">
                        {r.entityType}
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">{r.field}</span>
                      <span className="ml-auto text-[11px] tabular-nums text-slate-400">
                        dist {Number(r.distance).toFixed(4)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-3">
                      {r.snippet}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
