'use client'

import { AlertCircle } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { NoticePage } from '../api'
import { hasLeather, hideCounts, hidesOfNotice, lineChecksOf, listHref, type Problem } from '../model'
import { useDeliveryWords } from '../words'
import { CancelDialog, type CancelModel } from './Dialogs'
import { HidesTable, LineChecks, TermsFacts } from './parts'
import '../deliveries.css'

/**
 * SCR-227 › one ship notice as it stands (design sec:asn-grid "Row → ship notice view; editable until received"; live "Receipt
 * posted by our warehouse → status 'Received' or 'Received with differences' with the lines that differ"): the delivery's
 * terms, the lines with their checks (and what our receipt took), the leather packing list per hide with its verdicts
 * (Enter opens a row's detail). The band holds Change (sent) and ⋯ Cancel this ship notice… (before receipt). No price (C2).
 */

export interface NoticeViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  page: NoticePage | null
  prefix: string
  dialog: CancelModel | null
  /** A refusal of the last write (the cancel's own stays in its pop-up). */
  problem: Problem | null
  /** The notice was just cancelled here. */
  cancelled?: boolean
  openHide?: string | null
}

export interface NoticeActions {
  onRetry?: () => void
  dialog?: { onReason?: (reason: string) => void; onConfirm?: () => void; onClose?: () => void }
}

export function NoticeView({ model, actions }: { model: NoticeViewModel; actions?: NoticeActions }) {
  const words = useDeliveryWords()
  const { t, at, qty } = words
  if (model.state === 'loading') {
    return (
      <div className="fw-psn" role="status" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton height={28} width="40%" />
        <Skeleton height={96} />
        <Skeleton height={140} />
      </div>
    )
  }
  if (model.state === 'missing') {
    return (
      <div className="fw-psn">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('notice.missing')} description={t('notice.missingBody')} action={
            <Button asChild>
              <a href={listHref(model.prefix)}>{t('notice.toList')}</a>
            </Button>
          } />
      </div>
    )
  }
  if (model.state === 'error' || !model.page) {
    return (
      <div className="fw-psn">
        <div className="fw-psn-state" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('notice.failed')}</span>
          <Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>
        </div>
      </div>
    )
  }
  const page = model.page
  const notice = page.notice
  const received = notice.status === 'RECEIVED'
  const hides = hidesOfNotice(notice)
  const counts = hideCounts(hides)
  const lines = lineChecksOf(notice)
  const differing = lines.filter((line) => line.differs)
  return (
    <div className="fw-psn">
      {model.problem ? <Banner tone="danger" title={t(`problem.${model.problem}`)} /> : null}
      {notice.state === 'RECEIVED_WITH_DIFFERENCES' ? (
        <Banner tone="warning" title={t('notice.differences', { count: differing.length })}>
          {differing.map((line) => t('notice.differsLine', { seq: line.seq ?? '—', shipped: qty(line.quantity, line.uom), received: qty(line.receivedQuantity ?? '0', line.uom) })).join(' · ')}
        </Banner>
      ) : notice.state === 'RECEIVED' ? (
        <Banner tone="success" title={t('notice.received', { at: notice.receivedAt ? at(notice.receivedAt) : '—' })} />
      ) : notice.state === 'CANCELLED' ? (
        <Banner tone="neutral" title={t('notice.cancelledOn', { at: notice.cancelledAt ? at(notice.cancelledAt) : '—' })}>
          {notice.cancelReason ? t('notice.cancelReason', { reason: notice.cancelReason }) : null}
        </Banner>
      ) : notice.state === 'IN_TRANSIT' || notice.state === 'ANNOUNCED' ? (
        <Banner tone="info" title={t(notice.state === 'IN_TRANSIT' ? 'notice.inTransit' : 'notice.announced')}>
          {page.canEdit ? t('notice.editable') : null}
        </Banner>
      ) : null}
      <Card padded className="fw-psn-card">
        <h2 className="fw-psn-h2">{t('review.transport')}</h2>
        <TermsFacts notice={notice} site={page.site} prefix={model.prefix} />
      </Card>
      <Card padded className="fw-psn-card">
        <div className="fw-psn-card-head">
          <h2 className="fw-psn-h2">{t('review.lines')}</h2>
          <Pill tone={notice.verdict === 'OK' ? 'success' : notice.verdict === 'CHECK' ? 'warning' : 'danger'}>{t(`verdict.${notice.verdict}`)}</Pill>
        </div>
        <LineChecks lines={lines} received={received} label={t('review.lines')} />
      </Card>
      {hasLeather(notice) ? (
        <Card padded className="fw-psn-card">
          <h2 className="fw-psn-h2">{t('packing.title')}</h2>
          {hides.length > 0 ? (
            <div className="fw-psn-stack">
              <p className="fw-psn-hint">{`${t('packing.kept', { count: hides.length })} ${t('packing.counts', { ok: counts.ok, check: counts.check, bad: counts.notAsOrdered })}`}</p>
              <HidesTable rows={hides} label={t('packing.yourList')} openHide={model.openHide ?? null} />
            </div>
          ) : (
            <p className="fw-psn-hint">{t('review.noList')}</p>
          )}
        </Card>
      ) : null}
      {model.dialog ? <CancelDialog model={model.dialog} actions={actions?.dialog} /> : null}
    </div>
  )
}
