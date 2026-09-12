'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AsyncListboxPanel, Modal } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'

export type FamilyChoice = { id: string; sku: string; name?: string | null; unavailable?: string }
type Request = { kind: 'parent' | 'standalone'; exclude: string[]; resolve: (choice: FamilyChoice | null) => void }

export function useFamilyProductPicker(productId: string) {
  const [request, setRequest] = useState<Request | null>(null)
  const pending = useRef<Request | null>(null)
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ choices: FamilyChoice[]; more?: boolean; error?: string } | null>(null)
  const finish = useCallback((choice: FamilyChoice | null) => {
    pending.current?.resolve(choice)
    pending.current = null
    setRequest(null)
  }, [])
  useEffect(() => {
    setRequest(null)
    return () => { pending.current?.resolve(null); pending.current = null }
  }, [productId])
  const pick = useCallback((kind: Request['kind'], exclude: string[]) => new Promise<FamilyChoice | null>(resolve => {
    pending.current?.resolve(null)
    const next = { kind, exclude, resolve }
    pending.current = next
    setQuery(''); setResult(null); setRequest(next)
  }), [])
  useEffect(() => {
    if (!request) return
    let cancelled = false
    const abort = new AbortController()
    setResult(null)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ kind: request.kind, search: query, exclude: request.exclude.join(',') })
        const response = await fetch(`${getBackendUrl()}/api/pim/relationship-choices?${params}`, {
          credentials: 'include', cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        })
        const body = await response.json()
        if (!response.ok || !Array.isArray(body.items)) throw new Error('Could not load products. Try again.')
        if (!cancelled) setResult({ choices: body.items, more: body.more === true })
      } catch {
        if (!cancelled) setResult({ choices: [], error: 'Could not load products. Try again.' })
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(timer); abort.abort() }
  }, [request, query, retry])
  const element = request && <Modal open title={request.kind === 'parent' ? 'Choose a parent' : 'Choose a standalone product'} size="md" onClose={() => finish(null)}>
    <AsyncListboxPanel label="Find a product" query={query} onQueryChange={value => { setResult(null); setQuery(value) }}
      loading={!result} error={result?.error} placeholder="Search by SKU or name"
      emptyMessage="No eligible products match this search."
      message={result?.more ? 'Showing the first 50 matches. Refine your search to find another product.' : undefined}
      options={(result?.choices ?? []).map(choice => ({ value: choice.id, label: choice.sku, trailing: choice.unavailable ?? choice.name ?? undefined, title: [choice.sku, choice.unavailable ?? choice.name].filter(Boolean).join(' · '), disabled: !!choice.unavailable }))}
      onRetry={() => { setResult(null); setRetry(value => value + 1) }} onCancel={() => finish(null)}
      onCommit={id => { const choice = result?.choices.find(item => item.id === id && !item.unavailable); if (choice) finish(choice) }} />
  </Modal>
  return { pick, element }
}
