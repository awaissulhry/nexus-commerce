'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '../primitives/Button'
import { Kbd } from '../primitives/Kbd'
import { Modal } from '../components/Modal'
import { MediaPreview } from '../components/MediaPreview'
import { Thumbnail } from '../components/Thumbnail'
import type { ReturnFocusTarget } from '../components/modalStack'
import { lightboxCounter, lightboxHeld, lightboxKey, lightboxStep, lightboxThumbLabel, type LightboxDirection } from './lightboxModel'

export interface LightboxItem {
  url: string
  /** What the photo shows, or who sent it ("Photo 2 of 4 from Jonas K." — `photoAlt`). */
  alt: string
  /** `IMAGE` (default) or `VIDEO`, as `MediaPreview` takes it. */
  type?: string
}

export interface LightboxProps {
  open: boolean
  onClose: () => void
  items: LightboxItem[]
  /** The photo shown, 0-based. */
  index: number
  onIndex: (index: number) => void
  /** Default "Photo 2 of 4". */
  title?: ReactNode
  /** Under the title: stars, who and when. */
  meta?: ReactNode
  /** Under the photo: the review's words. */
  caption?: ReactNode
  /** The photo where it lives ("Open on eBay"); opens in a new tab. */
  external?: { label: string; href: string }
  /** Where the focus goes on close. Default: what had it when the lightbox opened. */
  returnFocusTo?: ReturnFocusTarget<HTMLElement>
}

/**
 * Photos of one review, one at a time (Reviews parts, 2026-10-26; wired in Phase 3). A DS `Modal` with the photo
 * (`MediaPreview`: a photo that does not load says so and keeps the link to the original), Previous / Next over it,
 * a strip of thumbnails and the counter "2 of 4". ← / → move, Esc closes and gives the focus back. No wrap: at the first
 * photo Previous is HELD and says "This is the first photo." (focusable, never disabled); the same for Next at the last.
 */
export function Lightbox({ open, onClose, items, index, onIndex, title, meta, caption, external, returnFocusTo }: LightboxProps) {
  const count = items.length
  const current = Math.max(0, Math.min(count - 1, index))
  const item = items[current]
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ current, count, onIndex })
  useEffect(() => { latest.current = { current, count, onIndex } })

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const direction = lightboxKey(event.key)
      if (direction == null || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      // Only while the focus is in this dialog, and never inside a text field or a video's own controls.
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active)) return
      if (active.closest('input, textarea, select, video, audio, [contenteditable="true"]')) return
      const { current: at, count: total, onIndex: go } = latest.current
      const next = lightboxStep(at, total, direction)
      event.preventDefault()
      if (next != null) go(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!item) return null
  const move = (direction: LightboxDirection) => {
    const next = lightboxStep(current, count, direction)
    if (next != null) onIndex(next)
  }
  const prevHeld = lightboxHeld(current, count, -1)
  const nextHeld = lightboxHeld(current, count, 1)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      className="nds-lightbox"
      title={title ?? `Photo ${lightboxCounter(current, count)}`}
      subtitle={meta}
      initialFocus="dialog"
      returnFocusTo={returnFocusTo}
      headerActions={external ? (
        <Button size="sm" asChild>
          <a href={external.href} target="_blank" rel="noopener noreferrer">
            {external.label}
            <ExternalLink size={13} aria-hidden focusable={false} />
          </a>
        </Button>
      ) : undefined}
    >
      <div className="nds-lightbox-body" ref={bodyRef}>
        <div className="nds-lightbox-stage">
          <MediaPreview type={item.type ?? 'IMAGE'} url={item.url} label={item.alt} />
          <div className="nds-lightbox-nav">
            <Button className="nds-lightbox-go" aria-label="Previous photo" aria-keyshortcuts="ArrowLeft" heldReason={prevHeld} onClick={() => move(-1)}>
              <ChevronLeft size={18} aria-hidden focusable={false} />
            </Button>
            <Button className="nds-lightbox-go" aria-label="Next photo" aria-keyshortcuts="ArrowRight" heldReason={nextHeld} onClick={() => move(1)}>
              <ChevronRight size={18} aria-hidden focusable={false} />
            </Button>
          </div>
        </div>
        {caption != null && <p className="nds-lightbox-caption">{caption}</p>}
        <div className="nds-lightbox-foot">
          {count > 1 && (
            <ol className="nds-lightbox-strip" aria-label="Photos">
              {items.map((photo, n) => (
                <li key={`${n}:${photo.url}`} className={n === current ? 'is-current' : undefined} aria-current={n === current ? 'true' : undefined}>
                  <Thumbnail src={photo.url} alt={photo.alt} hoverPreview={false} title={lightboxThumbLabel(n, count, n === current)} onClick={() => onIndex(n)} />
                </li>
              ))}
            </ol>
          )}
          <span className="grow" />
          <span className="nds-lightbox-count" aria-live="polite">{lightboxCounter(current, count)}</span>
          <span className="nds-lightbox-keys" aria-hidden>
            <Kbd>←</Kbd><Kbd>→</Kbd> move · <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </Modal>
  )
}
