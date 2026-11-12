'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { listHref, recordHref, RECORD_TABS } from '../model'
import { Freshness, InquiriesMessages, NoticeLine, StatusPill, useWords } from '../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { recordTabs, useRecordKeys } from './InquiryDetail'
import { fromLine, RecordBody, RecordMeta, RecordVerbs, type RecordSlots } from './RecordTabs'

/**
 * The inquiry's full page (design tab:inquiries.full; "Open full page" from the DetailModal, a new tab, for long requests
 * with many files; where a search result or Today opens an inquiry): ‹ Inquiries, "<number> · <who asks>", its source,
 * waiting and assignee, its status; Make quote, Assign, Decline, ⋯; the tabs always in view (Owner L1) as real links; the
 * same tabs and dialogs as the DetailModal.
 */
export function InquiryPageView({ model, actions, slots, asOf }: { model: InquiryRecordModel; actions?: InquiryRecordActions; slots?: RecordSlots; asOf?: string | null }) {
  return (
    <InquiriesMessages>
      <Body model={model} actions={actions} slots={slots} asOf={asOf ?? null} />
    </InquiriesMessages>
  )
}

function Problem({ title, body, back, onRetry, icon }: { title: string; body: string; back: ReactNode; onRetry?: () => void; icon: ReactNode }) {
  const { t } = useWords()
  return (
    <div className="fw-inq">
      <Card padded>
        <EmptyState
          icon={icon}
          title={title}
          description={body}
          action={
            <span className="fw-inq-actions">
              {back}
              {onRetry && (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              )}
            </span>
          }
        />
      </Card>
    </div>
  )
}

function Body({ model, actions, slots, asOf }: { model: InquiryRecordModel; actions?: InquiryRecordActions; slots?: RecordSlots; asOf: string | null }) {
  const { t } = useWords()
  useRecordKeys(model, actions, false)
  const list = listHref(model.prefix)
  const back = (
    <Button size="sm" asChild>
      <Link href={list}>{t('record.backToList')}</Link>
    </Button>
  )
  if (!model.can.view || model.loaded.status === 'forbidden') return <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
  if (model.loaded.status === 'loading')
    return (
      <div className="fw-inq" aria-busy="true">
        <p className="fw-inq-hint" role="status">
          <Spinner size={14} /> {t('record.reading')}
        </p>
        <Skeleton height={36} width="40%" />
        <Skeleton height={28} width="60%" />
        <div className="fw-inq-two">
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
      </div>
    )
  if (model.loaded.status === 'notFound') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.notFoundTitle')} body={t('record.notFoundBody')} back={back} />
  if (model.loaded.status === 'error') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.failedTitle')} body={t(model.loaded.problem)} back={back} onRetry={() => actions?.onRetry?.()} />
  const view = model.loaded.value
  const tabs = recordTabs(view, t).map((tab) => ({ ...tab, href: recordHref(model.prefix, view.id, tab.id as (typeof RECORD_TABS)[number]) }))
  return (
    <div className="fw-inq">
      <div className="fw-inq-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={list}>{t('record.back')}</Link>}
          title={
            <span>
              {view.number} <span className="fw-inq-title-name">· {fromLine(view, t)}</span>
            </span>
          }
          meta={<RecordMeta view={view} />}
          status={
            <span className="fw-inq-row">
              <StatusPill status={view.status} />
              <Freshness asOf={asOf} live={model.live} />
            </span>
          }
          actions={<RecordVerbs model={model} view={view} actions={actions} />}
        />
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} />
      </div>
      {model.live === 'offline' && <Banner tone="warning" title={t('record.offline')} />}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <p className="fw-inq-intro">{view.summary}</p>
      <RecordBody model={model} view={view} actions={actions} slots={slots} />
    </div>
  )
}
