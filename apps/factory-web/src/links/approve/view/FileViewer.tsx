'use client'

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import type { ApprovalPage } from '../api'
import { filesInOrder, isPdf, isPicture, markable, type ApproveActions, type ApproveViewModel } from '../model'

/**
 * A photo or a document of the request full size (design links.approve "Lightbox", "PdfViewer"), one at a time: a picture
 * as it is, never cropped; a PDF in the DS PdfViewer with its zoom; Previous / Next over the request's files (held at the
 * ends with the reason), ← →, Esc closes and gives the focus back. "Mark the photo" from here too. Composed of the DS
 * Modal (a sheet on a phone; its words in the page's language) because the DS Lightbox speaks English only and shows
 * pictures only.
 */
export function FileViewer({ page, model, actions }: { page: ApprovalPage; model: ApproveViewModel; actions?: ApproveActions }) {
  const t = useT('link-approve')
  const shell = useT('shell')
  const files = filesInOrder(page.files)
  const at = files.findIndex((file) => file.id === model.open)
  const file = at >= 0 ? files[at]! : null
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ at, files, actions })
  useEffect(() => {
    latest.current = { at, files, actions }
  })
  useEffect(() => {
    if (!file) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active) || active.closest('input, textarea, select')) return
      const { at: index, files: list, actions: act } = latest.current
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= list.length) return
      event.preventDefault()
      act?.onOpen?.(list[next]!.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [file])

  if (!file) return null
  const shown = model.files[file.id]
  const held = (direction: -1 | 1): string | null => {
    const next = at + direction
    if (next >= 0 && next < files.length) return null
    return t(files.length <= 1 ? 'viewer.only' : direction < 0 ? 'viewer.first' : 'viewer.last')
  }
  const canMark = markable(file) !== null && page.request.decided === null
  const markHeld = !page.may.answer ? (page.may.held ?? t('decision.held')) : null
  return (
    <Modal
      open
      sheet
      onClose={() => actions?.onOpen?.(null)}
      size="xl"
      title={file.originalName}
      subtitle={t('viewer.count', { n: at + 1, count: files.length })}
      initialFocus="dialog"
      footer={
        <>
          {canMark && (
            <Button heldReason={markHeld} onClick={() => actions?.onMark?.(file.id)} aria-haspopup="dialog">
              <PenLine size={16} aria-hidden /> {t('files.mark')}
            </Button>
          )}
          {files.length > 1 && (
            <>
              <Button aria-keyshortcuts="ArrowLeft" heldReason={held(-1)} onClick={() => actions?.onOpen?.(files[at - 1]!.id)}>
                <ChevronLeft size={16} aria-hidden /> {t('viewer.previous')}
              </Button>
              <Button aria-keyshortcuts="ArrowRight" heldReason={held(1)} onClick={() => actions?.onOpen?.(files[at + 1]!.id)}>
                {t('viewer.next')} <ChevronRight size={16} aria-hidden />
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="fw-ap-viewer" ref={bodyRef}>
        {shown?.problem ? (
          <Banner
            tone="warning"
            title={t('files.problem')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryFile?.(file.id)}>
                {t('retry')}
              </Button>
            }
          />
        ) : !isPicture(file.contentType) && !isPdf(file.contentType) ? (
          <p className="fw-ap-hint">{t('viewer.noPreview')}</p>
        ) : shown?.src == null ? (
          <p className="fw-ap-hint" role="status">
            <Spinner size={14} /> {t('files.loading')}
          </p>
        ) : isPdf(file.contentType) && shown.src instanceof Uint8Array ? (
          <PdfViewer src={shown.src} title={file.originalName} fileName={file.originalName} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
        ) : (
          <img className="fw-ap-picture" src={typeof shown.src === 'string' ? shown.src : undefined} alt={t('viewer.picture', { name: file.originalName })} />
        )}
      </div>
    </Modal>
  )
}
