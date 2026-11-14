'use client'

import { CircleCheck, FileText, Printer, TriangleAlert } from 'lucide-react'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { FloorButton } from '@nexus/ui/floor'
import type { Translate } from '../../../../../lib/i18n/messages'
import { TaskLine } from '../../../shared/view/TaskParts'
import type { JobStatus } from '../../api'
import { marksProblemOf, type MarksNote } from '../model'

/**
 * A closed carton's marks (B-W2b-387; LOG-013; design floor.pack "Scan into the carton" LabelPreview): what Close carton
 * did — "Carton 2 of 3 closed · marks sent to the printer", or why they did not print, in words from the problem's code — and
 * a preview of the marks as the floor knows them ("Carton 2 of 3", the style, sizes, garments, batch and the barcode the
 * marks carry, test-scannable off the screen), with the print job's state and its Retry. The marks also print the address
 * and the customer's order: the tablet never shows them, and says so. When they cannot print here: the marks as a PDF.
 */

const STATUS: Readonly<Record<JobStatus, 'queued' | 'sent' | 'printed' | 'failed'>> = { QUEUED: 'queued', SENT: 'sent', PRINTED: 'printed', FAILED: 'failed' }

export interface MarksPreviewFacts {
  readonly code: string
  readonly styles: string
  readonly sizes: string
  readonly garments: number
  readonly batches: string
}

export function MarksResult({
  note,
  facts,
  job,
  t,
  onAgain,
  onPdf,
  held,
}: {
  note: MarksNote
  facts: MarksPreviewFacts | null
  /** The marks' print job as last read, or null (none, or not read). */
  job: JobStatus | null
  t: Translate
  onAgain?: () => void
  onPdf?: () => void
  /** Why printing waits now (no network, a call on its way). */
  held: string | null
}) {
  const failed = !note.printed || job === 'FAILED'
  return (
    <section className="fw-floor-stack" aria-label={t('marks.preview', { n: note.n, of: note.of })}>
      {note.printed ? (
        <TaskLine tone="success" icon={<CircleCheck />}>
          {t('marks.closed', { n: note.n, of: note.of })}
        </TaskLine>
      ) : (
        <TaskLine tone="warning" icon={<TriangleAlert />} alert>
          <strong>{t('marks.closedNot', { n: note.n, of: note.of })}</strong> {t(`marks.problem.${marksProblemOf(note.problem)}`)}
        </TaskLine>
      )}
      {note.overweight ? (
        <TaskLine tone="warning" icon={<TriangleAlert />}>
          {t('marks.overweight')}
        </TaskLine>
      ) : null}
      {facts ? (
        <div className="fw-pack-marks">
          <LabelPreview
            layout={{
              name: t('marks.preview', { n: note.n, of: note.of }),
              widthMm: 100,
              heightMm: 62,
              blocks: [
                { kind: 'title', text: t('marks.label.carton', { n: note.n, of: note.of }), size: 'xl' },
                {
                  kind: 'fields',
                  columns: 2,
                  fields: [
                    { label: t('marks.label.style'), value: facts.styles },
                    { label: t('marks.label.sizes'), value: facts.sizes },
                    { label: t('marks.label.garments'), value: String(facts.garments), size: 'lg' },
                    { label: t('marks.label.batch'), value: facts.batches || '—' },
                  ],
                },
                { kind: 'fill' },
                { kind: 'barcode', value: facts.code, heightMm: 12 },
              ],
            }}
            scale={3}
            codeLabel={(value) => t('marks.barcode', { code: value })}
            print={job ? { status: STATUS[job], label: t(`marks.job.${job}`) } : undefined}
            onRetry={job === 'FAILED' ? onAgain : undefined}
            retryLabel={t('marks.retry')}
            retryHeldReason={held}
          />
          <p className="fw-floor-muted">{t('marks.previewNote')}</p>
        </div>
      ) : null}
      {failed && (onAgain || onPdf) ? (
        <div className="fw-floor-row-actions fw-pack-carton-actions">
          {onPdf ? (
            <FloorButton size="md" variant="secondary" icon={<FileText />} heldReason={held} onClick={onPdf}>
              {t('marks.pdf')}
            </FloorButton>
          ) : null}
          {onAgain && job !== 'FAILED' ? (
            <FloorButton size="md" variant="primary" icon={<Printer />} heldReason={held} onClick={onAgain}>
              {t('marks.again')}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
