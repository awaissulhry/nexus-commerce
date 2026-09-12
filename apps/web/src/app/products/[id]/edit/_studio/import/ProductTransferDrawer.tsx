'use client'
import { useEffect, useRef, useState } from 'react'
import type { ProductTransferOptions, ProductTransferSelection } from '@nexus/shared/catalog-transfer'
import { Button, Checkbox, Input, Select } from '@/design-system/primitives'
import { Banner, Disclosure, Drawer, Field, FileDropzone } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useAuth } from '@/lib/auth/AuthProvider'
import { TransferReview } from '@/app/products/catalog-transfer/TransferReview'
import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import { defaultSourceMapping, type SourceInspection, type SourceMapping, type TransferJob } from '@/app/products/catalog-transfer/sourceMapping'
import { SourceMappingEditor } from '@/app/products/catalog-transfer/SourceMappingEditor'
import { channelName, languageName } from '@/app/products/catalog-transfer/workbookSelection'
import { useStudioSave } from '../contracts'
import { editorTransferSelection, updateTransferProducts, transferDestinationGroups, type DestinationMode, type ProductTransferContext } from './productTransferSelection'
import styles from './ProductTransferDrawer.module.css'

interface Props extends ProductTransferContext {
  open: boolean; intent: 'import' | 'export'; selectedIds: string[]
  visibleFields?: string[]
  onClose: () => void; onApplied: () => void; onReference: () => void
}
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value]

/** The editor owns only selection and presentation; preview/apply use the catalog job engine. */
export function ProductTransferDrawer(props: Props) {
  const { open, productId, market, channel, accountId, aliasKey, locale } = props
  const save = useStudioSave()
  const auth = useAuth()
  const canImport = auth.has('products.import'), canExport = auth.has('products.export')
  const unsafe = save.kind === 'saving' || save.kind === 'error'
  const [options, setOptions] = useState<ProductTransferOptions | null>(null)
  const [selection, setSelection] = useState<ProductTransferSelection | null>(null)
  const [productsMode, setProductsMode] = useState('current'), [destinationsMode, setDestinationsMode] = useState<DestinationMode>('current')
  const [search, setSearch] = useState(''), [destinationPage, setDestinationPage] = useState(1)
  const [inputId, setInputId] = useState(''), [showReview, setShowReview] = useState(props.intent === 'import')
  const [sourceMode, setSourceMode] = useState(false), [source, setSource] = useState<SourceInspection | null>(null)
  const [mapping, setMapping] = useState<SourceMapping>(() => defaultSourceMapping([], market, 'update'))
  const [fieldMode, setFieldMode] = useState('all')
  const [jobId, setJobId] = useState(''), [file, setFile] = useState<File | null>(null), [error, setError] = useState(''), [note, setNote] = useState('')
  const [busy, setBusy] = useState(''), [attempt, setAttempt] = useState(0)
  const [reviewBusy, setReviewBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const completed = useRef('')
  const deferred = useRef<TransferJob | null>(null)
  const live = useRef({ unsafe, onApplied: props.onApplied }); live.current = { unsafe, onApplied: props.onApplied }
  const contextKey = JSON.stringify([productId, market, channel, accountId, aliasKey, locale])
  const storageKey = `nexus-product-transfer:${contextKey}`
  // Keep an accepted job recoverable after closing the drawer or reloading this product.
  useEffect(() => {
    abortRef.current?.abort(); setBusy(''); setInputId(''); setSource(null)
    setOptions(null); setSelection(null); setFile(null); setError(''); setNote(''); setProductsMode('current'); setDestinationsMode('current')
    try { setJobId(sessionStorage.getItem(storageKey) ?? '') } catch { setJobId('') }
  }, [storageKey])
  useEffect(() => { if (open) setShowReview(props.intent === 'import') }, [open, props.intent])
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void transferApi<ProductTransferOptions>(`catalog-transfer/products/${encodeURIComponent(productId)}/options`, undefined, abort.signal).then(result => {
      if (abort.signal.aborted) return
      setOptions(result)
      setSelection(current => current ?? editorTransferSelection(result, props, [productId]))
    }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [open, contextKey, attempt])
  useEffect(() => () => abortRef.current?.abort(), [])
  // Saving continues on the server after dismissal; refresh the editor when that job settles.
  useEffect(() => {
    if (open || !jobId) return
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const job = await transferApi<TransferJob>(`catalog-transfer/jobs/${encodeURIComponent(jobId)}`, undefined, abort.signal)
        if (abort.signal.aborted || job.boundary?.productId !== productId) return
        if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.state)) settled(job)
        else if (['STAGING', 'PREVIEWING', 'RUNNING'].includes(job.state)) timer = setTimeout(poll, 1500)
      } catch { /* Reopening review exposes any job-load failure and its recovery action. */ }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [open, jobId, productId])
  useEffect(() => { if (!unsafe && deferred.current) settled(deferred.current) }, [unsafe])
  const rememberJob = (id: string) => {
    setJobId(id)
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey) } catch { /* The current session can still complete the import. */ }
  }
  const changeSelection = (next: ProductTransferSelection) => { setSelection(next); setError(''); setNote('') }
  useEffect(() => { setDestinationPage(1) }, [selection?.productIds.join(',')])
  const chooseProducts = (mode: string) => {
    if (!options) return
    setProductsMode(mode)
    const ids = mode === 'all' ? options.products.map(p => p.id) : mode === 'selected' ? [...new Set(props.selectedIds)].filter(id => options.products.some(p => p.id === id)) : [productId]
    if (selection) changeSelection(updateTransferProducts(options, props, selection, ids, destinationsMode))
  }
  const chooseDestinations = (mode: DestinationMode) => {
    if (!options || !selection) return
    setDestinationsMode(mode)
    if (mode !== 'custom') changeSelection(updateTransferProducts(options, props, selection, selection.productIds, mode))
  }
  const run = async (kind: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (busy || unsafe) return
    setBusy(kind); setError(''); setNote('')
    const abort = new AbortController(); abortRef.current = abort
    try { await action(abort.signal) } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)) } finally { if (abortRef.current === abort) setBusy('') }
  }
  const download = () => run('export', async signal => {
    const response = await fetch(`${getBackendUrl()}/api/catalog-transfer/products/${encodeURIComponent(productId)}/export`, { method: 'POST', credentials: 'include', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market, selection, fields: fieldMode === 'visible' ? [...new Set(props.visibleFields)] : undefined }) })
    if (!response.ok) throw new Error((await response.json()).error ?? 'The export could not be prepared')
    const blob = await response.blob(), url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `nexus-product-editing.${blob.type.split(';')[0] === 'application/zip' ? 'zip' : 'xlsx'}`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNote('Download started. Edit value cells directly; blank or unchanged cells preserve data. Unhide action columns for explicit clearing or inheritance. Keep identities and versions intact. Return the XLSX or complete ZIP here within 30 days.')
  })
  const inspect = (next: File) => run('inspect', async signal => {
    setFile(next); setInputId(''); setSource(null)
    const body = new FormData(); body.set('file', next)
    if (sourceMode) {
      const result = await transferApi<SourceInspection>('catalog-transfer/source/inspect', body, signal)
      if (signal.aborted) return
      setSource(result); setMapping(defaultSourceMapping(result.headers, market, 'update'))
    } else {
      const result = await transferApi<{ inputId: string; selection: ProductTransferSelection; issues: number; warnings: string[] }>(`catalog-transfer/products/${encodeURIComponent(productId)}/inspect`, body, signal)
      if (signal.aborted) return
      setInputId(result.inputId)
      if (result.selection.productIds.length && (result.selection.includeShared || result.selection.listingIds.length)) { setSelection(result.selection); setProductsMode('custom'); setDestinationsMode('custom') }
      setNote(`File read${result.issues ? ` with ${result.issues} issues to inspect in the review` : ''}. Check the products, named listings and languages below. Every input is validated against this selection. ${(result.warnings ?? []).join(' ')}`)
    }
  })
  const preview = () => run('preview', async signal => {
    if (!selection || (!inputId && !source)) return
    const path = `catalog-transfer/products/${encodeURIComponent(productId)}/${sourceMode ? 'source/preview' : 'preview'}`
    const job = await transferApi<TransferJob>(path, sourceMode ? { sourceId: source?.sourceId, inputHash: source?.hash, mapping, selection } : { inputId, market, selection }, signal)
    if (!signal.aborted) { rememberJob(job.jobId); setShowReview(true) }
  })
  const settled = (job: TransferJob) => {
    if (completed.current === job.jobId) return
    if (live.current.unsafe) { deferred.current = job; return }
    completed.current = job.jobId; deferred.current = null
    live.current.onApplied()
    emitInvalidation({ type: 'product.updated', id: productId, meta: { source: 'product-import', jobId: job.jobId } })
    emitInvalidation({ type: 'listing.updated', meta: { source: 'product-import', jobId: job.jobId } })
  }
  const disabled = !!busy || unsafe || !selection?.productIds.length || !selection.includeShared && !selection.listingIds.length
  const selectedListings = options?.listings.filter(l => selection?.listingIds.includes(l.id)) ?? []
  const destinationLabel = (l: ProductTransferOptions['listings'][number]) => `${options?.products.find(p => p.id === l.productId)?.sku} · ${channelName(l.channel)} ${l.marketplace} · ${options?.accounts.find(a => a.id === l.accountId)?.displayName ?? 'Account unavailable'} · ${l.aliasLabel ?? (l.aliasKey || 'Primary listing')}`
  const groups = options && selection ? transferDestinationGroups(options, selection.productIds).filter(g => g.label.toLowerCase().includes(search.toLowerCase())) : []
  const close = () => {
    if (reviewBusy) return
    abortRef.current?.abort(); setBusy(''); props.onClose()
  }
  return <Drawer open={open} onClose={close} width={900} title={showReview && jobId ? 'Review product changes' : props.intent === 'export' ? 'Export product workbook' : 'Import product changes'} subtitle="Choose scope → edit workbook → review → save in Nexus">
    <div className={styles.body}>
      {error && <Banner tone="danger" action={!options ? <Button onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry</Button> : undefined}>{error}</Banner>}
      {!options && !error && <p role="status">Loading this product and its destinations…</p>}
      {unsafe && <Banner tone="warning">Finish saving or resolve the unsaved editor changes before importing or exporting.</Banner>}
      {options && jobId && showReview ? <TransferReview key={jobId} jobId={jobId} productId={productId} allowApply={!unsafe && canImport} options={{ ...options, families: [] }} onBusyChange={setReviewBusy} onJob={rememberJob} onReset={() => { rememberJob(''); setFile(null); setInputId(''); setSource(null); setNote('') }} onSettled={settled} onReturn={props.onClose} /> : options && selection && <>
        {!!jobId && <Banner tone="info" action={<Button onClick={() => setShowReview(true)}>Open saved review</Button>}>Your previous import review is still available.</Banner>}
        {!jobId && !!options.recentJobs?.length && <Disclosure summary="Recent imports for this product">{options.recentJobs.map(job => <div key={job.id} className={styles.actions}><span>{job.filename ?? 'Product import'}</span><Button size="sm" onClick={() => { rememberJob(job.id); setShowReview(true) }}>Open review</Button></div>)}</Disclosure>}
        {props.intent === 'import' && <>
          <Field label="File type"><Select disabled={!!busy} value={sourceMode ? 'source' : 'workbook'} onChange={e => { setSourceMode(e.target.value === 'source'); setFile(null); setSource(null); setInputId(''); setError(''); setNote('') }}>
            <option value="workbook">Nexus editing workbook or ZIP</option><option value="source">Map a supplier spreadsheet</option>
          </Select></Field>
          <FileDropzone accept={sourceMode ? '.xlsx,.csv,.json' : '.xlsx,.csv,.zip'} maxBytes={(sourceMode ? 10 : 50) * 1024 * 1024} disabled={!!busy || unsafe || !canImport} onFiles={files => { if (files[0]) void inspect(files[0]) }} hint={sourceMode ? 'Supplier CSV, single-sheet XLSX or JSON · up to 10 MB' : 'Nexus XLSX or attribute CSV · 10 MB per file · complete ZIP up to 50 MB'} />
          {file && <p role="status">{busy === 'inspect' ? `Reading ${file.name}…` : file.name}</p>}
        </>}
        <div className={styles.fields}>
          <Field label="Products"><Select value={productsMode} disabled={!!busy} onChange={e => chooseProducts(e.target.value)}>
            <option value="current">Current SKU · {options.products.find(p => p.id === productId)?.sku}</option>
            <option value="all">Parent and all variants · {options.products.length} SKUs</option>
            {!!props.selectedIds.length && <option value="selected">Selected sheet rows · {new Set(props.selectedIds).size} SKUs</option>}
            <option value="custom">Choose specific SKUs</option>
          </Select></Field>
          <Field label="Listings"><Select value={destinationsMode} disabled={!!busy} onChange={e => chooseDestinations(e.target.value as DestinationMode)}>
            <option value="current">{channel ? `${channelName(channel)} ${market} · current listing` : 'No channel listings'}</option>
            {channel && <option value="aliases">All aliases in this account and market</option>}
            <option value="all">All existing listing destinations</option>
            <option value="custom">Choose named listings</option>
          </Select></Field>
        </div>
        {productsMode === 'custom' && <Disclosure summary={`${selection.productIds.length} selected SKUs`}><div className={styles.choices} role="group" aria-label="Specific SKUs">{options.products.map(p => <Checkbox key={p.id} label={p.sku} disabled={!!busy} checked={selection.productIds.includes(p.id)} onChange={() => changeSelection(updateTransferProducts(options, props, selection, toggle(selection.productIds, p.id), destinationsMode))} />)}</div></Disclosure>}
        {destinationsMode === 'custom' && <div className={styles.body}>
          <Field label="Find a listing"><Input value={search} onChange={e => { setSearch(e.target.value); setDestinationPage(1) }} placeholder="Channel, account, market or alias name" disabled={!!busy} /></Field>
          <div className={styles.choices} role="group" aria-label="Named listing destinations">{groups.slice((destinationPage - 1) * 50, destinationPage * 50).map(g => <Checkbox key={g.key} disabled={!!busy} label={`${g.label} · ${g.listingIds.length} SKUs`} checked={g.listingIds.every(id => selection.listingIds.includes(id))} onChange={() => changeSelection({ ...selection, listingIds: g.listingIds.every(id => selection.listingIds.includes(id)) ? selection.listingIds.filter(id => !g.listingIds.includes(id)) : [...new Set([...selection.listingIds, ...g.listingIds])] })} />)}{!groups.length && <p>No matching listings for these SKUs.</p>}</div>
          {groups.length > 50 && <div className={styles.actions}><Button disabled={!!busy || destinationPage === 1} onClick={() => setDestinationPage(p => p - 1)}>Previous listings</Button><span>Page {destinationPage} of {Math.ceil(groups.length / 50)}</span><Button disabled={!!busy || destinationPage * 50 >= groups.length} onClick={() => setDestinationPage(p => p + 1)}>Next listings</Button></div>}
        </div>}
        <Checkbox label="Include shared product details" disabled={!!busy} checked={selection.includeShared} onChange={() => changeSelection({ ...selection, includeShared: !selection.includeShared, locales: selection.includeShared ? [] : editorTransferSelection(options, { ...props, channel: undefined }, selection.productIds).locales })} />
        <p role="status">{selection.productIds.length} {selection.productIds.length === 1 ? 'SKU' : 'SKUs'} · {selection.includeShared ? 'shared details · ' : ''}{selection.listingIds.length} {selection.listingIds.length === 1 ? 'listing' : 'listings'}</p>
        {selectedListings.length === 1 && <p>{destinationLabel(selectedListings[0])}</p>}
        <Disclosure summary="Review selected SKUs and destinations"><div className={styles.body}>
          <p>{options.products.filter(p => selection.productIds.includes(p.id)).map(p => p.sku).join(', ') || 'No SKUs selected'}</p>
          {!!selectedListings.length && <div className={styles.choices}>{selectedListings.map(l => <p key={l.id}>{destinationLabel(l)}</p>)}</div>}
        </div></Disclosure>
        {selection.includeShared && <>
          <Banner tone="info">Shared values may also change what inheriting variants and listings display. Destination overrides stay in place unless explicitly changed in this file.</Banner>
          <Disclosure summary={`Content languages · ${selection.locales.map(languageName).join(', ') || 'none selected'}`}><div className={styles.choices} role="group" aria-label="Content languages">{options.locales.map(l => <Checkbox key={l} label={languageName(l)} disabled={!!busy} checked={selection.locales.includes(l)} onChange={() => changeSelection({ ...selection, locales: toggle(selection.locales, l) })} />)}</div></Disclosure>
        </>}
        {!selection.includeShared && !selection.listingIds.length && <Banner tone="warning">These SKUs have no existing listing in the selected account, marketplace and listing. Select another scope or create their listings first.</Banner>}
        {sourceMode && source && props.intent === 'import' && <SourceMappingEditor source={source} mapping={mapping} onChange={setMapping} options={{ ...options, listings: selectedListings, families: [] }} productId={productId} familyId={options.familyId ?? ''} disabled={!!busy} />}
        {props.intent === 'export' ? <>
          <Field label="Attributes"><Select value={fieldMode} disabled={!!busy} onChange={e => setFieldMode(e.target.value)}><option value="all">All attributes in this scope</option>{!!props.visibleFields?.length && <option value="visible">Attributes displayed in the grid</option>}</Select></Field>
          <p>Edit values in the workbook, then use Import to review and save in Nexus. Blank or unchanged cells preserve existing data. Explicit clearing and inheritance are available in the action columns.</p>
          <Button variant="primary" disabled={disabled || !canExport} onClick={download}>{busy === 'export' ? 'Preparing workbook…' : 'Download editing workbook'}</Button>
        </> : <>
          {(inputId || source) && <Button variant="primary" disabled={disabled || !canImport || sourceMode && !mapping.bindings.length} onClick={preview}>{busy === 'preview' ? 'Preparing review…' : 'Review product changes'}</Button>}
          <Disclosure summary="Need an editing workbook?"><p>Download your selected data, edit its values, then upload it here. Saving in Nexus and publishing to a channel are separate steps.</p><Button disabled={disabled || !canExport} onClick={download}>{busy === 'export' ? 'Preparing workbook…' : 'Download editing workbook'}</Button></Disclosure>
        </>}
        {note && <Banner tone="success">{note}</Banner>}
        <Disclosure summary="Download the displayed table for reference"><p>This CSV follows the sheet’s filters and displayed rows. Use the editing workbook above to make changes with preserved ownership and versions.</p><Button disabled={!!busy || unsafe || !canExport} onClick={props.onReference}>Download current view</Button></Disclosure>
      </>}
    </div>
  </Drawer>
}
