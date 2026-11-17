'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, FileX, ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { CloseThreadConfirm } from '../../../../lib/record-thread/popups/view/Confirms'
import { listHref } from '../model'
import { Freshness, InquiriesMessages, useWords } from '../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { RequestPane, type PaneNav, type RequestPaneProps } from './pane/RequestPane'

/**
 * The request's full page (B-TH-219; O-SAL-INQ-REC.band, .thread, .side, PL5): the band (Back to Incoming with the list's filters
 * kept, as of), then the reading pane's own parts on a page of their own — row 1 (number and customer, the state with its waiting,
 * who keeps it, "3 of 41", ⋯), the actions with the ONE main button, the thread about two thirds and Details about one third; on a
 * phone the details behind "i" (a bottom sheet) and the main action stays on top. One part, not two: the pane and the page draw
 * the same RequestPane.
 */
export interface InquiryPageProps {
  model: InquiryRecordModel
  actions?: InquiryRecordActions
  thread?: ReactNode
  asOf?: string | null
  handled?: string | null
  /** Back to Incoming: the list it came from (its filters), with this request open. */
  backHref?: string
  /** The list's order when opened from it ("3 of 41", J / K); null for a deep link. */
  nav?: PaneNav | null
  closing?: { readonly problem: string | null } | null
  rights?: RequestPaneProps['rights']
  onErase?: () => void
  onCloseThread?: () => void
  onConfirmClose?: () => void
  onCancelClose?: () => void
  /** Design cases: the phone's details sheet open. */
  sheetOpen?: boolean
}

export function InquiryPageView(props: InquiryPageProps) {
  return (
    <InquiriesMessages>
      <Body {...props} />
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

function Body({ model, actions, thread, asOf, handled, backHref, nav, closing, rights, onErase, onCloseThread, onConfirmClose, onCancelClose, sheetOpen }: InquiryPageProps) {
  const { t } = useWords()
  const list = backHref ?? listHref(model.prefix)
  const back = (
    <Button size="sm" asChild>
      <Link href={list}>{t('record.backToList')}</Link>
    </Button>
  )
  // A request outside the reader's scope answers "not found" without a name (W37); a missing right is named.
  if (!model.can.view || model.loaded.status === 'forbidden') return <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
  if (model.loaded.status === 'notFound') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.notFoundTitle')} body={t('record.notFoundBody')} back={back} />
  if (model.loaded.status === 'error') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.failedTitle')} body={t(model.loaded.problem)} back={back} onRetry={() => actions?.onRetry?.()} />
  const view = model.loaded.status === 'ready' ? model.loaded.value : null
  return (
    <div className="fw-inq fw-inq-page">
      <div className="fw-inq-pageband">
        <Button size="sm" variant="quiet" asChild>
          <Link href={list}>
            <ChevronLeft size={14} aria-hidden /> {t('record.backToList')}
          </Link>
        </Button>
        <Freshness asOf={asOf ?? null} live={model.live} />
      </div>
      <div className="fw-inq-pagebody">
        <RequestPane model={model} actions={actions} slots={{ thread }} handled={handled ?? null} nav={nav ?? null} rights={rights} onErase={onErase} onCloseThread={onCloseThread} onNext={nav && view ? () => nav.ids[nav.ids.indexOf(view.id) + 1] && nav.onGo(nav.ids[nav.ids.indexOf(view.id) + 1]!) : undefined} place="page" sheetOpen={sheetOpen} />
      </div>
      {view && closing && <CloseThreadConfirm record={view.number} party={view.party?.name ?? null} problem={closing.problem} onClose={() => onConfirmClose?.()} onCancel={() => onCancelClose?.()} />}
    </div>
  )
}
