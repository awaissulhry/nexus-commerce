'use client'
import Link from '@/lib/workspaces/Link'
import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronRight, FolderTree, MoreHorizontal, Plus, RefreshCw, Search } from 'lucide-react'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button, Input, Pill } from '@/design-system/primitives'
import { Banner, EmptyState, KeyValue, Listbox, Menu, Modal, Pagination, ProgressBar, Tabs, tabPanelProps } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { mappingHref } from '@/app/channels/mapping/_shared/navigation'
import type { CategoryMappingRow } from '@/app/channels/mapping/_shared/contracts'
import { CategoryDialog } from './CategoryDialog'
import { TaxonomyDialog } from './TaxonomyDialog'
import { refreshSource, scopePath, type Assignments, type CategoryCommand, type CategoryRow, type Directory, type ImportRun, type Source } from './api'
import { useResource } from './useResource'
import styles from './categories.module.css'

const tabs = [{ id: 'categories', label: 'Our categories' }, { id: 'assignments', label: 'Channel assignments' }, { id: 'updates', label: 'Taxonomy updates' }]
const statusLabels: Record<string, string> = { ready: 'Up to date', missing: 'Not synchronized', queued: 'Queued', refreshing: 'Refreshing', stale: 'Refresh due', failed: 'Needs attention', unsupported: 'Adapter required', unconfigured: 'Market required' }
const statusTone = (state: string) => state === 'ready' ? 'success' as const : state === 'failed' ? 'danger' as const : ['queued', 'refreshing'].includes(state) ? 'info' as const : 'warning' as const
const healthLabels: Record<string, string> = { ready: 'Requirements current', store: 'Store rules apply', retired: 'Category retired', notAssignable: 'Choose a leaf category', missing: 'Requirements missing', stale: 'Requirements expired', unknown: 'Taxonomy unavailable', unmapped: 'Not assigned' }
const needsAttention = (health: string) => !['ready', 'store', 'unmapped'].includes(health)
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never synchronized'

export function CategoriesWorkspace({ initialView, initialChannel, initialMarket }: { initialView?: string; initialChannel?: string; initialMarket?: string }) {
  const id = useId()
  const [view, setView] = useState(tabs.some(tab => tab.id === initialView) ? initialView! : 'categories')
  const [revision, setRevision] = useState(0)
  const [sourceRevision, setSourceRevision] = useState(0)
  const [scope, setScope] = useState(initialChannel ? `${initialChannel}/${initialMarket ?? 'GLOBAL'}` : '')
  const [query, setQuery] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busySource, setBusySource] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ action: CategoryCommand['action']; category?: CategoryRow; parentId?: string } | null>(null)
  const [picker, setPicker] = useState<{ source: Source; assignment?: CategoryMappingRow; token?: string } | null>(null)
  const [history, setHistory] = useState<Source | null>(null)
  const directory = useResource<Directory>('category-workspace', revision)
  const sourceResult = useResource<{ sources: Source[] }>('taxonomies', sourceRevision)
  const sources = sourceResult.data?.sources ?? []
  const source = sources.find(s => `${s.channel}/${s.market}` === scope) ?? (!scope ? sources[0] : undefined)
  const assignments = useResource<Assignments>(view === 'assignments' && source ? `category-workspace/${scopePath(source)}/assignments` : null, revision + sourceRevision)
  const changed = () => { setRevision(v => v + 1); setSourceRevision(v => v + 1) }
  const pending = sources.some(s => s.state === 'queued' || s.state === 'refreshing')
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSourceRevision(v => v + 1), 3000)
    return () => clearTimeout(timer)
  }, [pending, sourceRevision, sourceResult.data])
  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', view)
    if (source) { url.searchParams.set('channel', source.channel); url.searchParams.set('market', source.market) }
    window.history.replaceState(window.history.state, '', url)
  }, [view, source?.channel, source?.market])
  const selectView = (next: string) => { setView(next); setQuery(''); setPage(1); setFilter('all'); setError(null) }
  const rows = directory.data?.rows ?? []
  const selectedParent = rows.find(row => row.id === parent)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => rows.filter(row => (!normalizedQuery ? parent === null || row.parentId === parent : `${row.path} ${row.code ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)) && (filter === 'all' || (filter === 'active' ? row.active : !row.active))), [rows, normalizedQuery, parent, filter])
  const assignmentRows = (assignments.data?.rows ?? []).filter(row => `${row.categoryPath} ${row.currentPath ?? row.mapping?.channelCategoryPath ?? row.mapping?.channelCategoryId ?? row.inheritedFrom?.channelCategoryId ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
    && (filter === 'all' || (filter === 'attention' ? needsAttention(row.health) || !!row.mapping && !row.mapping.reviewedAt || row.inheritedFrom?.reviewed === false : filter === 'unmapped' ? !row.mapping && !row.inheritedFrom : filter === 'inherited' ? !row.mapping && !!row.inheritedFrom : !!row.mapping)))
  const count = view === 'categories' ? filtered.length : assignmentRows.length
  const safePage = Math.min(page, Math.max(1, Math.ceil(count / 50)))
  const slice = <T,>(items: T[]) => items.slice((safePage - 1) * 50, safePage * 50)
  const sync = async (target: Source) => {
    setBusySource(scopePath(target)); setError(null); setNotice(null)
    try { await refreshSource(target); setSourceRevision(v => v + 1); setNotice(`${target.label} · ${target.market}: refresh queued. Existing categories remain available.`) }
    catch (error) { setError(error instanceof Error ? error.message : 'Refresh could not be queued.') }
    finally { setBusySource(null) }
  }
  const resultError = view === 'categories' ? directory.error : view === 'assignments' ? sourceResult.error ?? assignments.error : sourceResult.error
  const loading = view === 'categories' ? directory.loading : view === 'assignments' ? sourceResult.loading || assignments.loading : sourceResult.loading
  return <div className={styles.page}>
    <PageHeader eyebrow="Products" title="Categories" subtitle="Organize products once. Control how each channel classifies them." actions={<>
      <Button asChild size="sm" variant="ghost"><Link href="/products">Product list</Link></Button>
      <Button size="sm" disabled={directory.loading || !directory.data || !!directory.error} variant="primary" onClick={() => setEdit({ action: 'create', parentId: parent ?? undefined })}><Plus size={14} aria-hidden /> New category</Button>
    </>} />
    <Tabs overflow="scroll" idBase={id} ariaLabel="Category workspace" tabs={tabs} active={view} onChange={selectView} />
    <div {...tabPanelProps(id, view)} className={styles.content}>
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {(error || resultError) && <Banner tone="danger" title="Could not complete the request" action={<Button size="sm" onClick={() => { setError(null); changed() }}>Retry</Button>}>{error ?? resultError}</Banner>}
      {view === 'categories' && <>
        <div className={styles.toolbar}>
          <div className={styles.search}><Input fieldClassName={styles.searchField} size="sm" aria-label="Search internal categories" placeholder="Search category names, paths, or codes" leadingIcon={<Search size={14} aria-hidden />} value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /></div>
          <Listbox size="sm" ariaLabel="Category status" width={170} value={filter} onChange={value => { setFilter(value); setPage(1) }} options={[{ value: 'all', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
          <Button size="sm" disabled={loading} onClick={changed}><RefreshCw size={14} aria-hidden /> Reload</Button>
        </div>
        <div className={styles.context}>
          <Button size="sm" variant="link" onClick={() => { setParent(null); setQuery(''); setPage(1) }}>All categories</Button>
          {selectedParent && <><ChevronRight size={14} aria-hidden /><span>{selectedParent.path}</span><Button size="sm" onClick={() => setEdit({ action: 'create', parentId: selectedParent.id })}>Add child category</Button></>}
          <span className={styles.secondary}>{count.toLocaleString()} {normalizedQuery ? 'matching' : ''} categories</span>
        </div>
        {loading && !directory.data ? <ProgressBar indeterminate ariaLabel="Loading categories" /> : !resultError && <DataGrid ariaLabel="Internal categories" keyboardScroll rows={slice(filtered)} rowKey={row => row.id} columns={[
          { key: 'name', label: 'Category', render: row => <div className={styles.identity}><Button inline variant="link" onClick={() => setEdit({ action: 'rename', category: row })}>{row.name}</Button><span className={styles.secondary}>{row.path}</span></div> },
          { key: 'code', label: 'Reference code', render: row => row.code || '—' },
          { key: 'products', label: 'Direct products', numeric: true, render: row => row.products.toLocaleString() },
          { key: 'children', label: 'Child categories', numeric: true, render: row => row.children ? <Button inline variant="link" onClick={() => { setParent(row.id); setQuery(''); setPage(1) }}>{row.children}</Button> : '0' },
          { key: 'status', label: 'Status', render: row => <Pill tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Active' : 'Inactive'}</Pill> },
          { key: 'actions', label: 'Actions', render: row => <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': `Actions for ${row.name}` }} items={[
            { id: 'edit', label: 'Edit name and reference', onSelect: () => setEdit({ action: 'rename', category: row }) },
            { id: 'child', label: 'Add child category', onSelect: () => setEdit({ action: 'create', parentId: row.id }) },
            { id: 'assign', label: 'Manage channel assignments', onSelect: () => { selectView('assignments'); setQuery(row.path) } },
            { id: 'move', label: 'Move category', onSelect: () => setEdit({ action: 'move', category: row }) },
            { id: 'delete', label: 'Delete empty category', onSelect: () => setEdit({ action: 'delete', category: row }) },
          ]} /> },
        ]} emptyState={<EmptyState icon={<FolderTree size={28} aria-hidden />} title={rows.length ? 'No matching categories' : 'Start with your first category'} description={rows.length ? 'Try a different search or clear your filters.' : 'Create categories that make sense for your business, then assign their channel equivalents.'} action={<Button size="sm" onClick={() => rows.length ? (setQuery(''), setFilter('all'), setParent(null)) : setEdit({ action: 'create' })}>{rows.length ? 'Clear filters' : 'Create category'}</Button>} />} />}
      </>}
      {view === 'assignments' && <>
        <div className={styles.toolbar}>
          <Listbox ariaLabel="Channel and market" size="sm" width="min(360px, 100%)" searchable value={source ? `${source.channel}/${source.market}` : ''} onChange={value => { setScope(value); setPage(1); setError(null) }} options={sources.map(s => ({ value: `${s.channel}/${s.market}`, label: `${s.name} · ${s.market}` }))} placeholder="Choose a channel and market" />
          <div className={styles.search}><Input fieldClassName={styles.searchField} size="sm" aria-label="Search category assignments" placeholder="Search your categories or channel assignments" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /></div>
          <Listbox ariaLabel="Assignment status" size="sm" width={180} value={filter} onChange={value => { setFilter(value); setPage(1) }} options={[{ value: 'all', label: 'All assignments' }, { value: 'attention', label: 'Needs attention' }, { value: 'unmapped', label: 'Not assigned' }, { value: 'mapped', label: 'Assigned directly' }, { value: 'inherited', label: 'Inherited' }]} />
        </div>
        {!source && !sourceResult.loading && !sourceResult.error && <EmptyState title={scope ? 'This channel and market are unavailable' : 'Connect a channel to begin'} description="Manage your connections, then choose a configured channel and market." action={<Button asChild size="sm"><Link href="/settings/channels">Open connections</Link></Button>} />}
        {source && <>
          <p className={styles.secondary}>Assignments apply to {source.label} · {source.market}, across accounts. Products inherit the nearest mapped category; explicit listing overrides are preserved.</p>
          {!source.supported ? <Banner tone="warning" title={source.state === 'unconfigured' ? 'Configure a marketplace' : 'Taxonomy adapter required'}>{source.state === 'unconfigured' ? `Choose the countries served by your ${source.label} connection before synchronizing categories.` : `${source.label} is configured. Its category adapter must be connected before assignments can be made.`}</Banner> : !source.snapshotId ? <Banner tone="info" title="Synchronize the channel taxonomy" action={<Button size="sm" disabled={busySource !== null || ['queued', 'refreshing'].includes(source.state)} onClick={() => void sync(source)}>{['queued', 'refreshing'].includes(source.state) ? statusLabels[source.state] : 'Synchronize'}</Button>}>Download categories to search and select verified channel IDs.</Banner> : null}
          {source.error && <Banner tone="warning" title="Last refresh needs attention">{source.error}</Banner>}
          {assignments.data && <KeyValue columns={3} dense items={[{ label: 'Assigned directly', value: assignments.data.counts.mapped }, { label: 'Inherited', value: assignments.data.counts.inherited }, { label: 'Not assigned', value: assignments.data.counts.total - assignments.data.counts.mapped - assignments.data.counts.inherited }]} />}
          {assignments.loading && !assignments.data ? <ProgressBar indeterminate ariaLabel="Loading assignments" /> : !assignments.error && <DataGrid ariaLabel="Channel category assignments" keyboardScroll rows={slice(assignmentRows)} rowKey={row => row.categoryId} columns={[
            { key: 'category', label: 'Our category', render: row => <div className={styles.identity}><strong>{row.categoryName}</strong><span className={styles.secondary}>{row.categoryPath}</span></div> },
            { key: 'target', label: source.kind === 'productTypes' ? 'Amazon product type' : 'Channel category', render: row => row.currentPath || row.mapping?.channelCategoryPath || row.mapping?.channelCategoryId || row.inheritedFrom?.channelCategoryId || 'Not assigned' },
            { key: 'source', label: 'Assignment source', render: row => row.mapping ? <Pill tone={row.mapping.reviewedAt ? 'success' : 'warning'}>{row.mapping.reviewedAt ? row.mapping.marketplace === '*' ? 'All-market default' : 'Direct assignment' : 'Needs review'}</Pill> : row.inheritedFrom ? <div className={styles.identity}><span>Inherited from {row.inheritedFrom.categoryName}</span>{row.inheritedFrom.reviewed === false && <Pill tone="warning">Needs review</Pill>}</div> : <Pill tone="neutral">Not assigned</Pill> },
            { key: 'health', label: 'Requirements', render: row => <Pill tone={needsAttention(row.health) ? 'warning' : 'neutral'}>{healthLabels[row.health] ?? 'Checking requirements'}</Pill> },
            { key: 'products', label: 'Direct products', numeric: true, render: row => row.productCount.toLocaleString() },
            { key: 'actions', label: 'Actions', render: row => <div className={styles.actions}><Button size="xs" disabled={!source.supported || assignments.loading} onClick={() => setPicker({ source, assignment: row, token: assignments.data?.token })}>{row.mapping ? 'Change' : 'Assign'}</Button>{(row.mapping || row.inheritedFrom) && <Button asChild size="xs" variant="link"><Link href={mappingHref({ channel: source.channel, market: source.market, category: row.mapping?.channelCategoryId ?? row.inheritedFrom?.channelCategoryId })}>Attribute rules</Link></Button>}</div> },
          ]} emptyState={<EmptyState title={rows.length ? 'No matching assignments' : 'Create an internal category first'} description={rows.length ? 'Clear the search or change the assignment filter.' : 'Your shared categories appear here once created.'} action={<Button size="sm" onClick={() => rows.length ? (setQuery(''), setFilter('all')) : selectView('categories')}>{rows.length ? 'Clear filters' : 'Open our categories'}</Button>} />} />}
        </>}
      </>}
      {view === 'updates' && <>
        <p className={styles.secondary}>Review local category coverage and refresh status. Refreshing reference data does not change your assignments or publish listings.</p>
        {loading && !sourceResult.data ? <ProgressBar indeterminate ariaLabel="Loading taxonomy status" /> : !sourceResult.error && <DataGrid ariaLabel="Marketplace taxonomy updates" keyboardScroll rows={sources} rowKey={row => `${row.channel}/${row.market}`} columns={[
          { key: 'channel', label: 'Channel / market', render: row => <div className={styles.identity}><strong>{row.name}</strong><span className={styles.secondary}>{row.kind === 'productTypes' ? 'Product types' : 'Category taxonomy'} · {row.market}</span></div> },
          { key: 'status', label: 'Status', render: row => <div className={styles.identity}><Pill tone={statusTone(row.state)}>{statusLabels[row.state] ?? row.state}</Pill>{row.error && <span className={styles.errorDetail}>{row.error}</span>}</div> },
          { key: 'count', label: 'Categories cached', numeric: true, render: row => row.nodeCount?.toLocaleString() ?? '—' },
          { key: 'sync', label: 'Last successful tree sync', render: row => dateLabel(row.lastSyncedAt) },
          { key: 'changes', label: 'Last tree changes', render: row => row.changes ? `${row.changes.added} added · ${row.changes.changed} changed · ${row.changes.removed} removed` : '—' },
          { key: 'actions', label: 'Actions', render: row => <div className={styles.actions}><Button size="xs" disabled={!row.supported || busySource !== null || ['queued', 'refreshing'].includes(row.state)} onClick={() => void sync(row)}>{busySource === scopePath(row) ? 'Queuing…' : 'Refresh'}</Button><Button size="xs" disabled={!row.snapshotId} onClick={() => setPicker({ source: row })}>Browse</Button><Button size="xs" disabled={!row.sourceId} onClick={() => setHistory(row)}>History</Button></div> },
        ]} emptyState={<EmptyState title="No configured channels" description="Connect a channel to start synchronizing its taxonomy." action={<Button asChild size="sm"><Link href="/settings/channels">Open connections</Link></Button>} />} />}
      </>}
      {view !== 'updates' && count > 50 && <div className={styles.pager}><span className={styles.secondary}>Showing {(safePage - 1) * 50 + 1}–{Math.min(safePage * 50, count)} of {count.toLocaleString()}</span><Pagination page={safePage} pageCount={Math.ceil(count / 50)} onPage={setPage} /></div>}
    </div>
    {edit && directory.data && <CategoryDialog {...edit} directory={directory.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setNotice(edit.action === 'delete' ? 'Category deleted.' : 'Category saved.'); changed() }} />}
    {picker && <TaxonomyDialog source={sources.find(s => s.channel === picker.source.channel && s.market === picker.source.market) ?? picker.source} assignment={picker.assignment} token={picker.token} revision={sourceRevision} onClose={() => setPicker(null)} onChanged={changed} />}
    {history && <HistoryDialog source={history} onClose={() => setHistory(null)} />}
  </div>
}

function HistoryDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const [retry, setRetry] = useState(0)
  const result = useResource<{ runs: ImportRun[] }>(`taxonomies/${encodeURIComponent(source.sourceId!)}/history`, retry)
  return <Modal open title="Taxonomy history" subtitle={`${source.label} · ${source.market} · latest 25 imports`} size="lg" onClose={onClose} footer={<Button size="sm" onClick={onClose}>Close</Button>}>
    {result.error ? <Banner tone="danger" action={<Button size="sm" onClick={() => setRetry(v => v + 1)}>Retry</Button>}>{result.error}</Banner> : result.loading ? <ProgressBar indeterminate ariaLabel="Loading import history" /> : <DataGrid ariaLabel="Taxonomy import history" rows={result.data?.runs ?? []} rowKey={row => row.id} columns={[
      { key: 'date', label: 'Started', render: row => dateLabel(row.createdAt) }, { key: 'status', label: 'Result', render: row => row.status === 'SUCCEEDED' ? 'Imported' : row.status === 'IMPORTING' ? 'Import started' : 'Failed' },
      { key: 'nodes', label: 'Categories', numeric: true, render: row => row.nodeCount.toLocaleString() }, { key: 'changes', label: 'Changes', render: row => row.error ?? `${row.addedCount} added · ${row.changedCount} changed · ${row.removedCount} removed` },
    ]} emptyState={<EmptyState title="No completed imports yet" description="The first import will appear here once its download has been validated." />} />}
  </Modal>
}
