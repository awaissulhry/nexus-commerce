'use client'

import { FileCheck2 } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button } from '@nexus/ui/primitives'
import { RLS_NOTICE_LAW } from '@nexus/factory-domain/safety/organisation/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { noticeLists, noticeToConfirm } from '../model'
import type { CalendarPageActions, CalendarPageModel } from '../view-model'
import { SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

/**
 * The RLS notice to INAIL (design sec rls; QHS-226; D.Lgs. 81/2008 art. 18 c.1 aa): after an RLS is elected or designated,
 * the employer sends the name to INAIL — by hand on the INAIL portal (no connection): the panel records when it was filed,
 * its reference and INAIL's receipt. Pending notices first, with their due day (the first day unless one was confirmed:
 * "to confirm", never late — the plan gives no fixed number of days); the last 10 filed below.
 */
export function RlsPanel({ model, actions }: { model: CalendarPageModel; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const answer = model.notices.status === 'ready' ? model.notices.value : null
  const canManage = model.can.manageOrganisation && (answer?.canManage ?? true)
  const head = <SectionHead id="fw-hs-rls" title={t('rls.title')} note={<LawRef law={answer?.law ?? RLS_NOTICE_LAW} plain={t('law.notice')} labels={ds.lawRef} />} />

  if (model.notices.status === 'error') {
    return (
      <Card padded>
        {head}
        <SectionFailed title={t('rls.failed')} problem={model.notices.problem} onRetry={actions?.onRetryNotices} />
      </Card>
    )
  }
  if (!answer) {
    return (
      <Card padded>
        {head}
        <SectionLoading rows={3} />
      </Card>
    )
  }

  const { pending, filed } = noticeLists(answer.notices)
  const who = (notice: (typeof pending)[number]) => t('rls.who', { role: t(`role.${notice.role}`), person: notice.appointee })
  return (
    <Card padded>
      <div className="fw-hs-stack">
        {head}
        <p className="fw-hs-muted">{t('rls.manual')}</p>
        <h3 className="fw-hs-h3">{t('rls.pending', { count: pending.length })}</h3>
        {pending.length === 0 ? (
          <EmptyState icon={<FileCheck2 size={22} aria-hidden />} title={t('rls.nothing')} />
        ) : (
          <SummaryTable
            label={t('rls.pendingLabel')}
            density="roomy"
            stackOnPhone
            columns={[t('rls.col.who'), t('rls.col.site'), t('rls.col.due'), t('rls.col.filed'), t('rls.col.reference'), '']}
            widths={['26%', '16%', '28%', '10%', '10%', undefined]}
            rows={pending.map((notice) => ({
              id: notice.id,
              cells: [
                who(notice),
                notice.site?.name ?? t('site.whole'),
                noticeToConfirm(notice) ? t('rls.dueToConfirm', { date: day(notice.dueOn) }) : t('rls.dueOn', { date: day(notice.dueOn) }),
                '—',
                '—',
                <Button key="file" size="sm" variant="primary" heldReason={canManage ? (notice.canManage ? null : t('held.organisation')) : t('held.organisation')} aria-label={t('rls.recordFor', { person: notice.appointee })} onClick={() => actions?.onAddress?.({ filing: notice.id })}>
                  {t('rls.record')}
                </Button>,
              ],
            }))}
          />
        )}
        {filed.length > 0 && (
          <>
            <h3 className="fw-hs-h3">{t('rls.filed')}</h3>
            <SummaryTable
              label={t('rls.filedLabel')}
              density="roomy"
              stackOnPhone
              columns={[t('rls.col.who'), t('rls.col.site'), t('rls.col.filed'), t('rls.col.reference'), t('rls.col.receipt')]}
              rows={filed.map((notice) => ({
                id: notice.id,
                cells: [
                  who(notice),
                  notice.site?.name ?? t('site.whole'),
                  day(notice.filedOn),
                  notice.reference ?? '—',
                  notice.receipt ? (
                    <Button key="receipt" size="sm" variant="link" wrap onClick={() => actions?.onOpenFile?.(notice.receipt!.fileId)}>
                      {notice.receipt.name}
                    </Button>
                  ) : (
                    <Button key="receipt" size="sm" variant="quiet" heldReason={canManage ? null : t('held.organisation')} onClick={() => actions?.onAddress?.({ filing: notice.id })}>
                      {t('rls.addReceipt')}
                    </Button>
                  ),
                ],
              }))}
            />
          </>
        )}
      </div>
    </Card>
  )
}
