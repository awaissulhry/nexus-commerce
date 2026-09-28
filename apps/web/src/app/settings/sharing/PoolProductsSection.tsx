'use client'

/**
 * The product switch (plan docs/2026-09-19-shared-stock-plan.md §4, switch 2): the products the lender
 * shared with this business, which stock each one uses now, and a switch to the shared stock or back to
 * this business's own stock. Before any switch the preview shows the exact number each listing will
 * show afterwards (API: the derivation core on the ledger the product would follow). All or nothing: if
 * one product cannot switch, the preview says which and why, and nothing is switched.
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, EmptyState, Modal } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { AliasMark, Button, Pill } from '@/design-system/primitives'
import { sharingApi } from './sharingApi'
import type { Grant, ListingPreview, PoolProduct, SwitchPreview } from './stockPoolApi'
import { COST_PRICE_MISSING, listingNameParts, previewRuleWords } from './stockWords'
import { count } from './words'

type Target = 'pool' | 'own'

export function PoolProductsSection({ grant, canAct, onChanged }: { grant: Grant; canAct: boolean; onChanged: () => Promise<void> }) {
  const [products, setProducts] = useState<PoolProduct[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [switching, setSwitching] = useState<{ to: Target; productIds: string[] } | null>(null)

  const load = useCallback(async (after?: string) => {
    setError(null)
    try {
      const page = await sharingApi<{ products: PoolProduct[]; nextCursor: string | null }>(
        `stock-pool/products?grantId=${encodeURIComponent(grant.id)}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`)
      setProducts((current) => after && current ? [...current, ...page.products] : page.products)
      setCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The shared products could not be loaded.')
    }
  }, [grant.id])
  useEffect(() => { void load() }, [load])

  if (error) return <Banner tone="danger" action={<Button onClick={() => { void load() }}>Retry</Button>}>{error}</Banner>
  if (!products) return <p role="status" className="shared-products-note">Loading the products {grant.ownerWorkspaceName} shared…</p>
  if (products.length === 0) return <EmptyState title="No shared products yet"
    description={`Only products ${grant.ownerWorkspaceName} shared with this business, and that were copied or linked here, can use this stock.`} />

  const chosen = products.filter((p) => selected.has(p.productId))
  const toPool = chosen.filter((p) => p.source === 'own').map((p) => p.productId)
  const toOwn = chosen.filter((p) => p.source === 'pool' && p.grantId === grant.id).map((p) => p.productId)
  const poolOn = grant.status === 'active'

  const columns: Array<Column<PoolProduct>> = [
    { key: 'product', label: 'Product', render: (p) => <span><strong>{p.sku}</strong>{p.name && p.name !== p.sku ? <span className="shared-products-note"> · {p.name}</span> : null}</span> },
    { key: 'uses', label: 'Stock used', render: (p) => p.source === 'pool' ? <Pill tone="info">Shared stock</Pill> : <Pill tone="neutral">Own stock</Pill> },
    { key: 'own', label: 'Own available', numeric: true, render: (p) => p.ownAvailable.toLocaleString() },
    { key: 'pool', label: 'Shared available', numeric: true, render: (p) => p.poolAvailable === null ? 'Not on' : p.poolAvailable.toLocaleString() },
    { key: 'cost', label: 'Cost price', render: (p) => p.costPriceMissing ? <Pill tone="warning">Missing</Pill> : 'Set' },
  ]

  return <div className="shared-stock-products">
    <h4 className="shared-stock-subheading">Products that can use this stock</h4>
    {canAct && <div className="business-profile-actions">
      {chosen.length === 0 && <p className="shared-products-note">Choose products to switch them.</p>}
      {toPool.length > 0 && (poolOn
        ? <Button variant="primary" onClick={() => setSwitching({ to: 'pool', productIds: toPool })}>Use shared stock for {count(toPool.length, 'product')}</Button>
        : <p className="shared-products-note">This shared stock is paused: products can switch to it again when {grant.ownerWorkspaceName} resumes it.</p>)}
      {toOwn.length > 0 && <Button onClick={() => setSwitching({ to: 'own', productIds: toOwn })}>Use own stock for {count(toOwn.length, 'product')}</Button>}
    </div>}
    <DataGrid maxHeight={420} ariaLabel={`Products shared by ${grant.ownerWorkspaceName}`} columns={columns} rows={products} rowKey={(p) => p.productId}
      selectable={canAct} selected={selected} onSelectedChange={setSelected}
      selectAllHint="Choose every product in this list" selectRowHint="Choose this product" />
    {cursor && <div className="business-profile-actions"><Button onClick={() => { void load(cursor) }}>Show more products</Button></div>}
    {products.some((p) => p.costPriceMissing) && <p className="shared-products-note">{COST_PRICE_MISSING}</p>}
    {switching && <SwitchPreviewModal grant={grant} to={switching.to} productIds={switching.productIds}
      onClose={() => setSwitching(null)}
      onSwitched={async () => { setSwitching(null); setSelected(new Set()); await Promise.all([load(), onChanged()]) }} />}
  </div>
}

function SwitchPreviewModal({ grant, to, productIds, onClose, onSwitched }: {
  grant: Grant; to: Target; productIds: string[]; onClose: () => void; onSwitched: () => Promise<void>
}) {
  const [preview, setPreview] = useState<SwitchPreview[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setError(null)
    try { setPreview((await sharingApi<{ products: SwitchPreview[] }>('stock-pool/products/preview', { productIds, to, grantId: grant.id })).products) }
    catch (err) { setError(err instanceof Error ? err.message : 'The preview could not be worked out.') }
  }, [productIds, to, grant.id])
  useEffect(() => { void load() }, [load])

  async function run() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await sharingApi('stock-pool/products/switch', { productIds, to, grantId: grant.id })
      await onSwitched()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The products could not be switched.')
      setBusy(false)
    }
  }

  const refused = (preview ?? []).filter((p) => p.refusal)
  const title = to === 'pool' ? `Use ${grant.ownerWorkspaceName}’s stock` : 'Use this business’s own stock'
  const columns: Array<Column<ListingPreview>> = [
    { key: 'listing', label: 'Listing', render: (row) => {
      const { head, name } = listingNameParts(row)
      return <>{head}{name !== null && <> · {row.listingMark != null && !row.itemId && <><AliasMark position={row.listingMark} /> </>}{name}</>}</>
    } },
    { key: 'now', label: 'Shows now', numeric: true, render: (row) => row.showsNow === null ? '—' : row.showsNow.toLocaleString() },
    { key: 'after', label: 'After the switch', render: (row) => previewRuleWords(row) },
  ]
  return <Modal open onClose={() => { if (!busy) onClose() }} size="lg" title={title}
    subtitle={to === 'pool'
      ? 'Each listing that follows stock will show the shared number. Orders then take from the shared stock and ship from its warehouse.'
      : 'Each listing that follows stock will show this business’s own number. A product never counted here shows 0, never the shared number.'}
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button>
      {preview && refused.length === 0 && <Button variant="primary" disabled={busy} onClick={() => { void run() }}>{busy ? 'Switching…' : `Switch ${count(preview.length, 'product')}`}</Button>}</>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger" action={preview ? undefined : <Button onClick={() => { void load() }}>Retry</Button>}>{error}</Banner>}
      {!preview && !error && <p role="status" className="shared-products-note">Working out the number each listing will show…</p>}
      {refused.length > 0 && <Banner tone="warning" title={`${count(refused.length, 'product')} cannot switch`}>
        Nothing is switched while one product cannot. Choose again without {refused.length === 1 ? 'it' : 'them'}: {refused.map((p) => `${p.sku} — ${p.refusal}`).join(' · ')}
      </Banner>}
      {preview?.filter((p) => !p.refusal).map((p) => <section key={p.productId} className="shared-stock-preview" aria-label={`Listings of ${p.sku}`}>
        <h4 className="shared-stock-subheading">{p.sku}{p.costPriceMissing && <> <Pill tone="warning">No cost price</Pill></>}</h4>
        {p.listings.length === 0
          ? <p className="shared-products-note">No live listing: nothing changes on any channel.</p>
          : <DataGrid maxHeight={320} ariaLabel={`Listings of ${p.sku}`} columns={columns} rows={p.listings} rowKey={(row) => `${row.listingId ?? row.itemId}:${row.channel}:${row.marketplace}`} />}
      </section>)}
    </div>
  </Modal>
}
