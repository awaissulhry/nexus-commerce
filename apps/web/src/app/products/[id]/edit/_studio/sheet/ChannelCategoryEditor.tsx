'use client'
import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Button } from '@/design-system/primitives'
import { categoryHref } from '@/app/catalog/categories/api'
import { AsyncListboxPanel } from '@/design-system/components'
import { loadCategoryOptions, type CategoryOption } from './categoryOptions'

export function ChannelCategoryEditor({ value, onValueChange, channel, market, accountId, stopEditing }: {
  value: unknown; onValueChange: (value: unknown) => void; channel: 'AMAZON' | 'EBAY' | 'ETSY'; market: string; accountId?: string; stopEditing: (cancel?: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const remoteQuery = query.trim()
  const key = JSON.stringify([channel, market, accountId, remoteQuery, revision])
  const needsSearch = channel !== 'AMAZON' && remoteQuery.length < 2
  const [result, setResult] = useState<{ key: string; items: CategoryOption[]; error?: string }>({ key: '', items: [] })
  const loading = !needsSearch && result.key !== key
  const error = result.key === key ? result.error : undefined
  const items = result.key === key ? result.items : []
  const matches = items

  useEffect(() => {
    if (needsSearch) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void loadCategoryOptions(channel, market, remoteQuery, abort.signal, revision > 0, accountId)
        .then(items => { if (!abort.signal.aborted) setResult({ key, items }) })
        .catch(error => { if (!abort.signal.aborted) setResult({ key, items: [], error: error.message }) })
    }, 250)
    return () => { clearTimeout(timer); abort.abort() }
  }, [channel, market, accountId, remoteQuery, revision, key, needsSearch])

  const cancel = () => stopEditing(true)
  const commit = (chosen: string) => {
    if (chosen === String(value ?? '')) return cancel()
    onValueChange(channel === 'ETSY' ? Number(chosen) : chosen)
    stopEditing()
  }
  return <div><AsyncListboxPanel label={channel === 'EBAY' ? 'Search eBay categories' : channel === 'ETSY' ? 'Search Etsy categories' : 'Search Amazon product types'}
    query={query} onQueryChange={setQuery} options={matches} value={value == null ? '' : String(value)}
    loading={loading} error={error} placeholder={channel !== 'AMAZON' ? 'Enter at least 2 characters' : 'Search by name or code'}
    message={matches.length === 50 ? 'Showing the first 50 matches. Refine your search to narrow the list.' : undefined}
    emptyMessage={needsSearch ? 'Enter at least 2 characters to find a category.' : 'No categories match your search.'}
    onRetry={error ? () => setRevision(value => value + 1) : undefined} onCancel={cancel} onCommit={commit}
    style={{ width: 'min(480px, 85vw)' }} /><Button asChild size="xs" variant="link"><Link href={categoryHref('assignments', { channel, market })} onClick={cancel}>Manage categories</Link></Button></div>
}
