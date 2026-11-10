'use client'

import { useMemo } from 'react'
import { FileWarning } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import type { Read } from '../../../../../quality/_shared/model'
import { NoAccess } from '../../../../../quality/_shared/parts'
import { RegisterMessages } from '../../../view/parts'
import type { AuthorityNotice } from '../../api'
import { NoticeStatus, NS } from '../../view/parts'

/**
 * SCR-329 — Authority notice (PDF) (design compliance.register › tab:rg-notice-pdf, W2b; "Draft to submit on the
 * authority's site"): a window page with the notice as the authority's paper in the language chosen (every language of
 * the notice one choice away), the DS PdfViewer with its download, and what the paper is (a DRAFT says so: a person
 * submits it and marks it as sent). Fetches nothing: NoticePdfWindow.tsx reads the notice and the PDF's bytes.
 */
export interface NoticePdfModel {
  readonly allowed: boolean
  readonly notice: Read<AuthorityNotice>
  readonly language: string | null
  readonly pdf: Read<Uint8Array> | null
}

export interface NoticePdfActions {
  onLanguage?(language: string): void
  onRetry?(): void
}

export function NoticePdfView({ model, actions }: { model: NoticePdfModel; actions?: NoticePdfActions }) {
  return (
    <RegisterMessages>
      <NoticePdf model={model} actions={actions} />
    </RegisterMessages>
  )
}

function NoticePdf({ model, actions }: { model: NoticePdfModel; actions?: NoticePdfActions }) {
  const d = useT(NS)
  const q = useT('quality')
  const shell = useT('shell')
  const locale = useLocale()
  const labels = useMemo(() => pdfViewerLabels(shell), [shell])
  if (!model.allowed) return <NoAccess title={d('pdf.noAccessTitle')} body={d('pdf.noAccessBody')} />
  const notice = model.notice.value
  if (model.notice.problem && !notice)
    return (
      <Card padded>
        <EmptyState
          icon={<FileWarning size={24} aria-hidden />}
          title={d('pdf.failed')}
          description={q(model.notice.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {q('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  if (!notice)
    return (
      <div className="fw-rgd-window" aria-busy="true">
        <Skeleton width="40%" height={24} />
        <Skeleton height={480} />
      </div>
    )
  const languages = Object.keys(notice.words)
  const shown = model.language ?? languages[0] ?? ''
  return (
    <div className="fw-rgd-window">
      <div className="fw-rgd-window-head">
        <h1 className="fw-rgd-h1">{d('pdf.title', { authority: notice.authorityName, reference: notice.entry.reference })}</h1>
        <NoticeStatus notice={notice} />
        {languages.length > 1 && <SegmentedControl ariaLabel={d('notice.language')} size="sm" options={languages.map((code) => ({ value: code, label: code.toUpperCase() }))} value={shown} onChange={(next) => actions?.onLanguage?.(next)} />}
      </div>
      {notice.status === 'DRAFT' ? (
        <Banner tone="warning" title={d('pdf.draft')}>
          {d('pdf.draftBody')}
        </Banner>
      ) : notice.status === 'SENT' ? (
        <Banner tone="success" title={d('pdf.sent', { date: notice.sentAt ? formatDateTime(notice.sentAt, { locale }) : '—', reference: notice.reference ?? '—' })} />
      ) : (
        <Banner tone="neutral" title={d('pdf.cancelled')} />
      )}
      {model.pdf?.value ? (
        <PdfViewer src={model.pdf.value} title={d('notice.pdfTitle', { reference: notice.entry.reference, language: shown.toUpperCase() })} labels={labels} height="calc(100vh - 220px)" />
      ) : model.pdf?.problem ? (
        <Card padded>
          <EmptyState
            title={d('notice.pdfFailed')}
            description={q(model.pdf.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {q('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Skeleton height={480} />
      )}
    </div>
  )
}
