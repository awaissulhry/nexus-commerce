'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Save, Eye, RefreshCw, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import { fieldKey, inspectShopifyContent, resolveShopifyContent, shopifyContentSchema, shopifyFieldTypes, type ShopifyContent, type ContentAssignment, type ContentField, type ContentValue, type ContentVariant } from '@nexus/shared/shopify-content'
import { Banner, Disclosure, EmptyState, Field, MediaGallery, MediaCard, MediaPreview, Modal } from '@/design-system/components'
import { Button, Checkbox, Input, Select, Textarea, ToolbarButton } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import { useSaveReporter } from '../../contracts'
import { mediaRequest, MediaRequestError } from '../ebay/transport'
import { SourceLibrary } from '../ebay/SourceLibrary'
import styles from './content.module.css'
import { ShopifyFieldValue } from './ShopifyFieldValue'
import { CollectionOrderEditor } from './CollectionOrderEditor'
import { informationValueLabel } from '../../shopify/informationEditing'

interface Workspace {
  productId: string; name: string; sku: string; initialized: boolean; draft: ShopifyContent; variants: ContentVariant[]; revision: string; errors: string[]
  sourceAssets: ShopifyContent['assets']; destination: { accountId: string; listingId: string | null; market: string }
  publication: { status: string; productId: string | null; lastVerifiedAt: string | null; error: string | null; contentHash: string | null }
}
interface Review extends Workspace { changes?: { newProductStatus?: string; requiresActiveConfirmation?: boolean }; domain: string | null; locations: { id: string; name: string }[]; remote: { id: string; status: string; handle: string } | null; remoteRevision: string | null; informationOverrides?: { productId: string; label: string; type: string; locale: string; value: string | null }[] }
interface ImportSource { sourceProductId: string; title: string; defaultLocale: string; locales: string[]; fields: ContentField[]; values: Record<string, ContentValue>; metaobjectDefinitions: ShopifyContent['metaobjectDefinitions']; metaobjects: ShopifyContent['metaobjects']; assets: ShopifyContent['assets']; warnings: string[] }
const newId = () => crypto.randomUUID()
const endpoint = (path: string, suffix: string) => { const [base, query] = path.split('?'); return `${base}${suffix}?${query}` }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

async function request(path: string, body?: unknown): Promise<Workspace> {
  const result = await mediaRequest(path, body === undefined ? 'GET' : 'PUT', body) as Workspace
  const parsed = shopifyContentSchema.safeParse(result?.draft)
  if (!parsed.success || !result.productId || !result.revision || !Array.isArray(result.variants)) throw new MediaRequestError('The saved content could not be verified. Reload before retrying.')
  const query = new URLSearchParams(path.split('?')[1])
  if (query.get('accountId') !== result.destination?.accountId || query.get('market') !== result.destination.market) throw new MediaRequestError('The response belongs to another Shopify destination. Reload before continuing.')
  return { ...result, draft: parsed.data }
}

export function ShopifyContentWorkspace({ path, accountLabel }: { path: string; accountLabel: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [draft, setDraft] = useState<ShopifyContent | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reloadRequired, setReloadRequired] = useState(false)
  const [assignmentId, setAssignmentId] = useState('family'), [groupId, setGroupId] = useState(''), [language, setLanguage] = useState('')
  const [previewId, setPreviewId] = useState(''), [imageId, setImageId] = useState<string | null>(null), [libraryOpen, setLibraryOpen] = useState(false)
  const [review, setReview] = useState<Review | null>(null), [reviewOpen, setReviewOpen] = useState(false), [locationId, setLocationId] = useState(''), [confirmActive, setConfirmActive] = useState(false)
  const [fieldModal, setFieldModal] = useState(false), [newField, setNewField] = useState<ContentField>({ namespace: 'custom', key: '', label: '', type: 'single_line_text_field' })
  const [importOpen, setImportOpen] = useState(false), [sourceProductId, setSourceProductId] = useState(''), [importSource, setImportSource] = useState<ImportSource | null>(null)
  const [confirmation, setConfirmation] = useState<(() => void) | null>(null)
  const canEdit = usePermission('products.edit'), canPublish = usePermission('products.publish')
  const reporter = useSaveReporter(), subject = `shopify-content:${path}`
  const alive = useRef(true), pending = useRef(false), draftRef = useRef(draft), workspaceRef = useRef(workspace)
  draftRef.current = draft; workspaceRef.current = workspace; pending.current = busy
  const dirty = !!draft && !!workspace && (!workspace.initialized || JSON.stringify(draft) !== JSON.stringify(workspace.draft))
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const adopt = useCallback((data: Workspace) => { setWorkspace(data); setDraft(copy(data.draft)); setReloadRequired(false); setError(''); reporter.cleared([subject]) }, [reporter, subject])
  useEffect(() => {
    alive.current = true; const abort = new AbortController()
    void request(path).then(data => { if (!abort.signal.aborted) adopt(data) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => { alive.current = false; abort.abort() }
  }, [path, adopt])
  usePresentationNavigationGuard(dirty || busy, async () => {
    if (pending.current) { setError('Wait for the current request before leaving.'); return false }
    if (!dirtyRef.current) return true
    return new Promise<boolean>(resolve => setLeaveDecision({ resolve }))
  })
  const [leaveDecision, setLeaveDecision] = useState<{ resolve: (leave: boolean) => void } | null>(null)
  const mutate = (change: (value: ShopifyContent) => void) => {
    if (!canEdit || pending.current) return
    setDraft(old => { if (!old) return old; const next = copy(old); change(next); return next }); setNotice(''); setReview(null)
  }
  const check = useMemo(() => draft && workspace ? inspectShopifyContent(draft, workspace.variants) : [], [draft, workspace])
  const variant = workspace?.variants.find(v => v.id === previewId) ?? workspace?.variants[0]
  const locale = language || draft?.defaultLocale || 'it'
  const resolved = draft && variant ? resolveShopifyContent(draft, variant, locale) : null
  const assignment = draft?.assignments.find(a => a.id === assignmentId) ?? draft?.assignments[0]
  const group = draft?.groups.find(g => g.id === groupId) ?? draft?.groups[0]
  const patchAssignment = (change: (value: ContentAssignment) => void) => mutate(d => { const a = d.assignments.find(a => a.id === assignment?.id); if (a) change(a) })
  const disabled = busy || !canEdit

  async function reload() {
    if (pending.current) return
    setBusy(true)
    try { const data = await request(path); if (alive.current) { adopt(data); setNotice('Saved Shopify content loaded.'); setReview(null) } }
    catch (e) { if (alive.current) setError((e as Error).message) } finally { if (alive.current) setBusy(false) }
  }
  async function save() {
    const current = draftRef.current, observed = workspaceRef.current
    if (!current || !observed || pending.current || reloadRequired || !canEdit) return false
    const writeId = newId(); setBusy(true); pending.current = true; setError(''); reporter.pending(writeId, subject)
    try {
      const next = await request(path, { draft: current, expectedRevision: observed.revision })
      reporter.resolved(writeId, true, undefined, subject)
      if (alive.current) { adopt(next); setNotice('Saved in Nexus. Shopify has not been changed.'); setReview(null) }
      return true
    } catch (e) {
      reporter.resolved(writeId, false, (e as Error).message, subject)
      if (alive.current) { setError((e as Error).message); if (!(e instanceof MediaRequestError) || e.status === 0 || e.status === 409 || e.status >= 500) setReloadRequired(true) }
      return false
    } finally { if (alive.current) setBusy(false); pending.current = false }
  }
  async function remoteReview() {
    if (dirty || busy) return
    setBusy(true); setError(''); setConfirmActive(false)
    try { const next = await mediaRequest(endpoint(path, '/preview'), 'POST', { remote: true }) as Review; setReview(next); setReviewOpen(true) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function sync() {
    if (!review || !locationId || busy || dirty) return
    setBusy(true); setError('')
    try {
      const result = await mediaRequest(endpoint(path, '/synchronize'), 'POST', { expectedRevision: review.revision, expectedRemoteRevision: review.remoteRevision, locationId, confirmActive }) as { message: string }
      const next = await request(path); adopt(next); setNotice(result.message); setReviewOpen(false); setReview(null)
    } catch (e) { setError((e as Error).message); setReloadRequired(true); setReview(null); setReviewOpen(false) } finally { setBusy(false) }
  }
  async function refreshLibrary() {
    const next = await request(path)
    // A source upload changes the observed family revision. Rebase only if content/variants still agree.
    const current = workspaceRef.current
    if (!current || ((current.initialized || next.initialized) && JSON.stringify(next.draft) !== JSON.stringify(current.draft)) || JSON.stringify(next.variants) !== JSON.stringify(current.variants)) { setReloadRequired(true); throw new Error('The family changed while uploading. Keep your edits and reload before saving.') }
    setWorkspace(next)
  }
  async function readImport() {
    setBusy(true); setError(''); setImportSource(null)
    try { setImportSource(await mediaRequest(endpoint(path, '/import-source'), 'POST', { sourceProductId }) as ImportSource) }
    catch (e) { setError((e as Error).message); setImportOpen(false) } finally { setBusy(false) }
  }
  function applyImport() {
    if (!importSource || !assignment) return
    const conflict = importSource.fields.find(f => draft?.fields.some(existing => fieldKey(existing) === fieldKey(f) && (existing.type !== f.type || existing.metaobjectType !== f.metaobjectType)))
    if (conflict) { setError(`The imported type for ${fieldKey(conflict)} conflicts with this document. Nothing was imported.`); setImportOpen(false); return }
    mutate(d => {
      d.defaultLocale = importSource.defaultLocale; d.locales = [...new Set([...d.locales, ...importSource.locales])]
      for (const field of importSource.fields) if (!d.fields.some(f => fieldKey(f) === fieldKey(field))) d.fields.push(field)
      for (const def of importSource.metaobjectDefinitions) if (!d.metaobjectDefinitions.some(f => f.type === def.type)) d.metaobjectDefinitions.push(def)
      for (const entry of importSource.metaobjects) if (!d.metaobjects.some(m => m.id === entry.id)) d.metaobjects.push(entry)
      const ids = importSource.assets.map(asset => { const found = d.assets.find(a => a.url === asset.url); if (!found) d.assets.push(asset); return found?.id ?? asset.id })
      const groupId = newId(); d.groups.push({ id: groupId, name: importSource.title, assetIds: ids, featuredId: ids[0] ?? null })
      const target = d.assignments.find(a => a.id === assignment.id)!
      target.values = { ...target.values, ...importSource.values }; target.gallery = { mode: 'replace', groupIds: [groupId], featuredId: null }
    })
    setNotice(`Imported ${importSource.title} into ${assignment.name}. Review the variant previews, then save in Nexus.`); setImportOpen(false)
  }
  if (!workspace || !draft) return <div className={styles.workspace}>{error ? <Banner tone="danger" title="Shopify content unavailable" action={<Button onClick={() => void reload()}>Retry</Button>}>{error}</Banner> : <p role="status">Loading family content…</p>}</div>
  const sourceName = (ids: string[] | undefined) => ids?.map(id => draft.assignments.find(a => a.id === id)?.name ?? id).join(' + ') || 'No assignment'
  return <div className={`${styles.workspace} nds-readable`} aria-busy={busy}>
    <header className={styles.header}>
      <div><h2>Shopify family content</h2><p>{accountLabel} · {workspace.variants.length} native variants · {workspace.name}</p></div>
      <div className={styles.actions}>
        <CollectionOrderEditor path={path} disabled={busy || dirty} />
        <Button size="sm" disabled={disabled} onClick={() => { setImportOpen(true); setImportSource(null) }}>Import Shopify content</Button>
        <Button size="sm" disabled={busy} onClick={() => dirty ? setConfirmation(() => () => void reload()) : void reload()}><RefreshCw size={14} aria-hidden />Reload</Button>
        <Button size="sm" disabled={busy || dirty || !canPublish || check.length > 0 || reloadRequired} onClick={() => void remoteReview()}><Eye size={14} aria-hidden />Review Shopify sync</Button>
        <Button size="sm" variant="primary" disabled={disabled || !dirty || reloadRequired} onClick={() => void save()}><Save size={14} aria-hidden />{busy ? 'Working…' : 'Save content'}</Button>
      </div>
    </header>
    <p className={styles.explanation}>Reuse images and custom fields across the family, option values, combinations and individual variants. More specific assignments override broader ones. Priority resolves competing assignments at the same level.</p>
    {error && <Banner tone="danger" title={reloadRequired ? 'Reload required; your edits are preserved' : 'Request could not be completed'}>{error}</Banner>}
    {notice && <Banner tone="success">{notice}</Banner>}
    {workspace.publication.error && !error && <Banner tone="warning" title="Last Shopify sync is unverified">{workspace.publication.error}</Banner>}
    {check.length > 0 && <Banner tone="warning" title={`${check.length} ${check.length === 1 ? 'issue blocks' : 'issues block'} publishing`}><ul>{check.slice(0, 12).map(e => <li key={e}>{e}</li>)}</ul>{check.length > 12 && <p>{check.length - 12} more issues; review the affected assignments.</p>}</Banner>}
    <div className={styles.settings}>
      <Field label="Shopify destination" hint="A new draft preserves existing colour products for migration review."><Select size="sm" disabled={disabled || workspace.publication.status !== 'NOT_PUBLISHED'} value={draft.target ?? 'new-draft'} onChange={e => mutate(d => { d.target = e.target.value as ShopifyContent['target'] })}><option value="new-draft">New native family draft</option><option value="linked-product">Existing linked Shopify product</option></Select></Field>
      <Field label="Editing language"><Select size="sm" value={locale} onChange={e => setLanguage(e.target.value)}>{draft.locales.map(l => <option key={l} value={l}>{l}{l === draft.defaultLocale ? ' · Default' : ''}</option>)}</Select></Field>
      <Field label="Default language" hint="Must match the Shopify store’s primary language."><Select size="sm" disabled={disabled} value={draft.defaultLocale} onChange={e => mutate(d => { d.defaultLocale = e.target.value })}>{draft.locales.map(l => <option key={l}>{l}</option>)}</Select></Field>
      <Field label="Languages" hint="Comma-separated language codes, such as it, en, de."><DelimitedInput disabled={disabled} values={draft.locales} onChange={values => mutate(d => { d.locales = values })} /></Field>
      <Field label="Native option axes" hint="Names and order follow Information → Variation Theme. Each variant must have a value."><Input readOnly value={draft.axes.map(axis => draft.optionNames?.[axis] ?? axis).join(' · ')} /></Field>
    </div>
    <Disclosure summary="Collection cards"><p>Colours can appear independently in the same collection while sizes remain native variants of one product. Save and synchronise the family to update its collection cards.</p>
      <div className={styles.settings}><Field label="Collection card grouping"><Select disabled={disabled} value={draft.collectionMode ?? 'groups'} onChange={e => mutate(d => { d.collectionMode = e.target.value as ShopifyContent['collectionMode'] })}><option value="groups">One card per option group</option><option value="variants">One card per sellable variant</option><option value="family">One card for the whole family</option></Select></Field></div>
      {(draft.collectionMode ?? 'groups') === 'groups' && <div className={styles.actions}>{draft.axes.map(axis => { const axes = draft.collectionAxes ?? [draft.axes.find(a => /^(colou?r|colore)$/i.test(a)) ?? draft.axes[0]].filter(Boolean); return <Checkbox key={axis} disabled={disabled} checked={axes.includes(axis)} label={`Group cards by ${draft.optionNames?.[axis] ?? axis}`} onChange={e => mutate(d => { d.collectionAxes = e.target.checked ? [...axes, axis] : axes.filter(a => a !== axis) })} /> })}</div>}
    </Disclosure>
    <div className={styles.columns}>
      <section className={styles.panel} aria-label="Content assignments">
        <div className={styles.sectionHeader}><h3>Assignments</h3><Button size="sm" disabled={disabled} onClick={() => { const id = newId(); mutate(d => d.assignments.push({ id, name: 'New assignment', target: { kind: 'options', values: {} }, priority: 0, values: {} })); setAssignmentId(id) }}><Plus size={14} aria-hidden />Add</Button></div>
        <Field label="Assignment"><Select size="sm" value={assignment?.id ?? ''} onChange={e => setAssignmentId(e.target.value)}>{draft.assignments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        {assignment && <>
          <Field label="Name"><Input size="sm" disabled={disabled} value={assignment.name} onChange={e => patchAssignment(a => { a.name = e.target.value })} /></Field>
          <Field label="Applies to"><Select size="sm" disabled={disabled} value={assignment.target.kind} onChange={e => patchAssignment(a => { a.target = e.target.value === 'family' ? { kind: 'family' } : e.target.value === 'variant' ? { kind: 'variant', variantId: workspace.variants[0]?.id ?? '' } : { kind: 'options', values: {} } })}><option value="family">Whole family</option><option value="options">Option value or combination</option><option value="variant">Exact variant</option></Select></Field>
          {assignment.target.kind === 'options' && draft.axes.map(axis => <Field key={axis} label={draft.optionNames?.[axis] ?? axis}><Select size="sm" disabled={disabled} value={assignment.target.kind === 'options' ? assignment.target.values[axis] ?? '' : ''} onChange={e => patchAssignment(a => { if (a.target.kind === 'options') { if (e.target.value) a.target.values[axis] = e.target.value; else delete a.target.values[axis] } })}><option value="">Any {axis.toLowerCase()}</option>{[...new Set(workspace.variants.map(v => v.options[axis]).filter(Boolean))].map(value => <option key={value}>{value}</option>)}</Select></Field>)}
          {assignment.target.kind === 'variant' && <Field label="Exact variant"><Select size="sm" disabled={disabled} value={assignment.target.variantId} onChange={e => patchAssignment(a => { a.target = { kind: 'variant', variantId: e.target.value } })}>{workspace.variants.map(v => <option key={v.id} value={v.id}>{v.sku} · {draft.axes.map(a => v.options[a]).join(' / ')}</option>)}</Select></Field>}
          <Field label="Priority" hint="Higher numbers win between assignments of equal specificity."><Input size="sm" type="number" min={-100} max={100} disabled={disabled} value={assignment.priority} onChange={e => patchAssignment(a => { a.priority = Number(e.target.value) })} /></Field>
          <Field label="Images"><Select size="sm" disabled={disabled} value={assignment.gallery?.mode ?? 'inherit'} onChange={e => patchAssignment(a => { if (e.target.value === 'inherit') delete a.gallery; else a.gallery = { mode: e.target.value as 'replace' | 'append', groupIds: a.gallery?.groupIds ?? [], featuredId: a.gallery?.featuredId ?? null } })}><option value="inherit">Inherit gallery</option><option value="replace">Replace inherited gallery</option><option value="append">Add to inherited gallery</option></Select></Field>
          {assignment.gallery && <>
            <p>Image groups, in display order</p>
            {assignment.gallery.groupIds.map((id, index) => <div key={id} className={styles.orderedRow}><span>{draft.groups.find(g => g.id === id)?.name ?? 'Missing group'}</span><ToolbarButton label="Move group earlier" icon={<ArrowUp size={14} />} disabled={disabled || index === 0} onClick={() => patchAssignment(a => { const ids = a.gallery!.groupIds; [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]] })} /><ToolbarButton label="Move group later" icon={<ArrowDown size={14} />} disabled={disabled || index === assignment.gallery!.groupIds.length - 1} onClick={() => patchAssignment(a => { const ids = a.gallery!.groupIds; [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]] })} /><ToolbarButton label={`Remove ${draft.groups.find(g => g.id === id)?.name ?? 'group'} from assignment`} icon={<Trash2 size={14} />} disabled={disabled} onClick={() => patchAssignment(a => { a.gallery!.groupIds = a.gallery!.groupIds.filter(g => g !== id) })} /></div>)}
            <Field label="Add image group"><Select size="sm" disabled={disabled} value="" onChange={e => { if (e.target.value) patchAssignment(a => a.gallery!.groupIds.push(e.target.value)) }}><option value="">Choose a reusable group</option>{draft.groups.filter(g => !assignment.gallery!.groupIds.includes(g.id)).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
            <Field label="Featured image" hint="The resolved featured image appears first in the gallery and is assigned to the cart variant."><Select size="sm" disabled={disabled} value={assignment.gallery.featuredId ?? ''} onChange={e => patchAssignment(a => { a.gallery!.featuredId = e.target.value || null })}><option value="">Use group featured image</option>{draft.assets.map(a => <option key={a.id} value={a.id}>{a.alt || a.id}</option>)}</Select></Field>
            {assignment.gallery.mode === 'replace' && !assignment.gallery.groupIds.length && <p>This assignment explicitly clears the gallery.</p>}
          </>}
          <Button size="sm" variant="danger-outline" disabled={disabled || assignment.target.kind === 'family'} onClick={() => { mutate(d => { d.assignments = d.assignments.filter(a => a.id !== assignment.id) }); setAssignmentId('family') }}>Remove assignment</Button>
        </>}
      </section>
      <div className={styles.mainColumn}>
        <section className={styles.panel} aria-label="Reusable image groups">
          <div className={styles.sectionHeader}><h3>Image groups</h3><div className={styles.actions}><Button size="sm" disabled={disabled || !group} onClick={() => setLibraryOpen(true)}>Add images</Button><Button size="sm" disabled={disabled} onClick={() => { const id = newId(); mutate(d => d.groups.push({ id, name: 'New image group', assetIds: [], featuredId: null })); setGroupId(id) }}><Plus size={14} aria-hidden />New group</Button></div></div>
          <div className={styles.settings}><Field label="Image group"><Select size="sm" value={group?.id ?? ''} onChange={e => setGroupId(e.target.value)}>{draft.groups.map(g => <option key={g.id} value={g.id}>{g.name} · {g.assetIds.length} images</option>)}</Select></Field>{group && <Field label="Group name"><Input size="sm" disabled={disabled} value={group.name} onChange={e => mutate(d => { d.groups.find(g => g.id === group.id)!.name = e.target.value })} /></Field>}</div>
          {group?.assetIds.length ? <MediaGallery label={group.name} firstLabel="Featured" disabled={disabled} items={group.assetIds.flatMap(id => { const asset = draft.assets.find(a => a.id === id); return asset ? [{ id, src: !asset.type || asset.type === 'IMAGE' ? asset.url : null, mediaType: asset.type, label: (locale === draft.defaultLocale ? asset.alt : asset.translations[locale] ?? asset.translations[locale.split('-')[0]] ?? asset.alt) || 'Product image' }] : [] })}
            onChange={ids => mutate(d => { const g = d.groups.find(g => g.id === group.id)!; g.assetIds = ids; g.featuredId = ids[0] ?? null })}
            onRemove={id => mutate(d => { const g = d.groups.find(g => g.id === group.id)!; g.assetIds = g.assetIds.filter(a => a !== id); if (g.featuredId === id) g.featuredId = g.assetIds[0] ?? null })} onPreview={setImageId} /> : <EmptyState title="Build a reusable gallery" description="Add images from the product library, then assign this group to the family or any options." />}
          {group && <p>{draft.assignments.filter(a => a.gallery?.groupIds.includes(group.id)).length} assignments use this group. Reordering it updates every assignment that uses it.</p>}
        </section>
        <section className={styles.panel} aria-label="Shopify metafields">
          <div className={styles.sectionHeader}><div><h3>Metafields</h3><p>{assignment?.name} · {locale}</p></div><Button size="sm" disabled={disabled} onClick={() => setFieldModal(true)}><Plus size={14} aria-hidden />Add field</Button></div>
          {!draft.fields.length && <EmptyState title="Add product information" description="Define a Shopify metafield once, then inherit or override it for any option combination." />}
          {assignment && draft.fields.map(field => {
            const key = fieldKey(field), value = assignment.values[key]
            return <div key={key} className={styles.fieldRow}><div><strong>{field.label}</strong><p>{key} · {field.type}</p></div><Field label={`${field.label} source`}><Select size="sm" disabled={disabled} value={value === undefined ? 'inherit' : value.value === null ? 'clear' : 'override'} onChange={e => patchAssignment(a => { if (e.target.value === 'inherit') delete a.values[key]; else a.values[key] = { value: e.target.value === 'clear' ? null : '', translations: {} } })}><option value="inherit">Inherit</option><option value="override">Override</option><option value="clear">Clear explicitly</option></Select></Field>
              {value && value.value !== null && <ShopifyFieldValue field={field} value={value} language={locale} defaultLocale={draft.defaultLocale} metaobjects={draft.metaobjects} assets={draft.assets} disabled={disabled} onChange={next => patchAssignment(a => { a.values[key] = next })} />}
              <p>Preview source: {sourceName(resolved?.sources[key])}{resolved?.fields[key] === null ? ' · Explicitly cleared' : ''}</p>
            </div>
          })}
        </section>
        <MetaobjectsEditor draft={draft} language={locale} disabled={disabled} mutate={mutate} />
      </div>
      <section className={styles.panel} aria-label="Resolved variant preview">
        <h3>Variant preview</h3>
        <Field label="Preview variant"><Select size="sm" value={variant?.id ?? ''} onChange={e => setPreviewId(e.target.value)}>{workspace.variants.map(v => <option key={v.id} value={v.id}>{v.sku} · {draft.axes.map(a => v.options[a]).join(' / ')}</option>)}</Select></Field>
        {variant && <div className={styles.facts}><strong>{variant.sku}</strong><span>{variant.price} · {variant.stock > 0 ? `${variant.stock} available` : 'Out of stock'}</span><span>{draft.axes.map(a => `${draft.optionNames?.[a] ?? a}: ${variant.options[a] ?? 'Missing'}`).join(' · ')}</span></div>}
        <p>Gallery from {sourceName(resolved?.sources.gallery)}</p>
        <div className={styles.previewGallery}>{resolved?.assetIds.map((id, index) => { const asset = draft.assets.find(a => a.id === id); return asset ? <MediaCard key={id} src={!asset.type || asset.type === 'IMAGE' ? asset.url : null} mediaType={asset.type} label={(locale === draft.defaultLocale ? asset.alt : asset.translations[locale] ?? asset.translations[locale.split('-')[0]] ?? asset.alt) || 'Product image'} marker={resolved.featuredId === id ? 'Featured' : index + 1} onPreview={() => setImageId(id)} /> : null })}</div>
        {!resolved?.assetIds.length && <p>No assigned images for this variant.</p>}
        {draft.fields.map(f => <div key={fieldKey(f)} className={styles.previewField}><strong>{f.label}</strong><span>{resolved?.fields[fieldKey(f)] ?? 'Empty'}</span><small>{sourceName(resolved?.sources[fieldKey(f)])}</small></div>)}
        <p className={styles.explanation}>The same resolution is used when synchronising Shopify. Price and inventory come from this variant’s product and Shopify offer settings.</p>
        <p>Last sync: {workspace.publication.status.toLowerCase().replace(/_/g, ' ')}{workspace.publication.lastVerifiedAt ? ` · ${new Date(workspace.publication.lastVerifiedAt).toLocaleString()}` : ''}</p>
      </section>
    </div>
    <Modal open={fieldModal} onClose={() => setFieldModal(false)} title="Define a Shopify metafield" size="md" readable footer={<><Button onClick={() => setFieldModal(false)}>Cancel</Button><Button variant="primary" disabled={disabled || !newField.label || !/^[A-Za-z0-9_-]{3,64}$/.test(newField.key) || draft.fields.some(f => fieldKey(f) === fieldKey(newField))} onClick={() => { mutate(d => d.fields.push(copy(newField))); setFieldModal(false); setNewField({ namespace: 'custom', key: '', label: '', type: 'single_line_text_field' }) }}>Add field</Button></>}>
      <Field label="Label"><Input value={newField.label} onChange={e => setNewField({ ...newField, label: e.target.value })} /></Field><Field label="Namespace"><Input value={newField.namespace} onChange={e => setNewField({ ...newField, namespace: e.target.value })} /></Field><Field label="Key"><Input value={newField.key} onChange={e => setNewField({ ...newField, key: e.target.value })} /></Field><Field label="Type"><Select value={newField.type} onChange={e => setNewField({ ...newField, type: e.target.value as ContentField['type'] })}>{shopifyFieldTypes.map(t => <option key={t}>{t}</option>)}</Select></Field>
      {newField.type.includes('metaobject_reference') && <Field label="Reusable entry type"><Select value={newField.metaobjectType ?? ''} onChange={e => setNewField({ ...newField, metaobjectType: e.target.value })}><option value="">Choose a defined type</option>{draft.metaobjectDefinitions.map(d => <option key={d.type} value={d.type}>{d.name}</option>)}</Select></Field>}
      <p>Compatible Shopify definitions are reused. A conflicting type blocks publication.</p>
      <Checkbox label="Show this field under product details" checked={newField.storefront ?? false} onChange={e => setNewField({ ...newField, storefront: e.target.checked })} />
    </Modal>
    <Modal open={importOpen} onClose={() => { if (!busy) setImportOpen(false) }} title="Import an existing Shopify product’s content" size="lg" readable footer={<><Button disabled={busy} onClick={() => setImportOpen(false)}>Close</Button>{importSource ? <Button variant="primary" disabled={disabled} onClick={applyImport}>Apply to {assignment?.name}</Button> : <Button variant="primary" disabled={busy || !sourceProductId} onClick={() => void readImport()}>{busy ? 'Reading Shopify…' : 'Read source product'}</Button>}</>}>
      <p>Select an assignment first, such as Color = Red, then import that colour product’s gallery and metafields. Repeat for the other source products. Source Shopify products are preserved.</p><Field label="Source Shopify product ID"><Input value={sourceProductId} disabled={busy || !!importSource} onChange={e => setSourceProductId(e.target.value)} placeholder="Numeric ID from the Shopify product’s admin URL" /></Field>
      {importSource && <><h3>{importSource.title}</h3><p>{importSource.assets.length} images · {importSource.fields.length} metafields · {importSource.metaobjects.length} reusable entries</p><p>This replaces the current assignment’s gallery and the matching field values in your unsaved draft. Existing reusable entries with the same ID are retained.</p>{importSource.warnings.length > 0 && <Banner tone="warning">{importSource.warnings.join(' ')}</Banner>}</>}
    </Modal>
    {imageId && <Modal open onClose={() => setImageId(null)} title="Media and alternative text" size="lg" readable>{(() => { const a = draft.assets.find(a => a.id === imageId); return a ? <div className={styles.imageEditor}><MediaPreview type={a.type ?? 'IMAGE'} url={a.url} label={(locale === draft.defaultLocale ? a.alt : a.translations[locale] ?? a.alt) || 'Product media'} captions={a.accessibility?.[locale]?.captions} transcript={a.accessibility?.[locale]?.transcript} /><Field label={`Alternative text · ${locale}`} hint="Describe the image for shoppers and screen readers. This text never controls grouping."><Textarea disabled={disabled} rows={3} value={locale === draft.defaultLocale ? a.alt : a.translations[locale] ?? ''} placeholder={locale === draft.defaultLocale ? 'Describe this image' : `Inherits: ${a.alt}`} onChange={e => mutate(d => { const asset = d.assets.find(a => a.id === imageId)!; if (locale === d.defaultLocale) asset.alt = e.target.value; else if (e.target.value) asset.translations[locale] = e.target.value; else delete asset.translations[locale] })} /></Field></div> : null })()}</Modal>}
    {libraryOpen && group && <SourceLibrary assets={[...new Map([...workspace.sourceAssets, ...draft.assets].map(a => [a.url, { ...a, label: a.alt || 'Product image', width: null, height: null, origin: 'product' as const }])).values()]} assignedUrls={new Set(group.assetIds.map(id => draft.assets.find(a => a.id === id)?.url ?? ''))} productId={workspace.productId} disabled={disabled} galleryLabel={group.name} galleryCount={group.assetIds.length} galleryLimit={250} pinned={false} canPin={false} onPinChange={() => {}} onClose={() => setLibraryOpen(false)} onBusyChange={setBusy} onRefresh={refreshLibrary} onPreview={id => { const source = workspace.sourceAssets.find(a => a.id === id); if (source && !draft.assets.some(a => a.id === id)) mutate(d => d.assets.push(source)); setImageId(id) }} onAdd={ids => { mutate(d => { const g = d.groups.find(g => g.id === group.id)!; for (const id of ids) { const source = [...d.assets, ...workspace.sourceAssets].find(a => a.id === id); if (!source) continue; const found = d.assets.find(a => a.url === source.url); if (!found) d.assets.push(copy(source)); const assetId = found?.id ?? source.id; if (!g.assetIds.includes(assetId)) g.assetIds.push(assetId) } g.featuredId ??= g.assetIds[0] ?? null }); return true }} />}
    <Modal open={reviewOpen} onClose={() => { if (!busy) setReviewOpen(false) }} title="Review Shopify synchronisation" size="lg" readable footer={<><Button disabled={busy} onClick={() => setReviewOpen(false)}>Close</Button><Button variant="primary" disabled={busy || !canPublish || !review || !!review.errors.length || !locationId || (review.changes?.requiresActiveConfirmation && !confirmActive)} onClick={() => void sync()}>{busy ? 'Synchronising…' : review?.remote ? 'Synchronise reviewed product' : review?.changes?.newProductStatus === 'DRAFT' ? 'Create draft product' : 'Create reviewed product'}</Button></>}>
      {!!review?.informationOverrides?.length && <Disclosure summary={`Information overrides (${review.informationOverrides.length})`} open>{review.informationOverrides.map((field, index) => <p key={index}>{review.variants.find(v => v.id === field.productId)?.sku ?? review.name} · {field.label} · {field.locale}: {informationValueLabel(field.type, field.value)}</p>)}</Disclosure>}
      {review && <><p>{review.domain} · {review.remote ? `${review.remote.status.toLowerCase()} product ${review.remote.id.split('/').pop()}` : `New product · ${review.changes?.newProductStatus ?? 'DRAFT'}`}</p><p>{review.variants.length} native variants · {review.draft.groups.length} media groups · {review.draft.fields.length} metafields · {review.draft.metaobjects.length} reusable entries</p><p>This sends the saved variant prices, inventory at the selected location, assigned images and resolved metafields. Shopify variants outside this family block the sync. Nexus creates reusable versions for this family; existing source products keep their content.</p>{review.errors.length > 0 && <Banner tone="danger">{review.errors.join(' ')}</Banner>}<Field label="Inventory location"><Select value={locationId} onChange={e => setLocationId(e.target.value)} disabled={busy}><option value="">Choose the stock destination</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>{review.changes?.requiresActiveConfirmation && <Checkbox checked={confirmActive} disabled={busy} onChange={e => setConfirmActive(e.target.checked)} label="I approve the reviewed product changes, including the saved status and any effect on a live or archived product." />}<p>Localized media descriptions, captions and transcripts are stored in the Nexus Shopify content manifest. Their storefront display depends on the reviewed theme; Shopify has one native product gallery. Review a theme preview separately before publishing theme changes.</p></>}
    </Modal>
    <Modal open={!!confirmation || !!leaveDecision} onClose={() => { setConfirmation(null); leaveDecision?.resolve(false); setLeaveDecision(null) }} title="Discard unsaved content?" footer={<><Button onClick={() => { setConfirmation(null); leaveDecision?.resolve(false); setLeaveDecision(null) }}>Keep editing</Button><Button variant="danger-outline" onClick={() => { confirmation?.(); setConfirmation(null); leaveDecision?.resolve(true); setLeaveDecision(null) }}>Discard edits</Button></>}><p>Changes since your last save will be discarded. Saved content and source images are retained.</p></Modal>
  </div>
}

function DelimitedInput({ id, values, disabled, onChange }: { id?: string; values: string[]; disabled: boolean; onChange(values: string[]): void }) {
  const [text, setText] = useState(values.join(', '))
  const parse = (raw: string) => raw.split(',').map(value => value.trim()).filter(Boolean)
  useEffect(() => { if (JSON.stringify(values) !== JSON.stringify(parse(text))) setText(values.join(', ')) }, [values, text])
  return <Input id={id} size="sm" disabled={disabled} value={text} onChange={e => { setText(e.target.value); onChange(parse(e.target.value)) }} />
}

function MetaobjectsEditor({ draft, language, disabled, mutate }: { draft: ShopifyContent; language: string; disabled: boolean; mutate(change: (d: ShopifyContent) => void): void }) {
  const [type, setType] = useState(''), [name, setName] = useState('')
  return <Disclosure summary={`Reusable content · ${draft.metaobjects.length} entries`}><p>Reusable content is published as Shopify metaobjects. Each entry can be referenced by several family or variant metafields.</p>
    <div className={styles.settings}><Field label="New content type"><Input size="sm" value={type} disabled={disabled} placeholder="feature_card" onChange={e => setType(e.target.value)} /></Field><Field label="Type name"><Input size="sm" value={name} disabled={disabled} placeholder="Feature card" onChange={e => setName(e.target.value)} /></Field><Button size="sm" disabled={disabled || !/^[a-z][a-z0-9_-]{2,100}$/.test(type) || !name || draft.metaobjectDefinitions.some(d => d.type === type)} onClick={() => { mutate(d => d.metaobjectDefinitions.push({ type, name, fields: [{ key: 'text', label: 'Text', type: 'multi_line_text_field' }] })); setType(''); setName('') }}>Add type</Button></div>
    {draft.metaobjectDefinitions.map(def => <Disclosure key={def.type} summary={def.name}><div className={styles.sectionHeader}><p>{def.type}</p><Button size="sm" disabled={disabled} onClick={() => mutate(d => d.metaobjects.push({ id: newId(), type: def.type, handle: `entry-${newId().slice(0, 8)}`, fields: Object.fromEntries(def.fields.map(f => [f.key, { value: null, translations: {} }])) }))}>New entry</Button></div>
      {def.fields.map((field, index) => <div className={styles.settings} key={index}><Field label="Field key"><Input size="sm" disabled={disabled || draft.metaobjects.some(m => m.type === def.type)} value={field.key} onChange={e => mutate(d => { d.metaobjectDefinitions.find(v => v.type === def.type)!.fields[index].key = e.target.value })} /></Field><Field label="Field label"><Input size="sm" disabled={disabled} value={field.label} onChange={e => mutate(d => { d.metaobjectDefinitions.find(v => v.type === def.type)!.fields[index].label = e.target.value })} /></Field><Field label="Field type"><Select size="sm" disabled={disabled} value={field.type} onChange={e => mutate(d => { d.metaobjectDefinitions.find(v => v.type === def.type)!.fields[index].type = e.target.value as ContentField['type'] })}>{shopifyFieldTypes.filter(t => !t.includes('metaobject')).map(t => <option key={t}>{t}</option>)}</Select></Field></div>)}
      <Button size="sm" disabled={disabled} onClick={() => mutate(d => d.metaobjectDefinitions.find(v => v.type === def.type)!.fields.push({ key: `field_${def.fields.length + 1}`, label: 'New field', type: 'single_line_text_field' }))}>Add entry field</Button>
      {draft.metaobjects.filter(m => m.type === def.type).map(entry => <div key={entry.id} className={styles.entry}><Field label="Entry handle"><Input size="sm" disabled={disabled} value={entry.handle} onChange={e => mutate(d => { d.metaobjects.find(m => m.id === entry.id)!.handle = e.target.value })} /></Field>{def.fields.map(f => <ShopifyFieldValue key={f.key} field={f} value={entry.fields[f.key] ?? { value: '', translations: {} }} language={language} defaultLocale={draft.defaultLocale} metaobjects={draft.metaobjects} assets={draft.assets} disabled={disabled} onChange={value => mutate(d => { d.metaobjects.find(m => m.id === entry.id)!.fields[f.key] = value })} />)}<p>Reference: @metaobject:{entry.id}</p></div>)}
    </Disclosure>)}
  </Disclosure>
}
