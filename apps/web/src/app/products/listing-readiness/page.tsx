'use client'

import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import type { ListingReadinessPage, ListingReadinessRow } from '@nexus/shared/listing-readiness'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Button, Textarea } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, Listbox, MetricStrip, Pagination } from '@/design-system/components'
import type { TransferOptions } from '../catalog-transfer/sourceMapping'
import { transferApi } from '../catalog-transfer/transferApi'
import { channelName, languageName } from '../catalog-transfer/workbookSelection'
import styles from './readiness.module.css'

type Selection = { familyId?: string; productIds?: string; listingIds?: string; job?: string; skus?: string }
type Request = Selection & { accountId?: string; marketplace?: string; page: string }
const stateLabel = { 'needs-attention': 'Needs attention', 'checks-passed': 'Local checks passed', unavailable: 'Checks incomplete' }
const issueLabel = { missing: 'Missing fact', invalid: 'Invalid value', translation: 'Translation needed', schema: 'Requirements unavailable', account: 'Destination setup', check: 'Check incomplete', warning: 'Review warning' }
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

export default function ListingReadiness() {
  const [options, setOptions] = useState<TransferOptions | null>(null), [optionsError, setOptionsError] = useState(''), [optionsAttempt, setOptionsAttempt] = useState(0)
  const [selection, setSelection] = useState<Selection>({}), [selectionMode, setSelectionMode] = useState('family')
  const [accountId, setAccountId] = useState(''), [marketplace, setMarketplace] = useState('')
  const [request, setRequest] = useState<Request | null>(null), [result, setResult] = useState<ListingReadinessPage | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initial: Selection = Object.fromEntries(['familyId', 'productIds', 'listingIds', 'job', 'skus'].filter(key => params.has(key)).map(key => [key, params.get(key)!]))
    if (Object.keys(initial).length) {
      let readableSkus = initial.skus
      try { const parsed: unknown = JSON.parse(initial.skus ?? 'null'); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) readableSkus = parsed.join('\n') } catch { /* Single-SKU bookmark. */ }
      setSelection({ ...initial, ...(readableSkus !== undefined ? { skus: readableSkus } : {}) }); setSelectionMode(initial.job || initial.productIds || initial.listingIds ? 'selection' : initial.skus ? 'skus' : 'family')
      setAccountId(params.get('accountId') ?? ''); setMarketplace(params.get('marketplace') ?? '')
      setRequest({ ...initial, accountId: params.get('accountId') ?? undefined, marketplace: params.get('marketplace') ?? undefined, page: params.get('page') ?? '1' })
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController(); setOptionsError('')
    void transferApi<TransferOptions>('catalog-transfer/readiness/options', undefined, abort.signal).then(value => { if (!abort.signal.aborted) setOptions(value) })
      .catch(e => { if (!abort.signal.aborted) setOptionsError(e.message) })
    return () => abort.abort()
  }, [optionsAttempt])
  useEffect(() => {
    if (!request) return
    const abort = new AbortController(); setLoading(true); setResult(null); setError('')
    const params = new URLSearchParams(Object.entries(request).filter((entry): entry is [string, string] => !!entry[1]))
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    void transferApi<ListingReadinessPage>(`catalog-transfer/readiness?${params}`, undefined, abort.signal)
      .then(value => { if (!abort.signal.aborted) setResult(value) })
      .catch(e => { if (!abort.signal.aborted) setError(e.message) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [request])
  const clearCheck = () => { setRequest(null); setResult(null); setError(''); setLoading(false) }
  const check = () => setRequest({ ...selection, ...(selection.skus ? { skus: JSON.stringify(selection.skus.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) } : {}), accountId: accountId || undefined, marketplace: marketplace || undefined, page: '1' })
  const chosenAccount = options?.accounts.find(a => a.id === accountId)
  const markets = [...new Map((options?.markets ?? []).filter(m => ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'].includes(m.channel) && (!chosenAccount || m.channel === chosenAccount.channelType && (!chosenAccount.marketplace || chosenAccount.marketplace === 'GLOBAL' || chosenAccount.marketplace === m.code))).map(m => [m.code, m])).values()]
  const groups = new Map<string, ListingReadinessRow[]>()
  for (const row of result?.rows ?? []) {
    const key = JSON.stringify([row.channel, row.marketplace, row.accountId])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  return <div className={styles.workspace}>
    <PageHeader eyebrow="Products" title="Listing readiness" subtitle="Find what needs attention for each seller account and marketplace." actions={<>
      <Button asChild><Link href="/products/catalog-transfer">Import &amp; export</Link></Button>
      <Button asChild><Link href="/products">Back to products</Link></Button>
    </>} />
    <Card header={<h2>Choose products to check</h2>} description="Checks saved Amazon and eBay listings, including drafts. Shared facts are reused; each destination keeps its own category and language.">
      <form className={styles.stack} onSubmit={e => { e.preventDefault(); check() }}>
        {optionsError && <Banner tone="danger" action={<Button onClick={() => setOptionsAttempt(n => n + 1)}>Retry options</Button>}>{optionsError}</Banner>}
        <div className={styles.fields}>
          <Field label="Products"><Listbox value={selectionMode} onChange={mode => { setSelectionMode(mode); setSelection({}); clearCheck() }} options={[
            ...(selectionMode === 'selection' ? [{ value: 'selection', label: selection.job ? 'Products saved by this import' : selection.listingIds ? 'Selected listings' : 'Selected products' }] : []),
            { value: 'family', label: 'Product family' }, { value: 'skus', label: 'Specific SKUs' },
          ]} width="100%" /></Field>
          <Field label="Seller account"><Listbox value={accountId} options={[{ value: '', label: 'All accounts' }, ...(options?.accounts ?? []).map(a => ({ value: a.id, label: a.displayName ?? a.id }))]} onChange={id => { setAccountId(id); setMarketplace(''); clearCheck() }} disabled={!options} width="100%" /></Field>
          <Field label="Marketplace"><Listbox value={marketplace} options={[{ value: '', label: 'All marketplaces' }, ...markets.map(m => ({ value: m.code, label: `${regionNames.of(m.code === 'UK' ? 'GB' : m.code) ?? m.code} · ${m.code}` }))]} onChange={value => { setMarketplace(value); clearCheck() }} disabled={!options} width="100%" /></Field>
        </div>
        {selectionMode === 'family' && <Field label="Product family" required><Listbox options={(options?.families ?? []).map(f => ({ value: f.id, label: f.label }))} value={selection.familyId ?? ''} onChange={familyId => { setSelection({ familyId }); clearCheck() }} disabled={!options} width="100%" /></Field>}
        {selectionMode === 'skus' && <Field label="SKUs" required hint="Up to 200 SKUs, one per line."><Textarea rows={3} value={selection.skus ?? ''} onChange={e => { setSelection({ skus: e.target.value }); clearCheck() }} /></Field>}
        {selectionMode === 'selection' && <p>{selection.job ? 'Checks the products successfully saved by this import across their existing destinations. Refused and excluded records remain in the import review.' : selection.listingIds ? `${selection.listingIds.split(',').length} selected ${selection.listingIds.split(',').length === 1 ? 'listing' : 'listings'}. Each seller account, marketplace and listing alias is preserved.` : `${selection.productIds?.split(',').length ?? 0} selected products. Each selected parent and variant is checked only if included in the selection.`}</p>}
        <div><Button variant="primary" type="submit" disabled={loading || !Object.values(selection).some(v => v?.trim())}>{loading ? 'Checking listings…' : 'Check listings'}</Button></div>
      </form>
    </Card>
    {loading && <p role="status">Resolving current values, category requirements and translations…</p>}
    {error && <Banner tone="danger" title="Readiness could not be checked" action={<Button onClick={check}>Retry check</Button>}>{error}</Banner>}
    {result && <>
      <div className={styles.actions}><p role="status">{result.productCount.toLocaleString()} {result.productCount === 1 ? 'product' : 'products'} · {result.total.toLocaleString()} matching {result.total === 1 ? 'listing' : 'listings'}. Checked {new Date(result.computedAt).toLocaleString()}.</p><Button onClick={() => setRequest(r => r && { ...r })}>Refresh checks</Button></div>
      {!!result.missingSelectionCount && <Banner tone="warning">{result.missingSelectionCount} selected {selection.listingIds ? 'listings' : 'products'} are missing or archived and could not be checked.</Banner>}
      {!!result.withoutListing.total && <Banner tone="warning" title={`${result.withoutListing.total} products have no matching listing`}>
        Open the product to choose its destination and create a listing draft.
        <div className={styles.links}>{result.withoutListing.sample.map(p => <Button key={p.id} asChild variant="link" size="sm"><Link href={`/products/${encodeURIComponent(p.id)}/edit/studio`}>{p.sku}</Link></Button>)}</div>
        {result.withoutListing.total > result.withoutListing.sample.length && <p>Showing the first {result.withoutListing.sample.length}. Narrow the product selection to find the others.</p>}
      </Banner>}
      {!!result.rows.length && <>
        <MetricStrip metrics={[
          { label: 'Listings on this page', value: result.rows.length },
          { label: 'Need attention', value: result.rows.filter(r => r.state === 'needs-attention').length },
          { label: 'Checks incomplete', value: result.rows.filter(r => r.state === 'unavailable').length },
          { label: 'Local checks passed', value: result.rows.filter(r => r.state === 'checks-passed').length },
        ]} />
        <Banner title="Prepare, validate with the channel, then publish">These are local attribute checks against cached category requirements. Review pricing, stock, policies and live channel validation in the listing editor before submitting. Channel acceptance and live availability must be confirmed there.</Banner>
        {[...groups.entries()].map(([key, rows]) => <Card key={key} header={<h2>{channelName(rows[0].channel)} · {rows[0].marketplace}</h2>} description={`${rows[0].accountName}${rows[0].accountId ? ` · ${rows[0].accountId.slice(-6)}` : ''} · ${rows.length} ${rows.length === 1 ? 'listing' : 'listings'} on this page`}>
          <div className={styles.stack}>{rows.map(row => <Disclosure key={row.id} summary={`${row.sku} · ${row.aliasKey || 'Primary listing'} · ${stateLabel[row.state]}${row.issues.length ? ` · ${row.issues.length} issues` : ''}`}>
            <div className={styles.stack}>
              <p>{row.name} · {languageName(row.locale)} · Category: {row.category ?? 'Not resolved'}</p>
              <div className={styles.actions}><Button asChild variant="primary" size="sm"><Link href={row.editorHref}>Review {row.sku} listing</Link></Button></div>
              {!!row.issues.length && <ul className={styles.issues}>{row.issues.map((issue, index) => <li key={index}><strong>{issue.label} · {issueLabel[issue.kind]}</strong><p>{issue.message}</p></li>)}</ul>}
              <Disclosure summary="Check details"><p>Schema: {row.schema?.version ?? 'Version unavailable'} · Retrieved {row.schema?.fetchedAt ? new Date(row.schema.fetchedAt).toLocaleString() : 'at an unknown date'}.</p><p>Saved listing status: {row.savedStatus}. Last sync: {row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : 'not recorded'}. This check did not contact the marketplace.</p></Disclosure>
            </div>
          </Disclosure>)}</div>
        </Card>)}
      </>}
      {!result.rows.length && <Card padded><p>{result.total ? 'This page no longer contains listings. Return to the first page to refresh the selection.' : 'No existing listings matched this selection.'}</p>{result.total > 0 && <Button onClick={() => setRequest(r => r && { ...r, page: '1' })}>First page</Button>}</Card>}
      {result.total > result.pageSize && <div className={styles.actions}><p>Page {result.page} of {Math.ceil(result.total / result.pageSize)}. Counts above describe this page.</p><Pagination page={result.page} pageCount={Math.ceil(result.total / result.pageSize)} onPage={page => setRequest(r => r && { ...r, page: String(page) })} /></div>}
    </>}
  </div>
}
