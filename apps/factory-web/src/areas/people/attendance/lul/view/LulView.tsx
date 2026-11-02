'use client'

import { Download } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { LUL_TO_CONFIRM } from '@nexus/factory-domain/people/close/lul'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { TIME_ZONE } from '../../../_shared/model'
import type { CloseMonth, LulOpened } from '../../api'
import { monthWords, type AttendanceCan } from '../../model'
import { AttendanceMessages, GateHeld, useAttendanceWords } from '../../view/parts'

/** SCR-157-lul — one view model, nothing fetched. */
export interface LulModel {
  /** people.attendance.lul. */
  allowed: boolean
  closeId: string
  can: AttendanceCan
  prefix: string
  gateShut: boolean
  opened: LulOpened | null
  src: string | Uint8Array | null
  month: CloseMonth | null
  problem: string | null
}

export function LulView({ model, onRetry, onCsv }: { model: LulModel; onRetry?: () => void; onCsv?: () => void }) {
  return (
    <AttendanceMessages>
      <Lul model={model} onRetry={onRetry} onCsv={onCsv} />
    </AttendanceMessages>
  )
}

function Lul({ model, onRetry, onCsv }: { model: LulModel; onRetry?: (() => void) | undefined; onCsv?: (() => void) | undefined }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const shell = useT('shell')
  const locale = useLocale()
  const { opened, month } = model
  if (!model.allowed) return <EmptyState title={t('problem.forbidden')} description={t('lul.noRight')} />
  if (!model.closeId) return <EmptyState title={t('lul.none')} description={t('lul.noneBody')} />
  if (model.gateShut) return <GateHeld gate="closed" prefix={model.prefix} can={model.can} />
  const title = month ? t('close.sealTitle', { month: monthWords(month.month, locale) }) : t('lul.title')
  return (
    <article className="fw-at-tab">
      <header className="fw-pp-head">
        <h1 className="fw-at-title">{title}</h1>
        <Button size="sm" variant="secondary" onClick={onCsv} heldReason={opened ? null : t('held.notRead')}>
          <Download size={14} aria-hidden /> {t('lul.csv')}
        </Button>
      </header>
      <p className="fw-pp-hint">{t('lul.recorded')}</p>
      {model.problem ? (
        <Banner
          tone="danger"
          title={t('lul.failed')}
          action={
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem)}
        </Banner>
      ) : !opened || !model.src ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('lul.reading')}
        </p>
      ) : (
        <div className="fw-at-lul">
          <PdfViewer src={model.src} title={title} fileName={opened.fileName} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
          <div className="fw-pp-stack tight">
            <DocumentSeal title={title} version="v1" sha256={opened.sha256} sealedAt={month?.closedAt ? formatDateTime(month.closedAt, { locale, timeZone: TIME_ZONE }) : '—'} timestampSource={t('close.sealClock')} labels={ds.documentSeal} />
            <Card padded>
              <b>{t('close.toConfirmTitle')}</b>
              <p className="fw-pp-hint">{t('close.toConfirmNote')}</p>
              <ol className="fw-at-confirm-list">
                {LUL_TO_CONFIRM.map((_, index) => (
                  <li key={index}>{t(`toConfirm.${index}`)}</li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      )}
    </article>
  )
}
