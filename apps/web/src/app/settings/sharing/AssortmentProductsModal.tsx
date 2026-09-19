'use client'

/**
 * The products of one assortment: listed ones, or the excluded ones of an "every product" assortment.
 * Adds and removes one product at a time, each sending the version it read, so two people editing the
 * same assortment never overwrite each other silently (a 409 reloads and says so).
 */
import { useCallback, useEffect, useState } from 'react'
import { AsyncListboxPanel, Banner, Modal } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { sharingApi, SharingError, type Assortment, type AssortmentMember } from './sharingApi'
import { count, dateWords } from './words'

type Choice = { id: string; sku: string; title: string }
const PAGE = 100

export function AssortmentProductsModal({ assortment, canEdit, onClose }: { assortment: Assortment; canEdit: boolean; onClose: () => void }) {
  const list = assortment.selection === 'list'
  const [members, setMembers] = useState<AssortmentMember[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [version, setVersion] = useState(assortment.version)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const loadFirst = useCallback(async () => {
    setError(null)
    try {
      const page = await sharingApi<{ members: AssortmentMember[]; nextCursor: string | null }>(`assortments/${encodeURIComponent(assortment.id)}/members?take=${PAGE}`)
      setMembers(page.members); setNextCursor(page.nextCursor)
    } catch (err) { setError(err instanceof Error ? err.message : 'The products could not be loaded.') }
  }, [assortment.id])
  useEffect(() => { void loadFirst() }, [loadFirst])

  async function loadMore() {
    if (!nextCursor || busy) return
    setBusy('more')
    try {
      const page = await sharingApi<{ members: AssortmentMember[]; nextCursor: string | null }>(`assortments/${encodeURIComponent(assortment.id)}/members?take=${PAGE}&cursor=${encodeURIComponent(nextCursor)}`)
      setMembers((current) => [...(current ?? []), ...page.members]); setNextCursor(page.nextCursor)
    } catch (err) { setError(err instanceof Error ? err.message : 'More products could not be loaded.') }
    finally { setBusy(null) }
  }

  /** A stale version means someone else changed the assortment: reload, and say so. */
  async function change(kind: 'add' | 'remove', productId: string, sku: string) {
    if (busy) return
    setBusy(productId); setError(null); setStatus('')
    try {
      const result = await sharingApi<{ version: number; added?: number; alreadyMembers?: number; removed?: number }>(
        `assortments/${encodeURIComponent(assortment.id)}/members/${kind}`, { productIds: [productId], expectedVersion: version })
      setVersion(result.version)
      setStatus(kind === 'add'
        ? (result.added ? `${sku} ${list ? 'added' : 'excluded'}.` : `${sku} was already ${list ? 'in this assortment' : 'excluded'}.`)
        : `${sku} ${list ? 'removed' : 'no longer excluded'}.`)
      await loadFirst()
    } catch (err) {
      if (err instanceof SharingError && err.code === 'assortment_changed') {
        setError('Someone else changed this assortment. The list is reloaded; try again.')
        const fresh = (await sharingApi<{ assortments: Assortment[] }>('assortments').catch(() => null))?.assortments.find((row) => row.id === assortment.id)
        if (fresh) setVersion(fresh.version)
        await loadFirst()
      } else setError(err instanceof Error ? err.message : 'That change could not be saved.')
    } finally { setBusy(null) }
  }

  const columns: Array<Column<AssortmentMember>> = [
    { key: 'sku', label: 'SKU', render: (row) => row.sku },
    { key: 'name', label: 'Product', render: (row) => row.name },
    { key: 'added', label: list ? 'Added' : 'Excluded', render: (row) => dateWords(row.addedAt) },
    ...(canEdit ? [{ key: 'action', label: 'Action', render: (row: AssortmentMember) => <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => { void change('remove', row.productId, row.sku) }}>{list ? 'Remove' : 'Include again'}</Button> }] : []),
  ]

  return <Modal open onClose={() => { if (!busy) onClose() }} size="xl"
    title={list ? `Products in ${assortment.name}` : `Products excluded from ${assortment.name}`}
    subtitle={list ? 'Only these products and their variations are shared.' : 'Every other product and its variations is shared.'}
    footer={<Button onClick={onClose} disabled={busy !== null}>Done</Button>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      <p role="status" className="shared-products-note">{status || (members ? `${count(members.length, 'product')} shown${nextCursor ? ', more below' : ''}.` : 'Loading products…')}</p>
      {canEdit && (adding
        ? <ProductPicker label={list ? 'Add a product' : 'Exclude a product'} exclude={new Set((members ?? []).map((row) => row.productId))}
          onPick={(choice) => { void change('add', choice.id, choice.sku) }} onDone={() => setAdding(false)} busy={busy !== null} />
        : <div className="business-profile-actions"><Button variant="primary" onClick={() => setAdding(true)}>{list ? 'Add a product' : 'Exclude a product'}</Button></div>)}
      {members && <DataGrid ariaLabel={list ? 'Products in this assortment' : 'Excluded products'} columns={columns} rows={members} rowKey={(row) => row.productId}
        emptyState={<p>{list ? 'No products yet. Variations follow their parent, so add the parent product.' : 'No products are excluded.'}</p>} />}
      {nextCursor && <div className="business-profile-actions"><Button disabled={busy !== null} onClick={() => { void loadMore() }}>{busy === 'more' ? 'Loading…' : 'Show more'}</Button></div>}
    </div>
  </Modal>
}

/** Top-level products only (a variation follows its parent), searched by SKU or name. */
function ProductPicker({ label, exclude, onPick, onDone, busy }: { label: string; exclude: Set<string>; onPick: (choice: Choice) => void; onDone: () => void; busy: boolean }) {
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ choices: Choice[]; error?: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    setResult(null)
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${getBackendUrl()}/api/products/lookup?${new URLSearchParams({ q: query, limit: '50' })}`, { cache: 'no-store', signal: abort.signal })
        const body = await response.json()
        if (!response.ok || !Array.isArray(body.items)) throw new Error('Products could not be loaded. Try again.')
        if (!cancelled) setResult({ choices: body.items.map((item: { id: string; sku: string; title: string }) => ({ id: item.id, sku: item.sku, title: item.title })) })
      } catch {
        if (!cancelled && !abort.signal.aborted) setResult({ choices: [], error: 'Products could not be loaded. Try again.' })
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(timer); abort.abort() }
  }, [query, attempt])
  return <div className="shared-products-picker">
    <AsyncListboxPanel label={label} query={query} onQueryChange={(value) => setQuery(value)} placeholder="Search by SKU or product name"
      loading={!result || busy} error={result?.error} emptyMessage="No product matches this search."
      message={result && result.choices.length === 50 ? 'Showing the first 50 matches. Type more of the SKU or name to narrow them.' : undefined}
      options={(result?.choices ?? []).map((choice) => ({ value: choice.id, label: choice.sku, trailing: exclude.has(choice.id) ? 'Already listed' : choice.title, title: `${choice.sku} · ${choice.title}`, disabled: exclude.has(choice.id) }))}
      onRetry={() => setAttempt((n) => n + 1)} onCancel={onDone}
      onCommit={(id) => { const choice = result?.choices.find((item) => item.id === id); if (choice && !exclude.has(id)) onPick(choice) }} />
  </div>
}
