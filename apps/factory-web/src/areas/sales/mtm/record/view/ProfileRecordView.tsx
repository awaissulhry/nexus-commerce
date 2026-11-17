'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { ClipboardCheck, PencilRuler } from 'lucide-react'
import { Banner, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Freshness, RecordProblem, RecordSkeleton } from '../../../../quality/_shared/parts'
// ---- B-TH-258: the rider profile on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import type { ProfileRecord } from '../../api'
import { customerHref, fittingsHeld, listHref, offPhrase, RECORD_TABS, recordHref, reviewDraftFor, reviewHeld, rightHeld, templatesHref, worksheetHref, type Phrase } from '../../model'
import { MtmMessages, NoticeLine, ReviewPill, useWords } from '../../parts'
import { LinkDialog } from '../../view/LinkDialog'
import { MeasurementsDialog } from '../../view/MeasurementsDialog'
import { QuoteDialog } from '../../view/QuoteDialog'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'
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
 * SCR-036-record — the rider profile (design sales.mtm "Record: Rider profile"; `?tab=measurements|photos|fittings|proofs|orders`,
 * `&do=` a row verb's dialog), on RecordFrame (B-TH-258; the rule of picture 38): the band in the shell's band row (‹ Made-to-measure,
 * "<rider> · <garment type>", ONE pill — the review state —, the customer, the revision, when measured, the next fitting and the
 * freshness; ONE primary — Review measurements while the newest revision waits and the person reviews, else New revision — the
 * Thread button (⌘J) and ⋯ with the rest: Send a measurement link, Book a fitting, Use in a new quote, Repeat order, Print worksheet
 * (new tab), each held with why, then the frame's Keyboard line). The rider's thread docked beside every tab (40 %), only for a
 * reader of measurements who reads threads (body data: the API's thread gate); Activity's tools are in its "⋯" (R-ACT), the rider
 * timeline is Measurements › History (R1-G03). The tabs 6 → 5: Measurements · Photos (body data, never the Files view) · Fittings ·
 * Proofs · Orders. ONE notice in the body column (the write's result, offline, changed meanwhile, made-to-measure off for this garment
 * type — GATE-MTM, said with the way to start it), the rest behind "N more notices".
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
  // B-TH-258: the record's states inside the frame (its band, no thread).
  if (!model.can.view || model.loaded.status !== 'ready') {
    const loaded = model.can.view ? model.loaded : ({ status: 'forbidden' } as const)
    return (
      <RecordFrame
        recordType="MeasurementProfile"
        personId={model.me}
        band={{ back: <Link href={listHref(model.prefix)}>{t('band.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.name'), moreLabel: t('band.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        {loaded.status === 'loading' ? (
          <RecordSkeleton />
        ) : loaded.status === 'notFound' ? (
          <RecordProblem problem="problem.notFound" back={back} />
        ) : loaded.status === 'error' ? (
          <RecordProblem problem={loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />
        ) : (
          <RecordProblem problem="problem.forbidden" back={back} />
        )}
      </RecordFrame>
    )
  }
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
    <>
      <span>{record.customer.name}</span>
      <span className="fw-mtm-code">{record.customer.code}</span>
      {latest && <span>{t('band.revision', { revision: latest.revision, count: record.revisions.length })}</span>}
      {latest && <span>{t('band.taken', { date: day(latest.takenAt) })}</span>}
      {record.nextFittingAt && <span>{t('band.nextFitting', { when: when(record.nextFittingAt) })}</span>}
      <Freshness asOf={model.asOf} live={model.live} />
    </>
  )
  // B-TH-258: the five tabs (Activity gone: its tools in the thread's "⋯", its timeline in Measurements › History).
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: recordHref(model.prefix, record.id, tab),
    label: t(`tab.${tab}`),
    count: tab === 'measurements' ? record.revisions.length : tab === 'orders' ? record.units.length : tab === 'fittings' ? (model.fittings.items ? model.fittings.items.appointments.length : null) : tab === 'photos' ? (model.sent.items ? model.sent.items.revisions.reduce((sum, revision) => sum + revision.photos.length, 0) + (photoCount(model.photos?.photos ?? null) ?? 0) : null) : tab === 'proofs' ? (model.proofs.items ? model.proofs.items.length : null) : null,
  }))

  return (
    <>
      <RecordFrame
        recordType="MeasurementProfile"
        personId={model.me}
        threadLabel={t('record.dockLabel')}
        thread={model.thread ?? null}
        printThread={model.printThread}
        band={{
          back: <Link href={listHref(model.prefix)}>{t('band.back')}</Link>,
          title: t('band.title', { rider: record.riderName, garment: record.garmentType }),
          status: latest ? <ReviewPill status={latest.review.status} /> : undefined,
          meta,
          primary,
          more: menu,
          moreLabel: t('band.more'),
        }}
      >
        <div className="fw-mtm fw-mtm-record">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
          {/* B-TH-258: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
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
          </RecordNotices>
          {model.tab === 'measurements' && <MeasurementsTab model={model} record={record} actions={actions} />}
          {model.tab === 'photos' && <PhotosTab model={model} record={record} actions={actions} />}
          {model.tab === 'fittings' && <FittingsTab model={model} record={record} actions={actions} />}
          {model.tab === 'proofs' && <ProofsTab model={model} record={record} />}
          {model.tab === 'orders' && <OrdersTab model={model} record={record} actions={actions} />}
        </div>
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
    </>
  )
}
