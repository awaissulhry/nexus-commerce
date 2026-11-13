'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { ClipboardCheck, MoreHorizontal, PencilRuler } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Freshness, RecordFrame, RecordProblem, RecordSkeleton } from '../../../../quality/_shared/parts'
import type { ProfileRecord } from '../../api'
import { customerHref, fittingsHeld, listHref, offPhrase, RECORD_TABS, recordHref, reviewDraftFor, reviewHeld, rightHeld, templatesHref, worksheetHref, type Phrase } from '../../model'
import { MtmMessages, NoticeLine, ReviewPill, useWords } from '../../parts'
import { LinkDialog } from '../../view/LinkDialog'
import { MeasurementsDialog } from '../../view/MeasurementsDialog'
import { QuoteDialog } from '../../view/QuoteDialog'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'
import { ActivityTab } from './ActivityTab'
import { FittingDialogs } from './FittingDialogs'
import { FittingsTab } from './FittingsTab'
import { MeasurementsTab } from './MeasurementsTab'
import { OrdersTab } from './OrdersTab'
import { OtherDialogs } from './OtherDialogs'
import { PhotosTab } from './PhotosTab'
import { ProofsTab } from './ProofsTab'
import { ReviewDialogs } from './ReviewDialogs'
// B-W2b-371: the photos' pop-ups and their count (XF2:01).
import { photoCount } from '../../photos/model'
import { PhotoDialogs } from '../../photos/view/PhotoDialogs'
import { ExtrasMessages } from '../../photos/words'

export type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * SCR-036-record — the rider profile (design sales.mtm "Record: Rider profile"; `?tab=measurements|photos|fittings|proofs|orders|
 * activity`, `&do=` a row verb's dialog): the band (‹ Made-to-measure, "<rider> · <garment type>", the customer, the revision,
 * when measured, the next fitting; the review state and the freshness; ONE primary — Review measurements while the newest revision
 * waits and the person reviews, else New revision — and ⋯ with the rest: Send a measurement link, Book a fitting, Use in a new
 * quote, Repeat order, Print worksheet (new tab), each held with why), the off state of made-to-measure for this garment type
 * (GATE-MTM: said with the way to start it), and the six tabs.
 */
export function ProfileRecordView({ model, actions }: { model: ProfileRecordModel; actions?: ProfileRecordActions }) {
  return (
    <MtmMessages>
      <Body model={model} actions={actions} />
    </MtmMessages>
  )
}

function Body({ model, actions }: { model: ProfileRecordModel; actions?: ProfileRecordActions }) {
  const { t, say, day, when } = useWords()
  const back = (
    <Link className="fw-mtm-link" href={listHref(model.prefix)}>
      {t('band.back')}
    </Link>
  )
  if (!model.can.view || model.loaded.status === 'forbidden') return <RecordProblem problem="problem.forbidden" back={back} />
  if (model.loaded.status === 'loading') return <RecordSkeleton />
  if (model.loaded.status === 'notFound') return <RecordProblem problem="problem.notFound" back={back} />
  if (model.loaded.status === 'error') return <RecordProblem problem={model.loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />
  const record: ProfileRecord = model.loaded.record
  const latest = record.revisions[0]
  const offline = model.live === 'offline'
  const off = offPhrase(record.template)
  const reviewWaits = latest !== undefined && latest.review.status !== 'CONFIRMED'
  const confirmHeld = reviewHeld(record, 'CONFIRM', model.me, model.can, offline)
  const askHeld = reviewHeld(record, 'NEED_MORE', model.me, model.can, offline)
  const reviewOpenHeld = confirmHeld && askHeld ? confirmHeld : null
  const recordHeld: Phrase | null = !record.may.record ? rightHeld('record') : offline ? { key: 'held.offline' } : null

  const openReview = () => actions?.onDialog?.({ kind: 'review', draft: reviewDraftFor(confirmHeld ? 'NEED_MORE' : 'CONFIRM', record.review.mailTo), check: null, checking: false, busy: false, notice: null })
  let primary: ReactNode
  if (reviewWaits && model.can.review)
    primary = (
      <Button size="sm" variant="primary" heldReason={say(reviewOpenHeld)} onClick={openReview}>
        <ClipboardCheck size={14} aria-hidden /> {t('band.review')}
      </Button>
    )
  else
    primary = (
      <Button size="sm" variant="primary" heldReason={say(recordHeld)} onClick={() => actions?.onNewRevision?.()}>
        <PencilRuler size={14} aria-hidden /> {t('band.newRevision')}
      </Button>
    )

  const item = (id: string, label: string, held: Phrase | null, onSelect: () => void): MenuItemDef => {
    const reason = say(held)
    return { id, label, disabled: !!reason, description: reason ?? undefined, onSelect }
  }
  const linkHeld: Phrase | null = !model.can.link ? rightHeld('link') : offline ? { key: 'held.offline' } : null
  const quoteHeldNow: Phrase | null = !model.can.quotes ? rightHeld('quotes') : offline ? { key: 'held.offline' } : null
  const menu: MenuItemDef[] = [
    ...(reviewWaits && model.can.review ? [item('revision', t('band.newRevision'), recordHeld, () => actions?.onNewRevision?.())] : [item('review', t('band.review'), reviewWaits ? reviewOpenHeld : { key: 'held.review.confirmed', params: { revision: latest?.revision ?? 0 } }, openReview)]),
    item('link', t('band.link'), linkHeld, () => actions?.onOpenLink?.()),
    item('fitting', t('band.fitting'), fittingsHeld(model.fittings.items, 'book', model.can, offline, record.template?.code ?? null), () => actions?.onOpenFitting?.()),
    item('quote', t('band.quote'), quoteHeldNow, () => actions?.onOpenQuote?.()),
    item('repeat', t('band.repeat'), quoteHeldNow, () => actions?.onOpenRepeat?.()),
    record.may.worksheet ? { id: 'worksheet', label: t('band.worksheet'), href: worksheetHref(model.prefix, record.id), target: '_blank' } : item('worksheet', t('band.worksheet'), rightHeld('record'), () => undefined),
    { id: 'customer', label: t('band.customer', { customer: record.customer.name }), href: customerHref(model.prefix, record.partyId) },
  ]

  const meta = (
    <span className="fw-mtm-row">
      <span>{record.customer.name}</span>
      <span className="fw-mtm-code">{record.customer.code}</span>
      {latest && <span>{t('band.revision', { revision: latest.revision, count: record.revisions.length })}</span>}
      {latest && <span>{t('band.taken', { date: day(latest.takenAt) })}</span>}
      {record.nextFittingAt && <span>{t('band.nextFitting', { when: when(record.nextFittingAt) })}</span>}
    </span>
  )
  const status = (
    <span className="fw-mtm-row">
      {latest && <ReviewPill status={latest.review.status} />}
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  const tabs = RECORD_TABS.map((tab) => ({
    id: tab,
    label: t(`tab.${tab}`),
    count: tab === 'measurements' ? record.revisions.length : tab === 'orders' ? record.units.length : tab === 'fittings' ? (model.fittings.items ? model.fittings.items.appointments.length : null) : tab === 'photos' ? (model.sent.items ? model.sent.items.revisions.reduce((sum, revision) => sum + revision.photos.length, 0) + (photoCount(model.photos?.photos ?? null) ?? 0) : null) : tab === 'proofs' ? (model.proofs.items ? model.proofs.items.length : null) : null,
  }))

  return (
    <div className="fw-mtm">
      <RecordFrame
        back={{ href: listHref(model.prefix), label: t('band.back') }}
        title={t('band.title', { rider: record.riderName, garment: record.garmentType })}
        meta={meta}
        status={status}
        actions={
          <>
            {primary}
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={menu} />
          </>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => recordHref(model.prefix, record.id, tab as (typeof RECORD_TABS)[number])}
      >
        {offline && <Banner tone="warning" title={t('record.offline')} />}
        {model.stale && (
          <Banner
            tone="warning"
            title={t('record.stale', { time: model.stale })}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
            }
          />
        )}
        {off && (
          <Banner
            tone="info"
            title={say(off)}
            action={
              <Button size="sm" variant="quiet" asChild>
                <Link href={templatesHref(model.prefix)}>{t('off.where')}</Link>
              </Button>
            }
          >
            {t('off.recordBody')}
          </Banner>
        )}
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'measurements' && <MeasurementsTab model={model} record={record} actions={actions} />}
        {model.tab === 'photos' && <PhotosTab model={model} record={record} actions={actions} />}
        {model.tab === 'fittings' && <FittingsTab model={model} record={record} actions={actions} />}
        {model.tab === 'proofs' && <ProofsTab model={model} record={record} />}
        {model.tab === 'orders' && <OrdersTab model={model} record={record} actions={actions} />}
        {model.tab === 'activity' && <ActivityTab record={record} thread={model.thread} />}
      </RecordFrame>
      <ReviewDialogs model={model} record={record} actions={actions} />
      <FittingDialogs model={model} record={record} actions={actions} />
      <OtherDialogs model={model} record={record} actions={actions} />
      {model.photos && (
        <ExtrasMessages>
          <PhotoDialogs model={model.photos} actions={actions?.photos} riderName={record.riderName} />
        </ExtrasMessages>
      )}
      {model.measurements && <MeasurementsDialog model={model.measurements} actions={actions?.measurements} />}
      {model.link && <LinkDialog model={model.link} can={model.can} actions={actions?.link} />}
      {model.quote && <QuoteDialog model={model.quote} can={model.can} companyId={model.companyId} actions={actions?.quote} />}
    </div>
  )
}
