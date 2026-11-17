'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Stepper, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt } from '../../../../_shared/buying/model'
import type { OrderAction, SubcontractOrder } from '../../api'
import { actHeld, JOURNEY, journeyIndex, say, STATUS_TONE } from '../../model'
import { isWideTab, liveDdt, primaryAct, RECORD_TABS, sendBeside, type RecordTab, type SubcontractRecordActions, type SubcontractRecordModel } from '../record-model'
import { BackTab } from './BackTab'
import { RecordDialogs } from './Dialogs'
import { KitTab } from './KitTab'
import { OperationsTab } from './OperationsTab'
import { useSay } from './parts'
import { DEPTH } from '../../depth/model'
import '../../../../_shared/buying/buying.css'
import '../record.css'
// ---- B-TH-263: the subcontract order on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { SubcontractRecordActions, SubcontractRecordModel } from '../record-model'

// B-W2b-344: the depth tabs' words (../../depth).
export const RECORD_NAMESPACES = ['subcontracting', 'subcontract-order', 'lists', 'records', DEPTH] as const

/**
 * SCR-128 record — a subcontract order (design purchasing.subcontracting "Record: Subcontract order"; 00 §2.2; Owner L1:
 * the tabs always in view), on RecordFrame (B-TH-263; the rule of picture 38, the tabs of 08-tabs O-PUR-SUB). The band in the
 * shell's band row: ‹ Subcontract orders, "<number> · <workshop>", ONE state pill in the design's words (Draft · Sent · In work ·
 * Partly back · Back · Closed · Cancelled), late, the services, the work order and its style, the site; the act of the state —
 * Issue to the workshop, Send kit, Receive back, Close — each held with why in words; the Thread button (⌘J, the frame's); ⋯ Print
 * job sheet, Print kit DDT, Back to draft, Cancel, Copy number, its Keyboard line. The journey (Sent → Kit out (DDT) → In work →
 * Back → Closed) and what the order waits for head the body. The thread is docked beside every tab; Activity's tools are in its
 * "⋯" (R-ACT). Tabs 7 → 5: Operations & quantities (a draft saves cell by cell), Kit & documents (the kit, then the job sheet and
 * the kit DDTs — the old Documents tab's work), Received back, Material balance, Cost. Fees and amounts only with the cost grain
 * (never drawn as '—' without it). ONE notice in the body column.
 */
// B-TH-263: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function SubcontractRecordView({ model, actions, thread, printThread }: { model: SubcontractRecordModel; actions?: SubcontractRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <WithMessages namespaces={RECORD_NAMESPACES}>
      <Record model={model} actions={actions} thread={thread} printThread={printThread} />
    </WithMessages>
  )
}

function Record({ model, actions, thread, printThread }: { model: SubcontractRecordModel; actions?: SubcontractRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('subcontract-order')
  const listHref = `${model.prefix}/purchasing/subcontracting`
  const loaded = model.order
  const frame = (body: ReactNode) => (
    <RecordFrame
      recordType="SubcontractOrder"
      personId={model.personId ?? null}
      band={{ back: <Link href={listHref}>{t('band.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('band.title'), moreLabel: t('band.more') }}
      thread={null}
      threadLabel={t('band.dockLabel')}
    >
      {body}
    </RecordFrame>
  )
  if (!model.can.view) {
    return frame(
      <Card padded>
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('record.noAccess.title')} description={t('record.noAccess.body')} />
      </Card>,
    )
  }
  if (loaded.status !== 'ready') {
    return frame(
      loaded.status === 'loading' ? (
        <Card padded aria-busy="true">
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <div className="fw-by-stack">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded>
          <EmptyState
            icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
            title={t(`record.${loaded.status}.title`)}
            description={loaded.status === 'error' ? t(loaded.problem) : t(`record.${loaded.status}.body`)}
            action={
              loaded.status === 'error' ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href={listHref}>{t('record.backToList')}</Link>
                </Button>
              )
            }
          />
        </Card>
      ),
    )
  }
  return <ReadyRecord order={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} />
}

/** The journey in one line for a phone: "Step 2 of 5: Sent · then Kit out (DDT)". */
function journeyLine(index: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const now = t('journey.short', { step: index + 1, count: JOURNEY.length, label: t(`journey.${JOURNEY[index]}`) })
  const next = JOURNEY[index + 1]
  return next ? `${now} · ${t('journey.next', { label: t(`journey.${next}`) })}` : now
}

function ReadyRecord({ order, model, actions, thread, printThread }: { order: SubcontractOrder; model: SubcontractRecordModel; actions?: SubcontractRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('subcontract-order')
  const sc = useT('subcontracting')
  const depth = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const recordHref = `${model.prefix}/purchasing/subcontracting/${order.id}`
  const held = (act: OrderAction): string | null => {
    if (model.busy) return t('held.busy')
    const words = actHeld(order, act, model.can)
    return words ? say(sc, words) : null
  }
  const primary = primaryAct(order)
  const open = (act: OrderAction) => {
    if (act === 'issue') actions?.onAct?.('issue')
    else if (act === 'send') actions?.onOpenSend?.()
    else if (act === 'receive') actions?.onOpenReceive?.()
    else if (act === 'close') actions?.onDialog?.({ kind: 'close', note: '' })
  }

  // ⌘J is the frame's (the thread).
  const tabCount = (tab: RecordTab): number | null => {
    if (tab === 'ops') return order.operations.length
    if (tab === 'kit') return order.kitLines.filter((line) => line.status !== 'CANCELLED').length
    if (tab === 'back') return order.receipts.length
    return null
  }
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({ id: tab, href: `${recordHref}?tab=${tab}`, label: tab === 'balance' || tab === 'cost' ? depth(`tab.${tab}`) : t(`tab.${tab}`), count: tabCount(tab) }))

  const button = (act: OrderAction, variant: 'primary' | 'secondary') => (
    <Button key={act} size="sm" variant={variant} heldReason={held(act)} onClick={() => open(act)}>
      {t(`band.act.${act}`)}
    </Button>
  )
  const live = liveDdt(order)
  const reopenHeld = held('reopen')
  const cancelHeld = held('cancel')
  const more: MenuItemDef[] = [
    { id: 'jobSheet', label: t('band.jobSheet'), href: `${recordHref}/job-sheet`, target: '_blank' },
    live && model.can.files
      ? { id: 'ddt', label: t('band.printDdt', { number: live.number }), onSelect: () => actions?.onOpenDdt?.(live.id) }
      : { id: 'ddt', label: t('band.printDdtNone'), disabled: true, description: live ? t('docs.noFiles') : t('band.noDdt') },
    ...(order.status === 'ISSUED' ? [reopenHeld ? { id: 'reopen', label: t('band.reopen'), disabled: true, description: reopenHeld } : { id: 'reopen', label: t('band.reopen'), onSelect: () => actions?.onAct?.('reopen') }] : []),
    ...(order.status === 'DRAFT' || order.status === 'ISSUED' || order.status === 'AT_WORKSHOP'
      ? [cancelHeld ? { id: 'cancel', label: t('band.cancel'), tone: 'danger' as const, disabled: true, description: cancelHeld } : { id: 'cancel', label: t('band.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '' }) }]
      : []),
    { id: 'copy', label: t('band.copyNumber'), onSelect: () => actions?.onCopyNumber?.() },
  ]

  const workOrderHref = `${model.prefix}/production/work-orders/${order.workOrder.id}`
  const ended = order.status === 'CANCELLED'
  const writes = model.can.manage || model.can.kit || model.can.receive

  return (
    <>
      <RecordFrame
        recordType="SubcontractOrder"
        personId={model.personId ?? null}
        threadLabel={t('band.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(model.tab)}
        band={{
          back: <Link href={`${model.prefix}/purchasing/subcontracting`}>{t('band.back')}</Link>,
          title: (
            <span className="fw-by-title">
              {order.number} <span className="fw-by-title-sub">· {order.workshop.name}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[order.status]}>{sc(`status.${order.status}`)}</Pill>,
          meta: (
            <>
              {order.late && <Tag tone="danger">{t('band.late', { date: order.expectedBackDate ? formatDate(dayAt(order.expectedBackDate), place) : '—' })}</Tag>}
              <span className="fw-by-hint">{order.services.map((service) => service.name).join(' · ')}</span>
              <span className="fw-by-hint">
                {model.can.workOrders ? (
                  <Link className="fw-by-link" href={workOrderHref}>
                    {order.workOrder.number}
                  </Link>
                ) : (
                  order.workOrder.number
                )}{' '}
                · {order.workOrder.style.code} {order.workOrder.style.name} · {order.site.code}
              </span>
            </>
          ),
          primary: primary ? (
              <span className="fw-by-actions">
                {primary === 'receive' && sendBeside(order) && button('send', 'secondary')}
                {primary && button(primary, 'primary')}
              </span>
            ) : undefined,
          more,
          moreLabel: t('band.more'),
        }}
      >
        {/* The journey and what the order waits for head the body (the band is one row). */}
        {!ended && (
          <>
            <div className="fw-by-journey">
              <Stepper current={journeyIndex(order)} steps={JOURNEY.map((key) => ({ key, label: t(`journey.${key}`) }))} />
            </div>
            <p className="fw-by-journey-short fw-by-hint">{journeyLine(journeyIndex(order), t)}</p>
          </>
        )}
        <p className="fw-by-hint">{waitWords(order, t, place)}</p>
        <Tabs ariaLabel={t('tab.label')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-263: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {ended && (
            <Banner tone="danger" title={t('record.cancelled', { date: order.cancelledAt ? formatDateTime(order.cancelledAt, place) : '—' })}>
              {order.cancelReason}
            </Banner>
          )}
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={sayWords(model.notice.words)}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                  {t('common.dismiss')}
                </Button>
              }
            />
          )}
          {model.changed && (
            <Banner
              tone="info"
              title={t('record.changed', { time: formatTime(model.changed.at, place) })}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {!writes && !ended && <Banner tone="info" title={t('record.readOnly')} />}
        </RecordNotices>

        <div className="fw-by-main">
          {model.tab === 'ops' && <OperationsTab order={order} model={model} actions={actions} />}
          {model.tab === 'kit' && <KitTab order={order} model={model} actions={actions} />}
          {model.tab === 'back' && <BackTab order={order} model={model} actions={actions} />}
          {model.tab === 'balance' && model.depth?.balance}
          {model.tab === 'cost' && model.depth?.cost}
        </div>
      </RecordFrame>

      <RecordDialogs order={order} model={model} actions={actions} />
    </>
  )
}

/** What the order waits for, and whom: the buyer (a draft), the warehouse (the kit), the workshop (the goods back). */
function waitWords(order: SubcontractOrder, t: (key: string, params?: Record<string, string | number>) => string, place: { locale: 'it' | 'en'; timeZone: string }): string {
  const date = order.expectedBackDate ? formatDate(dayAt(order.expectedBackDate), place) : null
  switch (order.status) {
    case 'DRAFT':
      return t('waits.draft')
    case 'ISSUED':
      return t('waits.kit', { workshop: order.workshop.name })
    case 'AT_WORKSHOP':
    case 'PARTLY_RECEIVED':
      return date ? t('waits.back', { workshop: order.workshop.name, date, count: order.pieces.atWorkshop }) : t('waits.backNoDate', { workshop: order.workshop.name, count: order.pieces.atWorkshop })
    case 'RECEIVED':
      return t('waits.close')
    case 'CLOSED':
      return t('waits.closed', { date: order.closedAt ? formatDate(order.closedAt, place) : '—' })
    default:
      return t('waits.cancelled')
  }
}
