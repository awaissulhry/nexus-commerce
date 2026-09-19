'use client'
import { useEffect, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Button } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, Listbox, MetricStrip, Pagination, ProgressBar } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { getBackendUrl } from '@/lib/backend-url'
import type { OutcomePage, TransferJob, TransferOptions, TransferOutcome } from './sourceMapping'
import { transferApi } from './transferApi'
import { previewColumns } from './previewColumns'
import { channelName, languageName } from './workbookSelection'
import styles from './transfer.module.css'

/**
 * What the review is for. `file` (the default) is a workbook or source import, and every consumer from
 * before AE.3 gets exactly its old words and actions. `copy` is a first copy of products another business
 * shares (settings/sharing, plan §19.3): there is no file to upload again; no retry, because a retry
 * creates a job the copy does not follow; and saving is offered even with no field changes, because
 * saving is also what links the products. One discriminant selects the whole set, never a caller's own
 * sentence (feedback: shared components carry no copy props).
 */
export type TransferReviewPurpose = 'file' | 'copy'
const REVIEW_WORDS = {
  file: {
    checking: 'Checking your complete file', stopped: 'Import stopped', partial: 'Import finished with issues',
    receipt: 'Saved import receipt', totals: 'File review totals',
    completedTitle: 'Next: check your listings before publishing',
    completedBody: 'Review the saved products across their seller accounts and marketplaces, then continue through the listing editor. Saving this import has not submitted your listings to Amazon or eBay.',
    noChanges: 'This file makes no catalog changes. Your existing values are preserved.',
    excludedTitle: (n: string) => `${n} inputs excluded from this import`,
    excludedBody: 'These include source instructions, managed fields or unsupported inputs. Each exclusion has a reason. Review them to make sure the file contains everything you intended to import.',
    closeNote: 'You can close this review. Processing continues in Nexus; reopen Import to check the result.',
    reviewed: (n: string) => `${n} record outcomes reviewed across the entire file.`,
    invalidTitle: 'Correct the source before applying',
    invalidBody: 'Validation failures block this review. Every failure and exclusion is available in the outcomes below.',
    filtersQueued: (n: number) => `Filters change what you see here. Saving includes all ${n} reviewed attribute changes in the file.`,
    filtersDone: 'Filters change what you see here. The import receipt covers the complete file.',
    save: 'Save reviewed changes', saving: 'Starting import…',
  },
  copy: {
    checking: 'Checking the shared products', stopped: 'Saving stopped', partial: 'Saved with issues',
    receipt: 'Saved copy receipt', totals: 'Review totals',
    completedTitle: 'Saved in this business',
    completedBody: 'Next, each saved product is linked to the product it copies. Nothing has been submitted to Amazon or eBay.',
    noChanges: 'These products already hold the shared values. Saving changes nothing and links them.',
    excludedTitle: (n: string) => `${n} values not copied`,
    excludedBody: 'These are fields this business manages itself, or values a shared product cannot carry. Each one has a reason.',
    closeNote: 'You can close this review. Saving continues in Nexus; reopen Shared products to check the result.',
    reviewed: (n: string) => `${n} product outcomes reviewed across every shared product.`,
    invalidTitle: 'Some products cannot be saved as they are',
    invalidBody: 'Every refusal is listed below with its reason. Fix it in the business that shares the products, then start a new copy.',
    filtersQueued: (n: number) => `Filters change what you see here. Saving includes all ${n} reviewed attribute changes.`,
    filtersDone: 'Filters change what you see here. The receipt covers every shared product.',
    save: 'Save and link products', saving: 'Starting to save…',
  },
} as const

export function TransferReview({ jobId, options, onReset, onJob, onSettled, onReturn, allowApply = true, productId, onBusyChange, purpose = 'file' }: { jobId: string; options: TransferOptions; onReset: () => void; onJob: (id: string) => void; onSettled?: (job: TransferJob) => void; onReturn?: () => void; allowApply?: boolean; productId?: string; onBusyChange?: (busy: boolean) => void; purpose?: TransferReviewPurpose }) {
  const words = REVIEW_WORDS[purpose]
  const [job, setJob] = useState<TransferJob | null>(null), [outcomes, setOutcomes] = useState<OutcomePage | null>(null)
  const [page, setPage] = useState(1), [filter, setFilter] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sku, setSku] = useState(''), [destination, setDestination] = useState('')
  const defaultFilterSet = useRef(false)
  useEffect(() => {
    if (job && !['STAGING', 'PREVIEWING'].includes(job.state) && !defaultFilterSet.current) {
      defaultFilterSet.current = true
      setFilter(job.state === 'INVALID' ? 'INVALID' : job.state === 'PARTIAL' ? 'FAILED' : job.hasChangeFilter && job.counts.changed ? 'CHANGED' : '')
    }
  }, [job])
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  const active = !!job && ['STAGING', 'RUNNING', 'PREVIEWING'].includes(job.state)
  const notified = useRef('')
  useEffect(() => {
    if (job && ['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.state) && notified.current !== `${job.jobId}:${job.state}`) {
      notified.current = `${job.jobId}:${job.state}`
      onSettled?.(job)
    }
  }, [job, onSettled])
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await transferApi<TransferJob>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}`, undefined, abort.signal)
        if (abort.signal.aborted) return
        if (productId && result.boundary?.productId !== productId) throw new Error('This review belongs to another product workflow. Upload a file for this product.')
        setJob(result)
        if (['RUNNING', 'PREVIEWING', 'STAGING'].includes(result.state)) timer = setTimeout(poll, 1500)
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [jobId, job?.state, productId, attempt])
  useEffect(() => {
    if (!job || job.state === 'PREVIEWING') return
    const abort = new AbortController(); setOutcomes(null)
    if (job.cells) {
      const cells = job.cells.slice((page - 1) * 50, page * 50)
      setOutcomes({ total: job.cells.length, page, pageSize: 50, rows: cells.map((c, i) => ({ id: String(i), index: c.row, status: c.verdict, identity: c, cells: [c], issues: [], exclusions: [] })) })
    } else void transferApi<OutcomePage>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}/outcomes?${new URLSearchParams({ page: String(page), ...(filter ? { status: filter } : {}), ...(sku ? { sku } : {}), ...(destination ? { destination } : {}) })}`, undefined, abort.signal).then(r => { if (!abort.signal.aborted) setOutcomes(r) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [jobId, page, filter, sku, destination, job?.state, job?.processed, attempt])
  const apply = async () => {
    if (!job || !allowApply) return
    setBusy(true); setError('')
    try { setJob(await transferApi<TransferJob>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}/apply`, { reviewToken: job.reviewToken })) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const retry = async () => {
    setBusy(true); setError('')
    try { const next = await transferApi<TransferJob>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}/retry`, {}); onJob(next.jobId) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const counts = job?.counts
  const title = job?.state === 'PREVIEWING' ? words.checking : job?.state === 'RUNNING' ? 'Saving catalog changes' : job?.state === 'COMPLETED' ? 'Changes saved in Nexus' : job?.state === 'FAILED' ? words.stopped : job?.state === 'PARTIAL' ? words.partial : 'Review the proposed changes'
  return <Card header={<h2>{title}</h2>} description={job?.filename ?? 'Loading saved import'}><div className={styles.stack}>
    {error && <Banner tone="danger" action={<Button disabled={busy} onClick={() => { setError(''); setAttempt(n => n + 1) }}>Reload review</Button>}>{error}</Banner>}
    {job?.error && <Banner tone="danger">{job.error}</Banner>}
    {job?.boundary && <Banner tone="info" title="Product import scope">
      <p>{job.boundary.products.map(p => p.sku).join(', ')}</p>
      <p>{job.boundary.includeShared ? `Shared details${job.boundary.locales.length ? ` and ${job.boundary.locales.map(languageName).join(', ')} content` : ''} · ` : ''}{job.boundary.listings.length} selected listings. Other products and destinations cannot be added to this review.</p>
      {job.boundary.includeShared && <p>Shared changes can affect variants and listings that inherit these values, including destinations outside this file. Existing destination overrides are preserved.</p>}
    </Banner>}
    {job?.receipt && <Banner tone={job.receipt.failed || job.receipt.unprocessed ? 'warning' : 'success'} title={words.receipt}><p>{job.receipt.saved} records saved · {job.receipt.unchanged} unchanged · {job.receipt.failed} refused · {job.receipt.excluded} excluded · {job.receipt.unprocessed} unprocessed.</p></Banner>}
    {counts && <><p className={styles.secondary}>{words.totals}{active ? ' (still processing)' : ''} · proposed changes</p><MetricStrip className={styles.reviewMetrics} metrics={[
      { value: counts.productsAffected ?? counts.productsCreated, label: 'Shared record changes' }, { value: counts.listingsAffected ?? counts.listingsCreated, label: 'Listing record changes' },
      { value: counts.changed, label: 'Attribute changes' }, { value: counts.refused, label: 'Issues to fix' },
      { value: counts.unchanged, label: 'Unchanged attributes' }, { value: counts.excluded ?? 0, label: 'Excluded inputs' },
    ]} /></>}
    {job && <>
      {job.state === 'COMPLETED' && <Banner tone="success" title={words.completedTitle}>{words.completedBody}</Banner>}
      {job.state === 'QUEUED' && <p>{counts?.changed ? 'Check the destination and before/after values below. Saving applies these changes to Nexus; it does not publish listings.' : words.noChanges}</p>}
      {!!counts?.excluded && <Banner tone="warning" title={words.excludedTitle(counts.excluded.toLocaleString())} action={<Button size="sm" onClick={() => { setFilter('EXCLUDED'); setPage(1) }}>Review excluded inputs</Button>}>{words.excludedBody}</Banner>}
      {counts && <Disclosure summary="Details of preserved values and overrides"><p>{counts.newOverrides ?? 0} new overrides · {counts.preservedOverrides ?? 0} existing override entries preserved. An override replaces a shared value only for its listed destination.</p></Disclosure>}
      {active && <><ProgressBar ariaLabel={title} value={job.processed / Math.max(1, job.total) * 100} /><p>{words.closeNote}</p></>}
      <p role="status">{active ? `${job.processed} of ${job.total} records checked in this phase; totals above are still accumulating.` : job.state === 'QUEUED' || job.state === 'INVALID' ? words.reviewed(job.total.toLocaleString()) : `${job.processed} of ${job.total} records processed. Inspect outcomes for individual refusals.`}</p>
      {job.policy && <p className={styles.secondary}>Source policy: shared facts — {job.policy.shared}; listing changes — {job.policy.overrides}. Blank and omitted values are preserved.</p>}
      {job.state === 'INVALID' && <Banner tone="danger" title={words.invalidTitle}>{words.invalidBody}</Banner>}
      {job.unmappedColumns?.length ? <Disclosure summary={`${job.unmappedColumns.length} unmapped columns excluded`}><p>{job.unmappedColumns.join(', ')}</p></Disclosure> : null}
      {job.issues?.length ? <Banner tone="danger">{job.issues.map((i, n) => <p key={n}>{i.sku} · {i.field}: {i.message}</p>)}</Banner> : null}
    </>}
    {job && job.state !== 'PREVIEWING' && <>
      {job.boundary && <div className={styles.fields}>
        <Field label="Filter by SKU"><Listbox value={sku} emptyLabel="All selected SKUs" options={job.boundary.products.map(p => ({ value: p.sku, label: p.sku }))} onChange={v => { setSku(v); setPage(1) }} searchable width="100%" /></Field>
        <Field label="Filter by listing"><Listbox value={destination} emptyLabel="All destinations" options={[...(job.boundary.includeShared ? [{ value: JSON.stringify(['', '', '', '']), label: 'Shared product details' }] : []), ...[...new Map(job.boundary.listings.map(l => [JSON.stringify([l.channel, l.accountId, l.marketplace, l.aliasKey]), { value: JSON.stringify([l.channel, l.accountId, l.marketplace, l.aliasKey]), label: `${channelName(l.channel)} ${l.marketplace} · ${options.accounts.find(a => a.id === l.accountId)?.displayName ?? l.accountId} · ${l.aliasLabel ?? (l.aliasKey || 'Primary listing')}` }])).values()]]} onChange={v => { setDestination(v); setPage(1) }} searchable width="100%" /></Field>
      </div>}
      <div className={styles.tableTools}>
        <Field label="Record outcomes"><Listbox options={[...(job.hasChangeFilter ? [{ value: 'CHANGED', label: 'Changed values' }, { value: 'UNCHANGED', label: 'Unchanged records' }] : []), { value: '', label: 'All outcomes' }, { value: 'INVALID', label: 'Validation failures / conflicts' }, { value: 'EXCLUDED', label: 'Excluded inputs' }, { value: 'SUCCESS', label: 'Processed successfully' }, { value: 'FAILED', label: 'Apply refusals' }]} value={filter} onChange={v => { setFilter(v); setPage(1) }} disabled={!!job.cells} /></Field>
        <Button asChild variant="link"><a href={`${getBackendUrl()}/api/catalog-transfer/jobs/${encodeURIComponent(jobId)}/errors`} download>Download all errors</a></Button>
      </div>
      <p>{outcomes ? `${outcomes.total.toLocaleString()} matching record outcomes · page ${page} of ${Math.max(1, Math.ceil(outcomes.total / 50))}` : 'Loading outcomes…'}</p>
      {(sku || destination || filter) && <p className={styles.secondary}>{job.state === 'QUEUED' ? words.filtersQueued(counts?.changed ?? 0) : words.filtersDone}</p>}
      {outcomes?.rows.map(row => <Outcome key={`${row.id}:${filter}`} row={row} options={options} changesOnly={filter === 'CHANGED'} historical={['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'].includes(job.state)} />)}
      <Pagination page={page} pageCount={Math.max(1, Math.ceil((outcomes?.total ?? 0) / 50))} onPage={setPage} />
    </>}
    {!!job?.warnings.length && <Banner tone="warning" title="Review notes">{job.warnings.map(w => <p key={w}>{w}</p>)}</Banner>}
    <div className={styles.actions}>
      {purpose === 'file' && <Button disabled={busy || active || !job && !error} onClick={onReset}>Upload another file</Button>}
      {purpose === 'file' && job && ['COMPLETED', 'PARTIAL'].includes(job.state) && (onReturn ? <Button variant="primary" onClick={onReturn}>Return to product</Button> : <Button asChild variant="primary"><Link href={`/products/listing-readiness${job.cells ? '' : `?job=${encodeURIComponent(jobId)}`}`}>Check saved products for listing</Link></Button>)}
      {purpose === 'file' && job && ['PARTIAL', 'FAILED'].includes(job.state) && <Button disabled={busy || !allowApply} onClick={retry}>Review unprocessed or refused records again</Button>}
      {job?.state === 'QUEUED' && !counts?.refused && (!!counts?.changed || purpose === 'copy') && <Button variant="primary" disabled={busy || !allowApply} onClick={apply}>{busy ? words.saving : words.save}</Button>}
    </div>
  </div></Card>
}
function Outcome({ row, options, changesOnly, historical }: { row: TransferOutcome; options: TransferOptions; changesOnly: boolean; historical: boolean }) {
  const [page, setPage] = useState(1)
  const [preservedPage, setPreservedPage] = useState(1)
  const id = row.identity
  const cells = changesOnly ? row.cells.filter(c => c.verdict === 'changed') : row.cells
  const alias = options.listings?.find(l => l.channel === id?.channel && l.accountId === id?.accountId && l.marketplace === id?.marketplace && l.aliasKey === id?.aliasKey)?.aliasLabel ?? (id?.aliasKey || 'Primary listing')
  const account = options.accounts.find(a => a.id === id?.accountId)?.displayName ?? id?.accountId
  const market = options.markets.find(m => m.channel === id?.channel && m.code === id?.marketplace)?.name ?? id?.marketplace
  const scope = id?.entity === 'Products' ? id.locale ? `${languageName(id.locale)} content` : 'Shared product details' : id ? `${channelName(id.channel)} ${market} · ${account} · ${alias}` : ''
  const changed = row.cells.some(c => c.verdict === 'changed')
  const status = ({ REVIEWED: changed ? 'Ready to save' : 'Unchanged', INVALID: 'Needs correction', EXCLUDED: 'Excluded', SUCCESS: changed ? 'Saved' : 'Unchanged', FAILED: 'Could not save', RUNNING: 'Saving', SKIPPED: 'Skipped', changed: 'Changed', unchanged: 'Unchanged', refused: 'Needs correction' } as Record<string, string>)[row.status] ?? row.status
  return <Disclosure open={changesOnly || row.status === 'INVALID' || row.status === 'FAILED' ? true : undefined} summary={`${id?.sku || row.issues[0]?.sku || `Record ${row.index}`} · ${scope} · ${status} · ${cells.length} attributes`}>
    <div className={styles.stack}>
      {row.error && <Banner tone="danger">{row.error}</Banner>}
      {row.issues.map((issue, i) => <p key={i}>{[issue.source?.file, issue.source?.sheet, `${issue.source?.column ?? 'Row '}${issue.row}`].filter(Boolean).join(' · ')} · {issue.field}: {issue.message}</p>)}
      {row.exclusions.map((issue, i) => <p key={i}>Row {issue.row} · {issue.field}: {issue.message}</p>)}
      {!!row.preserved?.length && <Disclosure summary={`${row.preserved.length} existing override entries preserved`}>
        <DataGrid ariaLabel={`Preserved overrides for ${id?.sku}`} columns={previewColumns(options.accounts, options.listings, historical)} rows={row.preserved.slice((preservedPage - 1) * 25, preservedPage * 25)} rowKey={c => JSON.stringify([c.field, c.channel, c.marketplace, c.accountId, c.aliasKey])} size="sm" />
        {row.preserved.length > 25 && <Pagination page={preservedPage} pageCount={Math.ceil(row.preserved.length / 25)} onPage={setPreservedPage} />}
      </Disclosure>}
      {!!cells.length && <>
        <DataGrid ariaLabel={`Attribute outcomes for ${id?.sku} · ${alias}`} columns={previewColumns(options.accounts, options.listings, historical)} rows={cells.slice((page - 1) * 25, page * 25)} rowKey={c => JSON.stringify([c.row, c.field, c.locale, c.marketplace, c.accountId, c.aliasKey])} size="sm" />
        {cells.length > 25 && <><p>{cells.length} attributes · page {page} of {Math.ceil(cells.length / 25)}</p><Pagination page={page} pageCount={Math.ceil(cells.length / 25)} onPage={setPage} /></>}
      </>}
    </div>
  </Disclosure>
}
