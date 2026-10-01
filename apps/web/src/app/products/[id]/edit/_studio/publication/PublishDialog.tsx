'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { blockingIssues, isPhotoChangeId, type StudioPublishResult, type StudioPublishReview, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import { Button, Select } from '@/design-system/primitives'
import { Banner, Disclosure, Field, Modal, ProgressBar } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useStudioProduct, usePublicationSave, useStudioScope, useStudioDiscoveryFailure } from '../contracts'
import { matchesPublicationReview, matchesPublicationSelection, publicationDestinations, publicationScopeKey, retainPublicationReceipt, publicationOverwriteAcknowledged } from './model'
import { PublicationOverwrite } from './PublicationOverwrite'
import { PublicationChanges } from './PublicationChanges'
import { publicationRequest as request } from './request'
import styles from './publication.module.css'

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
      {discoveryFailed && <Banner tone="danger" title="Destinations could not be loaded">Close this dialog and retry the studio’s connection read.</Banner>}
      {blockedSave && <Banner tone={save.kind === 'error' ? 'danger' : 'info'} title={save.kind === 'error' ? 'Save your changes first' : 'Waiting for changes to save'}>{save.kind === 'error' ? save.message : 'The review will load when autosave finishes.'}</Banner>}
      <Field label="Listing destination" hint="Choose the marketplace and connected account to receive this product.">
        <Select size="sm" value={selected} disabled={pending || uncertain || !!result} onChange={e => { setReview(null); setSelection(null); setSelectedIds([]); selectionRequest.current++; setSelected(e.target.value) }}>
          <option value="">Choose a destination</option>
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </Select>
      </Field>
      {!options.length && !discoveryFailed && <Banner tone="neutral" title="No connected destinations">Connect a sales channel to publish this product.</Banner>}
      {busy && <div className={styles.body}><ProgressBar indeterminate ariaLabel={busy === 'review' ? 'Checking saved product information' : busy === 'selection' ? 'Preparing selected request' : 'Publishing product'} /><p role="status">{busy === 'review' ? 'Reading saved values and channel content…' : busy === 'selection' ? 'Preparing the exact request for your selected fields…' : busy === 'publish' ? 'Submitting the reviewed changes. Waiting for the channel’s response…' : 'Checking publication status…'}</p></div>}
      {error && <Banner tone="danger" title={uncertain ? 'Publication result needs checking' : 'Review could not complete'}>{error}</Banner>}
      {review && <>
        <p><strong>{review.accountLabel}</strong> · {review.aliasLabel} · {review.scope.marketplace}</p>
        <p>{review.rows.length} {review.rows.length === 1 ? 'product reviewed' : 'products reviewed'}{review.excluded ? ` · ${review.excluded} excluded` : ''}{review.skipped?.length ? ` · ${review.skipped.length} skipped` : ''}.</p>
        {review.visibility && <Banner tone="info" title={`Shopify visibility: ${review.visibility}`}>The saved status and sales-channel selections will be applied.</Banner>}
        {review.locations && <Field label="Inventory location"><Select size="sm" disabled={pending || uncertain || !!result} value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">Choose a location</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        {review.issues.length > 0 && <Banner tone={blockers.length || review.photosOnly ? 'warning' : 'info'} title={review.photosOnly ? 'Other fields have problems — only photos can be sent now' : blockers.length ? `${blockers.length} ${blockers.length === 1 ? 'issue' : 'issues'} to resolve before publishing` : 'Review notes'}>
          <ul className={styles.issues}>{review.issues.map((issue, i) => <li key={i}>{issue.sku && <strong>{issue.sku}: </strong>}{issue.message}</li>)}</ul>
        </Banner>}
        {sparse && review.changes && <PublicationChanges changes={review.changes} selectedIds={selectedIds} onSelectionChange={chooseFields} disabled={!review.id || !!busy || uncertain || !!result} photosOnly={review.photosOnly} />}
        {/* An error above already says why no fields are listed: this banner is only for a review that names no error. */}
        {sparse && !review.changes && !blockers.length && <Banner tone="warning" title="Field review unavailable">The review did not list the fields to send. Refresh the review.</Banner>}
        {selectedReview && <div ref={selectionPreview} tabIndex={-1} role="region" aria-label="Selected publication request"><Banner tone="info" title="Selected request ready">
          <p>{selectedReview.fieldCount} {selectedReview.fieldCount === 1 ? 'change' : 'changes'} affecting {selectedReview.products.length} {selectedReview.products.length === 1 ? 'product' : 'products'}.</p>
          <p>{review.accountLabel} · {review.scope.marketplace}</p>
          <p>Only the selected changes will be applied. Where a channel requires a complete collection, its other values are preserved in the request shown below.</p>
          <Disclosure summary="Exact request to the channel"><pre tabIndex={0} aria-label="Exact channel request" className={styles.payload}>{selectedReview.payload.content}</pre></Disclosure>
        </Banner></div>}
        {!sparse && review.overwrite && <PublicationOverwrite overwrite={review.overwrite} confirmed={confirmedReviewId === review.id && !!review.id}
          onConfirm={confirmed => setConfirmedReviewId(confirmed ? review.id : null)} disabled={!review.id || !!busy || uncertain || !!result} />}
        {!sparse && !review.overwrite && !blockers.length && review.rows.some(row => row.existing) && <Banner tone="warning" title="Overwrite review unavailable">The review did not check what this overwrites on the existing listings. Refresh the review.</Banner>}
        <div className={styles.products} role="region" aria-label="Products in this publication" tabIndex={0}>
          {review.rows.map(row => <div key={row.productId} className={styles.product}><strong>{row.sku}</strong><span>{row.title}</span><span>{row.existing ? 'Existing listing' : 'New listing'}</span></div>)}
        </div>
      </>}
      {result && <Banner tone={result.status === 'VERIFIED' ? 'success' : ['SUBMITTED', 'ACCEPTED', 'PUBLISHING'].includes(result.status) ? 'info' : 'warning'} title={result.status === 'VERIFIED' ? 'Publication verified' : result.status === 'ACCEPTED' ? 'Accepted by the channel' : result.status === 'SUBMITTED' ? 'Submitted to the channel' : result.status === 'PUBLISHING' ? 'Publication in progress' : 'Publication needs attention'}>{result.message}
        {!!result.warnings?.length && <ul className={styles.issues}>{result.warnings.map(message => <li key={message}>{message}</li>)}</ul>}
        {result.results.some(r => r.status === 'FAILED') && <ul className={styles.issues}>{result.results.filter(r => r.status === 'FAILED').map(r => <li key={r.sku}><strong>{r.sku}: </strong>{r.message}</li>)}</ul>}
      </Banner>}
      {(error || blockers.length > 0) && !uncertain && !result && <div className={styles.actions}><Button size="sm" disabled={!!busy || blockedSave} onClick={() => setRefresh(n => n + 1)}>Refresh review</Button><Button size="sm" disabled={!!busy} onClick={onClose}>Back to editing</Button></div>}
    </div>
  </Modal>
}
