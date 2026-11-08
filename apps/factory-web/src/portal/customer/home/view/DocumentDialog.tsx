'use client'

import { useEffect } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import type { DocumentRow } from '../model'
import { useHomeWords } from '../words'

/**
 * pop:document-preview (design portal.customer.home › New documents): the document in the PdfViewer (a picture as it is),
 * Download (logged, like every open), and its versions ("v3 replaced v2 on 12 Oct"). J / K move to the next or previous new
 * document; PageUp / PageDown turn the viewer's pages; Esc closes.
 */

export interface DocumentDialogModel {
  row: DocumentRow
  state: 'loading' | 'error' | 'ready'
  /** The bytes as read (a PDF), or a picture's address. */
  src: Uint8Array | string | null
  pdf: boolean
  versions: readonly { id: string; version: number; previous: number | null; date: string; current: boolean }[]
  /** A withdrawn version: what replaces it (words). */
  withdrawn: { title: string; version: number } | null
  position: { index: number; count: number } | null
  /** Download runs (held with the reason) or a refusal in words. */
  downloading: boolean
  problem: string | null
}

export interface DocumentActions {
  onClose?: () => void
  onRetry?: () => void
  onDownload?: () => void
  onStep?: (step: 1 | -1) => void
}

export function DocumentDialog({ model, actions }: { model: DocumentDialogModel; actions?: DocumentActions }) {
  const { t, day } = useHomeWords()
  const shell = useT('shell')
  // J / K: the next or previous new document (not while typing), wherever the focus is in the pop-up.
  const step = actions?.onStep
  const canStep = model.position !== null
  useEffect(() => {
    if (!canStep) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select')) return
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault()
        step?.(1)
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        step?.(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canStep, step])
  const nav = model.position ? (
    <span className="fw-pch-nav">
      <Button size="sm" variant="quiet" aria-label={t('doc.previous')} heldReason={model.position.index <= 1 ? t('doc.atFirst') : null} onClick={() => actions?.onStep?.(-1)}>
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <span className="fw-pch-sub">{t('doc.of', { index: model.position.index, count: model.position.count })}</span>
      <Button size="sm" variant="quiet" aria-label={t('doc.next')} heldReason={model.position.index >= model.position.count ? t('doc.atLast') : null} onClick={() => actions?.onStep?.(1)}>
        <ChevronRight size={16} aria-hidden />
      </Button>
    </span>
  ) : null
  return (
    <Modal
      open
      sheet
      size="xl"
      onClose={() => actions?.onClose?.()}
      initialFocus="dialog"
      title={model.row.title}
      subtitle={[model.row.forWords ? t(model.row.forWords.key, model.row.forWords.params) : null, day(model.row.date), t('documents.version', { version: model.row.version })].filter(Boolean).join(' · ')}
      headerActions={nav}
      footer={
        // The PDF viewer has its own Download (the same logged one); a picture or a file without a preview needs this one.
        model.state === 'ready' && model.pdf && model.src instanceof Uint8Array ? undefined : (
          <Button variant="primary" heldReason={model.downloading ? t('documents.opening') : null} onClick={() => actions?.onDownload?.()}>
            <Download size={16} aria-hidden /> {t('documents.download')}
          </Button>
        )
      }
    >
      <div className="fw-pch-dialog">
        {model.problem ? <Banner tone="warning" title={model.problem} /> : null}
        {model.withdrawn ? <Banner tone="info" title={t('documents.withdrawn', { title: model.withdrawn.title, version: model.withdrawn.version })} /> : null}
        {model.state === 'loading' ? (
          <div className="fw-pch-stack" role="status" aria-label={t('doc.loading')}>
            <Skeleton height={420} />
          </div>
        ) : model.state === 'error' ? (
          <div className="fw-pstate" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{t('doc.failed')}</span>
            {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : model.pdf && model.src instanceof Uint8Array ? (
          <PdfViewer src={model.src} title={model.row.title} fileName={model.row.fileName} onDownload={() => actions?.onDownload?.()} labels={pdfViewerLabels(shell)} height="min(64vh, 720px)" />
        ) : typeof model.src === 'string' ? (
          <img className="fw-pch-askimg" src={model.src} alt={model.row.title} />
        ) : (
          <p className="fw-pch-sub">{t('doc.noPreview')}</p>
        )}
        {model.versions.length > 0 ? (
          <section className="fw-pch-dsection" aria-labelledby="fw-pch-doc-versions">
            <h3 id="fw-pch-doc-versions" className="fw-pch-dtitle">
              {t('doc.versions')}
            </h3>
            <ul className="fw-pch-versions">
              {model.versions.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.previous !== null ? t('doc.replaced', { version: entry.version, previous: entry.previous, date: day(entry.date) }) : t('doc.first', { version: entry.version, date: day(entry.date) })}</span>
                  {entry.current ? <Pill tone="success">{t('doc.current')}</Pill> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}
