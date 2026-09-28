'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MediaOp } from '@nexus/shared/media-plan'

import type { ProductMediaQuery, ProductMediaWorkspace } from '@nexus/shared/product-media'
import { Banner, Field, MediaBoard, MediaStrip, SourceIndicator, mediaTypeLabel, type MediaBoardItem, type MediaStripItem } from '@/design-system/components'
import { Button, Checkbox, Input, Spinner, Tag, Textarea } from '@/design-system/primitives'
import { EDITOR_KEY_HINT_PANEL } from '@/design-system/grid'

import type { SaveReporter } from '../types'
import { CellPanel } from '../shopify/ShopifyDraftCell'
import { CHANNEL_LABEL, assetProblems, destinationLabel, type MediaRead } from '../images/plan-page/model'
import { uploadPhoto } from '../images/plan-page/uploadApi'
import { sendPlanOps, type PlanAddress } from './planCellTransfer'
import * as model from './mediaPopupModel'
import { useMediaPopupData } from './useMediaPopupData'
import * as gallery from './galleryPopupModel'
import { uploadGalleryFile, useGalleryPopupData } from './useGalleryPopupData'
import { ChecksList, MediaPageLink, PhotoLibrary, PhotoViewer, PopupHead, UPLOAD_RUNNING, photoKeys, useFirstPhotoFocus, usePopupGuards, type AppliedCells, type LibraryShow, type Upload } from './popupParts'
import styles from './media.module.css'

export type { AppliedCells } from './popupParts'

export interface PlanMediaPopupProps {
  /** Any product of the family (the plan belongs to the family root). */
  productId: string
  rowProductId: string
  /** The row's SKU (or name). */
  title: string
  /** The layer the sheet edits: Shared on the product sheet, the listing's own layer on a channel sheet. */
  address: PlanAddress | null
  /** The sheet's language, as the cell was resolved ('und' = all languages). */
  locale: string
  canEdit: boolean
  anchor: HTMLElement | null
  /** The row's photos as the cell shows them — drawn at once, before the plan is read. */
  initial: readonly MediaStripItem[]
  /** Show the new photos in every cell of the set at once. */
  onApply(next: MediaRead, base: model.PlanPopupBase): AppliedCells
  /** The save landed: the sheet re-reads the family. */
  onSaved(): void
  onClose(): void
  /** The sheet's save status (the header's "Saving… / Saved"). */
  reporter: SaveReporter
  /** "All sets and channels": the Media page. */
  onOpenMediaPage(): void
  /** A change not yet saved, or a save on its way (switching scope or leaving the page asks first). */
  onDirtyChange?(dirty: boolean): void
}

/**
 * Lane C — the Product media cell pop-up for a family on the photo plan (docs/product-media-popup/PLAN-2026-09-28.md §3).
 * One panel under the cell: the ONE set the cell stands for, "+ Add" from the family's photos (and upload) and a bigger
 * photo in the same panel — no dialog on a dialog. Enter or a click outside saves ONE change; Esc cancels.
 */
export function PlanMediaPopup(props: PlanMediaPopupProps) {
  const { productId, rowProductId, title, address, locale, canEdit, anchor, initial, onApply, onSaved, onClose, reporter, onOpenMediaPage, onDirtyChange } = props
  const data = useMediaPopupData(productId)
  const language = locale === 'und' ? null : locale
  // Layers from the read the pop-up opened with (what a save may overwrite); the library from the latest read.
  const working: MediaRead | null = useMemo(() => data.baseline ? { ...data.baseline, library: data.latest?.library ?? data.baseline.library } : null, [data.baseline, data.latest])
  const base = useMemo(() => working ? model.planBase(working, { rowProductId, address }) : null, [working, rowProductId, address])
  const [draft, setDraft] = useState<model.PlanDraft | null>(null)
  useEffect(() => { if (!draft && working && base) setDraft(model.initialDraft(working, base)) }, [draft, working, base])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [show, setShow] = useState<LibraryShow>('not-in-set')
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const reported = useRef<string | null>(null)
  const afterSave = useRef<(() => void) | null>(null)

  const editable = canEdit && !!base?.view && !!draft && !busy
  const changedElsewhere = !!(base && data.baseline && model.changedSince(data.baseline, data.latest, base))
  const ops: MediaOp[] = working && base && draft ? model.saveOps(working, base, draft) : []
  useEffect(() => { onDirtyChange?.(ops.length > 0 || busy); return () => onDirtyChange?.(false) }, [ops.length, busy, onDirtyChange])

  const { menuPress, mounted, holdClick } = usePopupGuards()
  const root = useRef<HTMLDivElement>(null)
  useFirstPhotoFocus(root)

  // "+ Add" opens the family's photos under the strip: the search takes the focus and the list comes into view, so
  // the browser keeps it still while the strip above grows (scroll anchoring works once the panel has scrolled).
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (adding) searchInput.current?.focus({ preventScroll: false }) }, [adding])

  function close() {
    if (reported.current) reporter.cleared([reported.current])
    onClose()
  }

  /** Enter, or a click outside. `false` holds a click outside back (refused, or saving). */
  function save(): boolean {
    if (menuPress.current) return true
    if (busy) { holdClick(); return false }
    if (uploads.some(u => u.state === 'sending')) { setError(UPLOAD_RUNNING); holdClick(); return false }
    if (!working || !data.baseline || !base || !draft || !ops.length || !base.view || !address || !canEdit) { close(); return true }
    const local = model.localRefusal(working, base, ops)
    if (local) { afterSave.current = null; setError(`Not saved: ${local}`); holdClick(); return false }
    holdClick()
    void send(working, data.baseline, base, draft, address, ops)
    return false
  }

  async function send(read: MediaRead, baseline: MediaRead, popupBase: model.PlanPopupBase, current: model.PlanDraft, target: PlanAddress, request: MediaOp[]) {
    setBusy(true); setError(''); data.setSaving(true)
    const applied = onApply(model.afterSave(read, popupBase, request), popupBase)
    const subject = `product-media:plan:${JSON.stringify([target, model.mainRef(popupBase, current)])}`
    const writeId = crypto.randomUUID()
    reporter.pending(writeId, subject)
    const landed = () => {
      reporter.resolved(writeId, true, undefined, subject)
      applied.done()
      onSaved()
      // Closed meanwhile (Esc waits, but the sheet may have moved on): the cells and the save status still tell.
      if (mounted.current) { onClose(); afterSave.current?.() }
    }
    const refused = (message: string) => {
      applied.restore()
      reporter.resolved(writeId, false, message, subject)
      if (!mounted.current) return
      reported.current = subject
      setError(`Not saved: ${message}`)
      setBusy(false)
      afterSave.current = null
    }
    try {
      // A set this layer does not own yet binds the save only to "owned nothing"; a change to the set it follows would
      // not stop it. So read once more and compare what the row resolves to, before anything is sent.
      if (model.changedSince(baseline, await data.reload(), popupBase)) { refused(model.POPUP_TEXT.conflict); return }
      try {
        await sendPlanOps(productId, target, request)
        landed()
      } catch (e) {
        const network = e instanceof TypeError || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        const fresh = await data.reload()
        // The answer was lost but the photos are what the save makes: it landed.
        if (model.landedAnyway(baseline, fresh, popupBase, request)) { landed(); return }
        refused(network ? model.POPUP_TEXT.unconfirmed : model.refusalSentence(fresh, popupBase, request, e instanceof Error ? e.message : model.POPUP_TEXT.unconfirmed))
      }
    } finally {
      data.setSaving(false)
    }
  }

  const onKeyCapture = photoKeys(root, save)

  async function upload(files: File[], force = false) {
    if (!working || !editable) return
    for (const file of files) {
      setUploads(list => [...list.filter(u => u.name !== file.name), { name: file.name, state: 'sending' }])
      const status = await uploadPhoto(working.rootId, file, force)
      if (status.kind === 'failed') { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: status.message } : u)); continue }
      if (status.kind === 'similar') { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'similar', candidate: status.candidate, file } : u)); continue }
      if (status.kind !== 'new' && status.kind !== 'exact') continue
      const assetId = status.assetId
      const fresh = await data.reload()
      if (!fresh) { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: 'uploaded to the library, but the photos could not be read again. Reload the page, then add it.' } : u)); continue }
      setDraft(current => current ? model.addItem(fresh, current, assetId) : current)
      setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: status.kind === 'exact' ? 'exact' : 'added' } : u))
    }
    setError(current => current === UPLOAD_RUNNING ? '' : current)
  }

  const tiles = working && base && draft ? model.tiles(working, base, draft, language) : null
  const boardItems: MediaBoardItem[] = tiles
    ? tiles.map(t => ({ id: t.id, src: t.src, label: t.label, mediaType: t.mediaType, tone: t.missing ? 'danger' : t.problem ? 'warning' : !t.exact ? 'warning' : undefined,
      badges: <>
        {t.language && <Tag tone={t.exact ? 'info' : 'warning'}>{t.exact ? t.language.toUpperCase() : `shows ${t.language.toUpperCase()}`}</Tag>}
        {t.alsoInCommon && <Tag tone="neutral">also in Common</Tag>}
        {t.problem && <Tag tone={t.missing ? 'danger' : 'warning'}>{t.problem}</Tag>}
      </> }))
    : initial.filter(i => !i.muted).map(i => ({ id: i.id, src: i.type === 'IMAGE' ? i.preview ?? null : null, label: i.alt || mediaTypeLabel(i.type), mediaType: i.type }))
  const headline = base && draft ? model.setTitle(base, draft) : { label: 'Photos', detail: `${boardItems.length} photo${boardItems.length === 1 ? '' : 's'}` }
  const common = working && base && draft ? model.commonAfter(working, base, draft) : initial.filter(i => i.muted).map(i => i.id)
  const commonItems: MediaStripItem[] = working
    ? common.map(id => { const a = working.library.find(x => x.id === id || x.copies?.includes(id)); return { id, type: a?.mediaType ?? 'IMAGE', preview: a?.mediaType === 'IMAGE' ? a.url : null, alt: a?.label, muted: true } })
    : initial.filter(i => i.muted)
  const source = working && base && draft ? model.setSource(working, base, draft) : null
  const from = source === 'channel' && base?.destination ? `all ${CHANNEL_LABEL[base.destination.channel]} listings` : 'Shared'
  const found = working && base && draft ? model.checks(working, base, draft) : []
  const reason = !canEdit ? model.POPUP_TEXT.readOnly : base?.refusal ?? null
  const viewed = viewing && working ? working.library.find(a => a.id === viewing || a.copies?.includes(viewing)) ?? null : null
  // The list is chosen when it opens (and when the search, the filter or the library changes) — NOT on every tick: a
  // ticked photo stays where it is, ticked, so the next click lands on the photo under the pointer.
  const draftNow = useRef(draft); draftNow.current = draft
  const listed = useMemo(() => adding && working && draftNow.current ? model.libraryCards(working, draftNow.current, show, search).map(a => a.id) : [], [adding, working, show, search])
  const cards = working ? working.library.filter(a => listed.includes(a.id)) : []
  const context = base?.destination ? destinationLabel(base.destination) : null

  const edit = (next: model.PlanDraft) => { setDraft(next); setError('') }

  // Esc while a save is on its way waits for its answer: a refusal must be seen, not lost behind a closed pop-up.
  return <CellPanel anchor={anchor} label={`Product media: ${title}`} onSave={save} onCancel={() => { if (!busy) close() }}
    footer={<>
      <span className="nds-editor-keyhint">{busy ? <><Spinner size={12} /> Saving…</> : EDITOR_KEY_HINT_PANEL}</span>
      <span className={styles.muted}>{base ? model.saveLine(base, draft ?? { skuOnly: base.skuOnly }) : ''}</span>
    </>}>
    <div ref={root} className={styles.popup} onKeyDownCapture={onKeyCapture} aria-busy={busy || data.state.status === 'loading'}>
      <PopupHead context={context} title={title} />

      {error && <Banner tone="danger">{error}</Banner>}
      {!error && changedElsewhere && <Banner tone="warning">{model.POPUP_TEXT.changedElsewhere}</Banner>}
      {data.state.status === 'error' && <Banner tone="danger" action={<Button size="xs" onClick={() => void data.reload()}>Try again</Button>}>{data.state.message}</Banner>}
      {reason && <Banner tone="neutral">{reason}</Banner>}
      {base?.skuElsewhere && <p className={styles.muted}>{model.POPUP_TEXT.skuElsewhere}</p>}

      {base?.variant && base.valueRef && base.skuRef && canEdit && base.view && !base.skuElsewhere && draft &&
        <Checkbox label={`Only this SKU (${base.variant.sku})`} checked={draft.skuOnly} disabled={busy}
          onChange={event => working && edit(model.setSkuOnly(working, base, draft, event.target.checked))} />}

      <MediaBoard label={`Photos of ${headline.label}`} allowCopy={false} disabled={!editable} liveDrag
        rows={[{
          // A stable id: the row is not rebuilt when the plan arrives, so the focused photo keeps its focus.
          id: 'set', label: headline.label, detail: headline.detail, editable,
          emptyLabel: 'No photos yet — + Add from the family\'s photos',
          source: source === 'own'
            ? <SourceIndicator kind="override" showLabel label="Own photos" description={`Only this listing uses these photos for ${headline.label}.`} />
            : source ? <SourceIndicator kind={source === 'channel' ? 'channel' : 'master'} showLabel label={`Follows ${from}`}
                description={`${headline.label} shows the photos set on ${from}. A change here gives this listing its own copy; ${from} stays as it is.`} /> : undefined,
          actions: <>
            {editable && <Button size="xs" variant="secondary" aria-expanded={adding} onClick={() => setAdding(on => !on)}>{adding ? '− Close' : '+ Add'}</Button>}
            {editable && source === 'own' && ownedHere(working, base, draft) && <Button size="xs" variant="ghost" onClick={() => working && base && draft && edit(model.followAgain(working, base, draft))}>Follow {from} again</Button>}
          </>,
          items: boardItems,
        }]}
        onMove={move => draft && edit(model.moveItem(draft, move.itemId, move.index))}
        onRemove={(_, id) => draft && edit(model.removeItem(draft, id))}
        onOpen={(_, id) => setViewing(current => current === id ? null : id)} />
      {draft?.follow && <p className={styles.muted} role="status">⏎ applies it: this listing follows {from} again.</p>}
      {data.state.status === 'loading' && <p className={styles.muted} role="status"><Spinner size={12} /> {model.POPUP_TEXT.loading}</p>}

      {commonItems.length > 0 && <div className={styles.commonLine}>
        <span className={styles.muted}>Then Common · {commonItems.length} photo{commonItems.length === 1 ? '' : 's'}</span>
        <MediaStrip items={commonItems} label="Common photos shown after this set" limit={6} />
        <span className={styles.muted}>change them on the parent row</span>
      </div>}

      <ChecksList checks={found} blocked={base?.destination ? `You can save. Publishing to ${CHANNEL_LABEL[base.destination.channel]} stays blocked until it is fixed.` : null} />

      {viewed && <PhotoViewer photo={{ type: viewed.mediaType, url: viewed.url, label: viewed.label, width: viewed.width, height: viewed.height, fileSize: viewed.fileSize, language: viewed.languageTag }}
        onClose={() => setViewing(null)} />}

      {adding && working && draft && <PhotoLibrary target={headline.label} noun="family's photos" searchInput={searchInput} disabled={busy}
        cards={cards.map(asset => ({ id: asset.id, src: asset.mediaType === 'VIDEO' ? null : asset.url, mediaType: asset.mediaType, label: asset.label, width: asset.width, height: asset.height,
          tags: <>{asset.languageTag !== 'zxx' && <Tag tone="info">{asset.languageTag.toUpperCase()}</Tag>}{assetProblems(asset).slice(0, 1).map(p => <Tag key={p} tone="warning">{p}</Tag>)}</> }))}
        picked={id => model.inSet(working, draft, id)}
        onToggle={(id, on) => edit(on ? model.addItem(working, draft, id) : model.removePicture(working, draft, id))}
        onPreview={setViewing} search={search} onSearch={setSearch} show={show} onShow={setShow}
        accept=".jpg,.jpeg,.png,.webp,.gif,.avif" maxBytes={20 * 1024 * 1024} uploadHint="Images up to 20 MB · they join this set on Enter and stay in the library"
        onFiles={files => void upload(files)} uploads={uploads}
        onUseCandidate={u => { setDraft(current => current && working && u.candidate ? model.addItem(working, current, u.candidate.id) : current); setUploads(list => list.map(x => x.name === u.name ? { name: u.name, state: 'exact' } : x)) }}
        onUploadAnyway={u => { if (u.file) void upload([u.file], true) }} />}

      <MediaPageLink disabled={busy} onOpen={() => {
        // "All sets and channels": save first (nothing to save = leave now), then the Media page.
        afterSave.current = onOpenMediaPage
        if (!ops.length || !editable) { close(); onOpenMediaPage() } else save()
      }} />
    </div>
  </CellPanel>
}

function ownedHere(read: MediaRead | null, base: model.PlanPopupBase | null, draft: model.PlanDraft | null) {
  return !!read && !!base && !!draft && model.ownItems(read, base, model.mainRef(base, draft)) !== null
}

export interface GalleryMediaPopupProps {
  /** The row's product (the older gallery belongs to one product and, on a channel sheet, one listing). */
  productId: string
  title: string
  /** Where it saves: the Shared product in one language, or a listing's Nexus draft. */
  context: ProductMediaQuery
  /** "eBay IT · <account> · Main listing" on a channel sheet; null on the Shared sheet. */
  contextLabel: string | null
  channelLabel: string | null
  canEdit: boolean
  anchor: HTMLElement | null
  initial: readonly MediaStripItem[]
  /** Show the new list in the row's cell at once. */
  onApply(items: MediaStripItem[]): AppliedCells
  onSaved(): void
  onClose(): void
  reporter: SaveReporter
  onOpenMediaPage(): void
  onDirtyChange?(dirty: boolean): void
  /** An upload changed the library (the sheet reads again). Defaults to `onSaved`. */
  onLibraryChanged?(): void
}

/**
 * Lane C, C2 — the same pop-up for a product NOT on the photo plan: its own ordered list (per language on the Shared
 * sheet, or a listing's draft), the alt text per language, a video's transcript and captions, and today's save
 * (`PUT /product-media` bound to the revision read when it opened).
 */
export function GalleryMediaPopup(props: GalleryMediaPopupProps) {
  const { productId, title, context, contextLabel, channelLabel, canEdit, anchor, initial, onApply, onSaved, onClose, reporter, onOpenMediaPage, onDirtyChange, onLibraryChanged = onSaved } = props
  const data = useGalleryPopupData(productId, context)
  // The list and its revision from the read the pop-up opened with; the library from the latest read.
  const working: ProductMediaWorkspace | null = useMemo(() => data.baseline ? { ...data.baseline, assets: data.latest?.assets ?? data.baseline.assets } : null, [data.baseline, data.latest])
  const [draft, setDraft] = useState<gallery.GalleryDraft | null>(null)
  useEffect(() => { if (!draft && data.baseline) setDraft(gallery.galleryDraft(data.baseline)) }, [draft, data.baseline])
  const draftNow = useRef(draft); draftNow.current = draft
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [show, setShow] = useState<LibraryShow>('not-in-set')
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const reported = useRef<string | null>(null)
  const afterSave = useRef<(() => void) | null>(null)
  const { menuPress, mounted, holdClick } = usePopupGuards()
  const root = useRef<HTMLDivElement>(null)
  useFirstPhotoFocus(root)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (adding) searchInput.current?.focus({ preventScroll: false }) }, [adding])

  const editable = canEdit && !!draft && !busy
  const body = data.baseline && draft ? gallery.gallerySaveBody(data.baseline, draft) : null
  // A re-read (after an upload) whose list differs from the one the pop-up opened with: someone changed it.
  const changedElsewhere = !!(data.baseline && data.latest && data.latest.revision !== data.baseline.revision)
  useEffect(() => { onDirtyChange?.(!!body || busy); return () => onDirtyChange?.(false) }, [body, busy, onDirtyChange])
  const locale = context.locale

  function close() {
    if (reported.current) reporter.cleared([reported.current])
    onClose()
  }
  const edit = (next: gallery.GalleryDraft | null) => {
    if (!next) { setError(`Not saved: ${gallery.GALLERY_TEXT.max}`); return }
    setDraft(next); setError('')
  }

  function save(): boolean {
    if (menuPress.current) return true
    if (busy) { holdClick(); return false }
    // An upload joins the list on Enter: Enter waits for it (and a finished upload moves the revision the save binds to).
    if (uploads.some(u => u.state === 'sending')) { setError(UPLOAD_RUNNING); holdClick(); return false }
    if (!working || !draft || !body || !canEdit) { close(); return true }
    const local = gallery.galleryRefusal(draft)
    if (local) { afterSave.current = null; setError(`Not saved: ${local}`); holdClick(); return false }
    holdClick()
    void send(working, draft, body)
    return false
  }

  async function send(read: ProductMediaWorkspace, current: gallery.GalleryDraft, request: NonNullable<typeof body>) {
    setBusy(true); setError('')
    // The inherited list after a reset is the server's to resolve: the cell shows it when the sheet reads again.
    const applied = request.collection ? onApply(gallery.galleryCell(read, current)) : { restore: () => undefined, done: () => undefined }
    const subject = `product-media:${JSON.stringify([productId, context])}`
    const writeId = crypto.randomUUID()
    reporter.pending(writeId, subject)
    try {
      await data.save(request)
      reporter.resolved(writeId, true, undefined, subject)
      applied.done()
      onSaved()
      if (mounted.current) { onClose(); afterSave.current?.() }
    } catch (e) {
      applied.restore()
      const network = e instanceof TypeError || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      const server = e instanceof Error ? e.message : model.POPUP_TEXT.unconfirmed
      // "Media changed since this editor opened. Reload the gallery …": said the way every pop-up says it.
      const message = network ? model.POPUP_TEXT.unconfirmed : /^Media changed/.test(server) ? model.POPUP_TEXT.conflict : server
      reporter.resolved(writeId, false, message, subject)
      if (!mounted.current) return
      reported.current = subject
      setError(`Not saved: ${message}`)
      setBusy(false)
      afterSave.current = null
    }
  }
  const onKeyCapture = photoKeys(root, save)

  async function upload(files: File[], force = false) {
    if (!editable) return
    for (const file of files) {
      setUploads(list => [...list.filter(u => u.name !== file.name), { name: file.name, state: 'sending' }])
      if (!gallery.VIDEO_FILE.test(file.name) && file.size > 20 * 1024 * 1024) { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: 'images must be no larger than 20 MB.' } : u)); continue }
      const status = await uploadGalleryFile(productId, file, force)
      if (status.kind === 'failed') { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: status.message } : u)); continue }
      if (status.kind === 'similar') { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'similar', candidate: status.candidate, file } : u)); continue }
      const assetId = status.assetId
      // Only a NEW file changes the library: a re-upload of a file already there writes nothing, so it must not let the
      // baseline move past someone else's change to the list.
      const fresh = await data.afterUpload(status.kind === 'new' ? [assetId] : [])
      // An upload is in the library at once: the sheet reads again (a product with no list of its own shows it).
      onLibraryChanged()
      if (!fresh) { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: gallery.GALLERY_TEXT.uploadUnread } : u)); continue }
      const added = draftNow.current ? gallery.addAsset(draftNow.current, assetId) : null
      if (!added) { setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: 'failed', message: `in the library, but not added: ${gallery.GALLERY_TEXT.max}` } : u)); continue }
      setDraft(added); draftNow.current = added
      setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: status.kind === 'exact' ? 'exact' : 'added' } : u))
    }
    setError(current => current === UPLOAD_RUNNING ? '' : current)
  }

  const tiles = working && draft ? gallery.galleryTiles(working, draft) : null
  const boardItems: MediaBoardItem[] = tiles
    ? tiles.map(t => ({ id: t.id, src: t.src, label: t.label, mediaType: t.mediaType, tone: t.missing ? 'danger' : t.problem ? 'warning' : undefined,
      badges: t.problem ? <Tag tone={t.missing ? 'danger' : 'warning'}>{t.problem}</Tag> : undefined }))
    : initial.map(i => ({ id: i.id, src: i.preview ?? null, label: i.alt || mediaTypeLabel(i.type), mediaType: i.type }))
  const source = working && draft ? gallery.gallerySource(working, draft) : null
  const count = draft?.items.length ?? boardItems.length
  const found = working && draft ? gallery.galleryChecks(working, draft) : []
  const listed = useMemo(() => adding && working && draftNow.current ? gallery.galleryCards(working, draftNow.current, show, search).map(a => a.id) : [], [adding, working, show, search])
  const cards = working ? working.assets.filter(a => listed.includes(a.id)) : []
  const viewedAsset = viewing && working ? working.assets.find(a => a.id === viewing) ?? null : null
  const viewedItem = viewing && draft ? draft.items.find(i => i.assetId === viewing) ?? null : null
  const listName = context.scope === 'MASTER' ? `${gallery.languageName(locale)} list` : 'This listing\'s list'
  const target = source?.own ? 'this list' : context.scope === 'MASTER' ? `the ${gallery.languageName(locale)} list` : 'this listing\'s list'

  return <CellPanel anchor={anchor} label={`Product media: ${title}`} onSave={save} onCancel={() => { if (!busy) close() }}
    footer={<>
      <span className="nds-editor-keyhint">{busy ? <><Spinner size={12} /> Saving…</> : EDITOR_KEY_HINT_PANEL}</span>
      <span className={styles.muted}>{gallery.gallerySaveLine(context, channelLabel)}</span>
    </>}>
    <div ref={root} className={styles.popup} onKeyDownCapture={onKeyCapture} aria-busy={busy || data.state.status === 'loading'}>
      <PopupHead context={contextLabel} title={title} />
      {error && <Banner tone="danger">{error}</Banner>}
      {!error && changedElsewhere && <Banner tone="warning">{model.POPUP_TEXT.changedElsewhere}</Banner>}
      {data.state.status === 'error' && <Banner tone="danger" action={<Button size="xs" onClick={() => void data.reload()}>Try again</Button>}>{data.state.message}</Banner>}
      {!canEdit && <Banner tone="neutral">{model.POPUP_TEXT.readOnly}</Banner>}

      {draft?.reset
        ? <p className={styles.muted} role="status">{source?.note}</p>
        : <MediaBoard label={`${listName} of ${title}`} allowCopy={false} disabled={!editable} liveDrag
          rows={[{
            id: 'set', label: listName, detail: `${count} file${count === 1 ? '' : 's'}`, editable,
            emptyLabel: 'No photos yet — + Add from the product\'s photos',
            source: source?.own ? <SourceIndicator kind="override" showLabel label={source.label} description={`Only ${context.scope === 'MASTER' ? gallery.languageName(locale) : 'this listing'} uses this list.`} />
              : source ? <span className={styles.muted}>{source.label}</span> : undefined,
            actions: <>
              {editable && <Button size="xs" variant="secondary" aria-expanded={adding} onClick={() => setAdding(on => !on)}>{adding ? '− Close' : '+ Add'}</Button>}
              {editable && source?.own && <Button size="xs" variant="ghost" onClick={() => draft && edit({ items: draft.items, reset: true })}>Use the inherited list</Button>}
            </>,
            items: boardItems,
          }]}
          onMove={move => draft && edit(gallery.moveAsset(draft, move.itemId, move.index))}
          onRemove={(_, id) => draft && edit(gallery.removeAsset(draft, id))}
          onOpen={(_, id) => setViewing(current => current === id ? null : id)} />}
      {draft?.reset && <Button size="xs" variant="ghost" onClick={() => edit({ items: draft.items, reset: false })}>Keep {target}</Button>}
      {!draft?.reset && source?.note && <p className={styles.muted} role="status">{source.note}</p>}
      {data.state.status === 'loading' && <p className={styles.muted} role="status"><Spinner size={12} /> Loading the list…</p>}

      <ChecksList checks={found} blocked={channelLabel ? `You can save. Publishing to ${channelLabel} stays blocked until it is fixed.` : null} />

      {viewedAsset && <PhotoViewer photo={{ type: viewedAsset.type, url: viewedAsset.url, poster: viewedAsset.preview, label: (viewedItem?.alt ?? viewedAsset.alt) || title,
        width: viewedAsset.width, height: viewedAsset.height, fileSize: viewedAsset.fileSize }} onClose={() => setViewing(null)}>
        {viewedItem && draft && <div className={styles.fields}>
          <Field label={`Alt text · ${gallery.languageName(locale)}`} hint="Describe what matters in the picture, in this language. Empty uses the file's own text (shown greyed).">
            <Input size="sm" value={viewedItem.alt ?? ''} placeholder={viewedAsset.alt} maxLength={2000} readOnly={!editable} onChange={event => edit(gallery.setAlt(draft, viewedAsset.id, event.target.value))} />
          </Field>
          {gallery.hasText(viewedAsset.type) && <>
            <Field label="Transcript" hint="Ctrl or ⌘ + Enter saves."><Textarea rows={4} maxLength={50000} value={viewedItem.transcript ?? ''} readOnly={!editable} onChange={event => edit(gallery.setTranscript(draft, viewedAsset.id, event.target.value))} /></Field>
            <Field label={`Captions · ${locale}`} hint="Public HTTPS address of a WebVTT (.vtt) file. Other languages' captions are kept.">
              <Input size="sm" type="url" value={viewedItem.captions?.find(c => c.language === locale)?.url ?? ''} readOnly={!editable} onChange={event => edit(gallery.setCaption(draft, viewedAsset.id, locale, event.target.value))} />
            </Field>
          </>}
        </div>}
      </PhotoViewer>}

      {adding && working && draft && <PhotoLibrary target={target} noun="product's photos and videos" searchInput={searchInput} disabled={busy}
        cards={cards.map(asset => ({ id: asset.id, src: asset.preview, mediaType: asset.type, label: asset.alt || mediaTypeLabel(asset.type), width: asset.width ?? null, height: asset.height ?? null,
          tags: <>{gallery.galleryTiles(working, { items: [{ assetId: asset.id }], reset: false })[0]?.problem && <Tag tone="warning">{gallery.galleryTiles(working, { items: [{ assetId: asset.id }], reset: false })[0].problem}</Tag>}</> }))}
        picked={id => gallery.inList(draft, id)}
        onToggle={(id, on) => edit(on ? gallery.addAsset(draft, id) : gallery.removeAsset(draft, id))}
        onPreview={setViewing} search={search} onSearch={setSearch} show={show} onShow={setShow}
        accept=".jpg,.jpeg,.png,.webp,.gif,.avif,.mp4,.mov,.webm" maxBytes={200 * 1024 * 1024}
        uploadHint="Images up to 20 MB · MP4, MOV and WebM up to 200 MB · they join the list on Enter and stay in the library"
        onFiles={files => void upload(files)} uploads={uploads}
        onUseCandidate={u => {
          const added = u.candidate ? gallery.addAsset(draft, u.candidate.id) : null
          if (!added) { setUploads(list => list.map(x => x.name === u.name ? { name: u.name, state: 'failed', message: gallery.GALLERY_TEXT.max } : x)); return }
          edit(added); setUploads(list => list.map(x => x.name === u.name ? { name: u.name, state: 'exact' } : x))
        }}
        onUploadAnyway={u => { if (u.file) void upload([u.file], true) }} />}

      <MediaPageLink disabled={busy} onOpen={() => {
        afterSave.current = onOpenMediaPage
        if (!body || !editable) { close(); onOpenMediaPage() } else save()
      }} />
    </div>
  </CellPanel>
}
