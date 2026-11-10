'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronLeft, ChevronRight, ImageOff, Lock, MoreHorizontal, Plus, Star, Trash2, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { PICTURE_KINDS, type PictureKind } from '@nexus/factory-domain/product/images/rules'
import { FileDropzone, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { PictureView, StylePicturesView } from '../api'
import {
  activeColourways,
  addCallout,
  CAPTION_MAX,
  calloutsToSend,
  captionToSend,
  draftRevisions,
  draftsOf,
  fileProblem,
  galleryHeld,
  NO_GALLERY,
  ordered,
  PICTURE_MAX_BYTES,
  pictureOf,
  pictureSrc,
  pictureWhere,
  type CalloutDraft,
  type GalleryActions,
  type GalleryModel,
  type PictureTarget,
} from '../gallery-model'
import '../gallery.css'

const NS = 'products-gallery'

/**
 * SCR-304 — Style › Overview & variants › Sketches and pictures (B-W2b-236; PRD-016; design products.styles rec:Style
 * style.ov.gallery): the style's flats, photos per colourway and image pages with numbered callouts, in the gallery's
 * order, the main picture marked (the list's thumbnail, the gallery's card and the public DoC page's picture). Add
 * pictures (send files from this device or pick the style's picture files), ⋯ per picture (Make main, Move earlier /
 * later, Callouts…, Details…, Remove…), a picture opens full size with its callouts (← → step through them). A picture
 * of a released revision keeps what it shows: only its place and the main mark move (said on it). Composed of the DS
 * Card, Menu, Modal, FileDropzone and SegmentedControl: the DS MediaGallery, ImageUpload and Lightbox speak English only.
 * It draws the view model and fetches nothing (use-gallery.ts loads it).
 */
export function GallerySection({ model, actions }: { model?: GalleryModel; actions?: GalleryActions }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Section model={model ?? NO_GALLERY} actions={actions} />
    </WithMessages>
  )
}

function Section({ model, actions }: { model: GalleryModel; actions?: GalleryActions }) {
  const t = useT(NS)
  const part = model.part
  if (part.status === 'ready') return <Ready view={part.value} model={model} actions={actions} />
  if (part.status === 'error') {
    return (
      <Card header={t('gallery.title')} headingLevel={2}>
        <Banner
          tone="danger"
          title={t('gallery.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('gallery.retry')}
            </Button>
          }
        >
          {t(part.problem)}
        </Banner>
      </Card>
    )
  }
  return (
    <Card header={t('gallery.title')} headingLevel={2} aria-busy="true">
      <p className="fw-gal-hint" role="status">
        <Spinner size={14} /> {t('gallery.loading')}
      </p>
      <div className="fw-gal-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} height={180} />
        ))}
      </div>
    </Card>
  )
}

function Ready({ view, model, actions }: { view: StylePicturesView; model: GalleryModel; actions?: GalleryActions }) {
  const t = useT(NS)
  const pictures = ordered(view)
  const uploadHeld = galleryHeld(model, view, 'upload')
  const arrangeHeld = galleryHeld(model, view, 'arrange')
  const full = pictures.length >= view.limits.pictures
  const addHeld = uploadHeld && !(uploadHeld === 'gallery.held.noUpload' && view.unused.length > 0) ? uploadHeld : full ? 'gallery.held.full' : null
  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld ? t(addHeld, { max: view.limits.pictures }) : model.busy ? t('gallery.held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'add' })}>
      <Plus size={14} aria-hidden /> {t('gallery.add.button')}
    </Button>
  )
  return (
    <Card header={t('gallery.title')} headingLevel={2} description={t('gallery.intro')} headerAction={<span className="fw-gal-head">{addButton}</span>}>
      <div className="fw-gal-stack">
        {arrangeHeld && arrangeHeld !== 'gallery.held.offline' && <Banner tone="info" title={t(arrangeHeld.replace('gallery.held.', 'gallery.banner.'))} />}
        {model.offline && (
          <Banner
            tone="warning"
            title={
              <span className="fw-gal-inline">
                <WifiOff size={14} aria-hidden /> {t('gallery.held.offline')}
              </span>
            }
          />
        )}
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={t(model.notice.key, model.notice.params)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('gallery.dismiss')}
              </Button>
            }
          />
        )}
        {pictures.length === 0 ? (
          <EmptyState icon={<ImageOff size={24} aria-hidden />} title={t('gallery.empty.title')} description={t('gallery.empty.body')} action={addHeld ? undefined : addButton} />
        ) : (
          <>
            <p className="fw-gal-hint">{t('gallery.count', { count: pictures.length, printable: pictures.filter((picture) => picture.printable).length })}</p>
            <ol className="fw-gal-grid" aria-label={t('gallery.listLabel')}>
              {pictures.map((picture, index) => (
                <PictureCard key={picture.id} picture={picture} index={index} total={pictures.length} held={arrangeHeld} busy={model.busy} actions={actions} />
              ))}
            </ol>
          </>
        )}
      </div>
      <GalleryDialogs view={view} model={model} actions={actions} uploadHeld={uploadHeld} />
    </Card>
  )
}

function PictureCard({ picture, index, total, held, busy, actions }: { picture: PictureView; index: number; total: number; held: string | null; busy: boolean; actions?: GalleryActions }) {
  const t = useT(NS)
  const src = pictureSrc(picture)
  // A picture the store does not give now (an address run out, a file not there): said in words, never a broken image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const where = pictureWhere(picture)
  const label = picture.caption ?? picture.file.name
  const why = held ? t(held) : busy ? t('gallery.held.busy') : undefined
  const frozenWhy = picture.frozen ? t('gallery.frozen', { revision: picture.revision?.revision ?? 0 }) : undefined
  const items: MenuItemDef[] = [
    { id: 'view', label: t('gallery.menu.view'), onSelect: () => actions?.onDialog?.({ kind: 'view', pictureId: picture.id }) },
    { id: 'main', label: t('gallery.menu.main'), disabled: !!why || picture.isMain, description: picture.isMain ? t('gallery.menu.isMain') : why, onSelect: () => actions?.onMain?.(picture.id) },
    { id: 'earlier', label: t('gallery.menu.earlier'), disabled: !!why || index === 0, description: index === 0 ? t('gallery.menu.first') : why, onSelect: () => actions?.onMove?.(picture.id, index - 1) },
    { id: 'later', label: t('gallery.menu.later'), disabled: !!why || index === total - 1, description: index === total - 1 ? t('gallery.menu.last') : why, onSelect: () => actions?.onMove?.(picture.id, index + 1) },
    { id: 'callouts', label: t('gallery.menu.callouts'), disabled: !!why || !!frozenWhy, description: frozenWhy ?? why, onSelect: () => actions?.onDialog?.({ kind: 'callouts', pictureId: picture.id }) },
    { id: 'edit', label: t('gallery.menu.edit'), disabled: !!why || !!frozenWhy, description: frozenWhy ?? why, onSelect: () => actions?.onDialog?.({ kind: 'edit', pictureId: picture.id }) },
    { id: 'remove', label: t('gallery.menu.remove'), tone: 'danger', disabled: !!why || !!frozenWhy, description: frozenWhy ?? why, onSelect: () => actions?.onDialog?.({ kind: 'remove', pictureId: picture.id }) },
  ]
  return (
    <li className={picture.isMain ? 'fw-gal-card is-main' : 'fw-gal-card'}>
      <button type="button" className="fw-gal-frame" onClick={() => actions?.onDialog?.({ kind: 'view', pictureId: picture.id })} aria-label={t('gallery.open', { name: label })}>
        {src && failedSrc !== src ? (
          // The picture through the API (kept by the browser), shown whole and never cropped.
          <img className="fw-gal-img" src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
        ) : (
          <span className="fw-gal-none">
            <ImageOff size={22} aria-hidden /> {t(picture.file.status === 'AVAILABLE' ? 'gallery.noLook' : 'gallery.notAvailable')}
          </span>
        )}
        {picture.callouts.length > 0 && <span className="fw-gal-badge">{t('gallery.calloutCount', { count: picture.callouts.length })}</span>}
      </button>
      <div className="fw-gal-meta">
        <div className="fw-gal-row">
          <span className="fw-gal-caption" title={label}>
            {label}
          </span>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" items={items} triggerProps={{ 'aria-label': t('gallery.menu.label', { name: label }) }} />
        </div>
        <div className="fw-gal-tags">
          {picture.isMain && (
            <Pill tone="success">
              <Star size={12} aria-hidden /> {t('gallery.main')}
            </Pill>
          )}
          <Tag tone="neutral">{t(where.kind)}</Tag>
          {where.colourway && <Tag tone="info">{where.colourway}</Tag>}
          {where.revision !== null && (
            <Tag tone={picture.frozen ? 'neutral' : 'info'}>
              {picture.frozen && <Lock size={11} aria-hidden />} {t('gallery.revision', { revision: where.revision })}
            </Tag>
          )}
        </div>
        {!picture.printable && picture.file.status === 'AVAILABLE' && <span className="fw-gal-hint">{t('gallery.notInPdf')}</span>}
      </div>
    </li>
  )
}

// ---- the dialogs ---------------------------------------------------------------------------------------------------------

function GalleryDialogs({ view, model, actions, uploadHeld }: { view: StylePicturesView; model: GalleryModel; actions?: GalleryActions; uploadHeld: string | null }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  if (dialog.kind === 'add') return <AddDialog view={view} model={model} actions={actions} uploadHeld={uploadHeld} onClose={close} />
  const picture = pictureOf(view, dialog.pictureId)
  if (!picture) return null
  if (dialog.kind === 'view') return <Viewer view={view} picture={picture} actions={actions} onClose={close} />
  if (dialog.kind === 'callouts') return <CalloutsDialog picture={picture} busy={model.busy} actions={actions} onClose={close} />
  if (dialog.kind === 'edit') return <EditDialog view={view} picture={picture} busy={model.busy} actions={actions} onClose={close} />
  return <RemoveDialog view={view} picture={picture} busy={model.busy} actions={actions} onClose={close} />
}

function KindChoice({ value, onChange }: { value: PictureKind; onChange: (kind: PictureKind) => void }) {
  const t = useT(NS)
  return (
    <Field label={t('gallery.field.kind')} hint={t(`gallery.kindHint.${value}`)}>
      <SegmentedControl ariaLabel={t('gallery.field.kind')} size="sm" wrap value={value} onChange={(next) => onChange(next as PictureKind)} options={PICTURE_KINDS.map((kind) => ({ value: kind, label: t(`gallery.kind.${kind}`) }))} />
    </Field>
  )
}

function WhereFields({ view, revisionId, colourwayId, onRevision, onColourway, disabled }: { view: StylePicturesView; revisionId: string | null; colourwayId: string | null; onRevision: (id: string | null) => void; onColourway: (id: string | null) => void; disabled?: boolean }) {
  const t = useT(NS)
  const drafts = draftRevisions(view)
  const shown = revisionId && !drafts.some((revision) => revision.id === revisionId) ? view.revisions.find((revision) => revision.id === revisionId) : undefined
  return (
    <div className="fw-gal-two">
      <Field label={t('gallery.field.colourway')}>
        <Select size="sm" value={colourwayId ?? ''} disabled={disabled} onChange={(event) => onColourway(event.target.value || null)}>
          <option value="">{t('gallery.field.noColourway')}</option>
          {activeColourways(view).map((colourway) => (
            <option key={colourway.id} value={colourway.id}>
              {colourway.code} · {colourway.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('gallery.field.revision')} hint={t('gallery.field.revisionHint')}>
        <Select size="sm" value={revisionId ?? ''} disabled={disabled} onChange={(event) => onRevision(event.target.value || null)}>
          <option value="">{t('gallery.field.noRevision')}</option>
          {shown && <option value={shown.id}>{t('gallery.revision', { revision: shown.revision })}</option>}
          {drafts.map((revision) => (
            <option key={revision.id} value={revision.id}>
              {t('gallery.field.draftRevision', { revision: revision.revision })}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

function AddDialog({ view, model, actions, uploadHeld, onClose }: { view: StylePicturesView; model: GalleryModel; actions?: GalleryActions; uploadHeld: string | null; onClose: () => void }) {
  const t = useT(NS)
  const locale = useLocale()
  const [target, setTarget] = useState<PictureTarget>({ kind: 'PHOTO', revisionId: null, colourwayId: null, caption: null })
  const [caption, setCaption] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [refused, setRefused] = useState<string | null>(null)
  const sending = model.upload.state === 'sending'
  const typed = captionToSend(caption)
  const send = () => {
    if (typed.problem || files.length === 0) return
    actions?.onUpload?.(files, { ...target, caption: typed.caption })
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('gallery.add.title')}
      subtitle={t('gallery.add.subtitle', { code: view.style.code })}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={uploadHeld ? t(uploadHeld) : files.length === 0 ? t('gallery.add.pickFirst') : typed.problem ? t(typed.problem, { max: CAPTION_MAX }) : sending ? t('gallery.held.busy') : null} onClick={send}>
            {t('gallery.add.send', { count: files.length })}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack">
        <KindChoice value={target.kind} onChange={(kind) => setTarget({ ...target, kind })} />
        <WhereFields view={view} revisionId={target.revisionId} colourwayId={target.colourwayId} onRevision={(revisionId) => setTarget({ ...target, revisionId })} onColourway={(colourwayId) => setTarget({ ...target, colourwayId })} />
        {uploadHeld === null && (
          <FileDropzone
            multiple
            accept=".jpg,.jpeg,.png,.webp"
            maxBytes={PICTURE_MAX_BYTES}
            disabled={sending}
            hint={t('gallery.add.hint')}
            onFiles={(picked) => {
              const problem = picked.map((file) => fileProblem(file, PICTURE_MAX_BYTES)).find(Boolean) ?? null
              setRefused(problem)
              setFiles(picked.filter((file) => fileProblem(file, PICTURE_MAX_BYTES) === null))
            }}
          />
        )}
        {refused && <Banner tone="warning" title={t(refused)} />}
        {files.length > 0 && (
          <ul className="fw-gal-files">
            {files.map((file) => (
              <li key={`${file.name}-${file.size}`}>{file.name}</li>
            ))}
          </ul>
        )}
        {files.length <= 1 && (
          <Field label={t('gallery.field.caption')} hint={t('gallery.field.captionHint', { max: CAPTION_MAX })} error={typed.problem ? t(typed.problem, { max: CAPTION_MAX }) : undefined}>
            <Input size="sm" value={caption} maxLength={CAPTION_MAX + 1} onChange={(event) => setCaption(event.target.value)} />
          </Field>
        )}
        {model.upload.state !== 'idle' && (
          <p className="fw-gal-hint" role="status">
            {sending && <Spinner size={12} />} {t(model.upload.state === 'failed' ? (model.upload.problem ?? 'gallery.add.failed') : 'gallery.add.sending', { done: model.upload.done, of: model.upload.of })}
          </p>
        )}
        {view.unused.length > 0 && (
          <section className="fw-gal-stack" aria-labelledby="fw-gal-unused">
            <h3 id="fw-gal-unused" className="fw-gal-h3">
              {t('gallery.add.unused', { count: view.unused.length })}
            </h3>
            <ul className="fw-gal-unused">
              {view.unused.map((file) => (
                <li key={file.fileId} className="fw-gal-row">
                  <span className="fw-gal-caption">
                    {file.name} <span className="fw-gal-hint">{formatDate(file.createdAt, { locale })}</span>
                  </span>
                  <Button size="sm" heldReason={galleryHeld(model, view, 'arrange') ? t(galleryHeld(model, view, 'arrange')!) : model.busy ? t('gallery.held.busy') : null} onClick={() => actions?.onAddExisting?.(file.fileId, { ...target, caption: null })}>
                    {t('gallery.add.useFile')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}

/** The picture whole, with its numbered callouts on it (a picture of the tenant's own store; never cropped). */
function PictureWithCallouts({ picture, callouts, onPlace, placeLabel }: { picture: PictureView; callouts: readonly { n: number; x: string; y: string }[]; onPlace?: (x: number, y: number) => void; placeLabel?: string }) {
  const t = useT(NS)
  const src = pictureSrc(picture)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) {
    return (
      <p className="fw-gal-none is-large">
        <ImageOff size={24} aria-hidden /> {t(picture.file.status === 'AVAILABLE' ? 'gallery.noLook' : 'gallery.notAvailable')}
      </p>
    )
  }
  const place = (event: ReactMouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) onPlace?.((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height)
  }
  return (
    <div className="fw-gal-stage">
      <div className="fw-gal-canvas">
        <img className={onPlace ? 'fw-gal-full is-placing' : 'fw-gal-full'} src={src} alt={picture.caption ?? picture.file.name} onClick={onPlace ? place : undefined} title={placeLabel} onError={() => setFailedSrc(src)} />
        {callouts.map((callout) => (
          <span key={callout.n} className="fw-gal-pin" style={{ left: `${Number(callout.x) * 100}%`, top: `${Number(callout.y) * 100}%` }} aria-hidden>
            {callout.n}
          </span>
        ))}
      </div>
    </div>
  )
}

function Viewer({ view, picture, actions, onClose }: { view: StylePicturesView; picture: PictureView; actions?: GalleryActions; onClose: () => void }) {
  const t = useT(NS)
  const list = ordered(view)
  const at = list.findIndex((entry) => entry.id === picture.id)
  const bodyRef = useRef<HTMLDivElement>(null)
  const go = (delta: -1 | 1) => {
    const next = list[at + delta]
    if (next) actions?.onDialog?.({ kind: 'view', pictureId: next.id })
  }
  const latest = useRef(go)
  latest.current = go
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active) || active.closest('input, textarea, select')) return
      event.preventDefault()
      latest.current(event.key === 'ArrowLeft' ? -1 : 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const where = pictureWhere(picture)
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={picture.caption ?? picture.file.name}
      subtitle={t('gallery.viewer.position', { at: at + 1, of: list.length })}
      footer={
        <>
          <Button size="sm" heldReason={at <= 0 ? t('gallery.viewer.first') : null} onClick={() => go(-1)} aria-keyshortcuts="ArrowLeft">
            <ChevronLeft size={14} aria-hidden /> {t('gallery.viewer.previous')}
          </Button>
          <Button size="sm" heldReason={at >= list.length - 1 ? t('gallery.viewer.last') : null} onClick={() => go(1)} aria-keyshortcuts="ArrowRight">
            {t('gallery.viewer.next')} <ChevronRight size={14} aria-hidden />
          </Button>
        </>
      }
    >
      <div ref={bodyRef} className="fw-gal-stack">
        <div className="fw-gal-tags">
          {picture.isMain && <Pill tone="success">{t('gallery.main')}</Pill>}
          <Tag tone="neutral">{t(where.kind)}</Tag>
          {where.colourway && <Tag tone="info">{where.colourway}</Tag>}
          {where.revision !== null && <Tag tone="info">{t('gallery.revision', { revision: where.revision })}</Tag>}
        </div>
        <PictureWithCallouts picture={picture} callouts={picture.callouts} />
        {picture.callouts.length > 0 && (
          <ol className="fw-gal-callouts" aria-label={t('gallery.callouts.list')}>
            {[...picture.callouts]
              .sort((a, b) => a.n - b.n)
              .map((callout) => (
                <li key={callout.n}>
                  <span className="fw-gal-pin is-static" aria-hidden>
                    {callout.n}
                  </span>
                  <span>{t('gallery.callouts.item', { n: callout.n, text: callout.text })}</span>
                </li>
              ))}
          </ol>
        )}
        {picture.frozen && <Banner tone="info" title={t('gallery.frozen', { revision: picture.revision?.revision ?? 0 })} />}
        <p className="fw-gal-hint">{t('gallery.viewer.keys')}</p>
      </div>
    </Modal>
  )
}

function CalloutsDialog({ picture, busy, actions, onClose }: { picture: PictureView; busy: boolean; actions?: GalleryActions; onClose: () => void }) {
  const t = useT(NS)
  const [drafts, setDrafts] = useState<CalloutDraft[]>(() => draftsOf(picture.callouts))
  const { callouts, problems } = calloutsToSend(drafts)
  const count = Object.keys(problems).length
  const set = (index: number, change: Partial<CalloutDraft>) => setDrafts(drafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)))
  const preview = drafts.flatMap((draft, index) => (problems[index] === 'gallery.callouts.place' ? [] : [{ n: draft.n, x: callouts[index]!.x, y: callouts[index]!.y }]))
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={t('gallery.callouts.title', { name: picture.caption ?? picture.file.name })}
      subtitle={t('gallery.callouts.subtitle')}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={count > 0 ? t('gallery.callouts.held', { count }) : busy ? t('gallery.held.busy') : null} onClick={() => actions?.onSave?.(picture.id, { callouts })}>
            {t('gallery.callouts.save', { count: drafts.length })}
          </Button>
        </>
      }
    >
      <div className="fw-gal-editor">
        <PictureWithCallouts picture={picture} callouts={preview} onPlace={(x, y) => setDrafts(addCallout(drafts, x, y))} placeLabel={t('gallery.callouts.clickHint')} />
        <div className="fw-gal-stack">
          <Button size="sm" onClick={() => setDrafts(addCallout(drafts))} heldReason={drafts.length >= 60 ? t('gallery.callouts.full') : null}>
            <Plus size={14} aria-hidden /> {t('gallery.callouts.add')}
          </Button>
          {drafts.length === 0 && <p className="fw-gal-hint">{t('gallery.callouts.none')}</p>}
          <ol className="fw-gal-callout-rows">
            {drafts.map((draft, index) => (
              <li key={`${draft.n}-${index}`} className="fw-gal-callout-row">
                <span className="fw-gal-pin is-static" aria-hidden>
                  {draft.n}
                </span>
                {/* An empty text only holds Save (with the count); a text typed and refused says why at once. */}
                <Field label={t('gallery.callouts.textLabel', { n: draft.n })} error={problems[index] && problems[index] !== 'gallery.callouts.place' && draft.text.trim() !== '' ? t(problems[index]!) : undefined}>
                  <Input size="sm" value={draft.text} maxLength={501} onChange={(event) => set(index, { text: event.target.value })} />
                </Field>
                <Field label={t('gallery.callouts.x')} error={problems[index] === 'gallery.callouts.place' ? t('gallery.callouts.place') : undefined}>
                  <Input size="sm" inputMode="decimal" value={draft.x} onChange={(event) => set(index, { x: event.target.value })} />
                </Field>
                <Field label={t('gallery.callouts.y')}>
                  <Input size="sm" inputMode="decimal" value={draft.y} onChange={(event) => set(index, { y: event.target.value })} />
                </Field>
                <Button size="sm" variant="quiet" aria-label={t('gallery.callouts.remove', { n: draft.n })} onClick={() => setDrafts(drafts.filter((_, at) => at !== index))}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Modal>
  )
}

function EditDialog({ view, picture, busy, actions, onClose }: { view: StylePicturesView; picture: PictureView; busy: boolean; actions?: GalleryActions; onClose: () => void }) {
  const t = useT(NS)
  const [kind, setKind] = useState<PictureKind>(picture.kind)
  const [caption, setCaption] = useState(picture.caption ?? '')
  const [revisionId, setRevisionId] = useState<string | null>(picture.revision?.id ?? null)
  const [colourwayId, setColourwayId] = useState<string | null>(picture.colourway?.id ?? null)
  const typed = captionToSend(caption)
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typed.problem) actions?.onSave?.(picture.id, { kind, caption: typed.caption, revisionId, colourwayId })
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('gallery.edit.title')}
      subtitle={picture.file.name}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={typed.problem ? t(typed.problem, { max: CAPTION_MAX }) : busy ? t('gallery.held.busy') : null} onClick={() => actions?.onSave?.(picture.id, { kind, caption: typed.caption, revisionId, colourwayId })}>
            {t('gallery.edit.save')}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack" onKeyDown={onKeyDown}>
        <KindChoice value={kind} onChange={setKind} />
        <Field label={t('gallery.field.caption')} hint={t('gallery.field.captionHint', { max: CAPTION_MAX })} error={typed.problem ? t(typed.problem, { max: CAPTION_MAX }) : undefined}>
          <Input size="sm" value={caption} maxLength={CAPTION_MAX + 1} onChange={(event) => setCaption(event.target.value)} />
        </Field>
        <WhereFields view={view} revisionId={revisionId} colourwayId={colourwayId} onRevision={setRevisionId} onColourway={setColourwayId} />
      </div>
    </Modal>
  )
}

function RemoveDialog({ view, picture, busy, actions, onClose }: { view: StylePicturesView; picture: PictureView; busy: boolean; actions?: GalleryActions; onClose: () => void }) {
  const t = useT(NS)
  const heir = picture.isMain ? ordered(view).find((entry) => entry.id !== picture.id) : null
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('gallery.remove.title')}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={busy ? t('gallery.held.busy') : null} onClick={() => actions?.onRemove?.(picture.id)}>
            {t('gallery.remove.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack">
        <p>{t('gallery.remove.body', { name: picture.caption ?? picture.file.name })}</p>
        {picture.isMain && <p>{heir ? t('gallery.remove.heir', { name: heir.caption ?? heir.file.name }) : t('gallery.remove.noHeir')}</p>}
      </div>
    </Modal>
  )
}
