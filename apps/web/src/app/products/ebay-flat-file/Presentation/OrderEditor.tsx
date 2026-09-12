'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { PublicationReview } from './PublicationReview'
import { usePresentationNavigationGuard } from './usePresentationNavigationGuard'
import { Banner, Card, Drawer, OrderedList, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import styles from './presentation.module.css'

export interface PresentationOrderView {
  productId: string; marketplace: string; accountId: string; aliasKey: string; listingId: string; externalListingId: string | null
  version: number; token: string; axes: Array<{ name: string; key: string; values: string[] }>; warnings: string[]; conflicts: string[]
  explicitAxes: boolean; explicitValues: string[]; source: { id: string; name: string; version: number } | null
  family: Array<{ id: string; sku: string }>; membershipCount: number
}
interface OrderChange { axes?: string[] | null; values?: Record<string, string[] | null>; reset?: boolean }
interface Props {
  open: boolean; embedded?: boolean; productId: string; marketplace: string; accountId?: string; aliasKey?: string
  onClose: () => void; onSaved?: () => void; onPendingChange?: (pending: boolean) => void
}

export function OrderEditor(props: Props) {
  return <ScopedOrderEditor key={JSON.stringify([props.productId, props.marketplace, props.accountId, props.aliasKey])} {...props} />
}
function ScopedOrderEditor({ open, embedded = false, productId, marketplace, accountId, aliasKey = '', onClose, onSaved, onPendingChange }: Props) {
  const [view, setView] = useState<PresentationOrderView | null>(null)
  const [change, setChange] = useState<OrderChange>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const discardResolver = useRef<((ok: boolean) => void) | null>(null)
  const settleDiscard = useCallback((ok: boolean) => {
    const resolve = discardResolver.current
    discardResolver.current = null; setConfirming(false); resolve?.(ok)
  }, [])
  const cancel = useCallback(() => settleDiscard(false), [settleDiscard])
  const confirmDiscard = () => new Promise<boolean>(resolve => {
    discardResolver.current?.(false)
    discardResolver.current = resolve; setConfirming(true)
  })
  useEffect(() => () => { discardResolver.current?.(false) }, [])
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const [reload, setReload] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const [publicationBusy, setPublicationBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const dirty = Object.keys(change).length > 0
  useEffect(() => { onPendingChange?.(dirty || busy || publicationBusy); return () => onPendingChange?.(false) }, [dirty, busy, publicationBusy, onPendingChange])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setView(null); setError(null)
    const params = new URLSearchParams({ productId, marketplace, aliasKey, ...(accountId ? { accountId } : {}) })
    void fetch(`${getBackendUrl()}/api/ebay/cockpit/presentation-order?${params}`, { credentials: 'include', signal: controller.signal }).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? data.error ?? 'The current order could not load')
      if (!controller.signal.aborted) { setView(data); setChange({}) }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [open, productId, marketplace, accountId, aliasKey, reload])
  const mayLeave = async () => !busy && (!dirty || await confirmDiscard())
  usePresentationNavigationGuard(open && (dirty || busy), mayLeave)
  const close = () => { if (confirming) { cancel(); return }; void mayLeave().then(ok => { if (ok && live.current) onClose() }) }
  const save = async () => {
    if (!view || busy) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/ebay/cockpit/presentation-order`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: view.productId, marketplace: view.marketplace, accountId: view.accountId, aliasKey: view.aliasKey, expectedVersion: view.version, expectedToken: view.token, change }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? data.error ?? 'The order could not save')
      if (live.current) { setView(data); setChange({}); setSaved(true); onSaved?.() }
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (live.current) setBusy(false) }
  }
  const sequence = change.axes ?? view?.axes.map(a => a.name) ?? []
  const discard = () => void mayLeave().then(ok => { if (ok && live.current) { setChange({}); setSaved(false) } })
  const actions = <div className={styles.actions}>
    <Button disabled={busy || dirty || !view || confirming} onClick={() => setReviewing(true)}>Review publication</Button>
    {embedded ? <Button disabled={busy || !dirty} onClick={discard}>Discard changes</Button> : <Button disabled={busy} onClick={close}>Close</Button>}
    <Button variant="primary" disabled={busy || confirming || !dirty || !view} onClick={() => void save()}>{busy ? 'Saving…' : 'Save listing order'}</Button>
  </div>
  const content = <div className={styles.editor}>
    {error && <Banner tone="danger" action={<Button disabled={busy} onClick={() => void mayLeave().then(ok => { if (ok && live.current) { setChange({}); setReload(n => n + 1) } })}>Reload current order</Button>}>{error}</Banner>}
    {!view && !error && <ProgressBar indeterminate ariaLabel="Loading listing order" />}
    {view && <>
      <div className={styles.saveBar}>
        <p role="status">{dirty ? 'Unsaved order changes' : saved ? 'Listing order saved. Ready to review publication.' : view.explicitAxes || view.explicitValues.length ? 'This alias has custom ordering.' : 'Following the current rule or default.'}</p>
        <Button disabled={busy || Boolean(change.reset)} onClick={() => setChange({ reset: true })}>Restore inherited ordering</Button>
      </div>
      {view.source && <p>Shared rule: {view.source.name} · v{view.source.version}.{' '}
        <Button asChild inline variant="link"><Link href={`/channels/ebay/variation-order-rules?market=${encodeURIComponent(marketplace)}&rule=${encodeURIComponent(view.source.id)}`}>View shared rule</Link></Button>
      </p>}
      {view.conflicts.length > 0 && <Banner tone="warning">{view.conflicts.join(' · ')} Customize the conflicting property here or resolve its shared rules before publishing.</Banner>}
      {change.reset ? <Banner tone="info">Saving will restore the current rule or default for all axes and values in this alias. Discard changes to keep its saved ordering.</Banner> : <div className={styles.orderLayout}>
        <Card header={<span role="heading" aria-level={2} className={styles.sectionTitle}>Axis order</span>}>
          <div className={styles.stack}>
            <p>Which option buyers choose first.</p>
            <OrderedList label="Buyer-facing axis order" items={sequence} disabled={busy} onChange={axes => setChange(c => ({ ...c, axes }))} />
            {view.explicitAxes && <div><Button disabled={busy || change.axes === null} onClick={() => setChange(c => ({ ...c, axes: null }))}>Restore inherited axes</Button></div>}
            {change.axes === null && <p>Axes will follow the current rule or default after saving.</p>}
          </div>
        </Card>
        <div className={styles.valueLayout}>
          {sequence.map(name => view.axes.find(axis => axis.name === name)).filter((axis): axis is PresentationOrderView['axes'][number] => Boolean(axis)).map(axis => <Card key={axis.key} header={<span role="heading" aria-level={2} className={styles.sectionTitle}>{axis.name} values</span>}>
            <div className={styles.stack}>
              <p>The sequence of {axis.name.toLowerCase()} options.</p>
              <OrderedList label={`${axis.name} value order`} items={change.values?.[axis.key] ?? axis.values} disabled={busy} onChange={values => setChange(c => ({ ...c, values: { ...c.values, [axis.key]: values } }))} />
              {view.explicitValues.includes(axis.key) && <div><Button disabled={busy || change.values?.[axis.key] === null} onClick={() => setChange(c => ({ ...c, values: { ...c.values, [axis.key]: null } }))}>Restore inherited values</Button></div>}
              {change.values?.[axis.key] === null && <p>Values will follow the current rule or default after saving.</p>}
            </div>
          </Card>)}
        </div>
      </div>}
      <p>Drag to reorder, or use the up and down buttons. These settings apply to this alias’s variation family; shared variants and Information grid sorting keep their own order.</p>
      {view.warnings.filter(w => !view.conflicts.includes(w)).map(w => <Banner key={w} tone="neutral">{w}</Banner>)}
      <p>Saving updates this listing’s order. Publication requires a separate review. Inventory-managed publication is unavailable.</p>
    </>}
  </div>
  const review = reviewing && view && <PublicationReview productId={view.productId} marketplace={view.marketplace} accountId={view.accountId} aliasKey={view.aliasKey} operation="order" onPendingChange={setPublicationBusy} onClose={() => { setReviewing(false); setReload(n => n + 1) }} />
  const confirmation = <Drawer open={confirming} onClose={cancel} title="Discard order changes?" width={440}
    footer={<><Button autoFocus onClick={cancel}>Keep editing</Button><Button variant="danger" onClick={() => settleDiscard(true)}>Discard changes</Button></>}>
    <div className={styles.drawerContent}><p>Your order changes have not been saved. Discarding returns to this alias’s saved ordering.</p></div>
  </Drawer>
  if (embedded) return <>
    {content}
    <div className={styles.saveBar}><p>Changes apply to the selected listing alias.</p>{actions}</div>
    {confirmation}{review}
  </>
  if (review) return review
  return <><Drawer open={open} onClose={close} title="Buyer-facing variation order" width={960} footer={actions}>
    <div className={styles.drawerContent}>{content}</div>
  </Drawer>{confirmation}</>
}
