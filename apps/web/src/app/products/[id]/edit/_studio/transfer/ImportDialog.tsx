'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SheetImportChange, SheetImportChangesPage, SheetImportStatus } from '@nexus/shared/catalog-transfer'
import { Button, Checkbox, SegmentedControl, Tag } from '@/design-system/primitives'
import { Banner, Disclosure, FileDropzone, FileRow, JobProgress, MetricStrip, Modal, Pagination, useToast } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid, identical props) — the retiring `components/DataGrid` is on the grid-kit ratchet.
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { useStudioSave } from '../contracts'
import { PublishDialog } from '../publication/PublishDialog'
import { sheetTransferApi } from './sheetTransferApi'
import { applyLabel, cellValue, changeCells, doneView, formatLabel, IMPORT_ACCEPT, IMPORT_MAX_BYTES, isBusy, isFinished, openFamilyActions, STATUS_LABELS, summaryLine, whereInFile } from './importModel'
import styles from './sheetTransfer.module.css'

const POLL_MS = 700
type Filter = 'all' | 'problems'
type Decisions = { links: Record<string, string>; confirmDeletes: string[] }
const TONES: Record<SheetImportChange['status'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { ready: 'info', new: 'info', problem: 'danger', saved: 'success', failed: 'danger', skipped: 'warning' }
/** A check or save still running when the page reloads is picked up again; a finished one never is. */
const runningKey = (productId: string) => `psie:running-import:${productId}`
const remember = (productId: string, jobId: string | null) => {
  try { if (jobId) sessionStorage.setItem(runningKey(productId), jobId); else sessionStorage.removeItem(runningKey(productId)) } catch { /* storage unavailable: nothing to resume */ }
}

/* 2026-10-01 (edit ≤ 60 renders) — only the OPEN dialog reads the sheet's save state. The dialog stays mounted while
   closed so a running import keeps going; reading the save state at its top repainted it, and its Modal, on every
   sheet edit. The DS Modal renders nothing while closed, so these two subscribe only while it is open. */
function useSheetUnsaved(): boolean {
  const save = useStudioSave()
  return save.kind === 'saving' || save.kind === 'error'
}

function ApplyButton({ label, needsConfirmation, onClick }: { label: string | null; needsConfirmation: boolean; onClick(): void }) {
  const unsaved = useSheetUnsaved()
  return <Button size="sm" variant="primary" disabled={!label || unsaved || needsConfirmation} onClick={onClick}>{label ?? 'Nothing to apply'}</Button>
}

function UnsavedEditsBanner() {
  return useSheetUnsaved() ? <Banner tone="warning">Finish saving your edits in the sheet first. Then apply.</Banner> : null
}

/**
 * PSIE — Import: drop a file → one summary → Apply → done, with Undo. No format, scope or language choice: the file
 * says what it is and what it touches. Saving writes Nexus only; publishing is its own step (the Owner's D1 (a)).
 * The dialog stays mounted while closed, so a save keeps going and the sheet refreshes when it ends.
 */
export function ImportDialog({ open, onClose, productId, market, onApplied }: { open: boolean; onClose(): void; productId: string; market: string; onApplied(): void }) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState<number | null>(null)
  const [status, setStatus] = useState<SheetImportStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [changes, setChanges] = useState<SheetImportChangesPage | null>(null)
  const [decisions, setDecisions] = useState<Decisions>({ links: {}, confirmDeletes: [] })
  const [publishing, setPublishing] = useState(false)
  /** When the save (or the undo's save) started on this page: the job's own start is the upload. */
  const [savingSince, setSavingSince] = useState<number | null>(null)
  const settled = useRef(new Set<string>())
  const openRef = useRef(open)
  openRef.current = open

  const reset = () => { setFile(null); setReading(null); setStatus(null); setError(null); setFilter('all'); setPage(1); setChanges(null); setDecisions({ links: {}, confirmDeletes: [] }); setSavingSince(null) }
  const close = () => {
    // A finished import is not shown again next time; one still running keeps going and is shown on reopening.
    if (isFinished(status) || !status && !reading) reset()
    onClose()
  }

  const upload = async (picked: File, chosen: Decisions = { links: {}, confirmDeletes: [] }) => {
    setFile(picked); setError(null); setStatus(null); setChanges(null); setReading(Date.now())
    try {
      setStatus(await sheetTransferApi.startImport(productId, picked, market, { links: chosen.links, confirmDeletes: chosen.confirmDeletes.length ? chosen.confirmDeletes : undefined }))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setReading(null) }
  }

  // Poll while the server checks or saves; stop when it is done. A closed dialog keeps polling a save.
  const jobId = status?.jobId
  const busy = isBusy(status)
  useEffect(() => {
    if (!jobId || !busy) return
    let stop = false
    const tick = async () => {
      while (!stop) {
        await new Promise(r => setTimeout(r, POLL_MS))
        if (stop) return
        try {
          const next = await sheetTransferApi.status(jobId)
          if (stop) return
          setStatus(next)
          if (!isBusy(next)) return
        } catch { /* a missed poll is retried on the next tick */ }
      }
    }
    void tick()
    return () => { stop = true }
  }, [jobId, busy])

  // Picked up after a reload: a check or save that was still running when the page went away.
  useEffect(() => {
    let jobId: string | null = null
    try { jobId = sessionStorage.getItem(runningKey(productId)) } catch { /* no storage */ }
    if (!jobId) return
    sheetTransferApi.status(jobId).then(found => { if (isBusy(found)) setStatus(current => current ?? found); else remember(productId, null) }, () => remember(productId, null))
  }, [productId])
  useEffect(() => { if (status) remember(productId, isBusy(status) ? status.jobId : null) }, [status, productId])

  // Readiness is rebuilt right after the save: while it is pending, keep asking; when it lands, reload the sheet again
  // so its readiness column is current.
  const readinessPending = isFinished(status) && status?.readiness === 'pending'
  useEffect(() => {
    if (!jobId || !readinessPending) return
    let stop = false
    const tick = async () => {
      while (!stop) {
        await new Promise(r => setTimeout(r, 1500))
        if (stop) return
        try {
          const next = await sheetTransferApi.status(jobId)
          if (stop) return
          if (next.readiness !== 'pending') { setStatus(next); onApplied(); return }
        } catch { /* retried on the next tick */ }
      }
    }
    void tick()
    return () => { stop = true }
  }, [jobId, readinessPending, onApplied])

  // A save or an undo that ends refreshes the sheet once, and says so when the dialog is closed.
  useEffect(() => {
    if (!status || !isFinished(status) || settled.current.has(status.jobId)) return
    settled.current.add(status.jobId)
    if (!openRef.current) { const view = doneView(status); toast(view.title, view.tone === 'success' ? 'success' : view.tone) }
    if ((status.receipt?.saved ?? 0) > 0) {
      onApplied()
      emitInvalidation({ type: 'product.updated', id: productId, meta: { source: 'sheet-import', jobId: status.jobId } })
      emitInvalidation({ type: 'listing.updated', meta: { source: 'sheet-import', jobId: status.jobId } })
    }
  }, [status, onApplied, productId, toast])

  // The summary's table: every changed cell and every problem, 100 per page.
  const loadChanges = useCallback(async (id: string, nextFilter: Filter, nextPage: number) => {
    try { setChanges(await sheetTransferApi.changes(id, { filter: nextFilter, page: nextPage })) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  const state = status?.state
  useEffect(() => { if (jobId && state && !isBusy(status)) void loadChanges(jobId, filter, page) }, [jobId, state, filter, page, loadChanges]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (!status?.reviewToken) return
    setError(null)
    setSavingSince(Date.now())
    try { setStatus(await sheetTransferApi.apply(status.jobId, status.reviewToken)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const undo = async () => {
    if (!status) return
    setError(null); setChanges(null); setFilter('all'); setPage(1); setSavingSince(Date.now())
    try { setStatus(await sheetTransferApi.undo(status.jobId)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const needsConfirmation = !!status && (status.links.length > 0 || status.deletes.some(d => !d.confirmed))
  const label = status?.state === 'READY' ? applyLabel(status) : null
  const done = isFinished(status) ? doneView(status!) : null
  // A family the file created is another product: the done screen opens it, and it is published from there.
  const opens = openFamilyActions(status)
  const columns: Column<SheetImportChange>[] = [
    { key: 'sku', label: 'SKU', width: 190, className: styles.skuCol, render: c => <span className={styles.mono} title={c.sku}>{c.sku}</span> },
    { key: 'where', label: 'Where', width: 120, className: styles.whereCol, render: c => c.destination },
    { key: 'column', label: 'Column', width: 140, className: styles.fieldCol, render: c => <span title={c.field}>{c.label}{c.locale && c.entity !== 'Products' ? ` · ${c.locale}` : ''}</span> },
    { key: 'now', label: 'Now', width: 230, className: styles.valueCol, render: c => <span className={styles.value} title={cellValue(c, 'before', 4000)}>{changeCells(c)[0]}</span> },
    { key: 'new', label: 'New', width: 230, className: styles.valueCol, render: c => c.problem && (c.status === 'problem' || c.status === 'failed')
      ? <span className={styles.problem}>{c.problem}{whereInFile(c) ? <span className={styles.muted}> · {whereInFile(c)}</span> : null}</span>
      : <span className={styles.value} title={cellValue(c, 'after', 4000)}>{changeCells(c)[1]}</span> },
    { key: 'status', label: 'Status', width: 96, className: styles.statusCol, render: c => <Tag tone={TONES[c.status]}>{STATUS_LABELS[c.status]}</Tag> },
  ]

  const footer = <>
    {status?.state === 'READY' && <>
      {status.format !== 'undo' && <Button size="sm" variant="secondary" onClick={() => { reset() }}>Choose another file</Button>}
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close}>Cancel</Button>
      <ApplyButton label={label} needsConfirmation={needsConfirmation} onClick={apply} />
    </>}
    {done && <>
      {status?.canUndo && <Button size="sm" variant="secondary" onClick={undo}>Undo</Button>}
      {status?.format !== 'undo' && (status?.receipt?.saved ?? 0) > 0 && !opens.length && <Button size="sm" variant="secondary" onClick={() => { setPublishing(true); close() }}>Publish…</Button>}
      <Button size="sm" variant="secondary" onClick={reset}>Import another file</Button>
      <span className="grow" />
      {opens.map(action => <Button key={action.href} asChild size="sm" variant="primary"><Link href={action.href} onClick={close}>{action.label}</Link></Button>)}
      <Button size="sm" variant={opens.length ? 'secondary' : 'primary'} onClick={close}>Done</Button>
    </>}
    {(!status || busy) && <><span className="grow" /><Button size="sm" variant="secondary" onClick={close}>{busy ? 'Close' : 'Cancel'}</Button></>}
  </>

  return <>
    <Modal open={open} onClose={close} size="xxl" title={status?.format === 'undo' ? 'Undo import' : 'Import'}
      subtitle={status ? undefined : 'Drop a file you exported here, an Amazon template, an eBay file or a CSV.'} footer={footer}>
      <div className={styles.body}>
        {error && <Banner tone="danger" title="This did not work" onDismiss={() => setError(null)}>{error}</Banner>}
        {!file && !status && <FileDropzone accept={IMPORT_ACCEPT} maxBytes={IMPORT_MAX_BYTES} onFiles={files => { if (files[0]) void upload(files[0]) }}
          hint="Only the cells you changed are saved. You see every change before anything is saved." />}
        {file && <FileRow name={file.name} size={file.size} disabled={!!reading || busy}
          status={reading ? 'Reading…' : status && status.state !== 'CHECKING' ? summaryLine(status) : status ? formatLabel(status.format) : undefined}
          onReplace={!reading && !busy && !done && status?.format !== 'undo' ? reset : undefined} />}
        {reading && <JobProgress label="Reading your file" startedAt={reading} />}
        {status?.state === 'CHECKING' && <JobProgress label="Checking every change" startedAt={Date.parse(status.startedAt)} />}
        {status?.state === 'SAVING' && <JobProgress label={status.format === 'undo' ? 'Putting values back' : 'Saving changes'} value={status.processed} max={status.total}
          detail={`${status.processed} of ${status.total} records`} startedAt={savingSince ?? undefined} note="You can close this window. Saving continues in Nexus, and the sheet updates when it is done." />}

        {status?.state === 'READY' && <>
          <MetricStrip metrics={[
            { label: 'Changes', value: status.summary.changes.toLocaleString('en') },
            { label: 'Products', value: status.summary.products.toLocaleString('en') },
            { label: 'Listings', value: status.summary.listings.toLocaleString('en') },
            { label: 'Problems', value: status.summary.problems.toLocaleString('en'), onClick: status.summary.problems ? () => { setFilter('problems'); setPage(1) } : undefined, active: filter === 'problems' },
          ]} />
          <UnsavedEditsBanner />
          {!status.summary.changes && !status.summary.problems && <Banner tone="info">Nothing to change: this file holds the values Nexus already has.</Banner>}
          {status.summary.problems > 0 && <Banner tone="warning" title={`${status.summary.problems.toLocaleString('en')} ${status.summary.problems === 1 ? 'problem' : 'problems'}`}
            action={<a className={styles.link} href={sheetTransferApi.problemsUrl(status.jobId)}>Download the list</a>}>
            {status.format === 'undo' ? 'These values changed again after the import, or cannot be put back here. They are skipped; change them in the sheet.' : 'Rows with a problem are skipped. Fix them in your file and import it again.'}
          </Banner>}
          {/* One closed section for the notes (2026-10-01): they inform, they block nothing. */}
          {status.warnings.length > 0 && <Disclosure summary={`${status.warnings.length} ${status.warnings.length === 1 ? 'note' : 'notes'}`}>
            <ul className={styles.list}>{status.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
          </Disclosure>}
          {needsConfirmation && file && <Banner tone="warning" title="Confirm before applying"
            action={<Button size="sm" variant="secondary" onClick={() => void upload(file, decisions)}>Check again</Button>}>
            <ul className={styles.list}>
              {status.links.map(link => <li key={link.fileSku}><Checkbox label={`${link.fileSku} in the file is ${link.proposedSku} in Nexus (${link.reason})`} checked={decisions.links[link.fileSku] === link.proposedSku}
                onChange={() => setDecisions(d => { const links = { ...d.links }; if (links[link.fileSku]) delete links[link.fileSku]; else links[link.fileSku] = link.proposedSku; return { ...d, links } })} /></li>)}
              {status.deletes.filter(d => !d.confirmed).map(d => <li key={`${d.fileSku}${d.channel}${d.marketplace}`}><Checkbox label={`End the ${d.channel} ${d.marketplace} listing of ${d.sku}: the file deletes it`} checked={decisions.confirmDeletes.includes(d.fileSku)}
                onChange={() => setDecisions(x => ({ ...x, confirmDeletes: x.confirmDeletes.includes(d.fileSku) ? x.confirmDeletes.filter(s => s !== d.fileSku) : [...x.confirmDeletes, d.fileSku] }))} /></li>)}
            </ul>
          </Banner>}
        </>}

        {done && <Banner tone={done.tone} title={done.title}>{done.body}</Banner>}
        {done && status?.readiness === 'pending' && <p className={styles.muted} role="status">Updating readiness for this family… The sheet refreshes when it is done.</p>}
        {done && status?.readiness === 'failed' && <p className={styles.warning} role="status">Readiness could not be updated now. It updates with the next edit of this product.</p>}

        {status && !busy && (status.summary.changes > 0 || status.summary.problems > 0) && <>
          <div className={styles.toolbar}>
            <SegmentedControl ariaLabel="Show" size="sm" value={filter} onChange={value => { setFilter(value as Filter); setPage(1) }} options={[
              { value: 'all', label: 'All' },
              { value: 'problems', label: `Problems${status.summary.problems ? ` · ${status.summary.problems}` : ''}`, disabled: !status.summary.problems && status.state === 'READY' },
            ]} />
            {changes && <span className={styles.muted}>{changes.total.toLocaleString('en')} {changes.total === 1 ? 'row' : 'rows'}</span>}
          </div>
          <DataGrid ariaLabel="Changes in this file" size="sm" keyboardScroll columns={columns} rows={changes?.changes ?? []} rowKey={c => c.id}
            emptyState={<p className={styles.muted}>{changes ? 'Nothing to show here.' : 'Loading…'}</p>} />
          {changes && changes.total > changes.pageSize && <Pagination page={page} pageCount={Math.ceil(changes.total / changes.pageSize)} onPage={setPage} />}
        </>}
      </div>
    </Modal>
    {publishing && <PublishDialog onClose={() => setPublishing(false)} />}
  </>
}
