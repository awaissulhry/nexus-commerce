'use client'

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { ActionConfirm, FileDropzone, FileRow, Modal } from '../../../../lib/i18n/ds-parts'
import { PHOTO_ACCEPT, PHOTO_MAX_BYTES, type PickedPhoto } from '../model'
import { useReturnWords } from '../words'

/**
 * SCR-187's pop-ups on a case (design portal.customer.returns pop:cancel-case, rec Request "Add photos or information
 * while not yet decided", the photos full size): Esc closes and gives the focus back to the opener, Tab stays inside
 * (the DS Modal). Words by code from `portal-returns`.
 */

// ── pop:cancel-case ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface CancelModel {
  number: string
  busy: boolean
  /** The API refused: why (a key). */
  problem: string | null
}

/** "Cancel this request?" — the DS ActionConfirm: what happens, that a new one can be started any time, "Cancel request". */
export function CancelDialog({ model, onConfirm, onClose }: { model: CancelModel; onConfirm?: () => void; onClose?: () => void }) {
  const { t } = useReturnWords()
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('cancel.title'),
        confirmLabel: model.busy ? t('cancel.busy') : t('cancel.confirm'),
        consequences: [t('cancel.what', { number: model.number }), t('cancel.told')],
        reversal: { verb: t('cancel.again'), fidelity: 'lossy' },
        ...(model.problem ? { refusal: { reason: t(model.problem) } } : {}),
      }}
      onConfirm={() => onConfirm?.()}
      onCancel={() => (model.busy ? undefined : onClose?.())}
    />
  )
}

// ── Add photos ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PhotoTarget {
  /** A return's line id; null: the request (or the complaint) as a whole. */
  id: string | null
  label: string
  /** Photos it holds already. */
  count: number
}

export interface PhotosModel {
  number: string
  targets: readonly PhotoTarget[]
  target: string | null
  picked: readonly PickedPhoto[]
  /** More it takes (10 per record). */
  left: number
  /** Send waits: why (a key), or null. */
  held: string | null
  busy: boolean
  /** Sent: how many went. */
  done: number | null
}

export interface PhotosActions {
  onTarget?: (id: string | null) => void
  onFiles?: (files: File[]) => void
  onRemove?: (id: string) => void
  onSend?: () => void
  onClose?: () => void
}

export function PhotosDialog({ model, actions }: { model: PhotosModel; actions?: PhotosActions }) {
  const { t } = useReturnWords()
  const sending = model.picked.some((photo) => photo.state === 'sending')
  const waiting = model.picked.filter((photo) => photo.state === 'waiting' && !photo.problem).length
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      sheet
      title={t('photos.title')}
      subtitle={t('photos.subtitle', { number: model.number })}
      closeHeld={sending ? t('held.busy') : null}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} heldReason={sending ? t('held.busy') : null}>
            {model.done !== null ? t('photos.close') : t('photos.cancel')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={model.held ? t(model.held) : null}>
            {model.busy ? t('photos.sending') : t('photos.send', { count: waiting })}
          </Button>
        </>
      }
    >
      <div className="fw-pret-dialog">
        {model.done !== null ? <Banner tone="success" title={t('photos.sent', { count: model.done })} /> : null}
        {model.targets.length > 1 ? (
          <Field label={t('photos.of')}>
            <Select value={model.target ?? ''} onChange={(event) => actions?.onTarget?.(event.target.value || null)} disabled={model.busy}>
              {model.targets.map((target) => (
                <option key={target.id ?? 'request'} value={target.id ?? ''}>
                  {target.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <p className="fw-pret-hint">{t('photos.hint', { left: model.left, count: model.left })}</p>
        <FileDropzone
          accept={PHOTO_ACCEPT}
          multiple
          maxBytes={PHOTO_MAX_BYTES}
          disabled={model.busy || model.left === 0}
          hint={model.left === 0 ? t('photos.full') : t('photos.types')}
          onFiles={(files) => actions?.onFiles?.(files)}
        />
        {model.picked.length > 0 ? (
          <ul className="fw-pret-filelist" aria-label={t('photos.picked')}>
            {model.picked.map((photo) => (
              <li key={photo.id}>
                <FileRow
                  name={photo.name}
                  size={photo.size}
                  tone={photo.problem ? 'danger' : 'neutral'}
                  status={photo.problem ? t(photo.problem) : photo.state === 'sending' ? t('photos.state.sending') : photo.state === 'sent' ? t('photos.state.sent') : t('photos.state.waiting')}
                  onRemove={photo.state === 'waiting' || photo.state === 'failed' ? () => actions?.onRemove?.(photo.id) : undefined}
                  disabled={model.busy}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="fw-pret-quiet">{t('photos.privacy')}</p>
      </div>
    </Modal>
  )
}

// ── a photo full size ───────────────────────────────────────────────────────────────────────────────────────────────
export interface PhotoViewerModel {
  photos: readonly { id: string; name: string }[]
  index: number
  state: 'loading' | 'error' | 'ready'
  /** The picture's address (an object URL of the bytes read once). */
  src: string | null
}

/**
 * The photos of a case full size, one at a time (design rec Request "MediaGallery, Lightbox"): composed of the DS Modal
 * because the DS Lightbox speaks English only; Previous / Next held at the ends with the reason, ← → move, Esc closes.
 */
export function PhotoViewer({ model, onIndex, onClose, onRetry }: { model: PhotoViewerModel; onIndex?: (index: number) => void; onClose?: () => void; onRetry?: () => void }) {
  const { t } = useReturnWords()
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ model, onIndex })
  latest.current = { model, onIndex }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      if (!dialog || !document.activeElement || !dialog.contains(document.activeElement)) return
      const { model: now, onIndex: move } = latest.current
      const next = now.index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= now.photos.length) return
      event.preventDefault()
      move?.(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const photo = model.photos[model.index]
  if (!photo) return null
  const held = (direction: -1 | 1): string | null => {
    const next = model.index + direction
    if (next >= 0 && next < model.photos.length) return null
    if (model.photos.length <= 1) return t('viewer.only')
    return t(direction < 0 ? 'viewer.first' : 'viewer.last')
  }
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      size="xl"
      title={photo.name}
      subtitle={t('viewer.count', { n: model.index + 1, count: model.photos.length })}
      initialFocus="dialog"
      footer={
        model.photos.length > 1 ? (
          <>
            <Button aria-keyshortcuts="ArrowLeft" heldReason={held(-1)} onClick={() => onIndex?.(model.index - 1)}>
              <ChevronLeft size={16} aria-hidden /> {t('viewer.previous')}
            </Button>
            <Button aria-keyshortcuts="ArrowRight" heldReason={held(1)} onClick={() => onIndex?.(model.index + 1)}>
              {t('viewer.next')} <ChevronRight size={16} aria-hidden />
            </Button>
          </>
        ) : null
      }
    >
      <div ref={bodyRef} className="fw-pret-viewer">
        {model.state === 'loading' ? (
          <span className="fw-pret-viewer-wait" role="status">
            <Spinner size={20} /> {t('viewer.loading')}
          </span>
        ) : model.state === 'error' || !model.src ? (
          <Banner tone="danger" title={t('viewer.failed')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('state.retry')}</Button>} />
        ) : (
          <img className="fw-pret-viewer-img" src={model.src} alt={t('viewer.alt', { name: photo.name })} />
        )}
      </div>
    </Modal>
  )
}
