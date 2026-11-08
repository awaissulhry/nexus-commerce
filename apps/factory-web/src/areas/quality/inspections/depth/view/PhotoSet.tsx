'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { Section } from '../../../_shared/parts'
import type { Read } from '../../../_shared/model'
import type { Sheet } from '../api'
import { labelIn, photoSlots, type PhotoSlot } from '../model'
import { useDepthT } from '../parts'

const STATE_TONE = { TAKEN: 'success', MISSING: 'danger', NOT_APPLICABLE: 'neutral', OPEN: 'info' } as const

/** One photo of the set full size, Previous / Next over the set (held at the ends with the reason), ← →, Esc closes. */
export function PhotoViewer({ photos, openId, onOpen }: { photos: readonly { id: string; src: string | null; label: string }[]; openId: string | null; onOpen: (id: string | null) => void }) {
  const td = useDepthT()
  const at = photos.findIndex((photo) => photo.id === openId)
  const photo = at >= 0 ? photos[at]! : null
  const body = useRef<HTMLDivElement>(null)
  const latest = useRef({ at, photos, onOpen })
  useEffect(() => {
    latest.current = { at, photos, onOpen }
  })
  useEffect(() => {
    if (!photo) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      const dialog = body.current?.closest('[role="dialog"]')
      if (!dialog || !document.activeElement || !dialog.contains(document.activeElement)) return
      const { at: index, photos: list, onOpen: open } = latest.current
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= list.length) return
      event.preventDefault()
      open(list[next]!.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [photo])
  if (!photo) return null
  const firstHeld = at === 0 ? td(photos.length === 1 ? 'photos.only' : 'photos.first') : null
  const lastHeld = at === photos.length - 1 ? td(photos.length === 1 ? 'photos.only' : 'photos.last') : null
  return (
    <Modal
      open
      onClose={() => onOpen(null)}
      title={photo.label}
      subtitle={td('photos.count', { n: at + 1, count: photos.length })}
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpen(photos[at - 1]?.id ?? photo.id)} heldReason={firstHeld}>
            <ChevronLeft size={16} aria-hidden /> {td('photos.previous')}
          </Button>
          <span className="grow" />
          <Button onClick={() => onOpen(photos[at + 1]?.id ?? photo.id)} heldReason={lastHeld}>
            {td('photos.next')} <ChevronRight size={16} aria-hidden />
          </Button>
        </>
      }
    >
      <div ref={body} className="fw-qd-photo-full">
        {photo.src ? <img src={photo.src} alt={photo.label} /> : <p className="fw-q-hint" role="status">{td('photos.loading')}</p>}
      </div>
    </Modal>
  )
}

/**
 * Inspection › Defects & photos › Required photo set (design ins-photos, QHS-054 on B-W2b-97's sheet): the plan's photo slots
 * — Front ✓ · Back ✓ · Label ✕ missing — each with its state in words and the photos the bench took (a photo waiting for the
 * virus check is counted, not shown); a missing required photo holds "Sign result" (said with the sign reasons). A photo
 * opens full size with Previous / Next. W1's checklist and a plan without photo checks ask for none.
 */
export function PhotoSet({ sheet, photoSrc }: { sheet: Read<Sheet> | null; photoSrc: Readonly<Record<string, string>> }) {
  const td = useDepthT()
  const locale = useLocale()
  const [openId, setOpenId] = useState<string | null>(null)
  if (!sheet) {
    return (
      <Section id="photo-set" title={td('photos.heading')}>
        <p className="fw-q-hint">{td('photos.w1')}</p>
      </Section>
    )
  }
  if (!sheet.value) {
    return (
      <Section id="photo-set" title={td('photos.heading')}>
        {sheet.problem ? <p className="fw-q-hint">{td('checks.failed')}</p> : <Skeleton width="100%" height={96} />}
      </Section>
    )
  }
  const slots = photoSlots(sheet.value)
  const missing = slots.filter((slot) => slot.state === 'MISSING').length
  const all = slots.flatMap((slot: PhotoSlot) => slot.fileIds.map((id, index) => ({ id, src: photoSrc[id] ?? null, label: td('photos.photoOf', { slot: labelIn(slot, locale), n: index + 1 }) })))
  return (
    <Section id="photo-set" title={td('photos.heading')} sub={slots.length > 0 ? td('photos.summary', { taken: slots.filter((slot) => slot.state === 'TAKEN').length, total: slots.length, missing }) : undefined}>
      {slots.length === 0 ? (
        <EmptyState title={td('photos.empty')} />
      ) : (
        <ul className="fw-qd-slots">
          {slots.map((slot) => (
            <li key={slot.code} className="fw-qd-slot">
              <span className="fw-q-cell-row">
                <strong>{labelIn(slot, locale)}</strong>
                <Tag tone={STATE_TONE[slot.state]}>{td(`photos.state.${slot.state}`)}</Tag>
                {slot.mandatory && <span className="fw-q-hint">{td('photos.required')}</span>}
              </span>
              {slot.fileIds.length > 0 && (
                <span className="fw-qd-thumbs">
                  {slot.fileIds.map((fileId, index) => (
                    <button key={fileId} type="button" className="fw-qd-thumb" onClick={() => setOpenId(fileId)} aria-label={td('photos.open', { slot: labelIn(slot, locale), n: index + 1 })}>
                      {photoSrc[fileId] ? <img src={photoSrc[fileId]} alt="" /> : <span className="fw-q-hint">{index + 1}</span>}
                    </button>
                  ))}
                </span>
              )}
              {slot.quarantined > 0 && <span className="fw-q-hint">{td('photos.quarantined', { count: slot.quarantined })}</span>}
            </li>
          ))}
        </ul>
      )}
      {missing > 0 && <p className="fw-q-hint">{td('photos.holds')}</p>}
      <PhotoViewer photos={all} openId={openId} onOpen={setOpenId} />
    </Section>
  )
}
