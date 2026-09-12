'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2, RefreshCw, Save, Search, Layers, Wand2 } from 'lucide-react'
import { linkedDraftSignature, definitionAddress, fieldAddress, mergeImportedLinkedFamily, shopifyLinkedDraftSchema, type ShopifyFieldDefinition, type ShopifyFieldOwner, type ShopifyFieldSnapshot,
  type ShopifySharedSuggestion, type ShopifyLinkedDiscovery, type ShopifyLinkedDraft, type ShopifyLinkedMember, type ShopifyLinkedPlan, type ShopifyLinkedWorkspace as Workspace, type ShopifyReference } from '@nexus/shared/shopify-linked-products'
import { Banner, Card, Disclosure, EmptyState, Field, Modal, OrderedList } from '@/design-system/components'
import { Button, Checkbox, Input, Select, Pill, SegmentedControl } from '@/design-system/primitives'
import { useAuth, usePermission } from '@/lib/auth/AuthProvider'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import { useSaveReporter, useStudioScope } from '../contracts'
import { linkedEndpoint, linkedRequest } from './api'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { ReferencePicker } from './ReferencePicker'
import { AutomationPanel } from './AutomationPanel'
import { EntryEditor } from './EntryEditor'
import { useLiveShopifySchema } from './useLiveShopifySchema'
import { ShopifyLiveNotice } from './ShopifyLiveNotice'
import { informationRegistry, nativeEditAddress } from '@nexus/shared/shopify-information'
import styles from './linked.module.css'
import { mergeInformationDraft } from './draftMerge'
import { ShopifyGalleryReview } from './ShopifyGalleryReview'

export function ShopifyLinkedWorkspace({ path, accountLabel, view }: { path: string; accountLabel: string; view: 'family' | 'content' }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [draft, setDraft] = useState<ShopifyLinkedDraft | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(''), [variantId, setVariantId] = useState(''), [owner, setOwner] = useState<ShopifyFieldOwner | null>(null), [ownerError, setOwnerError] = useState(''), [ownerLoading, setOwnerLoading] = useState(false), [ownerRefresh, setOwnerRefresh] = useState(0)
  const [suggestions, setSuggestions] = useState<ShopifySharedSuggestion[] | null>(null), [chosenSuggestions, setChosenSuggestions] = useState<string[]>([])
  const [discovery, setDiscovery] = useState<ShopifyLinkedDiscovery | null>(null), [discovering, setDiscovering] = useState(false)
  const [fieldSelection, setFieldSelection] = useState(''), [fieldView, setFieldView] = useState('all'), [reviewIntent, setReviewIntent] = useState<'sync' | 'automatic'>('sync')
  const discovered = useRef(false)
  const [filter, setFilter] = useState(''), [picker, setPicker] = useState<'add' | 'import' | null>(null), [imported, setImported] = useState<ShopifyLinkedDraft | null>(null)
  const [entry, setEntry] = useState<{ id: string | null; copy?: boolean; replace?(newId: string): void } | null>(null), [review, setReview] = useState<ShopifyLinkedPlan | null>(null), [reviewNames, setReviewNames] = useState<ShopifyReference[]>([])
  const [confirmation, setConfirmation] = useState<{ title: string; text: string; run(): void } | null>(null), [leave, setLeave] = useState<((value: boolean) => void) | null>(null)
  const reporter = useSaveReporter(), canEdit = usePermission('products.edit'), canPublish = usePermission('products.publish')
  const { schema, error: schemaError, liveIssue, refresh: refreshSchema } = useLiveShopifySchema(path, canEdit)
  const { user } = useAuth()
  const liveNoticeKey = `nexus-shopify-live-notice:${user?.id ?? 'session'}:${new URLSearchParams(path.split('?')[1]).get('accountId')}`
  const liveNotice = liveIssue && <ShopifyLiveNotice key={`${liveNoticeKey}:${liveIssue}`} issue={liveIssue} accountLabel={accountLabel} storageKey={liveNoticeKey} />
  const recoveryKey = `nexus-shopify-draft:${user?.id ?? 'session'}:${path}`
  const [recovery, setRecovery] = useState<{ revision: string; draft: ShopifyLinkedDraft; base?: ShopifyLinkedDraft } | null>(null)
  const [mergeReview, setMergeReview] = useState<{ latest: Workspace; base: ShopifyLinkedDraft; local: ShopifyLinkedDraft; choices: Record<string, 'local' | 'saved'> } | null>(null)
  const [recoveryIssue, setRecoveryIssue] = useState('')
  const pending = useRef(false), alive = useRef(true), currentDraft = useRef(draft), currentWorkspace = useRef(workspace)
  currentDraft.current = draft; currentWorkspace.current = workspace
  const dirty = !!draft && !!workspace && linkedDraftSignature(draft) !== linkedDraftSignature(workspace.draft)
  const { registerScopeChangeGuard, registerShopifyLocales } = useStudioScope()
  useEffect(() => { const account = new URLSearchParams(path.split('?')[1]).get('accountId'); if (schema && account) registerShopifyLocales?.(account, schema.locales) }, [schema, path, registerShopifyLocales])
  useEffect(() => registerScopeChangeGuard(() => !dirty && !busy && !entry && !mergeReview), [registerScopeChangeGuard, dirty, busy, entry, mergeReview])
  const running = !!workspace?.operation && workspace.operation.status !== 'VERIFIED'
  const disabled = busy || !canEdit || running
  const subject = `shopify-linked:${path}`
  const accept = useCallback((data: Workspace) => {
    const parsed = shopifyLinkedDraftSchema.safeParse(data.draft), query = new URLSearchParams(path.split('?')[1])
    const productId = decodeURIComponent(path.split('/products/')[1].split('/')[0])
    if (!parsed.success || data.productId !== productId || data.destination?.accountId !== query.get('accountId') || data.destination.market !== 'GLOBAL' || !data.revision) throw new Error('The response does not match this product and Shopify store. Reload before continuing.')
    setWorkspace({ ...data, draft: parsed.data }); setDraft(structuredClone(parsed.data)); setReview(null); reporter.cleared([subject])
  }, [path, reporter, subject])
  useEffect(() => {
    alive.current = true; const controller = new AbortController()
    void linkedRequest<Workspace>(path, 'GET', undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return
      accept(data)
      try {
        const saved = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null')
        const parsed = shopifyLinkedDraftSchema.safeParse(saved?.draft)
        if (parsed.success && typeof saved.revision === 'string' && linkedDraftSignature(parsed.data) !== linkedDraftSignature(data.draft)) setRecovery({ revision: saved.revision, draft: parsed.data, base: shopifyLinkedDraftSchema.safeParse(saved.base).success ? saved.base : undefined })
      } catch { setRecoveryIssue('Browser recovery is unavailable. Save draft to keep your work before leaving.') }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => { alive.current = false; controller.abort() }
  }, [path, accept, recoveryKey])
  useEffect(() => {
    if (!workspace || !draft || recovery) return
    try {
      if (dirty) sessionStorage.setItem(recoveryKey, JSON.stringify({ revision: workspace.revision, draft, base: workspace.draft }))
      else sessionStorage.removeItem(recoveryKey)
    } catch { setRecoveryIssue('Browser recovery is unavailable. Save draft to keep your work before leaving.') }
  }, [draft, workspace?.revision, dirty, recovery, recoveryKey])
  useEffect(() => {
    if (!workspace || workspace.draft.members.length || discovered.current) return
    discovered.current = true
    const controller = new AbortController(); setDiscovering(true)
    void linkedRequest<ShopifyLinkedDiscovery>(linkedEndpoint(path, '/discover'), 'POST', {}, controller.signal).then(setDiscovery).catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setDiscovering(false) })
    return () => controller.abort()
  }, [workspace?.productId, path])
  useEffect(() => {
    if (!workspace?.automation || workspace.automation.mode === 'PAUSED' || dirty || busy || entry || review) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      const observed = currentWorkspace.current
      if (pending.current || !observed || linkedDraftSignature(currentDraft.current) !== linkedDraftSignature(observed.draft)) return
      void linkedRequest<Workspace>(path, 'GET', undefined, controller.signal).then(data => {
        if (!controller.signal.aborted && !pending.current && currentWorkspace.current?.revision === observed.revision && linkedDraftSignature(currentDraft.current) === linkedDraftSignature(observed.draft) && data.revision !== observed.revision) accept(data)
      }).catch(() => { /* Explicit actions retain their actionable network errors. */ })
    }, 15_000)
    return () => { clearInterval(timer); controller.abort() }
  }, [workspace?.automation?.mode, dirty, busy, entry, review, path, accept])
  usePresentationNavigationGuard(dirty || busy || !!entry, async () => {
    if (pending.current || entry) { setError('Finish the current operation or close the reusable entry editor before leaving.'); return false }
    return new Promise(resolve => setLeave(() => resolve))
  })
  const productId = draft?.members.some(m => m.id === selected) ? selected : draft?.members[0]?.id ?? ''
  const ownerId = variantId || productId
  useEffect(() => {
    if (!ownerId) { setOwner(null); return }
    const controller = new AbortController(); setOwnerLoading(true); setOwnerError(''); setOwner(null)
    void linkedRequest<ShopifyFieldOwner>(linkedEndpoint(path, '/owner', { ownerId }), 'GET', undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return
      if (data.id !== ownerId || data.productId !== productId) throw new Error('The returned fields belong to another product. Reload before editing.')
      setOwner(data)
    }).catch(e => { if (!controller.signal.aborted) setOwnerError(e.message) }).finally(() => { if (!controller.signal.aborted) setOwnerLoading(false) })
    return () => controller.abort()
  }, [ownerId, productId, path, ownerRefresh])
  const [variants, setVariants] = useState<ShopifyFieldOwner['variants']>([])
  useEffect(() => { if (owner?.ownerType === 'PRODUCT') setVariants(owner.variants) }, [owner])
  const mutate = (fn: (next: ShopifyLinkedDraft) => void) => {
    if (disabled) return
    setDraft(old => { if (!old) return old; const next = structuredClone(old); fn(next); return next }); setReview(null); setNotice('')
  }
  async function action(fn: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { if (alive.current) setError((e as Error).message) } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function saveDraft() {
    const data = currentDraft.current, observed = currentWorkspace.current
    if (!data || !observed || !canEdit) return
    const parsed = shopifyLinkedDraftSchema.safeParse(data)
    if (!parsed.success) throw new Error(parsed.error.issues.map(i => i.message).join(' '))
    const id = crypto.randomUUID(); reporter.pending(id, subject)
    try { const result = await linkedRequest<Workspace>(path, 'PUT', { draft: data, expectedRevision: observed.revision }); if (alive.current) { accept(result); currentWorkspace.current = result; currentDraft.current = result.draft; setNotice('Draft saved in Nexus. Review changes to synchronize Shopify.') }; reporter.resolved(id, true, undefined, subject) }
    catch (e) { reporter.resolved(id, false, (e as Error).message, subject); throw e }
  }
  async function readLinks(ids: string[], relationship: NonNullable<ShopifyLinkedDraft['relationship']>) {
    return linkedRequest<ShopifyFieldSnapshot[]>(linkedEndpoint(path, '/read-links'), 'POST', { ids, namespace: relationship.namespace, key: relationship.key })
  }
  async function chooseRelationship(value: string) {
    const definition = schema?.definitions.find(d => d.id === value), current = currentDraft.current
    if (!current || !definition) return
    const relationship = { namespace: definition.namespace, key: definition.key, includeSelf: current.relationship?.includeSelf ?? true }
    const baselineLinks = await readLinks(current.members.map(m => m.id), relationship)
    setDraft({ ...current, informationOnly: undefined, relationship, baselineLinks }); setReview(null)
  }
  function requestRelationship(value: string) {
    const next = schema?.definitions.find(d => d.id === value)
    if (!next) return
    if (draft?.relationship && (next.namespace !== draft.relationship.namespace || next.key !== draft.relationship.key)) {
      setConfirmation({ title: 'Change the theme relationship field?', text: 'Existing values in the previous field remain in Shopify. Nexus will manage the newly selected field after you save and review. Confirm that your theme uses this field.', run: () => { void action(() => chooseRelationship(value)) } })
    } else void action(() => chooseRelationship(value))
  }
  async function chooseProduct(reference: ShopifyReference, mode: 'add' | 'import') {
    setPicker(null)
    if (mode === 'import') {
      const next = await linkedRequest<ShopifyLinkedDraft>(linkedEndpoint(path, '/import'), 'POST', { sourceId: reference.id, relationship: currentDraft.current?.relationship ?? null })
      setImported(next); return
    }
    const current = currentDraft.current
    if (!current || current.members.some(m => m.id === reference.id)) return
    const members = await linkedRequest<ShopifyLinkedMember[]>(linkedEndpoint(path, '/products'), 'POST', { ids: [reference.id] })
    const baseline = current.relationship ? await readLinks([reference.id], current.relationship) : []
    const sharedFields = await Promise.all((current.sharedFields ?? []).map(async rule => ({ ...rule, baseline: [...rule.baseline, ...(await linkedRequest<ShopifyFieldSnapshot[]>(linkedEndpoint(path, '/field-values'), 'POST', { addresses: [{ ownerId: reference.id, namespace: rule.namespace, key: rule.key }] })).map(f => ({ ...f, type: f.type || rule.baseline[0]?.type || 'single_line_text_field' }))] })))
    setDraft({ ...current, members: [...current.members, ...members], baselineLinks: [...current.baselineLinks.filter(f => f.ownerId !== reference.id), ...baseline], ...(current.sharedFields ? { sharedFields } : {}) }); setReview(null)
  }
  async function reviewChanges(intent: 'sync' | 'automatic' = 'sync') {
    setReviewIntent(intent)
    if (dirty) await saveDraft()
    const result = await linkedRequest<{ workspace: Workspace; plan: ShopifyLinkedPlan }>(linkedEndpoint(path, '/preview'), 'POST', {})
    if (result.workspace.revision !== currentWorkspace.current?.revision) throw new Error('The saved draft changed. Reload before reviewing Shopify changes.')
    setReview(null); setReviewNames([])
    const ids = new Set<string>()
    for (const c of result.plan.changes.filter(c => c.type.includes('_reference'))) for (const raw of [c.value, c.nextValue]) if (raw) { try { for (const id of c.type.startsWith('list.') ? JSON.parse(raw) : [raw]) ids.add(id) } catch { /* preserve the raw value in review */ } }
    const names: ShopifyReference[] = [], all = [...ids]
    for (let i = 0; i < all.length; i += 100) names.push(...await linkedRequest<ShopifyReference[]>(linkedEndpoint(path, '/reference-names'), 'POST', { ids: all.slice(i, i + 100) }))
    setReviewNames(names); setReview(result.plan)
  }
  async function sync(resume = false) {
    let data = currentWorkspace.current
    if (!data || !canPublish || (!resume && !review)) return
    try {
      if (!resume) data = await linkedRequest<Workspace>(linkedEndpoint(path, '/synchronize'), 'POST', { expectedRevision: data.revision, planRevision: review!.revision })
      if (alive.current) accept(data)
      let steps = 0
      while (data.operation && data.operation.status !== 'VERIFIED' && steps++ < 40) {
        await new Promise(resolve => setTimeout(resolve, 500))
        data = await linkedRequest<Workspace>(linkedEndpoint(path, '/advance'), 'POST', { operationId: data.operation.id })
        if (!alive.current) return
        accept(data)
      }
      setNotice(data.operation?.status === 'VERIFIED' ? 'Saved changes were verified in Shopify.' : 'Synchronization is still running. Resume to check its saved progress.'); setOwnerRefresh(v => v + 1)
    } catch (error) {
      // Recover a lost acknowledgement from persisted operation status; never blindly restart it.
      const saved = await linkedRequest<Workspace>(path).catch(() => null)
      if (saved && alive.current) accept(saved)
      throw error
    }
  }
  async function setAutomation(mode: 'PAUSED' | 'MONITOR' | 'AUTOMATIC') {
    const current = currentWorkspace.current
    if (!current) return
    const result = await linkedRequest<Workspace>(linkedEndpoint(path, '/automation'), 'POST', { mode, expectedRevision: current.revision, ...(mode === 'AUTOMATIC' ? { planRevision: review?.revision } : {}) })
    if (mode === 'PAUSED' && linkedDraftSignature(currentDraft.current) !== linkedDraftSignature(current.draft)) { setWorkspace(result); currentWorkspace.current = result; setReview(null) }
    else { accept(result); currentWorkspace.current = result; currentDraft.current = result.draft }
    setNotice(mode === 'AUTOMATIC' ? 'Automation enabled for the reviewed rules. Checks continue on the server.' : mode === 'MONITOR' ? 'Background monitoring enabled. Changes wait for review.' : 'Automation paused.')
  }
  async function discoverFamily() {
    setDiscovery(await linkedRequest<ShopifyLinkedDiscovery>(linkedEndpoint(path, '/discover'), 'POST', { relationship: currentDraft.current?.relationship ?? null }))
  }
  async function shareField(def: ShopifyFieldDefinition) {
    const current = currentDraft.current
    if (!current || !owner) return
    const baseline = (await linkedRequest<ShopifyFieldSnapshot[]>(linkedEndpoint(path, '/field-values'), 'POST', { addresses: current.members.map(m => ({ ownerId: m.id, namespace: def.namespace, key: def.key })) })).map(f => ({ ...f, type: f.type || def.type }))
    const excludedProductIds = current.edits.filter(e => e.namespace === def.namespace && e.key === def.key && e.ownerId !== owner.id).map(e => e.ownerId).filter(id => current.members.some(m => m.id === id))
    setDraft({ ...current, sharedFields: [...(current.sharedFields ?? []).filter(r => definitionAddress(r) !== definitionAddress(def)), { namespace: def.namespace, key: def.key, sourceProductId: owner.id, excludedProductIds, baseline }] }); setReview(null)
    setNotice('Shared-content rule added. Existing product edits remain independent. Save and review to start automation.')
  }
  async function refreshRemote() {
    const current = currentWorkspace.current
    if (!current) return
    const result = await linkedRequest<Workspace>(linkedEndpoint(path, '/rebase'), 'POST', { expectedRevision: current.revision })
    accept(result); setOwnerRefresh(v => v + 1)
    await refreshSchema()
    setNotice('Latest Shopify values loaded. Pending field values remain in the draft; review them before applying.')
  }
  const definitions = useMemo(() => {
    if (!schema || !owner) return []
    const fields = schema.definitions.filter(d => d.ownerType === owner.ownerType)
    for (const f of owner.fields) if (!fields.some(d => d.namespace === f.namespace && d.key === f.key)) fields.push({ ...f, id: fieldAddress(f), name: f.key, description: 'Existing Shopify value without a definition.', ownerType: owner.ownerType, validations: [], access: { admin: null, storefront: null }, readOnlyReason: /^(\$app|app--|apps--)/.test(f.namespace) ? 'This field is managed by an app.' : null })
    return fields.sort((a, b) => a.name.localeCompare(b.name))
  }, [schema, owner])
  const visibleFields = definitions.filter(d => (fieldView === 'all' || (fieldView === 'shared' ? draft?.sharedFields?.some(r => definitionAddress(r) === definitionAddress(d)) && owner?.ownerType === 'PRODUCT' : draft?.edits.some(e => e.ownerId === ownerId && definitionAddress(e) === definitionAddress(d)))) && `${d.name} ${d.namespace}.${d.key} ${d.type}`.toLowerCase().includes(filter.toLowerCase()))
  const activeField = visibleFields.find(d => d.id === fieldSelection) ?? visibleFields.find(d => d.type.includes('metaobject_reference') && owner?.fields.some(f => definitionAddress(f) === definitionAddress(d) && f.value !== null)) ?? visibleFields[0]
  function changeField(def: ShopifyFieldDefinition, nextValue: string | null) {
    if (!owner) return
    mutate(next => {
      const address = { ownerId: owner.id, namespace: def.namespace, key: def.key }, prior = next.edits.find(e => fieldAddress(e) === fieldAddress(address))
      const baseline = prior ?? owner.fields.find(f => f.namespace === def.namespace && f.key === def.key) ?? { ...address, type: def.type, value: null, compareDigest: null }
      next.edits = next.edits.filter(e => fieldAddress(e) !== fieldAddress(address))
      if (baseline.value !== nextValue) next.edits.push({ ...baseline, nextValue, ownerLabel: owner.ownerType === 'PRODUCT' ? owner.title : `${next.members.find(m => m.id === productId)?.title} / ${owner.title}` })
    })
  }
  async function copyToFamily(def: ShopifyFieldDefinition, value: string | null) {
    const current = currentDraft.current
    if (!current) return
    const snapshots = await linkedRequest<ShopifyFieldSnapshot[]>(linkedEndpoint(path, '/field-values'), 'POST', { addresses: current.members.map(m => ({ ownerId: m.id, namespace: def.namespace, key: def.key })) })
    const next = structuredClone(current)
    for (const field of snapshots) {
      const existing = next.edits.find(e => fieldAddress(e) === fieldAddress(field)), baseline = existing ?? { ...field, type: field.type || def.type }
      next.edits = next.edits.filter(e => fieldAddress(e) !== fieldAddress(field))
      if (baseline.value !== value) next.edits.push({ ...baseline, nextValue: value, ownerLabel: current.members.find(m => m.id === field.ownerId)!.title })
    }
    setDraft(next); setReview(null); setNotice('The value is staged for every family product. Save and review the changes.')
  }
  const reviewValue = (type: string, value: string | null) => {
    if (value === null) return 'Not set'
    if (type.includes('_reference')) { try { return (type.startsWith('list.') ? JSON.parse(value) : [value]).map((id: string) => reviewNames.find(n => n.id === id)?.label ?? draft?.members.find(m => m.id === id)?.title ?? 'Loading reference…').join('\n') || 'Empty list' } catch { return value } }
    return value
  }
  async function reviewSavedDraft(base = currentWorkspace.current?.draft, local = currentDraft.current) {
    if (!base || !local) return
    const latest = await linkedRequest<Workspace>(path)
    const query = new URLSearchParams(path.split('?')[1])
    if (latest.productId !== workspace?.productId || latest.destination.accountId !== query.get('accountId') || latest.destination.market !== 'GLOBAL') throw new Error('The response belongs to another destination.')
    if (latest.operation && latest.operation.status !== 'VERIFIED') throw new Error('A synchronization is running or needs reconciliation. Your unsaved intent is retained until that operation is resolved.')
    setMergeReview({ latest, base, local, choices: {} })
  }
  const mergeResult = mergeReview ? mergeInformationDraft(mergeReview.base, mergeReview.local, mergeReview.latest.draft, mergeReview.choices) : null
  if (!workspace || !draft) return <div className={styles.workspace}>{error ? <EmptyState title="Shopify family could not load" description={error} action={<Button onClick={() => { void action(async () => accept(await linkedRequest<Workspace>(path))) }}>Try again</Button>} /> : <p role="status">Loading Shopify family…</p>}</div>
  const reviewCount = (review?.changes.length ?? 0) + (review?.nativeEdits?.length ?? 0) + (review?.mediaEdits?.length ?? 0) + (review?.sheetGalleries?.length ?? 0)
  const relation = schema?.definitions.find(d => d.ownerType === 'PRODUCT' && d.namespace === draft.relationship?.namespace && d.key === draft.relationship?.key)
  const syncLabel = workspace.operation?.status === 'UNVERIFIED' || ['NEEDS_REVIEW', 'ERROR'].includes(workspace.automation?.status ?? '') ? 'Needs attention' : running ? 'In progress' : dirty ? 'Draft changes' : workspace.operation?.status === 'VERIFIED' || workspace.automation?.status === 'VERIFIED' ? 'Verified' : 'Ready for review'
  return <div className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>SHOPIFY WORKSPACE</p><h2>{view === 'family' ? 'One family. Every variation.' : 'Metafields & content'}</h2><p className={styles.hint}>{accountLabel} · {workspace.name}</p></div><div className={styles.toolbar}>
      {view === 'content' && workspace.automation && workspace.automation.mode !== 'PAUSED' && <Button size="sm" disabled={busy || !canPublish} onClick={() => { void action(() => setAutomation('PAUSED')) }}>Pause automation</Button>}
      <Button size="sm" disabled={busy || !canEdit || dirty} onClick={() => setConfirmation({ title: 'Review latest Shopify values?', text: 'This loads current Shopify values for a new review and pauses automation. Saved edits and sharing rules remain. Review the resulting changes before replacing any Shopify content.', run: () => { void action(refreshRemote) } })}><RefreshCw size={14} />Refresh Shopify</Button>
      <Button size="sm" disabled={disabled || !dirty} onClick={() => { void action(saveDraft) }}><Save size={14} />Save draft</Button>
      <Button size="sm" variant="primary" disabled={busy || running || !schema || !canPublish || (dirty && !canEdit)} onClick={() => { void action(reviewChanges) }}>Review & synchronize</Button>
    </div></header>
    {recoveryIssue && <Banner tone="warning">{recoveryIssue}</Banner>}
    {recovery && <Banner tone="warning" title="Unsaved changes recovered from this browser" action={<><Button size="sm" disabled={disabled || recovery.revision !== workspace.revision} onClick={() => { setDraft(recovery.draft); setRecovery(null) }}>Restore changes</Button>{recovery.base && recovery.revision !== workspace.revision && <Button size="sm" disabled={disabled} onClick={() => { void action(() => reviewSavedDraft(recovery.base, recovery.draft)) }}>Review recovered changes</Button>}<Button size="sm" onClick={() => { sessionStorage.removeItem(recoveryKey); setRecovery(null) }}>Discard recovered changes</Button></>}>
      {recovery.revision === workspace.revision ? 'Restore these changes to review and save them.' : 'The saved Nexus draft changed. Restoration is paused to preserve that work. Keep the recovery details while reviewing the latest draft.'}
      <Disclosure summary="Recovery details"><pre className={styles.value}>{JSON.stringify(recovery.draft, null, 2)}</pre></Disclosure>
    </Banner>}
    {error && <Banner tone="danger" onDismiss={() => setError('')} action={<Button size="sm" disabled={busy} onClick={() => { void action(() => reviewSavedDraft()) }}>Review saved changes</Button>}>{error}</Banner>}{notice && <Banner tone={running ? 'info' : 'success'} onDismiss={() => setNotice('')}>{notice}</Banner>}
    {mergeReview && mergeResult && <Modal open readable size="md" title="Review concurrent draft changes" onClose={() => setMergeReview(null)} footer={<><Button size="sm" onClick={() => setMergeReview(null)}>Keep editing</Button><Button size="sm" variant="primary" disabled={!!mergeResult.conflicts.length} onClick={() => {
      const parsed = shopifyLinkedDraftSchema.safeParse(mergeResult.merged)
      if (!parsed.success) { setError('These choices produce an inconsistent family draft. Review the family and its field ownership before saving.'); return }
      accept(mergeReview.latest); setDraft(parsed.data); setRecovery(null); setMergeReview(null); setError(''); setNotice('Draft changes combined in Nexus. Review them, then Save draft.')
    }}>Use reviewed draft</Button></>}><div className={styles.stack}><p>Changes to different cells are kept together. Choose which intent to keep when both drafts changed the same cell. Shopify is unchanged.</p>
      {mergeInformationDraft(mergeReview.base, mergeReview.local, mergeReview.latest.draft).conflicts.map(conflict => <Field key={conflict.key} label={conflict.label}><Select size="sm" value={mergeReview.choices[conflict.key] ?? ''} onChange={event => setMergeReview({ ...mergeReview, choices: { ...mergeReview.choices, [conflict.key]: event.target.value as 'local' | 'saved' } })}><option value="">Choose a value</option><option value="local">Keep my change</option><option value="saved">Keep saved change</option></Select><Disclosure summary="Compare values"><p>My change</p><pre className={styles.value}>{JSON.stringify(conflict.local ?? null, null, 2)}</pre><p>Saved change</p><pre className={styles.value}>{JSON.stringify(conflict.saved ?? null, null, 2)}</pre></Disclosure></Field>)}
      {!mergeInformationDraft(mergeReview.base, mergeReview.local, mergeReview.latest.draft).conflicts.length && <p>The drafts have no conflicting cell changes. Your edits and the latest saved work will both be retained.</p>}
    </div></Modal>}
    {schemaError && <Banner tone="warning" title="Store attributes could not refresh" action={<Button size="sm" onClick={() => { void refreshSchema() }}>Retry attributes</Button>}>{schemaError} Your draft is preserved.</Banner>}
    {liveNotice}
    {!schema && !schemaError && <p role="status">Discovering this store’s fields and reusable content…</p>}
    <p role="status" className={styles.hint}>{busy ? 'Working with Shopify…' : dirty ? 'Unsaved draft changes' : 'Draft matches saved Nexus data'}</p>
    {running && <Banner tone={workspace.operation?.status === 'UNVERIFIED' ? 'warning' : 'info'} title="Synchronization progress" action={<Button size="sm" disabled={busy || !canPublish} onClick={() => { void action(() => sync(true)) }}>Resume synchronization</Button>}>
      {workspace.operation!.completed} of {workspace.operation!.total} field changes verified. {workspace.operation!.error ?? 'Progress is saved in Nexus.'}</Banner>}
    <div className={styles.summary} aria-label="Family overview">
      <Card padded><span className={styles.hint}>Linked products</span><strong className={styles.metric}>{draft.members.length}</strong><span className={styles.hint}>Each keeps its own variants and content</span></Card>
      <Card padded><span className={styles.hint}>Shared content rules</span><strong className={styles.metric}>{draft.sharedFields?.length ?? 0}</strong><span className={styles.hint}>One source, with individual overrides</span></Card>
      <Card padded><span className={styles.hint}>Sync status</span><strong className={styles.metricLabel}>{syncLabel}</strong><span className={styles.hint}>{dirty ? 'Save your changes to update the rules' : syncLabel === 'Verified' ? 'Saved changes verified in Shopify' : 'Review exact changes before enabling'}</span></Card>
    </div>
    {discovering && <p role="status">Discovering existing family links from this store…</p>}
    {discovery && <Banner tone={discovery.draft ? 'info' : 'warning'} title={discovery.draft ? `Found ${discovery.draft.members.length} linked products` : 'Family discovery needs your input'} onDismiss={() => setDiscovery(null)} action={discovery.draft ? <Button size="sm" disabled={disabled} onClick={() => { setImported(discovery.draft); setDiscovery(null) }}>Review discovered family</Button> : undefined}>{discovery.reasons.join(' ')}{discovery.candidates.length > 1 && <p>{discovery.candidates.map(c => c.name).join(' · ')}</p>}</Banner>}
    {schema && view === 'family' && <div className={styles.familyLayout}><Card header="Family products" description="The storefront selector follows this order. Each product retains its own sizes, stock and product page." headerAction={<Pill tone="neutral">{draft.members.length} products</Pill>}>
      <div className={styles.stack}>
        <div className={styles.toolbar}><Button size="sm" disabled={disabled} onClick={() => { void action(discoverFamily) }}><Wand2 size={14} aria-hidden />Discover family</Button><Button size="sm" disabled={disabled} onClick={() => setPicker('add')}>Add product</Button><Button size="sm" variant="quiet" disabled={disabled} onClick={() => setPicker('import')}>Import from product</Button></div>
        {draft.members.length ? <OrderedList label="Shopify family order" items={draft.members.map(m => m.id)} disabled={disabled} itemLabel={id => draft.members.find(m => m.id === id)!.title} onChange={ids => mutate(d => { d.members = ids.map(id => d.members.find(m => m.id === id)!) })} renderItem={id => { const member = draft.members.find(m => m.id === id)!; return <div className={styles.member}>{member.image ? <img src={member.image} alt="" loading="lazy" /> : <span className={styles.productPlaceholder}><Layers size={20} aria-hidden /></span>}<span><strong>{member.title}</strong><small className={styles.hint}>/{member.handle}</small></span><Button size="xs" variant="quiet" disabled={disabled} onClick={() => setConfirmation({ title: `Unlink ${member.title}?`, text: 'The reviewed synchronization will remove this product’s links to the family. Shared rules sourced from this product will also be removed. The Shopify product stays available.', run: () => mutate(d => { d.members = d.members.filter(m => m.id !== id); if (d.sharedFields) d.sharedFields = d.sharedFields.filter(r => r.sourceProductId !== id).map(r => ({ ...r, excludedProductIds: r.excludedProductIds.filter(v => v !== id), baseline: r.baseline.filter(f => f.ownerId !== id) })) }) })}>Unlink</Button></div> }} />
          : <EmptyState icon={<Link2 size={24} />} title="Let Nexus find your existing family" description="Discover the products already connected through Shopify. If the store has more than one possible family field, choose it below." action={<Button size="sm" disabled={disabled} onClick={() => { void action(discoverFamily) }}>Discover family</Button>} />}
        <Disclosure summary={relation ? `Storefront connection · ${relation.name}` : 'Choose the storefront relationship field'} open={!draft.relationship}>
          <div className={styles.stack}><Field label="Theme relationship field" hint="The product list used by your storefront variation selector."><Select size="sm" disabled={disabled} value={relation?.id ?? ''} onChange={e => requestRelationship(e.target.value)}><option value="">Choose a field from this store</option>{schema.definitions.filter(d => d.ownerType === 'PRODUCT' && d.type === 'list.product_reference').map(d => <option key={d.id} value={d.id} disabled={!!d.readOnlyReason}>{d.name} · {definitionAddress(d)}</option>)}</Select></Field>
          {draft.relationship && <Checkbox disabled={disabled} checked={draft.relationship.includeSelf} label="Include each product in its own variation list" onChange={e => mutate(d => { if (d.relationship) d.relationship.includeSelf = e.target.checked })} />}</div>
        </Disclosure>
      </div>
    </Card><AutomationPanel workspace={workspace} disabled={busy} dirty={dirty} canPublish={canPublish} onReview={() => { void action(() => reviewChanges('automatic')) }} onMode={mode => { void action(() => setAutomation(mode)) }} onCheck={() => { void action(async () => accept(await linkedRequest<Workspace>(linkedEndpoint(path, '/automation-check'), 'POST', {}))) }} /></div>}
    {schema && view === 'content' && <div className={styles.stack}>
      {draft.members.length > 1 && <div className={styles.header}><p className={styles.hint}>Find content that is already shared, then keep it consistent automatically.</p><Button size="sm" disabled={disabled} onClick={() => { void action(async () => { const found = await linkedRequest<ShopifySharedSuggestion[]>(linkedEndpoint(path, '/suggest-sharing'), 'POST', { draft: currentDraft.current }); setSuggestions(found); setChosenSuggestions(found.map(s => definitionAddress(s.rule))) }) }}><Wand2 size={14} aria-hidden />Find shared content</Button></div>}
      {draft.members.length ? <>
        <div className={styles.settings}><Field label="Product"><Select size="sm" disabled={busy} value={productId} onChange={e => { setSelected(e.target.value); setVariantId(''); setVariants([]) }}>{draft.members.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</Select></Field><Field label="Content belongs to"><Select size="sm" disabled={busy || ownerLoading} value={variantId} onChange={e => setVariantId(e.target.value)}><option value="">This product</option>{variants.map(v => <option key={v.id} value={v.id}>{v.title}{v.sku ? ` · ${v.sku}` : ''}</option>)}</Select></Field></div>
        <div className={styles.contentLayout}><Card header="Content library" description="Choose a field to edit its content or sharing rule."><div className={styles.stack}>
          <Field label="Find content"><Input size="sm" leadingIcon={<Search size={14} aria-hidden />} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search content" /></Field>
          <SegmentedControl size="sm" wrap ariaLabel="Filter content fields" value={fieldView} onChange={setFieldView} options={[{ value: 'all', label: 'All' }, { value: 'shared', label: 'Shared' }, { value: 'changed', label: 'Changed' }]} />
          <nav className={styles.fieldNavigation} aria-label="Content fields">{visibleFields.map(def => <Button key={def.id} size="sm" block variant={activeField?.id === def.id ? 'tonal' : 'quiet'} aria-current={activeField?.id === def.id ? 'true' : undefined} onClick={() => setFieldSelection(def.id)}>{def.name}</Button>)}</nav>
          <Button size="sm" disabled={busy || !canPublish} onClick={() => setEntry({ id: null })}>Create reusable entry</Button>
        </div></Card><Card header={activeField?.name ?? 'Product content'} description={owner?.ownerType === 'PRODUCTVARIANT' ? `${draft.members.find(m => m.id === productId)?.title} · ${owner.title}` : owner?.title}>
        {ownerLoading && <p role="status">Reading current Shopify values…</p>}{ownerError && <Banner tone="danger" action={<Button size="sm" onClick={() => setOwnerRefresh(v => v + 1)}>Retry</Button>}>{ownerError}</Banner>}
        {owner && (activeField ? [activeField] : []).map(def => {
          const field = owner.fields.find(f => f.namespace === def.namespace && f.key === def.key), edit = draft.edits.find(e => e.ownerId === owner.id && e.namespace === def.namespace && e.key === def.key)
          const value = edit ? edit.nextValue : field?.value ?? null, isRelationship = owner.ownerType === 'PRODUCT' && draft.relationship?.namespace === def.namespace && draft.relationship.key === def.key
          const rule = owner.ownerType === 'PRODUCT' ? draft.sharedFields?.find(r => definitionAddress(r) === definitionAddress(def)) : undefined
          const inherited = !!rule && rule.sourceProductId !== owner.id && !rule.excludedProductIds.includes(owner.id)
          const definition = inherited ? { ...def, readOnlyReason: 'This product follows the shared source. Make an override to edit it independently.' } : isRelationship ? { ...def, readOnlyReason: 'Managed by Product family so sibling lists remain consistent.' } : def
          return <section key={def.id} className={styles.field}><div className={styles.header}><div>{def.description && <p className={styles.hint}>{def.description}</p>}</div>
            <div className={styles.toolbar}>{edit && <Pill tone="warning">Pending change</Pill>}{edit && <Button size="xs" disabled={disabled} onClick={() => mutate(d => { d.edits = d.edits.filter(e => fieldAddress(e) !== fieldAddress(edit)) })}>Use Shopify value</Button>}
              {!definition.readOnlyReason && !rule && owner.ownerType === 'PRODUCT' && draft.members.length > 1 && <Button size="xs" disabled={disabled} onClick={() => setConfirmation({ title: `Apply ${def.name} to all family products?`, text: `The ${value === null ? 'clear' : 'current value'} will be staged for ${draft.members.length} Shopify products. You can review every change before synchronization.`, run: () => { void action(() => copyToFamily(def, value)) } })}>Apply to family</Button>}</div></div>
            {edit && (edit.value !== (field?.value ?? null) || edit.compareDigest !== (field?.compareDigest ?? null)) && <Banner tone="warning">This field changed in Shopify since the draft began. Refresh Shopify and review both values before synchronization.</Banner>}
            {rule && <Banner tone="info" title={rule.sourceProductId === owner.id ? 'Shared source for this family' : inherited ? 'Follows shared content' : 'Individual product override'} action={rule.sourceProductId === owner.id ? <Button size="xs" disabled={disabled} onClick={() => mutate(d => { d.sharedFields = d.sharedFields?.filter(r => definitionAddress(r) !== definitionAddress(def)) })}>Stop sharing</Button> : inherited ? <Button size="xs" disabled={disabled} onClick={() => mutate(d => { const r = d.sharedFields!.find(r => definitionAddress(r) === definitionAddress(def))!; r.excludedProductIds.push(owner.id) })}>Make product override</Button> : <Button size="xs" disabled={disabled} onClick={() => { void action(async () => { const baseline = await linkedRequest<ShopifyFieldSnapshot[]>(linkedEndpoint(path, '/field-values'), 'POST', { addresses: [{ ownerId: owner.id, namespace: def.namespace, key: def.key }] }); setDraft(current => { const next = structuredClone(current!); const r = next.sharedFields!.find(r => definitionAddress(r) === definitionAddress(def))!; r.excludedProductIds = r.excludedProductIds.filter(id => id !== owner.id); r.baseline = [...r.baseline.filter(f => f.ownerId !== owner.id), ...baseline.map(f => ({ ...f, type: f.type || def.type }))]; next.edits = next.edits.filter(e => !(e.ownerId === owner.id && definitionAddress(e) === definitionAddress(def))); return next }); setReview(null) }) }}>Use shared content</Button>}>{rule.sourceProductId === owner.id ? `Changes here flow to ${draft.members.length - 1 - rule.excludedProductIds.length} family ${draft.members.length - 1 - rule.excludedProductIds.length === 1 ? 'product' : 'products'} when synchronized.` : `Source: ${draft.members.find(m => m.id === rule.sourceProductId)?.title}. ${inherited ? 'Synchronization uses the latest source value.' : 'This product keeps its own value.'}`}</Banner>}
            {!rule && !definition.readOnlyReason && owner.ownerType === 'PRODUCT' && draft.members.length > 1 && value !== null && <div><Button size="sm" disabled={disabled} onClick={() => setConfirmation({ title: `Keep ${def.name} shared with the family?`, text: 'Use this product as the source. Future changes can flow automatically to the other products. Products with pending individual edits remain overrides.', run: () => { void action(() => shareField(def)) } })}>Keep shared with family</Button></div>}
            {rule?.excludedProductIds.includes(owner.id) && def.type.includes('metaobject_reference') && <p className={styles.hint}>Referenced entries can still be shared. Make a separate copy to change this product’s entry independently.</p>}
            <LinkedFieldEditor path={path} definition={definition} value={value} disabled={disabled || ownerLoading} schema={schema} onChange={v => changeField(def, v)} onOpenEntry={id => setEntry({ id })} onCopyEntry={canPublish && canEdit ? id => setEntry({ id, copy: true, replace: newId => changeField(def, def.type.startsWith('list.') ? JSON.stringify(JSON.parse(value!).map((ref: string) => ref === id ? newId : ref)) : newId) }) : undefined} />
            <Disclosure summary="Field details"><p className={styles.hint}>{definitionAddress(def)} · {def.type}</p></Disclosure>
          </section>
        })}
        {owner && !visibleFields.length && <EmptyState title="No matching content" description="Choose All or change your search to find another field." />}
        </Card></div>
      </> : <EmptyState title="Start with your product family" description="Discover or import its products in Product family. Their existing content appears here automatically." />}
    </div>}
    <Modal open={suggestions !== null} title="Shared content found in Shopify" size="lg" onClose={() => setSuggestions(null)} footer={<><Button onClick={() => setSuggestions(null)}>Cancel</Button><Button variant="primary" disabled={disabled || !chosenSuggestions.length} onClick={() => { mutate(d => { d.sharedFields = [...(d.sharedFields ?? []), ...(suggestions ?? []).filter(s => chosenSuggestions.includes(definitionAddress(s.rule))).map(s => s.rule)] }); setSuggestions(null); setNotice('Shared rules added to the draft. Save and review to enable automation.') }}>Add {chosenSuggestions.length} sharing {chosenSuggestions.length === 1 ? 'rule' : 'rules'}</Button></>}>
      <div className={styles.stack}><p>Matching values can follow one source. Different and empty values stay as individual product overrides. Choose which fields should stay shared.</p>{suggestions?.length === 0 && <EmptyState title="No additional common content" description="No unambiguous matching values were found. You can choose an individual field and keep it shared with the family." />}{suggestions?.map(s => <div key={definitionAddress(s.rule)} className={styles.field}><Checkbox label={s.name} checked={chosenSuggestions.includes(definitionAddress(s.rule))} onChange={e => setChosenSuggestions(ids => e.target.checked ? [...ids, definitionAddress(s.rule)] : ids.filter(id => id !== definitionAddress(s.rule)))} /><p className={styles.hint}>Source: {draft.members.find(m => m.id === s.rule.sourceProductId)?.title} · {draft.members.length - 1 - s.rule.excludedProductIds.length} {draft.members.length - 1 - s.rule.excludedProductIds.length === 1 ? 'follower' : 'followers'} · {s.rule.excludedProductIds.length} individual overrides</p></div>)}</div>
    </Modal>
    {schema && picker && <ReferencePicker path={path} type="product_reference" schema={schema} excluded={picker === 'add' ? draft.members.map(m => m.id) : []} onClose={() => setPicker(null)} onChoose={ref => { const mode = picker; void action(() => chooseProduct(ref, mode)) }} />}
    <Modal open={!!imported} title="Use these existing Shopify family links?" size="lg" onClose={() => setImported(null)} footer={<><Button onClick={() => setImported(null)}>Cancel</Button><Button variant="primary" disabled={disabled} onClick={() => { if (imported) { try { const merged = mergeImportedLinkedFamily(draft, imported); const parsed = shopifyLinkedDraftSchema.safeParse(merged); if (!parsed.success) throw new Error('Update or remove sharing rules that depend on the current family before replacing its products. Your current draft is preserved.'); setDraft(parsed.data); setImported(null); setReview(null) } catch (e) { setError((e as Error).message); setImported(null) } } }}>Use this family</Button></>}><p>The ordered members below will become this editor’s Shopify family. Existing saved field edits remain available for review. Removed products will be unlinked during synchronization.</p><ol>{imported?.members.map(m => <li key={m.id}>{m.title}</li>)}</ol><p>All sibling lists will follow this order when you synchronize.</p></Modal>
    <Modal open={!!review} title={reviewIntent === 'automatic' ? 'Review & enable automation' : 'Review Shopify changes'} size="xl" readable onClose={() => { if (!busy) setReview(null) }} footer={<><Button disabled={busy} onClick={() => setReview(null)}>Keep editing</Button><Button variant="primary" disabled={busy || !canPublish || (reviewIntent === 'sync' && !reviewCount)} onClick={() => { void action(() => reviewIntent === 'automatic' ? setAutomation('AUTOMATIC') : sync()) }}>{reviewIntent === 'automatic' ? 'Enable automatic synchronization' : `Synchronize ${reviewCount} ${reviewCount === 1 ? 'change' : 'changes'}`}</Button></>}>
      <div className={styles.stack}>{reviewIntent === 'automatic' && <Banner tone="info" title="These rules continue running in the background">Nexus checks every five minutes and synchronizes the reviewed family links and {draft.sharedFields?.length ?? 0} shared-content {draft.sharedFields?.length === 1 ? 'rule' : 'rules'}. Source changes flow to followers. Product overrides stay independent; conflicting edits stop for review. You can pause at any time.</Banner>}{reviewIntent === 'automatic' && draft.sharedFields?.map(rule => <p key={definitionAddress(rule)}>{schema?.definitions.find(d => d.ownerType === 'PRODUCT' && definitionAddress(d) === definitionAddress(rule))?.name ?? definitionAddress(rule)} · source: {draft.members.find(m => m.id === rule.sourceProductId)?.title} · {rule.excludedProductIds.length} {rule.excludedProductIds.length === 1 ? 'override' : 'overrides'}</p>)}{review?.warnings.map(w => <Banner key={w} tone="warning">{w}</Banner>)}{reviewCount === 0 && <p>The selected fields already match Shopify.</p>}{review?.changes.map(c => <section key={fieldAddress(c)} className={styles.field}><h3>{c.ownerLabel}</h3><p className={styles.hint}>{definitionAddress(c)}</p><div className={styles.review}><div><p>Shopify now</p><pre className={styles.value}>{reviewValue(c.type, c.value)}</pre></div><div><p>After synchronization</p><pre className={styles.value}>{reviewValue(c.type, c.nextValue)}</pre></div></div></section>)}</div>
      {review?.nativeEdits?.map(e => <section key={nativeEditAddress(e)} className={styles.field}><h3>{e.ownerLabel} · {informationRegistry(schema).find(f => f.id === (e.translation?.fieldId ?? e.field))?.label}{e.translation ? ` · ${e.translation.locale}` : ''}</h3><div className={styles.review}><div><p>Shopify now</p><pre className={styles.value}>{e.value ?? 'Not set'}</pre></div><div><p>After synchronization</p><pre className={styles.value}>{e.nextValue ?? 'Not set'}</pre></div></div></section>)}
      {review?.mediaEdits?.map(e => <section key={e.productId} className={styles.field}><h3>{e.ownerLabel} · Product media</h3><p>{e.nextValue.length} gallery items after synchronization · {e.nextValue.filter(id => !e.value.includes(id)).length} added · {e.value.filter(id => !e.nextValue.includes(id)).length} removed from this product.</p><p>Gallery order: {e.nextValue.map(id => e.value.includes(id) ? `current ${e.value.indexOf(id) + 1}` : 'new item').join(', ') || 'Empty gallery'}.</p>{e.altEdits?.map(a => <p key={a.id}>Alt text: {a.value || 'Empty'} → {a.nextValue || 'Empty'}</p>)}</section>)}
      <ShopifyGalleryReview galleries={review?.sheetGalleries} />
    </Modal>
    <Modal open={!!confirmation} title={confirmation?.title} onClose={() => setConfirmation(null)} footer={<><Button onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="primary" onClick={() => { const run = confirmation?.run; setConfirmation(null); run?.() }}>Continue</Button></>}><p>{confirmation?.text}</p></Modal>
    <Modal open={!!leave} title="Discard unsaved draft changes?" onClose={() => { leave?.(false); setLeave(null) }} footer={<><Button onClick={() => { leave?.(false); setLeave(null) }}>Keep editing</Button><Button variant="danger-outline" onClick={() => { leave?.(true); setLeave(null) }}>Discard changes</Button></>}><p>Your last saved Nexus draft remains available.</p></Modal>
    {schema && entry && <EntryEditor key={`${entry.id ?? 'new'}:${!!entry.copy}`} id={entry.id} copy={entry.copy} path={path} schema={schema} canPublish={canPublish} onClose={() => setEntry(null)} onSaved={saved => { setOwnerRefresh(v => v + 1); if (entry.copy) { entry.replace?.(saved.id); setEntry(null); setNotice('The separate entry was created. Its reference is staged for this product; save and review the draft to use it.') } }} />}
    {draft.edits.length > 0 && <Disclosure summary={`Pending field changes (${draft.edits.length})`}><p>Changes for a removed product must be discarded here or the product restored before synchronization.</p>{draft.edits.map(edit => <div key={fieldAddress(edit)} className={styles.field}><span>{edit.ownerLabel} · {definitionAddress(edit)}</span><Button size="xs" disabled={disabled} onClick={() => mutate(d => { d.edits = d.edits.filter(e => fieldAddress(e) !== fieldAddress(edit)) })}>Discard this change</Button></div>)}</Disclosure>}
    {draft.edits.length > 0 && <Disclosure summary={`Pending field edits · ${draft.edits.length}`}><div className={styles.stack}>{draft.edits.map(edit => <div key={fieldAddress(edit)} className={styles.header}><div><strong>{edit.ownerLabel}</strong><p className={styles.hint}>{schema?.definitions.find(d => d.ownerType === (edit.ownerId.includes('/Product/') ? 'PRODUCT' : 'PRODUCTVARIANT') && definitionAddress(d) === definitionAddress(edit))?.name ?? definitionAddress(edit)}</p></div><Button size="xs" disabled={disabled} aria-label={`Discard ${definitionAddress(edit)} edit for ${edit.ownerLabel}`} onClick={() => mutate(d => { d.edits = d.edits.filter(e => fieldAddress(e) !== fieldAddress(edit)) })}>Discard edit</Button></div>)}</div></Disclosure>}
    {schema && <Disclosure summary="Store field coverage"><p>{schema.types.length} types discovered from Shopify. Product and variant definitions are kept separate. App-owned fields remain read-only. Changes are verified against Shopify; the theme controls how storefront content appears.</p></Disclosure>}
  </div>
}
