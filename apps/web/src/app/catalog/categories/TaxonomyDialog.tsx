'use client'
import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Button, Pill } from '@/design-system/primitives'
import { AsyncListboxPanel, Banner, DataGrid, EmptyState, KeyValue, Modal, Pagination } from '@/design-system/components'
import { ImpactReview } from '@/app/channels/mapping/_shared/ImpactReview'
import { createConfigurationImpact } from '@/app/channels/mapping/_shared/api'
import { mappingHref } from '@/app/channels/mapping/_shared/navigation'
import type { CategoryMappingRow } from '@/app/channels/mapping/_shared/contracts'
import { refreshSource, requirementFields, scopePath, type NodeResults, type Requirements, type Source } from './api'
import { useResource } from './useResource'
import styles from './categories.module.css'

export function TaxonomyDialog({ source, assignment, token, revision, onClose, onChanged }: {
  source: Source; assignment?: CategoryMappingRow; token?: string; revision: number; onClose: () => void; onChanged: () => void;
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(assignment?.mapping?.channelCategoryId ?? assignment?.inheritedFrom?.channelCategoryId ?? '')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  const base = `taxonomies/${scopePath(source)}`
  const results = useResource<NodeResults>(`${base}/nodes?${new URLSearchParams({ q: query, page: String(page), ...(assignment ? { assignable: '1' } : {}) })}`, revision + retry, 200)
  const details = useResource<Requirements>(selected ? `${base}/requirements?id=${encodeURIComponent(selected)}` : null, revision + retry)
  useEffect(() => { if (!['queued', 'refreshing'].includes(source.state)) setQueued(false) }, [source.state])
  useEffect(() => { setPage(1) }, [source.snapshotId])
  const fields = details.data ? requirementFields(details.data) : []
  const canReview = !!details.data && ['ready', 'store'].includes(details.data.state) && !details.loading && !details.error
  const refresh = async (categoryId?: string) => {
    setBusy(true); setError(null)
    try { await refreshSource(source, categoryId); setQueued(true); onChanged() }
    catch (error) { setError(error instanceof Error ? error.message : 'Refresh could not be queued.') }
    finally { setBusy(false) }
  }
  const review = async (reset = false) => {
    if (!assignment || !token) return
    setBusy(true); setError(null)
    try { const result = await createConfigurationImpact(source.channel, source.market, token, { categoryChange: { expectedTaxonomySnapshotId: reset ? undefined : details.data?.snapshotId, categoryId: assignment.categoryId, channelCategoryId: reset ? null : selected } }); setJob(result.jobId) }
    catch (error) { setError(error instanceof Error ? error.message : 'Review could not start.') }
    finally { setBusy(false) }
  }
  return <Modal open title={assignment ? `Assign ${assignment.categoryName}` : `${source.label} ${source.kind === 'productTypes' ? 'product types' : 'categories'}`}
    subtitle={assignment ? `${assignment.categoryPath} → ${source.label} · ${source.market}` : `Local taxonomy · ${source.market}`}
    size="xl" onClose={() => { if (!busy) onClose() }} footer={<>
      <Button size="sm" disabled={busy} onClick={onClose}>Close</Button>
      {assignment?.mapping?.marketplace === source.market && !job && <Button size="sm" disabled={busy} onClick={() => void review(true)}>Review reset to inheritance</Button>}
      {assignment && !job && <Button size="sm" variant="primary" disabled={busy || !canReview || (selected === assignment.mapping?.channelCategoryId && !!assignment.mapping?.reviewedAt)} onClick={() => void review()}>{busy ? 'Preparing review…' : 'Review assignment'}</Button>}
    </>}>
    {source.error && <Banner tone="warning" title="Refresh needs attention">{source.error}</Banner>}
    {error && <Banner tone="danger">{error}</Banner>}
    {job ? <ImpactReview jobId={job} onApplied={onChanged} /> : !source.snapshotId ? <EmptyState title="Taxonomy has not been synchronized" description="Download the category list once. Browsing and searching will then use the local copy." action={<Button size="sm" disabled={busy || queued || !source.supported} onClick={() => void refresh()}>{queued ? 'Refresh queued' : 'Synchronize taxonomy'}</Button>} /> : <div className={styles.picker}>
      <div className={styles.stack}>
        <AsyncListboxPanel label={`Search ${source.label} ${source.kind === 'productTypes' ? 'product types' : 'categories'}`} query={query}
          onQueryChange={value => { setQuery(value); setPage(1) }} value={selected} loading={results.loading} error={results.error}
          options={(results.data?.items ?? []).map(node => ({ value: node.externalId, label: node.path, title: `${node.path}\nID: ${node.externalId}`, disabled: !!assignment && !node.assignable }))}
          placeholder="Search by name, path, or ID" emptyMessage="No categories match this search." message={results.data ? `${results.data.total.toLocaleString()} ${results.data.total === 1 ? 'match' : 'matches'} · 50 per page` : undefined}
          onRetry={() => setRetry(v => v + 1)} onCancel={onClose} onCommit={value => { setSelected(value); setQueued(false); setError(null) }} />
        {!!results.data?.pages && results.data.pages > 1 && <Pagination page={page} pageCount={results.data.pages} onPage={setPage} />}
      </div>
      <section className={styles.detail} aria-label="Category requirements" aria-busy={details.loading}>
        {!selected ? <EmptyState title="Choose a category" description="Inspect its requirements before assigning products." /> : details.error ? <Banner tone="danger" action={<Button size="sm" onClick={() => setRetry(v => v + 1)}>Retry</Button>}>{details.error}</Banner> : !details.data ? <p role="status">Loading requirements…</p> : <div className={styles.stack}>
          <h2>{details.data.node.name}</h2><p className={styles.secondary}>{details.data.node.path}</p>
          <KeyValue items={[{ label: 'Category ID', value: details.data.node.externalId }, { label: 'Scope', value: `${source.label} · ${source.market}` }]} />
          {source.kind === 'productTypes' && <Banner tone="info">Amazon product types determine attribute requirements. Browse-node placement remains a separate listing field.</Banner>}
          {details.data.state === 'notAssignable' ? <Banner tone="warning">Choose a leaf category to assign products.</Banner>
            : ['missing', 'stale'].includes(details.data.state) ? <Banner tone="warning" title={details.data.state === 'missing' ? 'Requirements are not cached yet' : 'Requirements need a refresh'} action={<Button size="sm" disabled={busy || queued} onClick={() => void refresh(selected)}>{queued ? 'Refresh queued' : 'Refresh requirements'}</Button>}>Requirements must be current before an assignment can be reviewed.</Banner>
            : details.data.state === 'store' ? <Banner tone="info">These are Shopify’s standard category attributes. Required custom fields and validation are configured separately for each connected store.</Banner>
            : <Pill tone="success">Requirements available</Pill>}
          {!!fields.length && <><p>{fields.length} fields · {fields.filter(f => f.required).length} marked required. Conditional requirements depend on the product’s values.</p>
            <DataGrid ariaLabel="Category field preview" rows={fields.slice(0, 10)} rowKey={f => f.key} columns={[{ key: 'name', label: 'Field', render: f => f.label }, { key: 'required', label: 'Requirement', render: f => f.required ? 'Required' : 'Optional or conditional' }]} />
            {fields.length > 10 && <p className={styles.secondary}>Showing the first 10 fields. Open attribute mappings to work with the complete field set.</p>}</>}
          {['ready', 'store'].includes(details.data.state) && <Button asChild size="sm" variant="link"><Link href={mappingHref({ channel: source.channel, market: source.market, category: selected })}>Open attribute mappings</Link></Button>}
        </div>}
      </section>
    </div>}
  </Modal>
}
