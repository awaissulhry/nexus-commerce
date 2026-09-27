'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Redo2, Undo2, Upload } from 'lucide-react'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'

import { Banner, Drawer, Listbox, MediaPreview, Modal, SourceIndicator, useToast } from '@/design-system/components'
import { Button, ToolbarButton } from '@/design-system/primitives'

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
import {
  CHANNEL_LABEL, assetMap, cardOf, libraryUsage, ownedSkuSets, setRows, showAsOptions, swatchRows, viewAxis, viewStack,
  type LayerView, type MediaChannel, type MediaRead,
} from './model'
import type { MediaPlanState } from './useMediaPlan'
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
    onSkip={() => { setLibraryOpen(false); const board = box.current; (board?.querySelector<HTMLElement>('.nds-media-board-thumb[tabindex="0"]') ?? board?.querySelector<HTMLElement>('.nds-media-board-row button'))?.focus() }} />
  // A plan may point at another SKU's copy of a picture: the preview opens its library card.
  const viewingAsset = viewing ? read.library.find(a => a.id === cardOf(read)(viewing)) ?? null : null

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
      <Button size="sm" variant="primary" onClick={() => setUploading([])} title="Upload photos (U)"><Upload size={14} aria-hidden />Upload photos</Button>
      <Button size="sm" variant="secondary" disabled={comparable.length < 2} onClick={() => setComparing(true)}
        title={comparable.length < 2 ? 'Compare needs two or more destinations' : undefined}>Compare</Button>
      <ToolbarButton icon={<Undo2 size={16} />} label={plan.undoLabel ? `Undo: ${plan.undoLabel}` : 'Undo'} shortcut="⌘Z" disabled={!plan.canUndo} onClick={() => plan.undo()} />
      <ToolbarButton icon={<Redo2 size={16} />} label={plan.redoLabel ? `Redo: ${plan.redoLabel}` : 'Redo'} shortcut="⌘⇧Z" disabled={!plan.canRedo} onClick={() => plan.redo()} />
      {!wide && <Button size="sm" variant="secondary" onClick={() => setLibraryOpen(true)}>Library · {read.library.length}</Button>}
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
          languages={languages} edit={edit} onAddRequest={requestAdd} onOpen={openAsset} onClose={() => setOpen(null)} />}
      </div>
    </div>

    <Drawer open={!wide && libraryOpen} onClose={() => { setLibraryOpen(false); setPending(null) }} title="Photo library" width="min(520px, 100vw)">
      {library}
    </Drawer>
    <UploadDialog read={read} plan={plan} open={uploading !== null} files={uploading ?? []} onClose={() => setUploading(null)} />
    <CompareDialog read={read} assets={assets} open={comparing} initial={compareStart} onClose={() => setComparing(false)} onOpenDestination={setOpen} />
    <Modal open={!!viewingAsset} onClose={() => setViewing(null)} title={viewingAsset?.label} size="lg">
      {viewingAsset && <MediaPreview type={viewingAsset.mediaType} url={viewingAsset.url} label={viewingAsset.label} />}
      {viewingAsset && <p className={styles.muted}>{viewingAsset.width && viewingAsset.height ? `${viewingAsset.width} × ${viewingAsset.height} px · ` : ''}{usage.get(viewingAsset.id)?.join(' · ') || 'Not in any set'}</p>}
      {viewingAsset?.copies?.length ? <p className={styles.muted}>The same picture is stored {viewingAsset.copies.length} more time{viewingAsset.copies.length === 1 ? '' : 's'} (copies on other SKUs). The library shows it once.</p> : null}
    </Modal>
  </div>
}
