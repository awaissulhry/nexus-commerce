'use client'

/**
 * ADS AUTONOMY W1-4 — pick a category or a product to give its own strategy in this market. Search, arrows, Enter;
 * Escape or Cancel closes. A category or product that already has a row here is shown and held. Nothing is saved here:
 * the tab opens the picked scope with every field inherited, and its first save creates the row.
 */
import { useEffect, useMemo, useState } from 'react'
import { AsyncListboxPanel, Modal } from '@/design-system/components'
import { catalogApi, type CategoryNode } from './strategyApi'
import { categoryChoices } from './strategyWords'
import styles from './strategy.module.css'

export interface AddScopeDialogProps {
  kind: 'CATEGORY' | 'PRODUCT' | null
  market: string
  /** The categories or products that already have a row in this market. */
  taken: ReadonlySet<string>
  onPick: (scope: { level: 'CATEGORY' | 'PRODUCT'; id: string; label: string }) => void
  onClose: () => void
}

export function AddScopeDialog({ kind, market, taken, onPick, onClose }: AddScopeDialogProps) {
  const [query, setQuery] = useState('')
  const [tree, setTree] = useState<CategoryNode[] | null>(null)
  const [products, setProducts] = useState<Array<{ id: string; sku: string; name: string | null }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => { setQuery(''); setError(null) }, [kind])

  // Categories: the whole tree once; the search filters it here.
  useEffect(() => {
    if (kind !== 'CATEGORY' || tree) return
    let alive = true
    setLoading(true)
    catalogApi.categories()
      .then((t) => { if (alive) { setTree(t); setError(null) } })
      .catch((e: unknown) => { if (alive) setError(`The categories could not be read (${(e as Error).message}).`) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [kind, tree, attempt])

  // Products: searched on the server, 250 ms after the last key.
  useEffect(() => {
    if (kind !== 'PRODUCT') return
    const term = query.trim()
    if (!term) { setProducts([]); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      catalogApi.products(term, controller.signal)
        .then((items) => { setProducts(items); setError(null) })
        .catch((e: unknown) => { if (!controller.signal.aborted) setError(`The products could not be searched (${(e as Error).message}).`) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [kind, query, attempt])

  const options = useMemo(() => {
    if (kind === 'CATEGORY') {
      const all = categoryChoices(tree ?? [], taken)
      const q = query.trim().toLowerCase()
      return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
    }
    return products.map((p) => ({
      value: p.id,
      label: p.name ? `${p.sku} — ${p.name}` : p.sku,
      ...(taken.has(p.id) ? { disabled: true, trailing: 'has a strategy here' } : {}),
    }))
  }, [kind, tree, products, taken, query])

  const pick = (id: string) => {
    const option = options.find((o) => o.value === id)
    if (!option || !kind) return
    onPick({ level: kind, id, label: kind === 'PRODUCT' ? option.label.split(' — ')[0] : option.label })
  }

  return (
    <Modal open={!!kind} onClose={onClose} size="md" title={kind === 'CATEGORY' ? `Add a category in ${market}` : `Add a product in ${market}`}
      subtitle={kind === 'CATEGORY' ? 'It covers every product filed under it, and under the categories below it.' : 'A parent product covers its variations.'}>
      <div className={styles.addBody}>
        <AsyncListboxPanel
          label={kind === 'CATEGORY' ? 'Category' : 'Product'}
          placeholder={kind === 'CATEGORY' ? 'Search by name' : 'Search by SKU or name'}
          query={query} onQueryChange={setQuery} options={options} loading={loading} error={error ?? undefined}
          emptyMessage={kind === 'PRODUCT' && !query.trim() ? 'Type a SKU or a name.' : 'No matches.'}
          onRetry={error ? () => { setError(null); setTree(null); setAttempt((n) => n + 1) } : undefined}
          onCommit={pick} onCancel={onClose}
        />
      </div>
    </Modal>
  )
}
