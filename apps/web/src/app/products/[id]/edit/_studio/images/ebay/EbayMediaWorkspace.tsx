'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Eye, Image as ImageIcon, Plus, RefreshCw, Save, Search, ClipboardCheck } from 'lucide-react'
import { appendGalleryAssets, draftFingerprint, galleryLimit, galleryKey, galleryLabel, inspectMediaDraft, isUsableMediaUrl,
  type EbayMediaDraft, type EbayMediaGallery, type EbayMediaWorkspace as Workspace } from '@nexus/shared/ebay-media'
import { Banner, Disclosure, EmptyState, Field, MediaGallery, Modal, PressableRow, Thumbnail } from '@/design-system/components'
import { Button, Input, Select, Tag, ToolbarButton } from '@/design-system/primitives'
import { PageHeader } from '@/design-system/patterns'
import { GridDensityProvider } from '@/design-system/lib/density'
import { usePermission } from '@/lib/auth/AuthProvider'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import { useSaveReporter } from '../../contracts'
import { ListingPhotoPreview } from './ListingPhotoPreview'
import { MediaReview } from './MediaReview'
import { dimensions, SourceLibrary } from './SourceLibrary'
import { MediaRequestError, requestWorkspace } from './transport'
import styles from './media.module.css'

const LISTING: EbayMediaGallery = { axis: null, value: null, assetIds: [] }

export function EbayMediaWorkspace({ path, productId, onListingChange, accountLabel }: { accountLabel: string; path: string; productId: string; onListingChange: (id: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [draft, setDraft] = useState<EbayMediaDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [savedMessage, setSavedMessage] = useState('')
  const [activeKey, setActiveKey] = useState(galleryKey(LISTING))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [groupQuery, setGroupQuery] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryPinned, setLibraryPinned] = useState(false)
  const [canPinLibrary, setCanPinLibrary] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const galleryHeading = useRef<HTMLHeadingElement>(null)
  const [compactLayout, setCompactLayout] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; proceed: () => void; cancel: () => void } | null>(null)
  const reporter = useSaveReporter()
  const canEdit = usePermission('products.images.edit')
  const pending = useRef(false)
  const alive = useRef(true)
  const readSequence = useRef(0)
  const subject = `ebay-media:${path}`
  const dirty = !!workspace && !!draft && draftFingerprint(workspace.draft) !== draftFingerprint(draft)
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  pending.current = busy || uploading

  useEffect(() => {
    if (!workspace || !root.current) return
    const element = root.current
    const measure = () => { setCanPinLibrary(element.clientWidth >= 1180); setCompactLayout(element.clientWidth < 700) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [workspace?.productId])

  const adopt = useCallback((next: Workspace) => {
    setWorkspace(next); setDraft(next.draft); setError(null); setRequiresReload(false)
    reporter.cleared([subject])
  }, [reporter, subject])

  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    const sequence = ++readSequence.current
    void requestWorkspace(path, undefined, abort.signal).then(next => {
      if (!abort.signal.aborted && sequence === readSequence.current) adopt(next)
    }).catch(error => { if (!abort.signal.aborted) setLoadError(error instanceof Error ? error.message : 'The gallery could not be loaded.') })
    return () => { alive.current = false; abort.abort() }
  }, [path, adopt])

  usePresentationNavigationGuard(dirty || busy || uploading, async () => {
    if (pending.current) { setError('Wait for the current request to finish before leaving.'); return false }
    if (!dirtyRef.current) return true
    return new Promise<boolean>(resolve => setConfirmation({ title: 'Discard unsaved gallery changes?',
      description: 'The saved gallery and source uploads will be retained. Changes made since your last gallery save will be discarded.',
      proceed: () => { setConfirmation(null); resolve(true) }, cancel: () => { setConfirmation(null); resolve(false) } }))
  })

  const galleries = useMemo(() => {
    if (!draft || !workspace) return [LISTING]
    const groups = new Map<string, EbayMediaGallery>([[galleryKey(LISTING), LISTING]])
    const axis = workspace.axes.find(a => a.name === draft.axis)
    for (const value of axis?.values ?? []) { const g = { axis: axis!.name, value, assetIds: [] }; groups.set(galleryKey(g), g) }
    for (const g of draft.galleries) if (g.axis === null || g.axis === draft.axis) groups.set(galleryKey(g), g)
    return [...groups.values()]
  }, [draft, workspace])
  const active = galleries.find(g => galleryKey(g) === activeKey) ?? galleries[0]
  const byId = new Map(workspace?.assets.map(a => [a.id, a]) ?? [])
  const assignedUrls = new Set(active.assetIds.flatMap(id => byId.has(id) ? [byId.get(id)!.url] : []))
  const preview = previewId ? byId.get(previewId) : undefined
  const check = draft && workspace ? inspectMediaDraft(draft, workspace.assets, workspace.axisLabels) : { problems: [], review: [] }
  const blocked = busy || uploading || !canEdit || !workspace?.destination.listingId

  function replaceGallery(gallery: EbayMediaGallery) {
    if (blocked) return
    setDraft(current => current && ({ ...current, galleries: [...current.galleries.filter(g => galleryKey(g) !== galleryKey(gallery)), gallery] }))
    setSavedMessage(''); if (!requiresReload) setError(null)
  }
  function add(ids: string[]) {
    if (!workspace || blocked) return false
    try { replaceGallery(appendGalleryAssets(active, ids, workspace.assets)); return true }
    catch (error) { setError(error instanceof Error ? error.message : 'Images could not be added.'); return false }
  }
  async function reload() {
    if (pending.current) return
    const sequence = ++readSequence.current
    setBusy(true); pending.current = true; setLoadError(null)
    try { const next = await requestWorkspace(path); if (alive.current && sequence === readSequence.current) { adopt(next); setSavedMessage('Loaded the saved gallery from Nexus.'); setActiveKey(galleryKey(LISTING)) } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'The gallery could not be reloaded.') }
    finally { if (alive.current) setBusy(false); pending.current = false }
  }
  function askReload() {
    if (!dirty) { void reload(); return }
    setConfirmation({ title: 'Reload the saved gallery?', description: 'Your unsaved gallery edits will be discarded. Uploaded source images will be retained.',
      proceed: () => { setConfirmation(null); void reload() }, cancel: () => setConfirmation(null) })
  }
  async function refreshLibrary() {
    const sequence = ++readSequence.current
    const next = await requestWorkspace(path)
    if (!alive.current || sequence !== readSequence.current) return
    if (workspace && next.revision !== workspace.revision) {
      setRequiresReload(true); setError('The saved gallery changed while the library refreshed. Your edits are retained. Reload the saved gallery before saving.')
    }
    // Refresh evidence and labels while preserving the operator's draft and observed revision.
    setWorkspace(current => current ? { ...current, axes: next.axes, axisLabels: next.axisLabels, warnings: next.warnings, destination: next.destination,
      assets: [...next.assets, ...current.assets.filter(a => !next.assets.some(n => n.id === a.id))] } : next)
  }
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  refreshRef.current = async () => {
    if (pending.current) return
    const sequence = ++readSequence.current
    const next = await requestWorkspace(path)
    if (!alive.current || pending.current || sequence !== readSequence.current) return
    if (!dirtyRef.current) adopt(next)
    else {
      if (next.revision !== workspace?.revision) {
        setRequiresReload(true); setError('This listing or its variation groups changed. Your edits are retained. Reload before saving.')
      }
      setWorkspace(current => current ? { ...current, axes: next.axes, axisLabels: next.axisLabels, warnings: next.warnings } : next)
    }
  }
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void refreshRef.current().catch(() => {
      if (alive.current) setError('The listing context could not be refreshed. The last loaded data is still shown. Reload to retry.')
    }) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  async function save() {
    if (!workspace || !draft || blocked || pending.current || (!dirty && !workspace.destination.inherited) || requiresReload || check.problems.length) return
    ++readSequence.current
    const writeId = `${subject}:${crypto.randomUUID()}`
    setBusy(true); pending.current = true; setError(null); reporter.pending(writeId, subject)
    try {
      const next = await requestWorkspace(path, { expectedRevision: workspace.revision, draft })
      reporter.resolved(writeId, true, undefined, subject)
      if (alive.current) { adopt(next); setSavedMessage('Gallery saved in Nexus. No live eBay listing was updated.') }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The save result could not be confirmed.'
      reporter.resolved(writeId, false, message, subject)
      if (alive.current) { setError(message); if (!(error instanceof MediaRequestError) || error.status === 0 || error.status === 409 || error.status >= 500) setRequiresReload(true) }
    } finally { if (alive.current) setBusy(false); pending.current = false }
  }

  if (!workspace || !draft) return <div className={styles.state} aria-busy={!loadError && !error}>
    {loadError || error ? <EmptyState title="Gallery unavailable" description={loadError ?? error} action={<Button onClick={() => { void reload() }} disabled={busy}><RefreshCw size={16} aria-hidden />Retry</Button>} />
      : <p role="status">Loading eBay galleries and source images…</p>}
  </div>

  const axisNames = [...new Set([...workspace.axes.map(a => a.name), ...draft.galleries.flatMap(g => g.axis ? [g.axis] : []), ...(draft.axis ? [draft.axis] : [])])]
  const labelGallery = (gallery: EbayMediaGallery) => galleryLabel(gallery, workspace.axisLabels)
  const common = galleries[0]
  const cover = byId.get(common.assetIds[0])
  const copySources = draft.galleries.filter(g => g.assetIds.length && galleryKey(g) !== galleryKey(active))
  const variations = galleries.filter(g => g.axis !== null)
  const visibleVariations = variations.filter(g => (g.value ?? '').toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase()))
  const missing = variations.filter(g => !g.assetIds.length)
  const unverified = variations.filter(g => g.assetIds.length && !workspace.axes.some(a => a.name === g.axis && a.values.includes(g.value ?? '')))
  const reviewCount = check.problems.length + check.review.length + missing.length + unverified.length
  const pinned = libraryOpen && libraryPinned && canPinLibrary
  const selectGallery = (gallery: EbayMediaGallery) => {
    setActiveKey(galleryKey(gallery)); if (!requiresReload) setError(null)
    if (compactLayout) { setGroupsOpen(false); requestAnimationFrame(() => galleryHeading.current?.focus()) }
  }
  const variationNavigation = <div className={styles.variationControls}>
            {!compactLayout && <div className={styles.sectionHead}><h2>Variation photos</h2><span className={styles.count}>{variations.length} groups</span></div>}
            <Field label="Group photos by"><Select value={draft.axis ?? ''} disabled={blocked} onChange={event => {
              setDraft({ ...draft, axis: event.target.value || null }); setActiveKey(galleryKey(LISTING)); setGroupQuery(''); setSavedMessage('')
            }}><option value="">Common photos only</option>{axisNames.map(name => <option key={name} value={name}>{workspace.axisLabels[name] ?? name}{workspace.axes.some(a => a.name === name) ? '' : ' · Saved, unverified'}</option>)}</Select></Field>
            {(variations.length > 6 || groupQuery) && <Input aria-label="Search variation groups" placeholder="Find a variation" leadingIcon={<Search size={16} aria-hidden />} value={groupQuery} onChange={event => setGroupQuery(event.target.value)} />}
            <div className={styles.galleryList}>
              {visibleVariations.map(g => <PressableRow key={galleryKey(g)} label={g.value}
                leading={<Thumbnail src={byId.get(g.assetIds[0])?.url ?? null} alt="" hoverPreview={false} />}
                current={galleryKey(g) === galleryKey(active)} disabled={busy || uploading} onClick={() => selectGallery(g)} description={`${g.assetIds.length} ${g.assetIds.length === 1 ? 'image' : 'images'} assigned`}>
                {g.assetIds.length ? <span className={styles.count}>{g.assetIds.length}</span> : <Tag>No photos</Tag>}
              </PressableRow>)}
            </div>
            {groupQuery && <p role="status" className={styles.groupHint}>{visibleVariations.length} of {variations.length} groups{visibleVariations.length ? '' : ' · Try a different search.'}</p>}
  </div>
  return <div className={styles.workspace} ref={root}>
    <header className={styles.workspaceHeader}>
      <PageHeader title="Images" actions={<div className={styles.actionRow}>
        {compactLayout ? <>
          <ToolbarButton icon={<Eye size={16} aria-hidden />} label="Preview" onClick={() => setPreviewOpen(true)} />
          <ToolbarButton icon={<ClipboardCheck size={16} aria-hidden />} label="Review image draft" badge={reviewCount || undefined} onClick={() => setReviewOpen(true)} />
        </> : <>
          <Button onClick={() => setPreviewOpen(true)}><Eye size={16} aria-hidden />Preview</Button>
          <Button onClick={() => setReviewOpen(true)}><ClipboardCheck size={16} aria-hidden />Review{reviewCount ? ` (${reviewCount})` : ''}</Button>
        </>}
        <Button variant="tonal" disabled={blocked || (!dirty && !workspace.destination.inherited) || requiresReload || !!check.problems.length} onClick={() => { void save() }}>{!compactLayout && <Save size={16} aria-hidden />}Save draft</Button>
      </div>} />
      <section className={styles.destination} aria-label="Listing destination">
        <Field label="Listing alias"><Select value={workspace.destination.listingId ?? ''} disabled={busy || uploading || !workspace.destination.listings.length} onChange={event => onListingChange(event.target.value)}>
          {!workspace.destination.listingId && <option value="">Choose a listing</option>}
          {workspace.destination.listings.map(listing => <option key={listing.id} value={listing.id}>{listing.label}{listing.externalListingId ? ` · ${listing.externalListingId}` : ' · No live ID'}{workspace.destination.listings.some(other => other.id !== listing.id && other.label === listing.label && other.externalListingId === listing.externalListingId) ? ` · ${listing.id}` : ''}</option>)}
        </Select></Field>
        <div className={styles.destinationSummary}><strong>eBay {workspace.destination.marketplace} · {accountLabel}</strong><p>Draft only · Saving does not publish</p></div>
        <p className={styles.saveStatus} role="status">{busy ? 'Saving or refreshing…' : requiresReload ? 'Reload required before saving' : dirty ? 'Unsaved changes' : workspace.destination.inherited ? 'Starting images · Save to keep' : 'Saved in Nexus'}</p>
      </section>
    </header>
    <div className={styles.workspaceBody}>
      {!workspace.destination.listingId && <Banner tone="neutral" title="Choose a listing to edit">{workspace.destination.listings.length ? 'Select a listing alias above to load its galleries and variation groups.' : 'There are no available listings for this product in the selected account and market. Create a listing in Information, then reload Media.'}</Banner>}
      {!canEdit && <Banner tone="neutral" title="View access">You can inspect these galleries. Image editing permission is required to change them.</Banner>}
      {error && <Banner tone="danger" title={requiresReload ? 'Reload required before saving' : 'Action could not be completed'} action={requiresReload ? <Button disabled={busy || uploading} onClick={askReload}>Reload saved</Button> : undefined}>{error}</Banner>}
      {check.problems.length > 0 && <Banner tone="neutral" title="Review required before saving"
        action={<Button onClick={() => setReviewOpen(true)}>Review issues</Button>}>{check.problems[0]}</Banner>}
      {savedMessage && <p className={styles.savedMessage} role="status">{savedMessage}</p>}
      {workspace.warnings.length > 0 && <Banner tone="neutral" title="Gallery context"><ul>{workspace.warnings.map(w => <li key={w}>{w}</li>)}</ul></Banner>}
      <div className={styles.editor} data-library-pinned={pinned || undefined}>
        <GridDensityProvider value="compact"><aside className={styles.galleries} aria-label="Image galleries">
          {!compactLayout && <div className={styles.gallerySection}>
            <h2>Common photos</h2>
            <PressableRow label="Cover & common photos" leading={<Thumbnail src={cover?.url ?? null} alt="" hoverPreview={false} />}
              current={active.axis === null} disabled={busy || uploading} onClick={() => selectGallery(common)} description={`${common.assetIds.length} common images; the first is the default cover.`}>
              <span className={styles.count}>{common.assetIds.length}</span>
            </PressableRow>
          </div>}
          <div className={styles.gallerySection}>
            {compactLayout ? <Disclosure summary={`Variation photos · ${variations.length} groups`} open={groupsOpen} onToggle={event => setGroupsOpen(event.currentTarget.open)}>{variationNavigation}</Disclosure> : variationNavigation}
          </div>
        </aside></GridDensityProvider>
        <section className={styles.canvas} aria-label={labelGallery(active)}>
          {active.axis !== null && <section className={styles.commonSummary} aria-label="Common photos for this listing">
            <Thumbnail src={cover?.url ?? null} alt={cover?.label ?? 'No default cover'} hoverPreview={false} />
            <div><strong>Cover & common photos</strong><p>{cover ? `${common.assetIds.length} common photos · Cover: ${cover.label}` : 'No default cover assigned.'}</p></div>
            <Button onClick={() => selectGallery(common)}>Edit common photos</Button>
          </section>}
          <div className={styles.sectionHead}><div><h2 ref={galleryHeading} tabIndex={-1}>{labelGallery(active)}</h2><p>{active.assetIds.length} / {galleryLimit(active)} photos</p></div>
            <div className={styles.actionRow}>
              <Button disabled={blocked || !copySources.length} onClick={() => { setCopyFrom(galleryKey(copySources[0])); setCopyOpen(true) }}><Copy size={16} aria-hidden />Copy from…</Button>
              <Button variant="tonal" disabled={blocked} onClick={() => setLibraryOpen(true)} aria-expanded={libraryOpen}><Plus size={16} aria-hidden />Add photos</Button>
            </div>
          </div>
          <p className={styles.galleryHint}>{active.axis === null ? 'First photo = default cover. These photos are shared by the listing.' : 'First photo appears when this variation is selected. Common photos are retained.'}</p>
          <MediaGallery label={`${labelGallery(active)} image order`} disabled={blocked}
            firstLabel={active.axis === null ? '1 · Cover' : '1 · First'}
            items={active.assetIds.map(id => { const a = byId.get(id); return { id, src: a?.url ?? '', label: a?.label ?? 'Unavailable image', detail: a ? dimensions(a) : 'Source is unavailable' } })}
            onChange={assetIds => replaceGallery({ ...active, assetIds })} onPreview={setPreviewId}
            onRemove={id => replaceGallery({ ...active, assetIds: active.assetIds.filter(value => value !== id) })} />
          {active.assetIds.length === 0 && <EmptyState icon={<ImageIcon size={36} aria-hidden />} title={active.axis === null ? 'Choose a cover photo' : `Add photos for ${active.value}`}
            description="Choose from the product library or upload new photos."
            action={<Button disabled={blocked} onClick={() => setLibraryOpen(true)}><Plus size={16} aria-hidden />Add photos</Button>} />}
          <Disclosure summary="How these galleries work">
            <p>Drag the grip or use the arrow buttons to reorder. Removing a photo keeps its source in the product library.</p>
            <p>Groups follow the selected listing’s variation data. Values retain their saved wording. Changing the grouping retains other saved photo sets.</p>
            <p>Common photos support up to 24 images; each variation set supports up to 12. Category exceptions need review before publication.</p>
          </Disclosure>
        </section>
        {libraryOpen && <SourceLibrary key={galleryKey(active)} assets={workspace.assets} assignedUrls={assignedUrls} productId={productId} disabled={blocked}
          galleryLabel={labelGallery(active)} galleryCount={active.assetIds.length} galleryLimit={galleryLimit(active)} pinned={pinned} canPin={canPinLibrary}
          onPinChange={setLibraryPinned} onClose={() => { if (!uploading) setLibraryOpen(false) }}
          onAdd={ids => { const added = add(ids); if (added && !pinned) setLibraryOpen(false); return added }} onPreview={setPreviewId} onRefresh={refreshLibrary} onBusyChange={setUploading} />}
      </div>
    </div>
    <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Photo preview" subtitle={`${workspace.destination.label} · eBay ${workspace.destination.marketplace} · Draft preview only`} size="full">
      <ListingPhotoPreview workspace={workspace} draft={draft} galleries={galleries} onPreview={setPreviewId} />
    </Modal>
    <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title="Review image draft" size="xl"
      footer={<><Button disabled={busy || uploading} onClick={() => { setReviewOpen(false); askReload() }}><RefreshCw size={16} aria-hidden />Reload saved</Button><Button onClick={() => setReviewOpen(false)}>Done</Button></>}>
      <MediaReview workspace={workspace} draft={draft} dirty={dirty} accountLabel={accountLabel} />
    </Modal>
    <Modal open={!!preview} onClose={() => setPreviewId(null)} title={preview?.label} subtitle={preview ? `${dimensions(preview)} · Original image preview` : undefined} size="full"
      footer={preview && isUsableMediaUrl(preview.url) && <Button asChild><a href={preview.url} target="_blank" rel="noreferrer">Open original image</a></Button>}>
      {preview && (previewFailed === preview.url || !isUsableMediaUrl(preview.url) ? <EmptyState title="Original image unavailable" description="The original could not be loaded. This does not confirm whether it is accessible to eBay." />
        : <div className={styles.preview}><img src={preview.url} alt={preview.label} onError={() => setPreviewFailed(preview.url)} /></div>)}
    </Modal>
    <Modal open={copyOpen} onClose={() => setCopyOpen(false)} title={`Copy images into ${labelGallery(active)}`} size="md"
      subtitle="Images are appended in source order. Existing images are retained, and duplicates within this gallery are skipped."
      footer={<><Button onClick={() => setCopyOpen(false)}>Cancel</Button><Button variant="tonal" disabled={blocked || !copyFrom} onClick={() => {
        const source = copySources.find(g => galleryKey(g) === copyFrom); if (source && add(source.assetIds)) setCopyOpen(false)
      }}>Copy images</Button></>}>
      <Field label="Source gallery"><Select value={copyFrom} onChange={event => setCopyFrom(event.target.value)}>{copySources.map(g => <option key={galleryKey(g)} value={galleryKey(g)}>{labelGallery(g)} · {g.assetIds.length} images</option>)}</Select></Field>
      {error && <Banner tone="danger" title="Images could not be copied">{error}</Banner>}
    </Modal>
    <Modal open={!!confirmation} onClose={() => confirmation?.cancel()} title={confirmation?.title} size="md"
      footer={<><Button onClick={() => confirmation?.cancel()}>Keep editing</Button><Button onClick={() => confirmation?.proceed()}>Discard changes</Button></>}>
      <p>{confirmation?.description}</p>
    </Modal>
  </div>
}
