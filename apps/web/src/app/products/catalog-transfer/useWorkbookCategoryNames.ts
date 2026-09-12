'use client'
import { useEffect, useState } from 'react'
import type { TransferOptions } from './sourceMapping'
import { destinationCategories, type WorkbookDestination } from './workbookSelection'
import { transferApi } from './transferApi'

/** Enrich only selected eBay markets, using the platform's existing taxonomy cache. */
export function useWorkbookCategoryNames(options: TransferOptions, destinations: WorkbookDestination[]) {
  const markets = new Map<string, string[]>()
  for (const d of destinations) if (d.marketplace && options.accounts.find(a => a.id === d.accountId)?.channelType === 'EBAY') markets.set(d.marketplace, destinationCategories(options, d).sort())
  const query = JSON.stringify([...markets.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ query: string; labels: Record<string, Record<string, string>>; failed: boolean; loading: boolean }>({ query: '', labels: {}, failed: false, loading: false })
  useEffect(() => {
    const abort = new AbortController()
    const selected = JSON.parse(query) as [string, string[]][]
    if (!selected.length) return
    setResult({ query, labels: {}, failed: false, loading: true })
    const requests = selected.flatMap(([market, ids]) => Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ({ market, ids: ids.slice(i * 200, (i + 1) * 200) })))
    void Promise.allSettled(requests.map(async ({ market, ids }) => {
      const body = await transferApi<{ breadcrumbs: Record<string, { local?: string }> }>(`ebay/flat-file/category-breadcrumbs?${new URLSearchParams({ ids: ids.join(','), marketplace: market })}`, undefined, abort.signal)
      return { market, labels: Object.fromEntries(Object.entries(body.breadcrumbs ?? {}).flatMap(([id, value]) => value.local ? [[id, value.local]] : [])) }
    })).then(results => {
      if (abort.signal.aborted) return
      const labels: Record<string, Record<string, string>> = {}
      for (const result of results) if (result.status === 'fulfilled') labels[result.value.market] = { ...labels[result.value.market], ...result.value.labels }
      const missing = selected.some(([market, ids]) => ids.some(id => !labels[market]?.[id]))
      setResult({ query, labels, failed: results.some(r => r.status === 'rejected') || missing, loading: false })
    })
    return () => abort.abort()
  }, [query, attempt])
  return { labels: result.query === query ? result.labels : {}, loading: !!markets.size && (result.query !== query || result.loading), failed: result.query === query && result.failed, retry: () => setAttempt(n => n + 1) }
}
