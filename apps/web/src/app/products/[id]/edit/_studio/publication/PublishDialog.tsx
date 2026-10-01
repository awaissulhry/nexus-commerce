'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { blockingIssues, isPhotoChangeId, type StudioPublishResult, type StudioPublishReview, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import { Button, Select } from '@/design-system/primitives'
import { Banner, Disclosure, Field, JobProgress, MetricStrip, Modal } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid), as the Import dialog lists its rows (audit D4: one way to list rows in both dialogs).
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useStudioProduct, usePublicationSave, useStudioScope, useStudioDiscoveryFailure } from '../contracts'
import { matchesPublicationReview, matchesPublicationSelection, publicationDestinations, publicationProblems, publicationScopeKey, retainPublicationReceipt, publicationOverwriteAcknowledged, type PublicationProblemRow } from './model'
import { PublicationOverwrite } from './PublicationOverwrite'
import { PublicationChanges } from './PublicationChanges'
import { publicationRequest as request } from './request'
import { saveFirstNotice } from '../saveFirst'
import styles from './publication.module.css'

type ReviewRow = StudioPublishReview['rows'][number]
type ResultRow = StudioPublishResult['results'][number]
const BUSY: Record<'review' | 'selection' | 'publish' | 'status', { label: string; detail: string }> = {
  review: { label: 'Checking saved product information', detail: 'Reading saved values and running every check…' },
  selection: { label: 'Preparing the selected request', detail: 'Preparing the exact request for your selected fields…' },
  publish: { label: 'Publishing', detail: 'Submitting the reviewed changes. Waiting for the channel’s response…' },
  status: { label: 'Checking publication status', detail: 'Asking the channel for the result…' },
}
// Audit D4 — what to fix, by SKU, in one table; the channel's own words under it, muted.
const PROBLEM_COLUMNS: Column<PublicationProblemRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'fix', label: 'What to fix', width: 560, className: styles.textCol, render: row => <span className={styles.fix}>
    <span>{row.message}</span>{row.detail && <span className={styles.detail} title={row.detail}>{row.detail}</span>}</span> },
]
const PRODUCT_COLUMNS: Column<ReviewRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'title', label: 'Title', width: 380, className: styles.textCol, render: row => <span className={styles.clamp} title={row.title}>{row.title}</span> },
  { key: 'listing', label: 'Listing', width: 130, render: row => row.existing ? 'Existing listing' : 'New listing' },
]
const REFUSED_COLUMNS: Column<ResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'message', label: 'What the channel said', width: 560, className: styles.textCol, render: row => <span className={styles.fix}>{row.message}</span> },
]

export function PublishDialog({ onClose }: { onClose(): void }) {
  const product = useStudioProduct(), studio = useStudioScope()
  const { state: save, preparePublication, publicationBlocker } = usePublicationSave()
  const canChangeEditor = studio.canChangeEditor
  const canPublish = usePermission('products.publish'), discoveryFailed = useStudioDiscoveryFailure()
  const current: StudioPublishScope | undefined = studio.scope !== 'master' && studio.market && studio.accountId
    ? { channel: studio.scope, marketplace: studio.market, accountId: studio.accountId, ...(studio.listingId ? { listingId: studio.listingId } : {}) } : undefined
  const options = publicationDestinations(studio.marketplaces, current)
  const [selected, setSelected] = useState(() => current ? publicationScopeKey(current) : options.length === 1 ? options[0].key : '')
  const selectedScope = options.find(o => o.key === selected)?.scope
  const [review, setReview] = useState<StudioPublishReview | null>(null)
  const [result, setResult] = useState<StudioPublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'review' | 'selection' | 'publish' | 'status' | null>(null)
  // When the current wait started: the progress shows the time passed, as the Import dialog's does.
  const [busySince, setBusySince] = useState<number | null>(null)
  useEffect(() => { setBusySince(busy ? Date.now() : null) }, [busy])
  const [locationId, setLocationId] = useState(''), [refresh, setRefresh] = useState(0)
  const [uncertain, setUncertain] = useState(false)
  const [confirmedReviewId, setConfirmedReviewId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selection, setSelection] = useState<StudioPublishSelection | null>(null)
  const selectionRequest = useRef(0)
  const selectionPreview = useRef<HTMLDivElement>(null)
  const sending = useRef(false)
  const blockedSave = save.kind === 'saving' || save.kind === 'error'
  const saveRevision = save.kind === 'saved' ? save.at : save.kind
  const base = `/api/products/${encodeURIComponent(product.id)}/studio-publication`
  const scopeKey = selectedScope ? publicationScopeKey(selectedScope) : null
  const scope = useMemo<StudioPublishScope | undefined>(() => {
    if (!scopeKey) return undefined
    const [channel, marketplace, accountId, listingId] = JSON.parse(scopeKey)
    return { channel, marketplace, accountId, ...(listingId ? { listingId } : {}) }
  }, [scopeKey])

  useEffect(() => {
    // Save notifications may arrive while a channel request is outstanding. Keep
    // its durable review and status until the user closes the dialog.
    if (sending.current || result || uncertain) return
    setReview(null); setError(null); setLocationId(''); setConfirmedReviewId(null)
    setSelection(null); setSelectedIds([]); selectionRequest.current++
    if (!scope || blockedSave || !canPublish || discoveryFailed) { setBusy(null); return }
    const controller = new AbortController()
    setBusy('review')
    void preparePublication(canChangeEditor).then(message => {
      if (controller.signal.aborted) return null
      if (message) throw new Error(message)
      return request<StudioPublishReview>(`${base}/preview`, 'POST', scope, controller.signal)
    }).then(data => {
      if (!data) return
      if (controller.signal.aborted) return
      if (!matchesPublicationReview(data, product.id, scope)) throw new Error('The review does not match this product and destination. Refresh the review.')
      setReview(data)
      setSelectedIds(data.changes?.filter(c => c.selectable && c.selectedByDefault && (!data.photosOnly || isPhotoChangeId(c.id))).map(c => c.id) ?? [])
      if (data.previousPublicationId) setUncertain(true)
      if (data.locations?.length === 1) setLocationId(data.locations[0].id)
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(null) })
    return () => controller.abort()
  }, [scope, base, product.id, blockedSave, saveRevision, canPublish, discoveryFailed, refresh, preparePublication, canChangeEditor])

  const acceptResult = (data: StudioPublishResult, id: string) => {
    if (data.id !== id || !Array.isArray(data.results) || !['SUBMITTED', 'ACCEPTED', 'VERIFIED', 'PARTIAL', 'FAILED', 'PUBLISHING', 'UNVERIFIED'].includes(data.status)) throw new Error('The publication result could not be verified. Check its status.')
    setResult(previous => retainPublicationReceipt(previous, data)); setUncertain(['PUBLISHING', 'UNVERIFIED', 'SUBMITTED'].includes(data.status))
  }
  const sparse = !!review && ['AMAZON', 'EBAY'].includes(review.scope.channel)
  const currentReview = !!scope && matchesPublicationReview(review, product.id, scope)
  const selectedReview = matchesPublicationSelection(selection, review, selectedIds) ? selection : null
  useEffect(() => {
    if (!selectedReview?.token) return
    selectionPreview.current?.scrollIntoView({ block: 'start' })
    selectionPreview.current?.focus({ preventScroll: true })
  }, [selectedReview?.token])
  const chooseFields = (ids: string[]) => {
    setSelectedIds(ids); setSelection(null); setError(null); selectionRequest.current++
  }
  const reviewSelection = async () => {
    if (!currentReview || !review?.id || !review.changes || !selectedIds.length || busy || uncertain || result) return
    const version = ++selectionRequest.current
    setBusy('selection'); setSelection(null); setError(null)
    try {
      const data = await request<StudioPublishSelection>(`${base}/${encodeURIComponent(review.id)}/selection`, 'POST', { selectedIds })
      if (version !== selectionRequest.current) return
      if (!matchesPublicationSelection(data, review, selectedIds)) throw new Error('The request preview does not match your selected fields. Review the selection again.')
      setSelection(data)
    } catch (e) { if (version === selectionRequest.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (version === selectionRequest.current) setBusy(null) }
  }
  const send = async () => {
    if (!currentReview || sending.current || !review?.id || !scope || !canPublish || blockedSave || uncertain || result || review.issues.some(i => i.severity === 'error')) return
    if (sparse ? !selectedReview?.fieldCount || !selectedReview.products.length : !publicationOverwriteAcknowledged(review, confirmedReviewId)) return
    const saveBlocker = publicationBlocker(canChangeEditor)
    if (saveBlocker) { setReview(null); setError(saveBlocker); return }
    sending.current = true; setBusy('publish'); setError(null)
    const id = review.id
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}/submit`, 'POST', { locationId, confirmOverwrite: confirmedReviewId === id, selectionToken: selectedReview?.token }), id) }
    catch (e) {
      const status = (e as { status?: number }).status
      setUncertain(!status || status >= 500)
      if (status && status < 500) { setReview(null); setSelection(null); selectionRequest.current++ }
      setError(e instanceof Error ? e.message : String(e))
    }
    finally { sending.current = false; setBusy(null) }
  }
  const checkStatus = async () => {
    const id = review?.previousPublicationId ?? review?.id
    if (!id || sending.current) return
    sending.current = true; setBusy('status'); setError(null)
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}`, 'GET'), id) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { sending.current = false; setBusy(null) }
  }
  // P4c — on a photos-only review, other fields' problems block only a selection that includes them.
  const blockers = review ? blockingIssues(review.issues, review.photosOnly ? selectedIds : undefined) : []
  const pending = busy === 'publish' || busy === 'status'
  const canSend = currentReview && !!review?.id && !busy && !blockedSave && canPublish && !blockers.length && !result && !uncertain
    && (!review.locations || review.locations.some(l => l.id === locationId))
    && (sparse ? !!selectedReview?.fieldCount && !!selectedReview.products.length : publicationOverwriteAcknowledged(review, confirmedReviewId))
  const { problems, notes } = useMemo(() => publicationProblems(review?.issues ?? []), [review])
  const refused = result?.results.filter(r => r.status === 'FAILED') ?? []
  const saveNotice = saveFirstNotice(save, 'The review loads')
  const canReviewSelection = currentReview && !!review?.id && !!review.changes && selectedIds.length > 0 && !busy && !blockedSave && canPublish && !blockers.length && !result && !uncertain
  return <Modal open onClose={() => { if (!pending) onClose() }} size="xl" readable title="Publish product"
    subtitle={`${product.sku} · Saved product information and included variants`}
    footer={<>
      <Button size="sm" disabled={pending} onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
      {uncertain ? <Button size="sm" variant="primary" disabled={!!busy} onClick={checkStatus}>{busy === 'status' ? 'Checking…' : 'Check publication status'}</Button>
        : result ? null : sparse && !selectedReview ? <Button size="sm" variant="primary" disabled={!canReviewSelection} onClick={reviewSelection}>{busy === 'selection' ? 'Preparing request…' : 'Review selected changes'}</Button>
          : <Button size="sm" variant="primary" disabled={!canSend} onClick={send}>{busy === 'publish' ? 'Publishing…' : sparse ? `Publish ${selectedReview!.fieldCount} ${selectedReview!.fieldCount === 1 ? 'change' : 'changes'}` : review?.visibility === 'DRAFT' ? 'Send draft to Shopify' : 'Publish product'}</Button>}
    </>}>
    <div className={styles.body} aria-busy={!!busy}>
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Destinations could not be loaded">Close this dialog, then choose Try again in the sheet footer.</Banner>}
      {/* Step 4 (D3) — the same "save first" notice as the Import dialog. */}
      {saveNotice && <Banner tone={saveNotice.tone} title={saveNotice.title}>{saveNotice.body}</Banner>}
      <Field label="Listing destination" hint="Choose the marketplace and connected account to receive this product.">
        <Select size="sm" value={selected} disabled={pending || uncertain || !!result} onChange={e => { setReview(null); setSelection(null); setSelectedIds([]); selectionRequest.current++; setSelected(e.target.value) }}>
          <option value="">Choose a destination</option>
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </Select>
      </Field>
      {!options.length && !discoveryFailed && <Banner tone="neutral" title="No connected destinations">Connect a sales channel to publish this product.</Banner>}
      {busy && <JobProgress label={BUSY[busy].label} detail={BUSY[busy].detail} startedAt={busySince ?? undefined} />}
      {error && <Banner tone="danger" title={uncertain ? 'Publication result needs checking' : 'Review could not complete'}>{error}</Banner>}
      {review && <>
        <p><strong>{review.accountLabel}</strong> · {review.aliasLabel} · {review.scope.marketplace}</p>
        <MetricStrip metrics={[
          { label: 'Products', value: review.rows.length.toLocaleString('en'), hint: review.excluded || review.skipped?.length
            ? [review.excluded ? `${review.excluded} excluded` : '', review.skipped?.length ? `${review.skipped.length} skipped` : ''].filter(Boolean).join(' · ') : undefined },
          { label: 'Problems', value: problems.length.toLocaleString('en') },
          { label: 'Notes', value: notes.length.toLocaleString('en') },
        ]} />
        {review.visibility && <Banner tone="info" title={`Shopify visibility: ${review.visibility}`}>The saved status and sales-channel selections will be applied.</Banner>}
        {review.locations && <Field label="Inventory location"><Select size="sm" disabled={pending || uncertain || !!result} value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">Choose a location</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        {/* Audit D4 — one short banner says what the table is; the table names each problem (SKU · what to fix). The count is
            the Problems tile's (step 4): the banner does not say it again. */}
        {problems.length > 0 && <Banner tone="warning" title={review.photosOnly ? 'Other fields have problems — only photos can be sent now'
          : 'Fix these before publishing'}>
          {review.photosOnly ? 'Choose only photos to send now, or fix the problems below first.' : 'Each row says what to fix. Fix them, then refresh the review.'}
        </Banner>}
        {problems.length > 0 && <DataGrid ariaLabel="Problems to fix before publishing" size="sm" keyboardScroll columns={PROBLEM_COLUMNS} rows={problems} rowKey={row => row.id} />}
        {/* Notes inform and block nothing: one closed section, as in the Import dialog. */}
        {notes.length > 0 && <Disclosure summary={`${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}>
          <ul className={styles.issues}>{notes.map(note => <li key={note}>{note}</li>)}</ul>
        </Disclosure>}
        {sparse && review.changes && <PublicationChanges changes={review.changes} selectedIds={selectedIds} onSelectionChange={chooseFields} disabled={!review.id || !!busy || uncertain || !!result} photosOnly={review.photosOnly} />}
        {/* An error above already says why no fields are listed: this banner is only for a review that names no error. */}
        {sparse && !review.changes && !blockers.length && <Banner tone="warning" title="Field review unavailable">The review did not list the fields to send. Refresh the review.</Banner>}
        {/* The request itself sits below the banner, never inside it (audit D4: a banner holds a sentence, not a payload). */}
        {selectedReview && <div ref={selectionPreview} tabIndex={-1} role="region" aria-label="Selected publication request" className={styles.body}>
          <Banner tone="info" title="Selected request ready">
            {selectedReview.fieldCount} {selectedReview.fieldCount === 1 ? 'change' : 'changes'} affecting {selectedReview.products.length} {selectedReview.products.length === 1 ? 'product' : 'products'} on {review.accountLabel} · {review.scope.marketplace}.
            Only the selected changes will be applied. Where a channel requires a complete collection, its other values are preserved in the request below.
          </Banner>
          <Disclosure summary="Exact request to the channel"><pre tabIndex={0} aria-label="Exact channel request" className={styles.payload}>{selectedReview.payload.content}</pre></Disclosure>
        </div>}
        {!sparse && review.overwrite && <PublicationOverwrite overwrite={review.overwrite} confirmed={confirmedReviewId === review.id && !!review.id}
          onConfirm={confirmed => setConfirmedReviewId(confirmed ? review.id : null)} disabled={!review.id || !!busy || uncertain || !!result} />}
        {!sparse && !review.overwrite && !blockers.length && review.rows.some(row => row.existing) && <Banner tone="warning" title="Overwrite review unavailable">The review did not check what this overwrites on the existing listings. Refresh the review.</Banner>}
        <DataGrid ariaLabel="Products in this publication" size="sm" keyboardScroll columns={PRODUCT_COLUMNS} rows={review.rows} rowKey={row => row.productId} />
      </>}
      {result && <Banner tone={result.status === 'VERIFIED' ? 'success' : ['SUBMITTED', 'ACCEPTED', 'PUBLISHING'].includes(result.status) ? 'info' : 'warning'} title={result.status === 'VERIFIED' ? 'Publication verified' : result.status === 'ACCEPTED' ? 'Accepted by the channel' : result.status === 'SUBMITTED' ? 'Submitted to the channel' : result.status === 'PUBLISHING' ? 'Publication in progress' : 'Publication needs attention'}>{result.message}</Banner>}
      {refused.length > 0 && <DataGrid ariaLabel="Products the channel refused" size="sm" keyboardScroll columns={REFUSED_COLUMNS} rows={refused} rowKey={row => row.sku} />}
      {!!result?.warnings?.length && <Disclosure open summary={`${result.warnings.length} ${result.warnings.length === 1 ? 'note' : 'notes'} from the channel`}>
        <ul className={styles.issues}>{result.warnings.map(message => <li key={message}>{message}</li>)}</ul>
      </Disclosure>}
      {(error || blockers.length > 0) && !uncertain && !result && <div className={styles.actions}><Button size="sm" disabled={!!busy || blockedSave} onClick={() => setRefresh(n => n + 1)}>Refresh review</Button><Button size="sm" disabled={!!busy} onClick={onClose}>Back to editing</Button></div>}
    </div>
  </Modal>
}
