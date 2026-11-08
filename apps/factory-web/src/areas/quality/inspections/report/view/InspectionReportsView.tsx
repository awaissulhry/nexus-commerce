'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { DepthMessages, useDepthT } from '../../depth/parts'

/** One report of the bulk print: its number once read, its PDF, or why it could not be made. */
export interface BulkReport {
  readonly id: string
  readonly number: string | null
  readonly pdf: Uint8Array | null
  readonly problem: string | null
}

/** SCR-076-reports — the bulk print window's view model ("Print 6 reports", a new tab from the list's selection). */
export interface ReportsModel {
  readonly allowed: boolean
  readonly language: 'it' | 'en'
  readonly reports: readonly BulkReport[]
}

/**
 * The selection's reports one after the other (design qi-grid selection row "Print 6 reports" (W2b), on B-W2b-123's report:
 * no bulk route, one preview per inspection, read one at a time so the machine stays free): each in its DS PdfViewer under
 * its number, a report that could not be made says so in its place; Print all prints the page once every report is read.
 */
export function InspectionReportsView({ model, onLanguage, onRetry }: { model: ReportsModel; onLanguage?: (language: 'it' | 'en') => void; onRetry?: (id: string) => void }) {
  return (
    <DepthMessages>
      <Reports model={model} onLanguage={onLanguage} onRetry={onRetry} />
    </DepthMessages>
  )
}

function Reports({ model, onLanguage, onRetry }: { model: ReportsModel; onLanguage?: (language: 'it' | 'en') => void; onRetry?: (id: string) => void }) {
  const td = useDepthT()
  const t = useT('quality')
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={td('report.noAccess.title')} description={td('report.noAccess.body')} />
  if (model.reports.length === 0) return <EmptyState title={td('bulk.none')} description={td('bulk.noneHint')} />
  const reading = model.reports.filter((entry) => entry.pdf === null && entry.problem === null).length
  return (
    <div className="fw-qd-report">
      <div className="fw-qd-band fw-qd-noprint">
        <span className="fw-q-cell">
          <h1 className="fw-qd-h">{td('bulk.title', { count: model.reports.length })}</h1>
          <span className="fw-q-hint" role="status">
            {reading > 0 ? td('bulk.reading', { count: reading }) : td('report.preview')}
          </span>
        </span>
        <span className="fw-q-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={td('report.language')}
            value={model.language}
            onChange={(value) => onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={[
              { value: 'it', label: td('report.it') },
              { value: 'en', label: td('report.en') },
            ]}
          />
          <Button size="sm" variant="primary" heldReason={reading > 0 ? td('bulk.held.reading', { count: reading }) : null} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {td('bulk.printAll')}
          </Button>
        </span>
      </div>
      {model.reports.map((entry) => {
        const name = entry.number ?? td('bulk.unnamed')
        return (
          <section key={entry.id} className="fw-qd-bulk-item" aria-label={td('report.title', { number: name })}>
            <h2 className="fw-qd-h2">{td('report.title', { number: name })}</h2>
            {entry.problem ? (
              <Banner
                tone="danger"
                title={td('bulk.failed', { number: name })}
                action={
                  <Button size="sm" onClick={() => onRetry?.(entry.id)}>
                    {t('common.retry')}
                  </Button>
                }
              >
                {t(entry.problem)}
              </Banner>
            ) : entry.pdf ? (
              <PdfViewer src={entry.pdf} title={td('report.title', { number: name })} fileName={`${name}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
            ) : (
              <p className="fw-q-hint" role="status">
                <Spinner size={14} /> {td('bulk.readingOne', { number: name })}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
