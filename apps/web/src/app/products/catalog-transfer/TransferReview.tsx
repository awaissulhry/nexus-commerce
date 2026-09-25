'use client'
import { useEffect, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Button } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, Listbox, MetricStrip, Pagination, ProgressBar, useActionConfirm } from '@/design-system/components'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { DataGrid } from '@/design-system/grid/datagrid'
import { getBackendUrl } from '@/lib/backend-url'
import type { OutcomePage, TransferJob, TransferOptions, TransferOutcome } from './sourceMapping'
import { transferApi } from './transferApi'
import { previewColumns } from './previewColumns'
import { channelName, languageName } from './workbookSelection'
import { blankSentence, invalidBody, outcomeSummary, recheckLabel } from './reviewText'
import { applyRequest, confirmedDeletes, deleteKey, deleteName, hasReadyRecords, linkChoices, NO_CONFIRMATIONS, pendingDeletes, recheckConfirmations, toggleDelete, toggleLink, type Confirmations } from './reviewConfirmations'
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

/**
 * `onRecheck` (CFI-4 / CFI-3) re-sends the SAME file with the Owner's confirmations and swaps to the new
 * review; it is absent when the file is no longer in hand (a review reopened from a link), and the
 * panel then says to upload the file again. `confirmed` = what this review was checked with.
 */
export function TransferReview({ jobId, options, onReset, onJob, onSettled, onReturn, allowApply = true, productId, onBusyChange, purpose = 'file', onRecheck, confirmed = NO_CONFIRMATIONS }: { jobId: string; options: TransferOptions; onReset: () => void; onJob: (id: string) => void; onSettled?: (job: TransferJob) => void; onReturn?: () => void; allowApply?: boolean; productId?: string; onBusyChange?: (busy: boolean) => void; purpose?: TransferReviewPurpose; onRecheck?: (confirmations: Confirmations) => Promise<void> | void; confirmed?: Confirmations }) {
  const words = REVIEW_WORDS[purpose]
  const [job, setJob] = useState<TransferJob | null>(null), [outcomes, setOutcomes] = useState<OutcomePage | null>(null)
  const [page, setPage] = useState(1), [filter, setFilter] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sku, setSku] = useState(''), [destination, setDestination] = useState('')
  const [selectedLinks, setSelectedLinks] = useState<Record<string, string>>({}), [endSkus, setEndSkus] = useState<string[]>([])
  const confirmStep = useActionConfirm()
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
  const apply = async (readyOnly = false) => {
    if (!job || !allowApply) return
    setBusy(true); setError('')
    try { setJob(await transferApi<TransferJob>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}/apply`, applyRequest(job, readyOnly))) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  // CFI-7 — the refused records stay listed and unsaved; only the ready ones are written, in Nexus only.
  const applyReady = async () => {
    if (!job || !allowApply) return
    const refused = job.counts?.refused ?? 0
    const ok = await confirmStep.ask({ level: 'confirm', title: 'Save the ready records and skip the ones that need correction?', consequences: [
      `${refused.toLocaleString()} ${refused === 1 ? 'issue needs' : 'issues need'} correction. The records they belong to are skipped: nothing in them is saved, and they stay listed in this review.`,
      'Every other reviewed record is saved in Nexus.',
      'Nothing is sent to Amazon or eBay. Publishing stays a separate step.',
      'Correct the file and import it again to save the skipped records.',
    ] })
    if (ok) await apply(true)
  }
  const recheck = async () => {
    if (!onRecheck) return
    setBusy(true); setError('')
    try { await onRecheck(recheckConfirmations(confirmed, selectedLinks, endSkus, job ?? {})) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
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
    {job?.receipt && <Banner tone={job.receipt.failed || job.receipt.unprocessed || job.receipt.skipped ? 'warning' : 'success'} title={words.receipt}><p>{job.receipt.saved} records saved · {job.receipt.unchanged} unchanged · {job.receipt.failed} refused · {job.receipt.excluded} excluded · {job.receipt.unprocessed} unprocessed{job.receipt.skipped ? ` · ${job.receipt.skipped} skipped because they needed correction` : ''}.</p></Banner>}
    {counts && <><p className={styles.secondary}>{words.totals}{active ? ' (still processing)' : ''} · proposed changes</p><MetricStrip className={styles.reviewMetrics} metrics={reviewMetrics(counts)} /></>}
    {job && <>
      {job.state === 'COMPLETED' && <Banner tone="success" title={words.completedTitle}>{words.completedBody}</Banner>}
      {job.state === 'QUEUED' && <p>{counts?.changed ? 'Check the destination and before/after values below. Saving applies these changes to Nexus; it does not publish listings.' : words.noChanges}</p>}
      {!!counts?.excluded && <Banner tone="warning" title={words.excludedTitle(counts.excluded.toLocaleString())} action={<Button size="sm" onClick={() => { setFilter('EXCLUDED'); setPage(1) }}>Review excluded inputs</Button>}>{words.excludedBody}</Banner>}
      {counts && <ChannelFileCounts counts={counts} />}
      {!!counts?.clearUnchecked && <Banner tone="warning" title={`${counts.clearUnchecked.toLocaleString()} blank ${counts.clearUnchecked === 1 ? 'cell was' : 'cells were'} not cleared`}>The file&apos;s full update leaves {counts.clearUnchecked === 1 ? 'this value' : 'these values'} blank, but Nexus could not read its current value for that market, so nothing was cleared. Check {counts.clearUnchecked === 1 ? 'it' : 'them'} in the product sheet.</Banner>}
      {counts && <Disclosure summary="Details of preserved values and overrides"><p>{counts.newOverrides ?? 0} new overrides · {counts.preservedOverrides ?? 0} existing override entries preserved. An override replaces a shared value only for its listed destination.</p></Disclosure>}
      {['QUEUED', 'INVALID'].includes(job.state) && <ReviewConfirmations job={job} busy={busy} canRecheck={!!onRecheck} confirmed={confirmed} selectedLinks={selectedLinks} onLinks={setSelectedLinks} endSkus={endSkus} onEndSkus={setEndSkus} onRecheck={recheck} />}
      {active && <><ProgressBar ariaLabel={title} value={job.processed / Math.max(1, job.total) * 100} /><p>{words.closeNote}</p></>}
      <p role="status">{active ? `${job.processed} of ${job.total} records checked in this phase; totals above are still accumulating.` : job.state === 'QUEUED' || job.state === 'INVALID' ? words.reviewed(job.total.toLocaleString()) : `${job.processed} of ${job.total} records processed. Inspect outcomes for individual refusals.`}</p>
      <PolicyNote job={job} />
      {job.state === 'INVALID' && <Banner tone="danger" title={purpose === 'file' && hasReadyRecords(job) ? 'Some records need correction' : words.invalidTitle}>{invalidBody(job, words.invalidBody, purpose === 'file')}</Banner>}
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
      {purpose === 'file' && job && hasReadyRecords(job) && <Button variant="secondary" disabled={busy || !allowApply} onClick={() => void applyReady()}>{busy ? words.saving : 'Save the ready records'}</Button>}
      {job?.state === 'QUEUED' && !counts?.refused && (!!counts?.changed || purpose === 'copy') && <Button variant="primary" disabled={busy || !allowApply} onClick={() => void apply()}>{busy ? words.saving : words.save}</Button>}
    </div>
    {confirmStep.element}
  </div></Card>
}

/** The review totals. Numbers carry the locale's separators, like every other count on the page (1,160 not 1160). */
export function reviewMetrics(counts: TransferJob['counts']) {
  const n = (v: number | undefined) => (v ?? 0).toLocaleString()
  return [
    { value: n(counts.productsAffected ?? counts.productsCreated), label: 'Shared record changes' }, { value: n(counts.listingsAffected ?? counts.listingsCreated), label: 'Listing record changes' },
    { value: n(counts.changed), label: 'Attribute changes' }, { value: n(counts.refused), label: 'Issues to fix' },
    { value: n(counts.unchanged), label: 'Unchanged attributes' }, { value: n(counts.excluded), label: 'Excluded inputs' },
  ]
}

/** The source policy and what blanks do in THIS review (a channel file's full-update blank removes a value). */
export function PolicyNote({ job }: { job: Pick<TransferJob, 'policy' | 'counts'> }) {
  return job.policy ? <p className={styles.secondary}>Source policy: shared facts — {job.policy.shared}; listing changes — {job.policy.overrides}. {blankSentence(job.counts)}</p> : null
}

/** CFI — what a channel file does beyond attribute changes. Shown only when it does any of it. */
export function ChannelFileCounts({ counts }: { counts: TransferJob['counts'] }) {
  const parts = [
    counts.cleared ? `${counts.cleared.toLocaleString()} values Amazon removed — cleared in Nexus` : '',
    counts.alreadyEmpty ? `${counts.alreadyEmpty.toLocaleString()} removed values already empty in Nexus` : '',
    counts.ended ? `${counts.ended.toLocaleString()} ${counts.ended === 1 ? 'listing' : 'listings'} to mark ended` : '',
    counts.pricesRecorded ? `${counts.pricesRecorded.toLocaleString()} prices recorded, not sent` : '',
  ].filter(Boolean)
  return parts.length ? <p className={styles.secondary}>From the channel file · {parts.join(' · ')}</p> : null
}

/**
 * CFI-4 links and CFI-3 deletes, both confirmed BEFORE a new check of the same file. Nothing here
 * writes: ticking only chooses what the next check is allowed to plan.
 */
export function ReviewConfirmations({ job, busy, canRecheck, confirmed, selectedLinks, onLinks, endSkus, onEndSkus, onRecheck }: {
  job: TransferJob; busy: boolean; canRecheck: boolean; confirmed: Confirmations
  selectedLinks: Record<string, string>; onLinks: (next: Record<string, string>) => void
  endSkus: string[]; onEndSkus: (next: string[]) => void; onRecheck: () => void
}) {
  const proposals = job.links ?? [], pending = pendingDeletes(job), ended = confirmedDeletes(job)
  const done = Object.entries(confirmed.links)
  if (!proposals.length && !pending.length && !ended.length && !done.length) return null
  const choices = linkChoices(proposals, selectedLinks)
  const shownPending = pending.map(d => d.fileSku)
  const ticked = endSkus.filter(sku => shownPending.includes(sku))
  const chosen = Object.keys(selectedLinks).length > 0 || ticked.length > 0
  return <div className={styles.stack}>
    {!!done.length && <p className={styles.secondary}>Confirmed links in this check: {done.map(([from, to]) => `${from} → ${to}`).join(', ')}</p>}
    {!!ended.length && <Banner tone="info" title={`${ended.length} ${ended.length === 1 ? 'listing' : 'listings'} will be marked ended in Nexus`}>
      <ul className={styles.issues}>{ended.map(d => <li key={deleteKey(d)}>{deleteName(d, channelName)}</li>)}</ul>
      <p>Saving marks {ended.length === 1 ? 'it' : 'them'} ended in Nexus only. Nothing is sent to Amazon or eBay.</p>
    </Banner>}
    {!!proposals.length && <Banner tone="warning" title="Confirm which Nexus product these file SKUs are">
      <p>The file uses SKUs that are not Nexus SKUs. Nexus found a likely match for each. Rows for an unconfirmed SKU are not saved.</p>
      <div className={styles.stack} role="group" aria-label="Proposed product links">{choices.map(c => <div key={c.proposal.fileSku} className={styles.choice}>
        <Checkbox checked={c.checked} disabled={busy || c.disabled} onChange={() => onLinks(toggleLink(proposals, selectedLinks, c.proposal.fileSku))}
          label={`File parent ${c.proposal.fileSku} → Nexus ${c.proposal.proposedSku}`} />
        <span className={styles.secondary}>{c.proposal.reason}</span>
        {c.reason && <span className={styles.secondary}>{c.reason}</span>}
      </div>)}</div>
    </Banner>}
    {!!pending.length && <Banner tone="danger" title={`The file deletes ${pending.length} ${pending.length === 1 ? 'listing' : 'listings'} on the channel`}>
      <p>A file can be older than the channel. Check the evidence before you confirm.</p>
      <p>Tick each listing to mark ended in Nexus. Nothing is sent to Amazon or eBay.</p>
      <div className={styles.issues} role="group" aria-label="Listings the file deletes">{pending.map(d => <div key={deleteKey(d)} className={styles.choice}>
        <Checkbox tone="warning" checked={ticked.includes(d.fileSku)} disabled={busy} onChange={() => onEndSkus(toggleDelete(shownPending, endSkus, d.fileSku))} label={`Mark ${deleteName(d, channelName)} ended in Nexus`} />
        {d.evidence && <span className={styles.secondary}>{d.evidence}</span>}
      </div>)}</div>
    </Banner>}
    {(!!proposals.length || !!pending.length) && (canRecheck
      ? <div><Button disabled={busy || !chosen} onClick={onRecheck}>{recheckLabel(Object.keys(selectedLinks).length, ticked.length, proposals.length, pending.length)}</Button></div>
      : <p className={styles.secondary}>To confirm, upload the same file again. This review was opened without its file.</p>)}
  </div>
}
function Outcome({ row, options, changesOnly, historical }: { row: TransferOutcome; options: TransferOptions; changesOnly: boolean; historical: boolean }) {
  const [page, setPage] = useState(1)
  const [preservedPage, setPreservedPage] = useState(1)
  const id = row.identity
  const cells = changesOnly ? row.cells.filter(c => c.verdict === 'changed') : row.cells
  const alias = options.listings?.find(l => l.channel === id?.channel && l.accountId === id?.accountId && l.marketplace === id?.marketplace && l.aliasKey === id?.aliasKey)?.aliasLabel ?? (id?.aliasKey || 'Primary listing')
  const changed = row.cells.some(c => c.verdict === 'changed')
  const status = ({ REVIEWED: changed ? 'Ready to save' : 'Unchanged', INVALID: 'Needs correction', EXCLUDED: 'Excluded', SUCCESS: changed ? 'Saved' : 'Unchanged', FAILED: 'Could not save', RUNNING: 'Saving', SKIPPED: 'Skipped', changed: 'Changed', unchanged: 'Unchanged', refused: 'Needs correction' } as Record<string, string>)[row.status] ?? row.status
  return <Disclosure open={changesOnly || row.status === 'INVALID' || row.status === 'FAILED' ? true : undefined} summary={outcomeSummary(row, options, status, cells.length)}>
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
