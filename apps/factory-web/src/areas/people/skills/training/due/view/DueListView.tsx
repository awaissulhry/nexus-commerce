'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { CourseRef, DueView } from '../../api'
import { DUE_VIEWS } from '../../constants'
import { courseName } from '../../model'
import { PDF_NAMESPACES } from '../../certificate/view/CertificateView'
import { Law, useTrainingWords } from '../../view/parts'
import { LAWS } from '../../constants'

/** The due list window's view model (design people.skills tab:due-pdf "For the RSPP or training provider"). */
export interface DueListModel {
  allowed: boolean
  language: 'it' | 'en'
  view: DueView
  courseId: string | null
  /** The courses to narrow the list to (the catalogue's). */
  courses: readonly CourseRef[]
  /** The company and site the list covers, in words. */
  scope: string
  pdf: Uint8Array | null
  problem: string | null
}

export interface DueListActions {
  onTerms?: (change: Partial<Pick<DueListModel, 'language' | 'view' | 'courseId'>>) => void
  onRetry?: () => void
}

/**
 * Training due list (PDF) — the list the API makes for the RSPP or the training provider (GET /safety/training/due/pdf;
 * made now, stored nowhere), as filtered here: which rows (due and overdue, overdue, due in 60 days, language not checked,
 * all), one course or every course, Italian or English; printable. A legal register (art. 37) names people: it is opened
 * by the roles that keep it and never leaves as a file of ours.
 */
export function DueListView({ model, actions }: { model: DueListModel; actions?: DueListActions }) {
  return (
    <WithMessages namespaces={PDF_NAMESPACES}>
      <DueList model={model} actions={actions} />
    </WithMessages>
  )
}

function DueList({ model, actions }: { model: DueListModel; actions?: DueListActions | undefined }) {
  const t = useTrainingWords()
  const shell = useT('shell')
  const locale = useLocale()
  if (!model.allowed) return <EmptyState title={t('access.title')} description={t('access.body')} />
  const title = t('due.title')
  return (
    <div className="fw-tr-pdf">
      <div className="fw-tr-band fw-tr-noprint">
        <span className="fw-tr-stack">
          <h1>{title}</h1>
          <span className="fw-tr-muted">{model.scope}</span>
        </span>
        <span className="fw-tr-row">
          <SegmentedControl size="sm" ariaLabel={t('due.rows')} value={model.view} onChange={(value) => actions?.onTerms?.({ view: value as DueView })} options={DUE_VIEWS.map((view) => ({ value: view, label: t(`due.view.${view}`) }))} />
          <Select size="sm" aria-label={t('due.course')} value={model.courseId ?? ''} onChange={(event) => actions?.onTerms?.({ courseId: event.target.value || null })}>
            <option value="">{t('due.allCourses')}</option>
            {model.courses.map((course) => (
              <option key={course.id} value={course.id}>
                {courseName(course, locale)}
              </option>
            ))}
          </Select>
          <SegmentedControl
            size="sm"
            ariaLabel={t('pdf.language')}
            value={model.language}
            onChange={(value) => actions?.onTerms?.({ language: value === 'en' ? 'en' : 'it' })}
            options={[
              { value: 'it', label: t('pdf.it') },
              { value: 'en', label: t('pdf.en') },
            ]}
          />
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('pdf.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('pdf.print')}
          </Button>
        </span>
      </div>
      <p className="fw-tr-muted fw-tr-noprint">
        {t('due.preview')} <Law law={LAWS.training} plain="law.training" />
      </p>
      {model.problem ? (
        <Banner
          tone="danger"
          title={t(model.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
      ) : (
        <p className="fw-tr-muted" role="status">
          <Spinner size={14} /> {t('pdf.loading')}
        </p>
      )}
    </div>
  )
}
