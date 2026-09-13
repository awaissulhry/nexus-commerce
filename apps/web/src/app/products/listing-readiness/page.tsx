'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { ListingReadinessPage, ListingReadinessRow } from '@nexus/shared/listing-readiness'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Button, Tag } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, Listbox, Pagination } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { readinessMeta, SCOPE_READINESS_STATES } from '@/design-system/grid'
import { transferApi } from '../catalog-transfer/transferApi'
import { TranslateDialog, languageLabel, useCatalogLanguages } from '../next/TranslateDialog'
import styles from './readiness.module.css'

type Options = { families: Array<{ id: string; label: string }>; markets: Array<{ channel: string; code: string; name: string }> }
export default function ListingReadiness() {
  const [query, setQuery] = useState<Record<string, string> | null>(null), [result, setResult] = useState<ListingReadinessPage | null>(null)
  const [options, setOptions] = useState<Options | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [translate, setTranslate] = useState(false)
  const languages = useCatalogLanguages()
  useEffect(() => {
    setQuery(Object.fromEntries(new URLSearchParams(window.location.search)))
    void transferApi<Options>('catalog-transfer/readiness/options').then(setOptions).catch(error => setError(error.message))
  }, [])
  useEffect(() => {
    if (!query) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(null)
    const params = new URLSearchParams(query)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    void transferApi<ListingReadinessPage>(`catalog-transfer/readiness?${params}`, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResult(value) })
      .catch(error => { if (!controller.signal.aborted) setError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query])
  const filter = (key: string, value: string) => setQuery(prior => { const next = { ...prior, page: '1' }; if (key === 'channel') delete (next as Record<string, string>).marketplace; if (value) Object.assign(next, { [key]: value }); else delete (next as Record<string, string>)[key]; return next })
  const columns = useMemo(() => [
    { key: 'product', label: 'Product', render: (row: ListingReadinessRow) => <Link className={styles.product} href={row.editorHref}>{row.sku}<span className={styles.productName} title={row.name ?? undefined}>{row.name}</span></Link> },
    { key: 'destination', label: 'Destination', render: (row: ListingReadinessRow) => <span>{row.channel} {row.marketplace}<br />{row.accountName}</span> },
    { key: 'language', label: 'Language', render: (row: ListingReadinessRow) => languageLabel(row.locale) },
    { key: 'state', label: 'Readiness', render: (row: ListingReadinessRow) => { const meta = readinessMeta(row.state, 'scope'); return <Tag tone={meta.tone}>{meta.label} · {row.pct === null ? '—' : `${row.pct}%`}</Tag> } },
    { key: 'missing', label: 'Needs attention', render: (row: ListingReadinessRow) => row.issues.length ? <Disclosure summary={`${row.issues.length} ${row.issues.length === 1 ? 'issue' : 'issues'} to review`}><ul className={styles.issues}>{row.issues.map((issue, i) => <li key={i} title={issue.message}>{issue.label}: {issue.message}</li>)}</ul></Disclosure> : '—' },
    { key: 'actions', label: 'Actions', render: (row: ListingReadinessRow) => <Button asChild size="sm"><Link href={row.editorHref}>Open in studio</Link></Button> },
  ], [])
  return <div className={styles.workspace}>
    <PageHeader eyebrow="Products" title="Listing readiness" subtitle="Find what needs attention by channel, market and language." actions={<Button asChild><Link href="/products/next">Back to products</Link></Button>} />
    <Card padded><div className={styles.fields}>
      <Field label="Channel"><Listbox value={query?.channel ?? ''} onChange={value => filter('channel', value)} options={[{ value: '', label: 'All channels' }, { value: 'SHARED', label: 'Shared product' }, ...[...new Set(options?.markets.map(m => m.channel))].map(channel => ({ value: channel, label: channel }))]} /></Field>
      <Field label="Market"><Listbox value={query?.marketplace ?? ''} onChange={value => filter('marketplace', value)} options={[{ value: '', label: 'All markets' }, ...[...new Map(options?.markets.filter(m => !query?.channel || m.channel === query.channel).map(m => [m.code, m])).values()].map(m => ({ value: m.code, label: m.name }))]} /></Field>
      <Field label="Language"><Listbox value={query?.language ?? ''} onChange={value => filter('language', value)} options={[{ value: '', label: 'All languages' }, ...languages.options]} /></Field>
      <Field label="State"><Listbox value={query?.state ?? ''} onChange={value => filter('state', value)} options={[{ value: '', label: 'All states' }, ...SCOPE_READINESS_STATES.map(state => ({ value: state, label: readinessMeta(state, 'scope').label }))]} /></Field>
      <Field label="Family"><Listbox value={query?.familyId ?? ''} onChange={value => { setQuery(prior => { const next = { ...prior, page: '1', familyId: value }; for (const key of ['productIds', 'listingIds', 'job', 'skus']) delete (next as Record<string, string>)[key]; return next }) }} options={[{ value: '', label: 'All families' }, ...(options?.families ?? []).map(family => ({ value: family.id, label: family.label }))]} /></Field>
    </div></Card>
    {(error || languages.error) && <Banner tone="danger">{error || languages.error}</Banner>}
    <div className={styles.actions}><span aria-live="polite">{loading ? 'Loading readiness…' : `${result?.total ?? '—'} ${result?.total === 1 ? 'coordinate' : 'coordinates'} · ${result?.productCount ?? '—'} ${result?.productCount === 1 ? 'product' : 'products'}`}</span>
      <Button onClick={() => setTranslate(true)} disabled={!query?.language || loading || !result?.total} title={!query?.language ? 'Choose a language to preview translation for every matching row.' : undefined}>Translate filtered products…</Button></div>
    {result && <><DataGrid columns={columns} rows={result.rows} rowKey={row => row.id} ariaLabel="Readiness by coordinate and language" keyboardScroll emptyState="No indexed rows match this filter." />
      <Pagination page={result.page} pageCount={Math.max(1, Math.ceil(result.total / result.pageSize))} onPage={page => setQuery(prior => ({ ...prior, page: String(page) }))} />
      <p>Last computed: {result.computedAt ? new Date(result.computedAt).toLocaleString() : '—'}. Readiness reflects saved information; publication checks run before publishing.</p></>}
    {query && <TranslateDialog open={translate} onClose={() => setTranslate(false)} language={query.language ?? ''} scope={{ kind: 'readiness', query }} />}
  </div>
}
