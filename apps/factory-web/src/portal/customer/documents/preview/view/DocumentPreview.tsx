'use client'

import { useEffect } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Download, Lock } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { languageWords, PREVIEW_NS, type PreviewRow, type VersionLine } from '../model'
import '../preview.css'

/**
 * The document pop-up (design portal.customer.documents pop:preview "PdfViewer · versions · Download" and portal.customer.home
 * pop:document-preview; lifted from Home by B-W2b-195): the document in the DS PdfViewer (a picture as it is; anything else
 * "download it"), its fixed version with the fingerprint, Download (logged, like every open; the viewer has its own), and
 * its versions ("v3 replaced v2 on 12 Oct", newest first; an earlier one opens from there). A withdrawn version names the
 * one that replaces it. J / K move to the next or previous document of the page's list; PageUp / PageDown turn the viewer's
 * pages; Esc closes.
 */

export interface DocumentPreviewModel {
  row: PreviewRow
  state: 'loading' | 'error' | 'ready' | 'withdrawn' | 'held'
  /** The bytes as read (a PDF), or a picture's address. */
  src: Uint8Array | string | null
  pdf: boolean
  versions: readonly VersionLine[]
  /** A withdrawn version: what replaces it (its id when the person may open it). */
  withdrawn: { id: string | null; title: string; version: number } | null
  position: { index: number; count: number } | null
  /** Download runs (held with the reason). */
  downloading: boolean
  /** A refused open, a key of `portal-documents`. */
  problem: { key: string; params?: Readonly<Record<string, string | number>> } | null
  /** Why nothing may be opened now (a preview, no connection), in words. */
  held: string | null
}

export interface DocumentPreviewActions {
  onClose?: () => void
  onRetry?: () => void
  onDownload?: () => void
  onStep?: (step: 1 | -1) => void
  /** Opens another version of the document (from its versions, or the one that replaced a withdrawn version). */
  onVersion?: (id: string) => void
}

export function DocumentPreview(props: { model: DocumentPreviewModel; actions?: DocumentPreviewActions }) {
  return (
    <WithMessages namespaces={[PREVIEW_NS, 'shell', 'ds-words']}>
      <PreviewDialog {...props} />
    </WithMessages>
  )
}

/** A calendar day or an instant, written as a day in the page's language. */
const dayOf = (locale: 'it' | 'en', iso: string) => formatDate(iso.length === 10 ? `${iso}T12:00:00Z` : iso, { locale, ...(iso.length === 10 ? { timeZone: 'UTC' } : {}) })

function PreviewDialog({ model, actions }: { model: DocumentPreviewModel; actions?: DocumentPreviewActions }) {
  const t = useT(PREVIEW_NS)
  const shell = useT('shell')
  const locale = useLocale()
  const day = (iso: string) => dayOf(locale, iso)
  const { row } = model
  // J / K: the next or previous document (not while typing), wherever the focus is in the pop-up.
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
    <span className="fw-pdp-nav">
      <Button size="sm" variant="quiet" aria-label={t('preview.previous')} heldReason={model.position.index <= 1 ? t('preview.atFirst') : null} onClick={() => actions?.onStep?.(-1)}>
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <span className="fw-pdp-sub">{t('preview.of', { index: model.position.index, count: model.position.count })}</span>
      <Button size="sm" variant="quiet" aria-label={t('preview.next')} heldReason={model.position.index >= model.position.count ? t('preview.atLast') : null} onClick={() => actions?.onStep?.(1)}>
        <ChevronRight size={16} aria-hidden />
      </Button>
    </span>
  ) : null
  const subtitle = [
    row.forOrder ? t('preview.forOrder', { number: row.forOrder }) : row.forLabel ? t('preview.for', { label: row.forLabel }) : null,
    day(row.date),
    t('preview.version', { version: row.version, fingerprint: row.fingerprint }),
    row.language ? languageWords(t, row.language) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const viewer = model.state === 'ready' && model.pdf && model.src instanceof Uint8Array
  const downloadHeld = model.held ?? (model.downloading ? t('preview.opening') : model.state === 'withdrawn' ? t('preview.withdrawnHeld') : null)

  return (
    <Modal
      open
      sheet
      size="xl"
      onClose={() => actions?.onClose?.()}
      initialFocus="dialog"
      title={row.title}
      subtitle={subtitle}
      headerActions={nav}
      footer={
        // The PDF viewer has its own Download (the same logged one); a picture or a file without a preview needs this one.
        viewer ? undefined : (
          <Button variant="primary" heldReason={downloadHeld} onClick={() => actions?.onDownload?.()}>
            <Download size={16} aria-hidden /> {t('preview.download')}
          </Button>
        )
      }
    >
      <div className="fw-pdp">
        {model.problem ? <Banner tone="warning" title={t(model.problem.key, model.problem.params)} /> : null}
        {!row.current && row.replacedBy ? (
          <Banner
            tone="info"
            title={t('preview.earlier', { version: row.version, newer: row.replacedBy.version })}
            action={row.replacedBy.id ? <Button size="sm" onClick={() => actions?.onVersion?.(row.replacedBy!.id!)}>{t('preview.openVersion', { version: row.replacedBy.version })}</Button> : undefined}
          />
        ) : null}
        {model.state === 'withdrawn' || model.withdrawn ? (
          <Banner
            tone="info"
            title={model.withdrawn ? t('preview.withdrawn', { title: model.withdrawn.title, version: model.withdrawn.version }) : t('preview.withdrawnAsk')}
            action={model.withdrawn?.id ? <Button size="sm" onClick={() => actions?.onVersion?.(model.withdrawn!.id!)}>{t('preview.openVersion', { version: model.withdrawn.version })}</Button> : undefined}
          />
        ) : null}
        {model.state === 'loading' ? (
          <div className="fw-pdp-stack" role="status" aria-label={t('preview.loading')}>
            <Skeleton height={420} />
          </div>
        ) : model.state === 'held' ? (
          <div className="fw-pdp-state" role="note">
            <Lock size={18} aria-hidden />
            <span>{model.held ?? t('preview.failed')}</span>
          </div>
        ) : model.state === 'error' ? (
          <div className="fw-pdp-state" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{t('preview.failed')}</span>
            {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : model.state === 'withdrawn' ? null : viewer ? (
          <PdfViewer src={model.src as Uint8Array} title={row.title} fileName={row.fileName} onDownload={() => actions?.onDownload?.()} labels={pdfViewerLabels(shell)} height="min(64vh, 720px)" />
        ) : typeof model.src === 'string' ? (
          <img className="fw-pdp-image" src={model.src} alt={row.title} />
        ) : (
          <p className="fw-pdp-sub">{t('preview.noPreview')}</p>
        )}
        {model.versions.length > 0 ? (
          <section className="fw-pdp-section" aria-labelledby="fw-pdp-versions">
            <h3 id="fw-pdp-versions" className="fw-pdp-title">
              {t('preview.versions')}
            </h3>
            <ul className="fw-pdp-versions">
              {model.versions.map((entry) => {
                const words = entry.previous !== null ? t('preview.replaced', { version: entry.version, previous: entry.previous, date: day(entry.date) }) : t('preview.first', { version: entry.version, date: day(entry.date) })
                return (
                  <li key={entry.id}>
                    {entry.id === row.id ? (
                      <span aria-current="true" className="fw-pdp-shown">
                        {words}
                      </span>
                    ) : (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onVersion?.(entry.id)} aria-label={t('preview.openVersion', { version: entry.version })}>
                        {words}
                      </Button>
                    )}
                    {entry.current ? <Pill tone="success">{t('preview.current')}</Pill> : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}
