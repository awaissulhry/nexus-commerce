'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { Words } from '../../model'
import { PieceMessages, said, usePieceWords } from '../../view/parts'

/** SCR-158-statement — the statement tab's view model. */
export interface StatementPdfModel {
  /** people.earnings.records and the pay grain. */
  allowed: boolean
  pdf: Uint8Array | null
  problem: Words | null
}

/**
 * tab:statement-pdf — "Worker statement (PDF)" (design people.piecerates; c.c. art. 2101 c.3): the statement on the company's
 * letterhead in the DS PdfViewer, made by the API from the frozen row. Opening it is recorded; an approved one is stored once.
 */
export function StatementPdfView({ model, onRetry }: { model: StatementPdfModel; onRetry?: () => void }) {
  return (
    <PieceMessages>
      <Page model={model} onRetry={onRetry} />
    </PieceMessages>
  )
}

function Page({ model, onRetry }: { model: StatementPdfModel; onRetry?: (() => void) | undefined }) {
  const t = usePieceWords()
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={t('pay.hiddenTitle')} description={t('pay.hidden')} />
  return (
    <div className="fw-pr8-sheet">
      <div className="fw-pp-head fw-pr8-noprint">
        <h1 className="fw-pr8-h2">{t('pdf.title')}</h1>
        <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('pdf.held')} onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('sheet.print')}
        </Button>
      </div>
      <p className="fw-pr8-hint fw-pr8-noprint">{t('pdf.recorded')}</p>
      {model.problem ? (
        <Banner
          tone="danger"
          title={said(t, model.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={t('pdf.title')} fileName={`${t('pdf.title')}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
      ) : (
        <p className="fw-pr8-hint" role="status">
          <Spinner size={12} /> {t('common.reading')}
        </p>
      )}
    </div>
  )
}
