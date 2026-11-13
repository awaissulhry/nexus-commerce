'use client'

import { MessageSquareWarning, ShieldAlert } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { NS } from '../../../../lib/safety-reports/intake'
import { ReportDialog } from '../../../../lib/safety-reports/view/ReportDialog'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PublicReportActions, PublicReportModel } from '../model'
import '../report.css'

/**
 * links.doc › sec:report — Report a problem (B-W2b-357; design "The public channel for complaints and accident reports (GPSR)",
 * Reg. (EU) 2023/988 art. 19; follow-up GP2:01): one card on the public DoC page, before Type the code. OPEN: a sentence and
 * the button to the form — the shared dialog over the page, full screen on a phone: tell us (the garment with the batch from
 * the QR, what happened, whether anyone was hurt and, only after the consent tick, the injury, the day and place of an
 * accident, how to reach you), check and send, then the number to quote and the photos until their time is over. CLOSED
 * (until the privacy notice for these reports is published, GATE-PRIVACY): said as it is, with whom to write to meanwhile.
 * Loading: the card's shape; the read failed: the words and Try again. No price, no person.
 */
export function PublicReportSection({ model, actions }: { model: PublicReportModel; actions?: PublicReportActions }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <Section model={model} actions={actions} />
      {model.dialog && (
        <ReportDialog model={{ dialog: model.dialog, door: 'public', fixedBatch: model.batch, today: model.today, keeper: model.keeper, camera: model.camera, contact: model.contact?.email ?? null }} actions={actions} />
      )}
    </WithMessages>
  )
}

function Section({ model, actions }: { model: PublicReportModel; actions?: PublicReportActions }) {
  const t = useT(NS)
  return (
    <Card padded className="fw-pd-card fw-pdr" aria-labelledby="fw-pdr-title">
      <div className="fw-pdr-head">
        <h2 className="fw-pdr-h2" id="fw-pdr-title">
          <MessageSquareWarning size={18} aria-hidden /> {t('public.heading')}
        </h2>
        <p className="fw-pdr-hint">{t('public.hint')}</p>
      </div>
      {model.door === 'loading' ? (
        <div aria-busy="true" className="fw-pdr-body">
          <Skeleton width="70%" height={18} />
          <Skeleton width={180} height={36} />
        </div>
      ) : model.door === 'failed' ? (
        <EmptyState
          icon={<ShieldAlert size={24} aria-hidden />}
          title={t('public.failedTitle')}
          description={t('public.failedBody')}
          action={
            <Button variant="secondary" onClick={() => actions?.onRetryDoor?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.door === 'closed' ? (
        <Banner tone="info" title={t('public.closedTitle')}>
          <span>{model.contact ? t('public.closedWrite', { email: model.contact.email }) : t('public.closedWriteNoMail')}</span>
        </Banner>
      ) : (
        <div className="fw-pdr-body">
          <p className="fw-pdr-lead">{t('public.lead')}</p>
          <div>
            <Button variant="primary" onClick={() => actions?.onOpen?.()}>
              {t('public.open')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
