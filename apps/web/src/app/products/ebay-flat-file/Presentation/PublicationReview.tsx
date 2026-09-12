'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Drawer, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { usePresentationNavigationGuard } from './usePresentationNavigationGuard'

interface Outcome { listingId: string; itemId: string; status: string; message?: string; stamped?: boolean }
interface Review { jobId: string; targets: Array<{ listingId: string; itemId: string; version: number; destination: { channelConnectionId: string; marketplace: string; aliasKey: string }; preview: { before?: string; after?: string; axisOrder?: { from: string[]; to: string[] }; valueChanges?: Array<{ axis: string; from: string[]; to: string[] }> } }>; excluded: Outcome[] }
interface Props { productId: string; marketplace: string; accountId?: string; aliasKey?: string; operation: 'order' | 'description'; onClose: () => void; onPendingChange?: (pending: boolean) => void }
export function PublicationReview(props: Props) { return <ScopedPublicationReview key={JSON.stringify([props.productId, props.marketplace, props.accountId, props.aliasKey, props.operation])} {...props} /> }
function ScopedPublicationReview({ productId, marketplace, accountId, aliasKey = '', operation, onClose, onPendingChange }: Props) {
  const [review, setReview] = useState<Review | null>(null), [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null), [reload, setReload] = useState(0)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { onPendingChange?.(busy); return () => onPendingChange?.(false) }, [busy, onPendingChange])
  usePresentationNavigationGuard(busy, async () => false)
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(null); setReview(null); setOutcomes(null)
    void fetch(`${getBackendUrl()}/api/ebay/presentation-publications/review`, { method: 'POST', credentials: 'include', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, destinations: [{ productId, marketplace, accountId, aliasKey }] }) }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? data.message ?? 'Review could not load')
      if (!controller.signal.aborted) setReview(data)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [productId, marketplace, accountId, aliasKey, operation, reload])
  const execute = async () => {
    if (!review || busy) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/ebay/presentation-publications/${encodeURIComponent(review.jobId)}/execute`, { method: 'POST', credentials: 'include' })
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? data.message ?? 'Publication could not complete')
      if (live.current) setOutcomes(data.outcomes)
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (live.current) setBusy(false) }
  }
  const done = outcomes && outcomes.every(o => ['applied', 'unchanged', 'superseded', 'excluded', 'inventory-managed'].includes(o.status))
  return <Drawer open onClose={() => { if (!busy) onClose() }} title={`Review ${operation === 'order' ? 'variation order' : 'description'} publication`} width={760}
    footer={<><Button disabled={busy} onClick={onClose}>Close</Button>{review && review.targets.length > 0 && !done && <Button variant="primary" disabled={busy} onClick={() => void execute()}>{busy ? 'Processing…' : outcomes || error ? 'Retry this review' : 'Publish reviewed change'}</Button>}</>}>
    <div style={{ display: 'grid', gap: 'var(--nds-space-16)', padding: 'var(--nds-space-16)' }}>
      <Banner tone="info">This is a separate marketplace action for the exact listing below. Theme assignments and shared definitions are already saved separately. Review expires after 30 minutes; changed inputs require a fresh review.</Banner>
      {busy && <ProgressBar indeterminate ariaLabel={review ? 'Publishing reviewed presentation' : 'Reading current marketplace presentation'} />}
      {error && <Banner tone="danger" action={<Button disabled={busy} onClick={() => setReload(n => n + 1)}>Create fresh review</Button>}>{error}</Banner>}
      {review?.targets.map(target => <div key={target.listingId} style={{ display: 'grid', gap: 'var(--nds-space-8)' }}>
        <p>Item {target.itemId} · Account {target.destination.channelConnectionId} · {target.destination.marketplace} · {target.destination.aliasKey ? 'Selected alternate listing' : 'Primary listing'} · Listing v{target.version}</p>
        {operation === 'description' ? <><p>Current buyer description</p><iframe title="Current buyer description" sandbox="" srcDoc={target.preview.before} style={{ width: '100%', height: 240 }} /><p>Reviewed buyer description</p><iframe title="Reviewed buyer description" sandbox="" srcDoc={target.preview.after} style={{ width: '100%', height: 320 }} /></> : <>
          {target.preview.axisOrder && <p>Axes: {target.preview.axisOrder.from.join(' → ')} → {target.preview.axisOrder.to.join(' → ')}</p>}
          {target.preview.valueChanges?.map(change => <p key={change.axis}>{change.axis}: {change.from.join(', ')} → {change.to.join(', ')}</p>)}
          {!target.preview.axisOrder && <p>The live order already matches.</p>}
        </>}
      </div>)}
      {(outcomes ?? review?.excluded ?? []).map(outcome => <Banner key={outcome.listingId} tone={outcome.status === 'error' ? 'danger' : outcome.status === 'applied' || outcome.status === 'unchanged' ? 'success' : 'neutral'} title={`Item ${outcome.itemId || 'unpublished'} · ${outcome.status}`}>{outcome.message ?? (outcome.stamped ? 'The selected listing’s reviewed delivery is recorded.' : 'No newer local content is marked as submitted.')}</Banner>)}
      {review && <p>Review {review.jobId}. Retries reuse this review and retain each destination’s result.</p>}
    </div>
  </Drawer>
}
