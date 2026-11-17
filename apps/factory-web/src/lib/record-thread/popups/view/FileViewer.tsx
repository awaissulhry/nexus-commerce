'use client'

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, Lock, MessageSquare } from 'lucide-react'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Lightbox, Modal } from '../../../i18n/ds-parts'
import { formatNumber } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { pdfViewerLabels } from '../../../pdf/labels'
import { WithMessages } from '../../../../record-panels/i18n'
import { cardWordKey, heldWordKey, photoRun, viewerList, viewerShow, walk, type ViewerFile } from '../model'
import '../popups.css'

export const POPUPS_NS = 'record-thread-popups'

export interface FileViewerProps {
  /** Every file of the place it was opened from; the viewer walks those the reader may open. */
  files: readonly ViewerFile[]
  /** The file shown: its place in `viewerList(files).items`. */
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  /** "Go to message" (the file came with a message of the thread). */
  onGoToMessage?: (messageId: string) => void
  /** Where the focus goes on close (the picture that opened it); default what had it when it opened. */
  returnFocusTo?: HTMLElement | null
}

/**
 * The thread's ONE file viewer (B-TH-211, T-POP-F01): centred, ← / → walk the files, photos through the DS Lightbox, PDF
 * pages through the DS PdfViewer, a card with a real Download link for a file it cannot draw (HEIC, an Office file, a voice
 * note), a held file with its lock and reason and no download, "Go to message". Files the reader may not open are counted,
 * never listed. A factory wrapper over the DS Lightbox until the Owner's word on the Lightbox change (DS gate 2): the
 * Lightbox walks the photos; a PDF or a card opens in the DS Modal with the same keys. Esc closes; focus returns.
 */
export function FileViewer(props: FileViewerProps) {
  return (
    <WithMessages namespaces={[POPUPS_NS, 'shell']}>
      <Viewer {...props} />
    </WithMessages>
  )
}

function Viewer({ files, index, onIndex, onClose, onGoToMessage, returnFocusTo }: FileViewerProps) {
  const t = useT(POPUPS_NS)
  const shellT = useT('shell')
  const locale = useLocale()
  const { items, cannotOpen } = viewerList(files)
  const current = items[Math.max(0, Math.min(items.length - 1, index))]
  const at = current ? items.indexOf(current) : 0
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ at, count: items.length, onIndex })
  useEffect(() => {
    latest.current = { at, count: items.length, onIndex }
  })
  const show = current ? viewerShow(current) : 'card'
  const photoReady = show === 'photo' && typeof current?.src === 'string'

  // ← / → walk every file while the focus is in this window (the Lightbox has its own keys for its photos).
  useEffect(() => {
    if (!current || photoReady) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active) || active.closest('input, textarea, select, canvas, audio, video')) return
      const next = walk(latest.current.at, latest.current.count, event.key === 'ArrowLeft' ? -1 : 1)
      event.preventDefault()
      if (next !== null) latest.current.onIndex(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [current, photoReady])

  if (!current) return null
  const counter = t('viewer.counter', { n: at + 1, count: items.length })
  const size = sizeWords(current.sizeBytes, locale)
  const kind = t(`kind.${current.kind}`)
  const goToMessage = current.messageId && onGoToMessage ? () => onGoToMessage(current.messageId!) : null
  const download = <DownloadLink file={current} t={t} />
  const notOpen = cannotOpen > 0 ? <span className="fw-rtp-muted">{t('viewer.cannotOpen', { count: cannotOpen })}</span> : null

  if (photoReady) {
    const { photos, at: photoAt } = photoRun(items, at)
    return (
      <Lightbox
        open
        onClose={onClose}
        items={photos.map((photo) => ({ url: typeof photo.src === 'string' ? photo.src : '', alt: photo.name }))}
        index={photoAt}
        onIndex={(n) => {
          const photo = photos[n]
          if (photo) onIndex(items.indexOf(photo))
        }}
        title={current.name}
        meta={`${counter} · ${kind}${current.versionNo && current.versionNo > 1 ? ` · v${current.versionNo}` : ''} · ${size}`}
        returnFocusTo={returnFocusTo ?? undefined}
        caption={
          <span className="fw-rtp-actions">
            {download}
            {goToMessage && (
              <Button size="sm" variant="quiet" onClick={goToMessage}>
                <MessageSquare size={14} aria-hidden /> {t('viewer.goToMessage')}
              </Button>
            )}
            {notOpen}
          </span>
        }
      />
    )
  }

  const prevHeld = at === 0 ? t('viewer.first') : null
  const nextHeld = at >= items.length - 1 ? t('viewer.last') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={current.name}
      subtitle={`${counter} · ${kind}${current.versionNo && current.versionNo > 1 ? ` · v${current.versionNo}` : ''} · ${size}`}
      returnFocusTo={returnFocusTo ?? undefined}
      footer={
        <div className="fw-rtp-viewer-foot">
          {items.length > 1 && (
            <span className="fw-rtp-walk">
              <Button size="sm" aria-label={t('viewer.previous')} aria-keyshortcuts="ArrowLeft" heldReason={prevHeld} onClick={() => onIndex(at - 1)}>
                <ChevronLeft size={16} aria-hidden />
              </Button>
              <Button size="sm" aria-label={t('viewer.next')} aria-keyshortcuts="ArrowRight" heldReason={nextHeld} onClick={() => onIndex(at + 1)}>
                <ChevronRight size={16} aria-hidden />
              </Button>
            </span>
          )}
          {notOpen}
          <span className="fw-rtp-grow" />
          {goToMessage && (
            <Button size="sm" variant="quiet" onClick={goToMessage}>
              <MessageSquare size={14} aria-hidden /> {t('viewer.goToMessage')}
            </Button>
          )}
          {show !== 'held' && download}
        </div>
      }
    >
      <div ref={bodyRef} className="fw-rtp-viewer">
        {show === 'held' ? (
          <div className="fw-rtp-card" role="status">
            <span className="fw-rtp-card-icon is-held" aria-hidden>
              <Lock size={22} />
            </span>
            <p className="fw-rtp-card-title">{t('viewer.held.title')}</p>
            <p className="fw-rtp-muted">{t(heldWordKey(current.quarantineReason))}</p>
          </div>
        ) : show === 'card' ? (
          <div className="fw-rtp-card">
            <span className="fw-rtp-card-icon" aria-hidden>
              <FileText size={22} />
            </span>
            <p className="fw-rtp-card-title">{current.name}</p>
            <p className="fw-rtp-muted">{t(cardWordKey(current))}</p>
          </div>
        ) : current.src === null || show !== 'pdf' ? (
          <p className="fw-rtp-loading" role="status">
            <Spinner size={14} /> {t('viewer.opening')}
          </p>
        ) : (
          <PdfViewer src={current.src} title={current.name} fileName={current.name} labels={pdfViewerLabels(shellT)} height="min(68vh, 760px)" />
        )}
      </div>
    </Modal>
  )
}

/** A real link to the file (no blob, no script): ⌘-click and "Save link as" work. Held while the address is fetched. */
function DownloadLink({ file, t }: { file: ViewerFile; t: (key: string, params?: Record<string, string | number>) => string }) {
  if (!file.downloadHref) {
    return (
      <Button size="sm" heldReason={t('viewer.preparing')}>
        <Download size={14} aria-hidden /> {t('viewer.download')}
      </Button>
    )
  }
  return (
    <Button size="sm" asChild>
      <a href={file.downloadHref} download={file.name} rel="noopener noreferrer">
        <Download size={14} aria-hidden /> {t('viewer.download')}
      </a>
    </Button>
  )
}

/** "2.4 MB", "640 KB", in the page's language. */
export function sizeWords(bytes: number, locale: 'it' | 'en'): string {
  if (bytes >= 1_048_576) return `${formatNumber(Math.round((bytes / 1_048_576) * 10) / 10, locale)} MB`
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`
}
