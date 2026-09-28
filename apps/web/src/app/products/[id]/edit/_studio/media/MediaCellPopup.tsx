'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type { MediaOp } from '@nexus/shared/media-plan'

import { Banner, FileDropzone, MediaBoard, MediaCard, MediaPreview, MediaStrip, SourceIndicator, mediaTypeLabel, type MediaBoardItem, type MediaStripItem } from '@/design-system/components'
import { Button, Checkbox, Input, SegmentedControl, Spinner, Tag, ToolbarButton } from '@/design-system/primitives'
import { EDITOR_KEY_HINT_PANEL } from '@/design-system/grid'

import type { SaveReporter } from '../types'
import { CellPanel } from '../shopify/ShopifyDraftCell'
import { CHANNEL_LABEL, assetProblems, destinationLabel, type MediaRead } from '../images/plan-page/model'
import { uploadPhoto } from '../images/plan-page/uploadApi'
import { sendPlanOps, type PlanAddress } from './planCellTransfer'
import * as model from './mediaPopupModel'
import { useMediaPopupData } from './useMediaPopupData'
import styles from './media.module.css'

/** Photos changed in the cells at once; `restore` puts them back when the save is refused, `done` ends "saving". */
export interface AppliedCells { restore(): void; done(): void }

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
}

type Upload = { name: string; state: 'sending' | 'added' | 'exact' | 'similar' | 'failed'; message?: string; candidate?: { id: string; label: string }; file?: File }

/**
 * Lane C — the Product media cell pop-up for a family on the photo plan (docs/product-media-popup/PLAN-2026-09-28.md §3).
 * One panel under the cell: the ONE set the cell stands for, "+ Add" from the family's photos (and upload) and a bigger
 * photo in the same panel — no dialog on a dialog. Enter or a click outside saves ONE change; Esc cancels.
 */
export function PlanMediaPopup(props: PlanMediaPopupProps) {
  const { productId, rowProductId, title, address, locale, canEdit, anchor, initial, onApply, onSaved, onClose, reporter, onOpenMediaPage } = props
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
  const [show, setShow] = useState<model.LibraryShow>('not-in-set')
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const reported = useRef<string | null>(null)
  const afterSave = useRef<(() => void) | null>(null)

  const editable = canEdit && !!base?.view && !!draft && !busy
  const ref = base && draft ? model.mainRef(base, draft) : null
  const changedElsewhere = !!(base && data.latest && data.baseline && ref && [ref, base.skuRef].some(r => r && JSON.stringify(model.ownItems(data.latest!, base, r)) !== JSON.stringify(model.ownItems(data.baseline!, base, r))))
  const ops: MediaOp[] = working && base && draft ? model.saveOps(working, base, draft) : []

  // Presses in a menu this pop-up opened (a photo's ⋯ menu draws outside it) are not "outside". Registered on the
  // window, so it runs before the panel's own listener on the document.
  const menuPress = useRef(false)
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      menuPress.current = !!(event.target as Element | null)?.closest?.('.nds-menu')
      if (menuPress.current) window.setTimeout(() => { menuPress.current = false }, 0)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  // Focus the first photo (the panel focuses its first control first; this effect runs after the panel's).
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector<HTMLElement>('.nds-media-board-thumb[tabindex="0"]')?.focus({ preventScroll: true }) }, [])

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
    if (busy) return false
    if (!working || !base || !draft || !ops.length || !base.view || !address || !canEdit) { close(); return true }
    const local = model.localRefusal(working, base, ops)
    if (local) { afterSave.current = null; setError(`Not saved: ${local}`); return false }
    void send(working, base, draft, address, ops)
    return false
  }

  async function send(read: MediaRead, popupBase: model.PlanPopupBase, current: model.PlanDraft, target: PlanAddress, request: MediaOp[]) {
    setBusy(true); setError(''); data.setSaving(true)
    const applied = onApply(model.afterSave(read, popupBase, request), popupBase)
    const subject = `product-media:plan:${JSON.stringify([target, model.mainRef(popupBase, current)])}`
    const writeId = crypto.randomUUID()
    reporter.pending(writeId, subject)
    try {
      await sendPlanOps(productId, target, request)
      reporter.resolved(writeId, true, undefined, subject)
      applied.done()
      onSaved()
      onClose()
      afterSave.current?.()
    } catch (e) {
      applied.restore()
      const fresh = await data.reload()
      const message = model.refusalSentence(fresh, popupBase, request, e instanceof Error ? e.message : model.POPUP_TEXT.unconfirmed)
      reporter.resolved(writeId, false, message, subject)
      reported.current = subject
      setError(`Not saved: ${message}`)
      setBusy(false)
      afterSave.current = null
    } finally {
      data.setSaving(false)
    }
  }

  const onKeyCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter on a photo saves, like everywhere else in the pop-up (a click, or ⋯ → Open, shows the photo) — except while
    // a photo is picked up, when Enter drops it.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    const target = event.target as HTMLElement
    if (!target.closest('.nds-media-board-thumb') || root.current?.querySelector('[data-picked]')) return
    event.preventDefault(); event.stopPropagation()
    save()
  }

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
      setDraft(current => current && fresh ? model.addItem(fresh, current, assetId) : current)
      setUploads(list => list.map(u => u.name === file.name ? { name: file.name, state: status.kind === 'exact' ? 'exact' : 'added' } : u))
    }
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
      <div className={styles.popupHead}>
        <strong>Product media{context ? ` · ${context}` : ''}</strong>
        <span>{title}</span>
      </div>

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

      {found.length > 0 && <ul className={styles.checks} aria-label="Checks">
        {found.map(c => <li key={c.message} data-severity={c.severity}><Tag tone={c.severity === 'error' ? 'danger' : 'warning'}>{c.severity === 'error' ? 'Refused' : 'Warning'}</Tag> {c.message}</li>)}
        {found.some(c => c.severity === 'error') && base?.destination && <li className={styles.muted}>You can save. Publishing to {CHANNEL_LABEL[base.destination.channel]} stays blocked until it is fixed.</li>}
      </ul>}

      {viewed && <section className={styles.viewer} aria-label={`Photo: ${viewed.label}`}>
        <div className={styles.viewerHead}>
          <span>{mediaTypeLabel(viewed.mediaType)}{viewed.width && viewed.height ? ` · ${viewed.width} × ${viewed.height}` : ''}{viewed.fileSize ? ` · ${(viewed.fileSize / 1024 / 1024).toFixed(1)} MB` : ''} · {viewed.languageTag === 'zxx' ? 'no text' : viewed.languageTag.toUpperCase()}</span>
          <ToolbarButton label="Close the photo" icon={<X size={14} />} onClick={() => setViewing(null)} />
        </div>
        <MediaPreview type={viewed.mediaType} url={viewed.url} label={viewed.label} />
        <p className={styles.muted}>{viewed.label}</p>
      </section>}

      {adding && working && draft && <section className={styles.library} aria-label={`Add to ${headline.label}`}>
        <p className={styles.muted}>Add to {headline.label} · tick photos, they join the end.</p>
        <div className={styles.libraryTools}>
          <Input ref={searchInput} size="sm" placeholder="Search the family's photos" aria-label="Search the family's photos" value={search} onChange={event => setSearch(event.target.value)} />
          <SegmentedControl size="sm" ariaLabel="Show" value={show} onChange={value => setShow(value as model.LibraryShow)}
            options={[{ value: 'not-in-set', label: 'Not in this set' }, { value: 'all', label: 'All' }]} />
        </div>
        {cards.length ? <ul className={styles.libraryGrid} aria-label="The family's photos">
          {cards.map(asset => {
            const picked = model.inSet(working, draft, asset.id)
            const problems = assetProblems(asset)
            return <li key={asset.id}>
              <MediaCard compact src={asset.mediaType === 'VIDEO' ? null : asset.url} mediaType={asset.mediaType} label={asset.label}
                selected={picked} disabled={busy}
                onSelectedChange={on => edit(on ? model.addItem(working, draft, asset.id) : model.removePicture(working, draft, asset.id))}
                onPreview={() => setViewing(asset.id)}
                detail={<span className={styles.facts}>
                  {asset.width && asset.height ? <span>{asset.width}×{asset.height}</span> : null}
                  {asset.languageTag !== 'zxx' && <Tag tone="info">{asset.languageTag.toUpperCase()}</Tag>}
                  {problems.slice(0, 1).map(p => <Tag key={p} tone="warning">{p}</Tag>)}
                </span>} />
            </li>
          })}
        </ul> : <p className={styles.muted}>{search ? 'No photo matches.' : show === 'not-in-set' ? 'Every photo of the family is already in this set.' : 'No photos yet.'}</p>}
        <FileDropzone className={styles.upload} multiple accept=".jpg,.jpeg,.png,.webp,.gif,.avif" maxBytes={20 * 1024 * 1024} disabled={busy}
          hint="Images up to 20 MB · they join this set on Enter and stay in the library"
          onFiles={files => void upload(files)} />
        {uploads.length > 0 && <ul className={styles.uploads} aria-label="Uploads">
          {uploads.map(u => <li key={u.name} role="status">
            {u.state === 'sending' && <><Spinner size={12} /> Uploading {u.name}…</>}
            {u.state === 'added' && <>✓ {u.name} — added.</>}
            {u.state === 'exact' && <>= {u.name} — already in the library; that photo is added.</>}
            {u.state === 'failed' && <>✕ {u.name} — {u.message}</>}
            {u.state === 'similar' && u.candidate && <>≈ {u.name} looks like “{u.candidate.label}” in the library.{' '}
              <Button size="xs" variant="secondary" onClick={() => { setDraft(current => current && working ? model.addItem(working, current, u.candidate!.id) : current); setUploads(list => list.map(x => x.name === u.name ? { name: u.name, state: 'exact' } : x)) }}>Use “{u.candidate.label}”</Button>{' '}
              <Button size="xs" variant="ghost" onClick={() => u.file && void upload([u.file], true)}>Upload anyway</Button></>}
          </li>)}
        </ul>}
      </section>}

      <div className={styles.popupFoot}>
        <Button size="xs" variant="link" onClick={() => {
          // "All sets and channels": save first (nothing to save = leave now), then the Media page.
          afterSave.current = onOpenMediaPage
          if (!ops.length || !editable) { close(); onOpenMediaPage() } else save()
        }}>All sets and channels: Media page</Button>
      </div>
    </div>
  </CellPanel>
}

function ownedHere(read: MediaRead | null, base: model.PlanPopupBase | null, draft: model.PlanDraft | null) {
  return !!read && !!base && !!draft && model.ownItems(read, base, model.mainRef(base, draft)) !== null
}
