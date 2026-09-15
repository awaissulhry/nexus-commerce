'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudioPublishResult, StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import { Button, Select } from '@/design-system/primitives'
import { Banner, Field, Modal, ProgressBar } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useStudioProduct, usePublicationSave, useStudioScope, useStudioDiscoveryFailure } from '../contracts'
import { matchesPublicationReview, publicationDestinations, publicationScopeKey, retainPublicationReceipt } from './model'
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
  const [busy, setBusy] = useState<'review' | 'publish' | 'status' | null>(null)
  const [locationId, setLocationId] = useState(''), [refresh, setRefresh] = useState(0)
  const [uncertain, setUncertain] = useState(false)
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
    setReview(null); setError(null); setLocationId('')
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
  const send = async () => {
    if (sending.current || !review?.id || !scope || !canPublish || blockedSave || uncertain || result || review.issues.some(i => i.severity === 'error')) return
    const saveBlocker = publicationBlocker(canChangeEditor)
    if (saveBlocker) { setReview(null); setError(saveBlocker); return }
    sending.current = true; setBusy('publish'); setError(null)
    const id = review.id
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}/submit`, 'POST', { locationId }), id) }
    catch (e) {
      const status = (e as { status?: number }).status
      setUncertain(!status || status >= 500)
      if (status && status < 500) setReview(null)
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
  const blockers = review?.issues.filter(i => i.severity === 'error') ?? []
  const pending = busy === 'publish' || busy === 'status'
  const canSend = !!review?.id && !busy && !blockedSave && canPublish && !blockers.length && !result && !uncertain
    && (!review.locations || review.locations.some(l => l.id === locationId))
  return <Modal open onClose={() => { if (!pending) onClose() }} size="lg" readable title="Publish product"
    subtitle={`${product.sku} · Saved product information and included variants`}
    footer={<>
      <Button size="sm" disabled={pending} onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
      {uncertain ? <Button size="sm" variant="primary" disabled={!!busy} onClick={checkStatus}>{busy === 'status' ? 'Checking…' : 'Check publication status'}</Button>
        : result ? null : <Button size="sm" variant="primary" disabled={!canSend} onClick={send}>{busy === 'publish' ? 'Publishing…' : review?.visibility === 'DRAFT' ? 'Send draft to Shopify' : review?.action === 'update' ? 'Publish changes' : 'Publish product'}</Button>}
    </>}>
    <div className={styles.body} aria-busy={!!busy}>
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Destinations could not be loaded">Close this dialog and retry the studio’s connection read.</Banner>}
      {blockedSave && <Banner tone={save.kind === 'error' ? 'danger' : 'info'} title={save.kind === 'error' ? 'Save your changes first' : 'Waiting for changes to save'}>{save.kind === 'error' ? save.message : 'The review will load when autosave finishes.'}</Banner>}
      <Field label="Listing destination" hint="Choose the marketplace and connected account to receive this product.">
        <Select size="sm" value={selected} disabled={pending || uncertain || !!result} onChange={e => setSelected(e.target.value)}>
          <option value="">Choose a destination</option>
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </Select>
      </Field>
      {!options.length && !discoveryFailed && <Banner tone="neutral" title="No connected destinations">Connect a sales channel to publish this product.</Banner>}
      {busy && <div className={styles.body}><ProgressBar indeterminate ariaLabel={busy === 'review' ? 'Checking saved product information' : 'Publishing product'} /><p role="status">{busy === 'review' ? 'Checking saved values and destination…' : busy === 'publish' ? 'Submitting the reviewed product. Waiting for the channel’s response…' : 'Checking publication status…'}</p></div>}
      {error && <Banner tone="danger" title={uncertain ? 'Publication result needs checking' : 'Review could not complete'}>{error}</Banner>}
      {review && <>
        <p><strong>{review.accountLabel}</strong> · {review.aliasLabel} · {review.scope.marketplace}</p>
        <p>{review.action === 'create' ? 'Create a listing' : 'Update the existing listing'} with {review.rows.length} {review.rows.length === 1 ? 'product' : 'products'}{review.excluded ? ` · ${review.excluded} excluded` : ''}.</p>
        {review.visibility && <Banner tone="info" title={`Shopify visibility: ${review.visibility}`}>The saved status and sales-channel selections will be applied.</Banner>}
        {review.locations && <Field label="Inventory location"><Select size="sm" disabled={pending || uncertain || !!result} value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">Choose a location</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        {review.issues.length > 0 && <Banner tone={blockers.length ? 'warning' : 'info'} title={blockers.length ? `${blockers.length} ${blockers.length === 1 ? 'issue' : 'issues'} to resolve before publishing` : 'Review notes'}>
          <ul className={styles.issues}>{review.issues.map((issue, i) => <li key={i}>{issue.sku && <strong>{issue.sku}: </strong>}{issue.message}</li>)}</ul>
        </Banner>}
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
