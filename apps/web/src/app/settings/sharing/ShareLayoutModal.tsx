'use client'

/**
 * Sharing studio step 3 — the listing layout of EVERY product of an incoming share, made here as drafts: one choice
 * per channel and account of the business that shares (never its account names or ids), on accounts of this business.
 * The product studio's "Other businesses" page does the same for one product.
 */
import { useEffect, useState } from 'react'
import { Banner, Listbox, Modal, ProgressBar } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { accountOptions, shareLayoutRowWords, shareMadeWords, type FollowerAccount, type ShareLayoutGroup } from './layoutWords'
import { sharingApi, type Share } from './sharingApi'

interface Layout { groups: ShareLayoutGroup[]; accounts: Record<string, FollowerAccount[]> }
interface Made { products: number; listings: number; aliases: number; refused: Array<{ productId: string; sku: string; reason: string }> }

export function ShareLayoutModal({ share, onClose }: { share: Share; onClose: () => void }) {
  const [layout, setLayout] = useState<Layout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setError(null)
    sharingApi<Layout>(`assortment-shares/${encodeURIComponent(share.id)}/layout`, undefined, abort.signal)
      .then((value) => { setLayout(value); setChoice(Object.fromEntries(value.groups.map((g) => [g.key, g.suggestedAccountId ?? '']))) })
      .catch((err: unknown) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'The listing layout could not be read.') })
    return () => abort.abort()
  }, [share.id, attempt])

  async function run() {
    if (!layout || busy) return
    setBusy(true); setError(null)
    try {
      setMade(await sharingApi<Made>(`assortment-shares/${encodeURIComponent(share.id)}/layout`, { choices: layout.groups.map((g) => ({ key: g.key, accountId: choice[g.key] || null })) }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The drafts could not be made.')
    } finally {
      setBusy(false)
    }
  }

  const chosen = layout?.groups.filter((g) => choice[g.key]) ?? []
  const columns: Array<Column<ShareLayoutGroup>> = [
    { key: 'place', label: `In ${share.ownerWorkspaceName}`, render: (g) => shareLayoutRowWords(g, share.ownerWorkspaceName).place },
    { key: 'detail', label: 'Listed', render: (g) => shareLayoutRowWords(g, share.ownerWorkspaceName).detail },
    { key: 'account', label: 'Make it on', render: (g) => (layout?.accounts[g.channel] ?? []).length
      ? <Listbox size="sm" ariaLabel={`Account for ${shareLayoutRowWords(g, share.ownerWorkspaceName).place}`} value={choice[g.key] ?? ''} disabled={busy || !!made}
          options={accountOptions(layout?.accounts[g.channel] ?? [])} onChange={(value) => setChoice((prev) => ({ ...prev, [g.key]: value }))} width="100%" />
      : <span className="shared-products-note">No account for this channel here. Connect one in Settings › Channels.</span> },
  ]
  const result = made ? shareMadeWords(made) : null
  return <Modal open onClose={() => { if (!busy) onClose() }} size="xl" title={`Make draft listings: ${share.assortmentName ?? 'shared products'}`}
    subtitle={`Make the listings ${share.ownerWorkspaceName} has for these products here, on this business’s own accounts. The main listing and each alias are drafts: nothing is sent until you publish.`}
    footer={made
      ? <Button variant="primary" onClick={onClose}>Done</Button>
      : <><Button disabled={busy} onClick={onClose}>Cancel</Button>
        {layout && chosen.length > 0 && <Button variant="primary" disabled={busy} onClick={() => { void run() }}>{busy ? 'Making drafts…' : `Make drafts on ${chosen.length === 1 ? '1 account' : `${chosen.length} accounts`}`}</Button>}</>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger" action={layout ? undefined : <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{error}</Banner>}
      {!layout && !error && <ProgressBar indeterminate ariaLabel={`Reading where ${share.ownerWorkspaceName} lists these products`} />}
      {result && <div role="status"><Banner tone={result.refused.length ? 'warning' : 'success'} title={result.text}>
        {result.refused.map((line) => <p key={line} className="shared-products-note">{line}</p>)}
      </Banner></div>}
      {layout && (layout.groups.length === 0
        ? <p className="shared-products-note">{share.ownerWorkspaceName} does not list the linked products on any channel yet. Copy products first, if none are linked.</p>
        : <DataGrid maxHeight={420} ariaLabel="Where the other business lists these products" columns={columns} rows={layout.groups} rowKey={(g) => g.key} />)}
      {layout && layout.groups.length > 0 && chosen.length === 0 && !made && <p className="shared-products-note">Choose an account for at least one row to make drafts.</p>}
    </div>
  </Modal>
}
