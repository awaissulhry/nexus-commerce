'use client'

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../i18n/ds-parts'
import { useT } from '../i18n/provider'
import { pdfViewerLabels } from '../pdf/labels'
import './proof-viewer.css'

/** One proof as the viewer shows it: a picture's address or a PDF's bytes (null while read), `problem` when unreadable. */
export interface ViewerProof {
  id: string
  name: string
  shape: 'PDF' | 'PICTURE'
  versionNo: number
  src: string | Uint8Array | null
  problem: boolean
}

/**
 * The proofs of a quote full size, one at a time (B-W2b-165; SAL-199; design links.quote "Proofs": Lightbox and PdfViewer):
 * a picture as it is, a PDF in the DS PdfViewer, Previous / Next over them in order (held at the ends with the reason,
 * never disabled), ← and → move, Esc closes. The accept link and the quote record's Documents tab share it. Composed of
 * the DS Modal (its words in the page's language) because the DS Lightbox speaks English only and shows pictures only.
 * Words: the `quote-proofs` catalogue (`viewer.*`), which both callers load.
 */
export function ProofViewer({ proofs, openId, onOpen, onRetry }: { proofs: readonly ViewerProof[]; openId: string | null; onOpen: (id: string | null) => void; onRetry?: (id: string) => void }) {
  const t = useT('quote-proofs')
  const shell = useT('shell')
  const at = proofs.findIndex((proof) => proof.id === openId)
  const proof = at >= 0 ? proofs[at]! : null
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ at, proofs, onOpen })
  useEffect(() => {
    latest.current = { at, proofs, onOpen }
  })

  useEffect(() => {
    if (!proof) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      // Only while the focus is in this dialog, never inside a field or the PDF viewer's own page input.
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active) || active.closest('input, textarea, select')) return
      const { at: index, proofs: list, onOpen: open } = latest.current
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= list.length) return
      event.preventDefault()
      open(list[next]!.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [proof])

  if (!proof) return null
  const held = (direction: -1 | 1): string | null => {
    const next = at + direction
    if (next >= 0 && next < proofs.length) return null
    if (proofs.length <= 1) return t('viewer.only')
    return t(direction < 0 ? 'viewer.first' : 'viewer.last')
  }
  const title = t('viewer.title', { name: proof.name, n: proof.versionNo })
  return (
    <Modal
      open
      onClose={() => onOpen(null)}
      size="xl"
      title={title}
      subtitle={t('viewer.count', { n: at + 1, count: proofs.length })}
      initialFocus="dialog"
      footer={
        proofs.length > 1 ? (
          <>
            <Button aria-keyshortcuts="ArrowLeft" heldReason={held(-1)} onClick={() => onOpen(proofs[at - 1]!.id)}>
              <ChevronLeft size={16} aria-hidden /> {t('viewer.previous')}
            </Button>
            <Button aria-keyshortcuts="ArrowRight" heldReason={held(1)} onClick={() => onOpen(proofs[at + 1]!.id)}>
              {t('viewer.next')} <ChevronRight size={16} aria-hidden />
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="fw-pv-body" ref={bodyRef}>
        {proof.problem ? (
          <Banner tone="warning" title={t('viewer.problem')} action={onRetry ? <Button size="sm" onClick={() => onRetry(proof.id)}>{t('viewer.retry')}</Button> : undefined} />
        ) : proof.src === null ? (
          <p className="fw-pv-hint" role="status">
            <Spinner size={14} /> {t('viewer.loading')}
          </p>
        ) : proof.shape === 'PDF' ? (
          <PdfViewer src={proof.src} title={title} fileName={proof.name} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
        ) : (
          // A picture's address (data: or the store's presigned GET): shown whole, never cropped.
          <img className="fw-pv-picture" src={typeof proof.src === 'string' ? proof.src : undefined} alt={t('viewer.picture', { name: proof.name, n: proof.versionNo })} />
        )}
      </div>
    </Modal>
  )
}
