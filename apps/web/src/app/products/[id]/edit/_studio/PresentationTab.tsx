'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Banner, Card, EmptyState, Field, Listbox, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useSaveReporter, useStudioProduct, useStudioScope } from './contracts'
import { useChannelSheet, commitChannelRow } from './sheet/channel/useChannelSheet'
import { withRowIdentity } from './sheet/channel/rows'
import type { Theme } from '@/app/products/ebay-flat-file/DescriptionStudio/types'
import dynamic from 'next/dynamic'
import { PageHeader } from '@/design-system/patterns'
import styles from '@/app/products/ebay-flat-file/Presentation/presentation.module.css'

const EbayDescriptionStudio = dynamic(() => import('@/app/products/ebay-flat-file/DescriptionStudio').then(m => m.EbayDescriptionStudio), { loading: () => <ProgressBar indeterminate ariaLabel="Loading shared theme editor" /> })
import { fetchJson } from '@/app/products/ebay-flat-file/DescriptionStudio/fetchJson'
import Link from '@/lib/workspaces/Link'
import { OrderEditor } from '@/app/products/ebay-flat-file/Presentation/OrderEditor'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import { PublicationReview } from '@/app/products/ebay-flat-file/Presentation/PublicationReview'
import { useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { presentationListing } from '@/app/products/ebay-flat-file/Presentation/listing-selection'

/** Product presentation consumes the same cells, write routing and version check as the sheet. */
export function PresentationTab() { return <PresentationPage mode="description" /> }
/** Restored by the Owner on 2026-09-12: use the existing alias-scoped order editor. */
export function VariationOrderTab() { return <PresentationPage mode="order" /> }

function PresentationPage({ mode }: { mode: 'description' | 'order' }) {
  const product = useStudioProduct()
  const { market, accountId, locale } = useStudioScope()
  const listing = useSearchParams().get('listing')
  return market ? <EbayPresentation key={JSON.stringify([product.id, market, accountId, locale, listing, mode])} market={market} mode={mode} /> : null
}

function EbayPresentation({ market, mode }: { market: string; mode: 'description' | 'order' }) {
  const product = useStudioProduct()
  const { registerScopeChangeGuard, accountId, accounts, locale, setListing, setTab } = useStudioScope()
  const instanceId = useId()
  const search = useSearchParams()
  const selectedListing = search.get('listing')
  const reporter = useSaveReporter()
  const sheet = useChannelSheet({ productId: product.id, channel: 'EBAY', marketplace: market, accountId })
  const [editorOpen, setEditorOpen] = useState(false)
  const editorOpener = useRef<HTMLButtonElement>(null)
  const [editorPending, setEditorPending] = useState(false)
  const [orderPending, setOrderPending] = useState(false)
  const [publicationOpen, setPublicationOpen] = useState(false)
  const [publicationPending, setPublicationPending] = useState(false)
  const [themes, setThemes] = useState<Theme[]>([])
  const [preview, setPreview] = useState<{ html: string; warnings: string[]; stale: boolean; reasons: string[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  usePresentationNavigationGuard(busy, async () => false)
  useEffect(() => registerScopeChangeGuard(() => {
    if (editorPending || orderPending || publicationPending || busy) { setError('Save or discard your changes before changing the account, market or listing.'); return false }
    return true
  }), [editorPending, orderPending, publicationPending, busy, registerScopeChangeGuard])
  const rows = useMemo(() => sheet.data ? withRowIdentity(sheet.data.rows, sheet.data.aliases) : [], [sheet.data])
  const row = presentationListing(rows, sheet.data?.family.id, selectedListing)
  const aliasKey = row?.aliasId ?? ''
  const destinationAccount = sheet.data?.scope.connectionId ?? accountId
  const selectListing = (alias: string) => {
    if (busy || editorPending || orderPending || publicationPending) return
    const target = presentationListing(rows, sheet.data?.family.id, alias || null)
    if (target?.listing) setListing(target.listing.id)
  }
  const cell = row?.values.descriptionThemeId
  const selection = cell?.inherited ? '__inherit' : typeof cell?.value === 'string' && cell.value ? cell.value : '__inherit'
  useEffect(() => {
    if (mode !== 'description') return
    const controller = new AbortController()
    void fetchJson<{ themes: Theme[] }>(`${getBackendUrl()}/api/ebay/description-themes`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      if (result.ok) setThemes(result.data.themes); else setError(result.error)
    })
    return () => controller.abort()
  }, [refresh, mode])
  useEffect(() => {
    setPreview(null)
    if (mode !== 'description' || !row?.listing || !destinationAccount) return
    const controller = new AbortController()
    setPreviewing(true)
    const params = new URLSearchParams({ productId: row.id, marketplace: market, accountId: destinationAccount, aliasKey })
    void fetchJson<{ html: string; warnings: string[]; stale: boolean; reasons: string[] }>(`${getBackendUrl()}/api/ebay/presentation-description?${params}`, {
      signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) return
      setPreviewing(false)
      if (result.ok) setPreview(result.data); else setError(result.error)
    })
    return () => controller.abort()
  }, [row, market, destinationAccount, aliasKey, refresh, mode])
  const assign = async (theme: string) => {
    if (!row?.listing || !cell?.editable || !destinationAccount || busy) return
    const subject = JSON.stringify(['presentation', product.id, market, accountId ?? null, locale, aliasKey, row.rowId])
    const writeId = `${subject}:${instanceId}:${Date.now()}`
    setBusy(true); setError(null); reporter.pending(writeId, subject)
    try {
      const result = await commitChannelRow({ rowId: row.rowId, row, expectedVersion: row.version,
        cells: [{ colId: 'descriptionThemeId', value: theme === '__inherit' ? null : theme, intent: theme === '__inherit' ? 'reset' : 'set' }] }, { channel: 'EBAY', marketplace: market, accountId: destinationAccount })
      if (!result.ok) throw new Error(result.reason ?? 'The theme assignment was refused. Reload the current listing and try again.')
      reporter.resolved(writeId, true, undefined, subject); sheet.reload()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message); reporter.resolved(writeId, false, message, subject)
    } finally { setBusy(false) }
  }
  if (editorOpen) return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ flex: 1, minHeight: 0 }}><EbayDescriptionStudio open embedded lockMarketplace marketplace={market} accountId={destinationAccount} aliasKey={aliasKey} allowPublish={false} onPendingChange={setEditorPending}
      sampleProductId={row?.id ?? product.id} sampleProductSku={sheet.data?.family.sku ?? product.sku} onClose={() => {
        setEditorOpen(false); setRefresh(n => n + 1); sheet.reload()
        requestAnimationFrame(() => editorOpener.current?.focus({ preventScroll: true }))
      }} /></div>
  </div>
  if (sheet.loading && !sheet.data) return <ProgressBar indeterminate ariaLabel="Loading eBay listing" />
  const selectedAlias = sheet.data?.aliases.find(a => (a.id ?? '') === aliasKey)
  const accountLabel = accounts.find(a => a.id === destinationAccount)?.label ?? destinationAccount
  const title = mode === 'description' ? 'Description themes' : 'Variation order'
  const pending = busy || editorPending || orderPending || publicationPending
  return <div className={styles.page}>
    <header><PageHeader title={title} />
    <p className={styles.intro}>{mode === 'description'
      ? 'Choose how this listing looks to buyers. Each alias can use its own description and theme.'
      : 'Arrange the options buyers see in this listing. Each alias can use its own axis and value order.'}</p></header>
    {(error || sheet.error) && <Banner tone="danger" action={<Button disabled={pending} onClick={() => { setError(null); setRefresh(n => n + 1); sheet.reload() }}>Retry</Button>}>{error || sheet.error}</Banner>}
    {sheet.data && <Card padded>
      <div className={styles.destination}>
        <Field label="Listing alias"><Listbox ariaLabel="Presentation listing" value={row ? aliasKey : undefined} disabled={pending || sheet.loading} onChange={selectListing}
          options={sheet.data.aliases.map(a => ({ value: a.id ?? '', label: a.label || 'Primary listing' }))} /></Field>
        <dl className={styles.facts}>
          <div><dt>Account</dt><dd>{accountLabel}</dd></div>
          <div><dt>Market</dt><dd>{market}</dd></div>
          <div><dt>eBay item</dt><dd>{row?.listing?.externalListingId || 'Not published'}</dd></div>
        </dl>
      </div>
    </Card>}
    {sheet.data && !row && <EmptyState title="Choose an available listing" description="This listing is unavailable in the selected product, account and market. Select an alias above to continue." />}
    {row?.listing && mode === 'order' && (product.isParent || product.parentId
      ? <OrderEditor open embedded productId={row.id} marketplace={market} accountId={destinationAccount} aliasKey={aliasKey}
          onClose={() => setTab('sheet')} onPendingChange={setOrderPending} onSaved={() => void sheet.refresh(() => true)} />
      : <Card><EmptyState title="This product has no variation order" description="Variation order applies to listings with a family of variants. Manage this product’s details in Information." action={<Button onClick={() => setTab('sheet')}>Open listing information</Button>} /></Card>)}
    {row?.listing && mode === 'description' && <div className={styles.descriptionLayout}>
      <div className={styles.stack}>
        <Card header={<span role="heading" aria-level={2} className={styles.sectionTitle}>Theme for this alias</span>}>
          <div className={styles.stack}>
            <Field label="Description theme">
              <Listbox ariaLabel="Description theme" value={selection} disabled={busy || sheet.loading || !cell?.editable}
                options={[{ value: '__inherit', label: 'Inherit rule or default' }, { value: 'none', label: 'No theme · description only' }, ...themes.filter(t => t.active || t.id === selection).map(t => ({ value: t.id, label: `${t.name} · v${t.version}${t.active ? '' : ' · inactive'}`, disabled: !t.active }))]}
                onChange={theme => void assign(theme)} />
            </Field>
            <p>{cell?.inherited ? 'Following the current rule or default.' : 'Customized for this alias.'} Theme selections save automatically.</p>
            {!cell?.editable && <p>The theme is read-only for this listing.</p>}
            {cell?.mapped?.supplyingRule && <p>Supplied by {cell.mapped.supplyingRule.name} · v{cell.mapped.supplyingRule.version}.{' '}
              <Button asChild inline variant="link"><Link href={cell.mapped.supplyingRule.href}>View shared rule</Link></Button>
            </p>}
          </div>
        </Card>
        <Card header={<span role="heading" aria-level={2} className={styles.sectionTitle}>Description text</span>}>
          <div className={styles.stack}>
            <p>Edit the listing’s description in Information. Use a listing override when this alias needs different copy.</p>
            <div><Button disabled={busy} onClick={() => setTab('sheet')}>Edit listing description</Button></div>
          </div>
        </Card>
        <Card header={<span role="heading" aria-level={2} className={styles.sectionTitle}>Shared theme designs</span>}>
          <div className={styles.stack}>
            <p>Editing a theme changes its design for every listing that uses it. Assign separate themes when aliases need independent designs.</p>
            <div><Button ref={editorOpener} disabled={busy} onClick={() => setEditorOpen(true)}>Manage shared themes</Button></div>
          </div>
        </Card>
        <p>Theme selection and publication are separate. Review the saved description before sending it to eBay.</p>
      </div>
      <Card header={<span role="heading" aria-level={2} className={styles.sectionTitle}>Buyer preview</span>} headerAction={<Button disabled={busy || previewing} onClick={() => setRefresh(n => n + 1)}>Refresh</Button>}>
        <div className={styles.stack}>
          <p>{selectedAlias?.label || 'Primary listing'} · {accountLabel} · {market}</p>
          {previewing && <ProgressBar indeterminate ariaLabel="Rendering description preview" />}
          {preview && <>
            <p role="status">{preview.stale ? preview.reasons.join(' · ') : 'Matches the recorded description publication.'}</p>
            {preview.warnings.map((warning, index) => <Banner key={`${index}:${warning}`} tone="warning">{warning}</Banner>)}
            <iframe title="Buyer-facing eBay description" sandbox="" srcDoc={preview.html} className={styles.preview} />
          </>}
          {!preview && !previewing && <EmptyState title="Preview unavailable" description="Resolve the listing message above, then refresh the preview." />}
          <div className={styles.actions}><Button variant="primary" disabled={busy || previewing || !preview} onClick={() => setPublicationOpen(true)}>Review description publication</Button></div>
        </div>
      </Card>
    </div>}
    {publicationOpen && row?.listing && <PublicationReview productId={row.id} marketplace={market} accountId={destinationAccount} aliasKey={aliasKey} operation="description" onClose={() => { setPublicationOpen(false); setRefresh(n => n + 1) }} onPendingChange={setPublicationPending} />}
  </div>
}
