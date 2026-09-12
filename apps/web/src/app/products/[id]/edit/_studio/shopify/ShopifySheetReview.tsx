'use client'
import { useEffect, useRef, useState } from 'react'
import type { ShopifyLinkedPlan, ShopifyLinkedWorkspace, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { informationRegistry } from '@nexus/shared/shopify-information'
import { Banner, Disclosure } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { linkedEndpoint, linkedRequest } from './api'
import { informationValueLabel } from './informationEditing'
import { ShopifyGalleryReview } from './ShopifyGalleryReview'
import styles from './linked.module.css'

/** Shopify's reviewed operation adapter inside the common channel preflight dialog. */
export function ShopifySheetReview({ path, schema, onChanged, onBusyChange }: { path: string; schema: ShopifyStoreSchema | null | undefined; onChanged(): void; onBusyChange(busy: boolean): void }) {
  const [workspace, setWorkspace] = useState<ShopifyLinkedWorkspace | null>(null), [plan, setPlan] = useState<ShopifyLinkedPlan | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const alive = useRef(true), pending = useRef(false), canPublish = usePermission('products.publish'), canEdit = usePermission('products.edit')
  useEffect(() => { alive.current = true; void review(); return () => { alive.current = false } }, [path])
  async function action(fn: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); onBusyChange(true); setError('')
    try { await fn() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'The operation could not be confirmed.') }
    finally { pending.current = false; if (alive.current) { setBusy(false); onBusyChange(false) } }
  }
  async function review() { await action(async () => {
    setPlan(null); setNotice('')
    const saved = await linkedRequest<ShopifyLinkedWorkspace>(path)
    if (!alive.current) return
    setWorkspace(saved)
    if (saved.operation && saved.operation.status !== 'VERIFIED') return
    const result = await linkedRequest<{ workspace: ShopifyLinkedWorkspace; plan: ShopifyLinkedPlan }>(linkedEndpoint(path, '/preview'), 'POST', {})
    if (alive.current) { setWorkspace(result.workspace); setPlan(result.plan) }
  }) }
  async function synchronize(resume: boolean) { await action(async () => {
    if (!workspace || !canPublish || !resume && !plan) return
    let saved = workspace
    try {
      if (!resume) saved = await linkedRequest<ShopifyLinkedWorkspace>(linkedEndpoint(path, '/synchronize'), 'POST', { expectedRevision: workspace.revision, planRevision: plan!.revision })
      if (alive.current) setWorkspace(saved)
      let steps = 0
      while (alive.current && saved.operation && saved.operation.status !== 'VERIFIED' && steps++ < 40) {
        saved = await linkedRequest<ShopifyLinkedWorkspace>(linkedEndpoint(path, '/advance'), 'POST', { operationId: saved.operation.id })
        if (alive.current) setWorkspace(saved)
      }
      if (alive.current) { setPlan(null); setNotice(saved.operation?.status === 'VERIFIED' ? 'Saved changes were verified in Shopify.' : 'Synchronization is still in progress. Resume to check its saved progress.'); onChanged() }
    } catch (e) {
      const latest = await linkedRequest<ShopifyLinkedWorkspace>(path).catch(() => null)
      if (alive.current && latest) setWorkspace(latest)
      throw e
    }
  }) }
  async function refreshBaseline() { await action(async () => {
    if (!workspace || !canEdit) return
    const saved = await linkedRequest<ShopifyLinkedWorkspace>(linkedEndpoint(path, '/rebase'), 'POST', { expectedRevision: workspace.revision })
    if (!alive.current) return
    setWorkspace(saved)
    const result = await linkedRequest<{ workspace: ShopifyLinkedWorkspace; plan: ShopifyLinkedPlan }>(linkedEndpoint(path, '/preview'), 'POST', {})
    if (alive.current) { setWorkspace(result.workspace); setPlan(result.plan); setNotice('Shopify values were refreshed. Your Nexus edits are retained for a new review.'); onChanged() }
  }) }
  const count = (plan?.changes.length ?? 0) + (plan?.nativeEdits?.length ?? 0) + (plan?.mediaEdits?.length ?? 0) + (plan?.sheetGalleries?.length ?? 0)
  const running = workspace?.operation && workspace.operation.status !== 'VERIFIED'
  const registry = informationRegistry(schema ?? null)
  return <div className={styles.stack} aria-busy={busy}>
    <p>Nexus draft changes are shown below. Synchronization updates this Shopify listing after your review.</p>
    {error && <Banner tone="danger">{error} Your saved draft and synchronization progress are retained.</Banner>}
    {notice && <Banner tone="info">{notice}</Banner>}
    {running && <Banner tone="warning" title="Synchronization needs verification">{workspace.operation!.completed} of {workspace.operation!.total} changes verified. {workspace.operation!.error}</Banner>}
    {workspace?.operation?.status === 'UNVERIFIED' && <div><p>Keep your draft edits and read the latest Shopify values for another review. This does not synchronize changes.</p><Button size="sm" disabled={busy || !canEdit} onClick={() => void refreshBaseline()}>Review latest Shopify values</Button></div>}
    {plan?.warnings.map(message => <Banner key={message} tone="warning">{message}</Banner>)}
    {plan?.changes.map(change => <Disclosure key={`${change.ownerId}:${change.namespace}.${change.key}`} summary={`${change.ownerLabel} · ${registry.find(f => f.definition?.namespace === change.namespace && f.definition.key === change.key)?.label ?? `${change.namespace}.${change.key}`}`}>
      <p>Shopify now: {informationValueLabel(change.type, change.value)}</p><p>After synchronization: {informationValueLabel(change.type, change.nextValue)}</p>
    </Disclosure>)}
    {plan?.nativeEdits?.map(change => <Disclosure key={JSON.stringify([change.ownerId, change.field, change.translation])} summary={`${change.ownerLabel} · ${registry.find(f => f.id === (change.translation?.fieldId ?? change.field))?.label ?? change.field}${change.translation ? ` · ${change.translation.locale}` : ''}`}>
      <p>Shopify now</p><pre className={styles.value}>{change.value ?? 'Not set'}</pre><p>After synchronization</p><pre className={styles.value}>{change.nextValue ?? 'Not set'}</pre>
    </Disclosure>)}
    {plan?.mediaEdits?.map(change => <Disclosure key={change.productId} summary={`${change.ownerLabel} · Product media`}>
      <p>{change.nextValue.length} items · {change.nextValue.filter(id => !change.value.includes(id)).length} added · {change.value.filter(id => !change.nextValue.includes(id)).length} removed.</p>
      <p>Gallery order: {change.nextValue.map(id => change.value.includes(id) ? `current ${change.value.indexOf(id) + 1}` : 'new item').join(', ') || 'Empty gallery'}.</p>
      {change.altEdits?.map(edit => <p key={edit.id}>Shared file alt text: {edit.value || 'Empty'} → {edit.nextValue || 'Empty'}</p>)}
      {change.affectedVariants?.map(variant => <p key={variant.id}>Variant image affected: {variant.title}</p>)}
    </Disclosure>)}
    <ShopifyGalleryReview galleries={plan?.sheetGalleries} />
    {plan && !count && <p>No saved cell or gallery changes are pending in this review. Inherited product content uses the content publication review.</p>}
    <div className={styles.toolbar}><Button size="sm" disabled={busy || !!running} onClick={() => void review()}>Refresh review</Button>
      <Button size="sm" variant="primary" disabled={busy || !canPublish || !running && !count} onClick={() => void synchronize(!!running)}>{busy ? 'Checking…' : running ? 'Resume synchronization' : `Synchronize ${count} ${count === 1 ? 'change' : 'changes'}`}</Button>
    </div>
  </div>
}
