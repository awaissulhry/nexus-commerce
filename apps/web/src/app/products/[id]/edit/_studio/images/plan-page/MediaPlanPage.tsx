'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Redo2, Send, Undo2, Upload } from 'lucide-react'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'

import { Banner, Drawer, Field, Listbox, MediaPreview, Modal, SourceIndicator, useToast } from '@/design-system/components'
import { Button, Select, ToolbarButton } from '@/design-system/primitives'

import { MASTER_SCOPE } from '../../types'
import { useStudioScope } from '../../contracts'
import type { AddTarget } from './LibraryPanel'
import { LibraryPanel } from './LibraryPanel'
import { LibraryManager } from './LibraryManager'
import { PlanBoard } from './PlanBoard'
import { DestinationsTable } from './DestinationsTable'
import { ChannelView } from './ChannelView'
import { CompareDialog } from './CompareDialog'
import { UploadDialog } from './UploadDialog'
import { PublishPhotosDialog } from './PublishPhotosDialog'
import { SamePhotoDialog } from './SamePhotoDialog'
import { joinVersions, leaveVersions, markDistinct, markSame, separate, undoSame, undoVersions, type SamePhotoUndo, type VersionsUndo } from './lookalikeApi'
import {
  CHANNEL_LABEL, assetMap, cardOf, libraryUsage, ownedSkuSets, setRows, showAsOptions, swatchRows, viewAxis, viewStack,
  languageName, versionLanguages, versionsOf, type LayerView, type LibraryAsset, type MediaChannel, type MediaRead,
} from './model'
import { apiSend } from '../api'
import type { ActionEntry, MediaPlanState } from './useMediaPlan'
import styles from './planPage.module.css'

const WIDE = 1180
const PHONE = 720

/** The page's width decides where the library lives: beside the plan, or in a drawer (PLAN.md §5.2). */
function useWide() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(WIDE)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.getBoundingClientRect().width)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // A phone: the destinations become one card each (a table would scroll sideways).
  return [ref, width >= WIDE, width < PHONE] as const
}

/**
 * Images rebuild P3b — the Media page of a family on the photo plan (docs/images-studio-rebuild/PLAN.md §5.1–5.4, §5.8).
 * Library on the left, the Shared photo plan in the middle, every destination below it, and one destination's channel
 * view when a row is opened. The studio's channel chips filter the destinations; a chosen listing opens its view.
 */
export function MediaPlanPage({ read, plan }: { read: MediaRead; plan: MediaPlanState }) {
  const { scope, destination: studioDestination } = useStudioScope()
  const { toast } = useToast()
  const [box, wide, phone] = useWide()
  const [open, setOpen] = useState<string | null>(null)
  const [showSkus, setShowSkus] = useState(false)
  const [showAs, setShowAs] = useState<string>('')
  const [pending, setPending] = useState<{ view: LayerView; target: AddTarget } | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  // P4b — the upload dialog, with the files dropped on the page (if any).
  const [uploading, setUploading] = useState<File[] | null>(null)
  const [dropping, setDropping] = useState(false)
  // Review & publish: false = closed, 'all' = every destination (toolbar), else the destination key it was opened from.
  const [publishing, setPublishing] = useState<false | 'all' | string>(false)
  // W4a — two library photos that look the same ("Same photo?").
  const [lookalike, setLookalike] = useState<{ a: string; b: string; kind?: 'same' | 'versions' } | null>(null)

  const assets = useMemo(() => assetMap(read), [read])
  const usage = useMemo(() => libraryUsage(read), [read])
  const showAsList = useMemo(() => showAsOptions(read), [read])
  const languages = showAsList.find(o => o.value === showAs)?.languages ?? null
  const channelFilter = scope === MASTER_SCOPE ? null : (scope as MediaChannel)
  const destinations = read.destinations.filter(d => !channelFilter || d.channel === channelFilter)
  const shared: LayerView = { layer: 'SHARED' }

  // The studio chose one listing (channel scope with an account or alias): open its channel view.
  const studioKey = useMemo(() => {
    if (scope === MASTER_SCOPE || studioDestination.status !== 'ready') return null
    const s = studioDestination.data
    const global = s.channel === 'AMAZON' || s.channel === 'SHOPIFY' || s.channel === 'ETSY'
    return `LISTING:${s.channel}:${global ? 'GLOBAL' : s.marketplace}:${s.accountId}:${s.channel === 'AMAZON' ? '' : s.aliasKey ?? ''}`
  }, [scope, studioDestination])
  useEffect(() => { if (studioKey && read.destinations.some(d => d.key === studioKey)) setOpen(studioKey) }, [studioKey, read.destinations])

  const edit = useCallback((view: LayerView, ops: MediaOp[], label: string) => {
    void plan.edit(view, ops, label).then(outcome => {
      if (!outcome.ok) return
      toast(<span className={styles.toast}>{label}. <Button size="xs" variant="secondary" onClick={() => plan.undo()}>Undo</Button></span>, 'success', { duration: 6000 })
    })
  }, [plan, toast])

  const openAsset = (id: string) => { setLibraryOpen(false); setViewing(id) }
  // W4a/W4b — library answers go into the page's Undo/Redo (⌘Z, ⌘⇧Z), like plan edits; the message's Undo is the same entry.
  const sameEntry = (keep: LibraryAsset, drop: LibraryAsset, undo: SamePhotoUndo): ActionEntry => ({ label: `Same photo: ${drop.label} and ${keep.label}`,
    run: async () => {
      await undoSame(read.rootId, undo)
      toast(`${drop.label} is its own photo again.`, 'success')
      return { label: `Same photo: ${drop.label} and ${keep.label}`, run: async () => sameEntry(keep, drop, (await markSame(read.rootId, keep.id, drop.id)).undo) }
    } })
  const versionsEntry = (a: LibraryAsset, b: LibraryAsset, languages: Record<string, string>, undo: VersionsUndo): ActionEntry => ({ label: `Language versions: ${a.label} and ${b.label}`,
    run: async () => {
      await undoVersions(read.rootId, undo)
      toast(`${a.label} and ${b.label} are two photos again.`, 'success')
      return { label: `Language versions: ${a.label} and ${b.label}`, run: async () => versionsEntry(a, b, languages, (await joinVersions(read.rootId, [a.id, b.id], languages)).undo) }
    } })
  const distinctEntry = (a: LibraryAsset, b: LibraryAsset): ActionEntry => ({ label: `Not the same: ${a.label} and ${b.label}`,
    run: async () => {
      await markDistinct(read.rootId, a.id, b.id, true)
      return { label: `Not the same: ${a.label} and ${b.label}`, run: async () => { await markDistinct(read.rootId, a.id, b.id); return distinctEntry(a, b) } }
    } })
  const done = (entry: ActionEntry, text: string) => {
    plan.record(entry)
    void plan.reload()
    toast(<span className={styles.toast}>{text}{' '}<Button size="xs" variant="secondary" onClick={() => void plan.undoAction(entry)}>Undo</Button></span>, 'success', { duration: 10000 })
  }
  const layers = (n: number) => n ? ` (${n} photo layer${n === 1 ? '' : 's'} changed)` : ''
  const markSamePhoto = async (keep: LibraryAsset, drop: LibraryAsset) => {
    const answer = await markSame(read.rootId, keep.id, drop.id)
    done(sameEntry(keep, drop, answer.undo), `${drop.label} is now a copy of ${keep.label}${layers(answer.layersChanged)}. Undo is also in the toolbar (⌘Z).`)
  }
  const markNotSame = async (a: LibraryAsset, b: LibraryAsset) => {
    await markDistinct(read.rootId, a.id, b.id)
    done(distinctEntry(a, b), `${a.label} and ${b.label} are marked as different photos.`)
  }
  const makeVersions = async (a: LibraryAsset, b: LibraryAsset, languages: Record<string, string>) => {
    const answer = await joinVersions(read.rootId, [a.id, b.id], languages)
    done(versionsEntry(a, b, languages, answer.undo), `${a.label} and ${b.label} are language versions of one photo${layers(answer.layersChanged)}. Undo is also in the toolbar (⌘Z).`)
  }
  const setPhotoLanguage = async (asset: LibraryAsset, languageTag: string) => {
    const res = await apiSend<unknown>(`/api/products/${encodeURIComponent(read.rootId)}/media/library`, 'PATCH', { languages: [{ id: asset.id, languageTag }], groups: [] })
    if (!res.ok) { toast(res.message, 'danger'); return }
    void plan.reload()
    toast(`${asset.label}: ${languageName(languageTag)}.`, 'success')
  }
  const requestAdd = (view: LayerView, ref: MediaSetRef, label: string) => {
    setPending({ view, target: { id: ref, label, group: 'Sets' } })
    if (!wide) setLibraryOpen(true)
  }

  // "Add to" goes to the edited layer: the open channel view's listing layer, or Shared.
  const addView = pending?.view ?? shared
  const targets: AddTarget[] = [
    ...setRows(read, addView, { skus: showSkus }).map(r => ({ id: r.ref, label: r.label, group: 'Sets' as const })),
    ...swatchRows(read, addView).map(s => ({ id: `swatch:${s.value}`, label: s.label, group: 'Swatches' as const, one: true })),
  ]
  const addTo = (target: AddTarget, ids: string[]) => {
    const view = pending?.view ?? shared
    if (target.group === 'Swatches') edit(view, [{ op: 'swatch', value: target.id.slice('swatch:'.length), assetId: ids[0] }], `Set the ${target.label} swatch`)
    else edit(view, [{ op: 'insert', set: target.id as MediaSetRef, assetIds: ids }], `Add ${ids.length} photo${ids.length > 1 ? 's' : ''} to ${target.label}`)
    if (!wide) setLibraryOpen(false)
  }

  const stack = viewStack(read, shared)
  const axis = viewAxis(read, stack)
  const skuCount = ownedSkuSets(read, shared)
  const openDestination = read.destinations.find(d => d.key === open) ?? null
  // Compare starts from the open destination and the others of its channel, else the first three destinations.
  const comparable = read.destinations.filter(d => d.targetable)
  const compareStart = openDestination?.targetable
    ? [openDestination.key, ...comparable.filter(d => d.key !== openDestination.key && d.channel === openDestination.channel).map(d => d.key)].slice(0, 3)
    : comparable.slice(0, 3).map(d => d.key)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) plan.redo(); else plan.undo()
    }
    // U opens "Upload photos" (PLAN.md §5.2) — never from inside a control that owns the key.
    if (event.key.toLowerCase() === 'u' && !event.metaKey && !event.ctrlKey && !event.altKey && !target.closest('select, [role="listbox"], [role="menu"], [role="dialog"]')) {
      event.preventDefault()
      setUploading([])
    }
  }
  // Files dropped anywhere on the page open the upload dialog with them (a library photo dragged onto a set is not a file).
  const hasFiles = (event: DragEvent<HTMLDivElement>) => [...event.dataTransfer.types].includes('Files')
  const onDragOver = (event: DragEvent<HTMLDivElement>) => { if (!hasFiles(event)) return; event.preventDefault(); if (!dropping) setDropping(true) }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => { if (event.currentTarget === event.target) setDropping(false) }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault(); setDropping(false)
    setUploading([...event.dataTransfer.files])
  }

  const library = <LibraryPanel read={read} usage={usage} targets={targets} pendingTarget={pending?.target ?? null} onClearPending={() => setPending(null)}
    onAdd={addTo} onOpen={asset => openAsset(asset.id)} onManage={() => { setLibraryOpen(false); setManaging(true) }} onDragging={plan.hold} draggable={wide}
    onSkip={() => { setLibraryOpen(false); const board = box.current; (board?.querySelector<HTMLElement>('.nds-media-board-thumb[tabindex="0"]') ?? board?.querySelector<HTMLElement>('.nds-media-board-row button'))?.focus() }}
    onLookalike={(a, b, kind) => { setLibraryOpen(false); setViewing(null); setLookalike({ a, b, kind }) }} />
  // A plan may point at another SKU's copy of a picture: the preview opens its library card.
  const viewingAsset = viewing ? read.library.find(a => a.id === cardOf(read)(viewing)) ?? null : null
  // Copies of the same picture on other SKUs; the photos marked the same (W4a) are listed apart, each with "Separate it".
  const skuCopies = (viewingAsset?.copies ?? []).filter(id => !viewingAsset?.merged?.some(m => m.id === id)).length

  if (managing) return <div ref={box} className={styles.page}><LibraryManager productId={read.productId} onClose={() => { setManaging(false); void plan.reload(true) }} /></div>

  // Focusable (not a Tab stop): a click on the page keeps its shortcuts (U, ⌘Z) and lets PageDown scroll it.
  return <div ref={box} className={styles.page} tabIndex={-1} onKeyDown={onKeyDown} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} data-dropping={dropping || undefined}>
    <header className={styles.toolbar}>
      <h2 className={styles.pageTitle}>Media · {read.sku} · {read.family.variants.length} variant{read.family.variants.length === 1 ? '' : 's'}</h2>
      <label className={styles.control}><span>Photos vary by</span>
        <Listbox size="sm" ariaLabel="Photos vary by" value={axis.axis ?? ''}
          onChange={value => edit(shared, [{ op: 'axis', axis: value || null }], value ? `Photos vary by ${read.family.axes.find(a => a.code === value)?.label ?? value}` : 'One gallery for every variant')}
          options={[...read.family.axes.map(a => ({ value: a.code, label: a.label })), { value: '', label: 'Nothing — one gallery' }]} />
      </label>
      <label className={styles.control}><span>Show as</span>
        <Listbox size="sm" ariaLabel="Show photos as one market sees them" value={showAs} onChange={setShowAs}
          options={[{ value: '', label: 'Placed versions' }, ...showAsList.map(o => ({ value: o.value, label: o.label }))]} />
      </label>
      <span className={styles.spacer} />
      <Button size="sm" variant="secondary" onClick={() => setUploading([])} title="Upload photos (U)"><Upload size={14} aria-hidden />Upload photos</Button>
      <Button size="sm" variant="secondary" disabled={comparable.length < 2} onClick={() => setComparing(true)}
        title={comparable.length < 2 ? 'Compare needs two or more destinations' : undefined}>Compare</Button>
      <ToolbarButton icon={<Undo2 size={16} />} label={plan.undoLabel ? `Undo: ${plan.undoLabel}` : 'Undo'} shortcut="⌘Z" disabled={!plan.canUndo} onClick={() => plan.undo()} />
      <ToolbarButton icon={<Redo2 size={16} />} label={plan.redoLabel ? `Redo: ${plan.redoLabel}` : 'Redo'} shortcut="⌘⇧Z" disabled={!plan.canRedo} onClick={() => plan.redo()} />
      {!wide && <Button size="sm" variant="secondary" onClick={() => setLibraryOpen(true)}>Library · {read.library.length}</Button>}
      <Button size="sm" variant="primary" onClick={() => setPublishing('all')}><Send size={14} aria-hidden />Review &amp; publish</Button>
    </header>

    {plan.writeError && <Banner tone="danger" title="Not saved" onDismiss={plan.clearWriteError}
      action={plan.writeError.retry ? <Button size="sm" variant="secondary" onClick={plan.writeError.retry}>Retry</Button> : undefined}>{plan.writeError.message}</Banner>}
    {plan.notice && <Banner tone="warning" onDismiss={plan.clearNotice}>{plan.notice}</Banner>}
    {read.family.unmapped.length > 0 && <Banner tone="warning" title="Some option values are not in the attribute dictionary">
      {read.family.unmapped.map(k => read.family.valueLabels[k] ?? k).join(', ')} — their photos cannot reach eBay until they are mapped in the variation theme.
    </Banner>}

    <div className={wide ? styles.layout : styles.layoutNarrow}>
      {wide && <aside className={styles.libraryColumn}>{library}</aside>}
      <div className={styles.main}>
        <section aria-labelledby="media-plan-title" className={styles.section}>
          <header className={styles.sectionHead}>
            <h3 id="media-plan-title" className={styles.sectionTitle}>Photo plan · Shared</h3>
            <span className={styles.muted}>Every channel follows this unless it has its own photos. The first photo of a set is its main photo. Nothing is sent until you publish.</span>
          </header>
          <PlanBoard read={read} view={shared} channel={null} assets={assets} languages={languages} showSkus={showSkus}
            edit={(ops, label) => edit(shared, ops, label)} onAddRequest={(ref, label) => requestAdd(shared, ref, label)} onOpen={openAsset} />
          {read.family.variants.length > 0 ? <>
            <Button size="sm" variant="ghost" aria-expanded={showSkus} onClick={() => setShowSkus(v => !v)}>
              {showSkus ? '▾' : '▸'} Photos for one SKU only ({skuCount})
            </Button>
            {showSkus && <span className={styles.muted}>Amazon and Shopify use a SKU's own photos; eBay shows photos per {axis.info?.label ?? 'value'}.</span>}
          </> : <span className={styles.muted}>This product has no options — one gallery for every channel.</span>}
        </section>

        <section aria-labelledby="media-destinations-title" className={styles.section}>
          <header className={styles.sectionHead}>
            <h3 id="media-destinations-title" className={styles.sectionTitle}>Where the photos go{channelFilter ? ` · ${CHANNEL_LABEL[channelFilter]}` : ''}</h3>
            <span className={styles.legend}>
              <SourceIndicator kind="master" showLabel label="Follows Shared" description="The set shows the Shared photos." tabIndex={-1} />
              <SourceIndicator kind="channel" showLabel label="Follows the channel" description="The set shows the photos set for all listings of that channel." tabIndex={-1} />
              <SourceIndicator kind="override" showLabel label="Own photos" description="This destination has its own photos for the set." tabIndex={-1} />
              <span className={styles.muted}>Open a destination to change its photos, see what buyers see, and read its checks.</span>
            </span>
          </header>
          <DestinationsTable read={read} destinations={destinations} layouts={plan.layouts} selected={open} onOpen={setOpen} cards={phone} />
        </section>

        {openDestination && <ChannelView read={read} destination={openDestination} layout={plan.layouts[openDestination.key]} assets={assets}
          languages={languages} edit={edit} onAddRequest={requestAdd} onOpen={openAsset} onPublish={() => setPublishing(openDestination.key)} onClose={() => setOpen(null)} />}
      </div>
    </div>

    <Drawer open={!wide && libraryOpen} onClose={() => { setLibraryOpen(false); setPending(null) }} title="Photo library" width="min(520px, 100vw)">
      {library}
    </Drawer>
    <UploadDialog read={read} plan={plan} open={uploading !== null} files={uploading ?? []} onClose={() => setUploading(null)} onReview={() => setPublishing('all')} />
    <PublishPhotosDialog read={read} open={publishing !== false} only={publishing === 'all' || publishing === false ? null : publishing} onClose={() => setPublishing(false)} />
    <CompareDialog read={read} assets={assets} open={comparing} initial={compareStart} onClose={() => setComparing(false)} onOpenDestination={setOpen} />
    <SamePhotoDialog read={read} pair={lookalike} onClose={() => setLookalike(null)} onSame={markSamePhoto} onVersions={makeVersions} onDistinct={markNotSame} />
    <Modal open={!!viewingAsset} onClose={() => setViewing(null)} title={viewingAsset?.label} size="lg">
      {viewingAsset && <MediaPreview type={viewingAsset.mediaType} url={viewingAsset.url} label={viewingAsset.label} />}
      {viewingAsset && <p className={styles.muted}>{viewingAsset.width && viewingAsset.height ? `${viewingAsset.width} × ${viewingAsset.height} px · ` : ''}{usage.get(viewingAsset.id)?.join(' · ') || 'Not in any set'}</p>}
      {skuCopies ? <p className={styles.muted}>The same picture is stored {skuCopies} more time{skuCopies === 1 ? '' : 's'} (copies on other SKUs). The library shows it once.</p> : null}
      {viewingAsset?.merged?.map(copy => <p key={copy.id} className={styles.muted}>{copy.label} was marked the same photo as this one, so the library shows it here.{' '}
        <Button size="xs" variant="link" onClick={() => void separate(read.rootId, copy.id).then(() => { void plan.reload(); toast(`${copy.label} is its own photo again. Photo sets did not change.`, 'success') },
          (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))}>Separate it</Button></p>)}
      {viewingAsset?.lookalikes?.map(other => <p key={other.id} className={styles.muted}>
        {other.kind === 'versions' ? 'Similar to' : 'Looks like'} {read.library.find(x => x.id === other.id)?.label ?? 'another photo'}{other.kind === 'versions' ? ' — maybe another language of this photo.' : ', at another address.'}{' '}
        <Button size="xs" variant="link" onClick={() => { setViewing(null); setLookalike({ a: viewingAsset.id, b: other.id, kind: other.kind }) }}>Compare them</Button></p>)}
      {viewingAsset && viewingAsset.mediaType === 'IMAGE' && <div className={styles.photoLanguage}>
        <Field label="Language of the text in this photo">
          <Select size="sm" value={viewingAsset.languageTag} onChange={e => void setPhotoLanguage(viewingAsset, e.target.value)}>
            <option value="zxx">No text</option>
            <option value="mul">Several languages</option>
            {[...new Set([...versionLanguages(read), viewingAsset.languageTag])].filter(t => t !== 'zxx' && t !== 'mul').map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
          </Select>
        </Field>
        {versionsOf(read, viewingAsset.id).length > 1 && <p className={styles.muted}>
          Versions: {versionsOf(read, viewingAsset.id).map(v => `${v.label} (${languageName(v.languageTag)})`).join('; ')}.{' '}
          <Button size="xs" variant="link" onClick={() => void leaveVersions(read.rootId, viewingAsset.id).then(() => { void plan.reload(); toast(`${viewingAsset.label} is its own photo again. Photo sets did not change.`, 'success') },
            (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))}>Leave its versions</Button></p>}
        <Field label="Add a language version of this photo">
          <Select size="sm" value="" onChange={e => { const other = e.target.value; if (other) { setViewing(null); setLookalike({ a: viewingAsset.id, b: other, kind: 'versions' }) } }}>
            <option value="">Choose a photo</option>
            {read.library.filter(x => x.mediaType === 'IMAGE' && x.id !== viewingAsset.id && !versionsOf(read, viewingAsset.id).some(v => v.id === x.id)).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
      </div>}
    </Modal>
  </div>
}
