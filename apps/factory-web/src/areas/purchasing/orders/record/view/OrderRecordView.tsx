'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Stepper, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DocumentSendView } from '../../../../_shared/document-send/view/DocumentSendView'
import { dayAt } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import { cancelHeld, isWideTab, journeyIndex, nextStep, previewPdf, RECORD_TABS, STATUS_TONE, type OrderRecordActions, type OrderRecordModel, type OrderTab } from '../../model'
import { changeHeld, confirmByHeld, remindHeld } from '../../daily-model'
import { AnswerTab } from './AnswerTab'
import { DailyDialogs, SendExtraFields, useSay } from './DailyDialogs'
import { ReceiptsTab } from './ReceiptsTab'
import { LinesTab } from './LinesTab'
import { OrderDialogs } from './OrderDialogs'
// B-W2b-333: purchase orders in depth on screen — the Delivery schedule tab, the send's approval, chase, duplicate.
import { allChecks, chaseVerbHeld, copyableLines, DEPTH, duplicateHeld } from '../../depth/model'
import { ApprovalBanner, SendApprovalNote } from '../../depth/view/LinesDepth'
import { ScheduleTab } from '../../depth/view/ScheduleTab'
import { DepthDialogs } from '../../depth/view/DepthDialogs'
import { ChaseDialog } from '../../depth/view/ChaseDialog'
import { useDepthSay } from '../../depth/view/words'
import '../../depth/depth.css'
import '../../../../_shared/buying/buying.css'
// ---- B-TH-263: the order on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

const JOURNEY = ['drafted', 'sent', 'confirmed', 'receiving', 'received'] as const

/** The journey in one line for a phone: "Step 2 of 5: Sent · then Confirmed". */
function journeyLine(index: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const now = t('po.journey.short', { step: index + 1, count: JOURNEY.length, label: t(`po.journey.${JOURNEY[index]}`) })
  const next = JOURNEY[index + 1]
  return next ? `${now} · ${t('po.journey.next', { label: t(`po.journey.${next}`) })}` : now
}

export type { OrderRecordActions, OrderRecordModel } from '../../model'

/**
 * SCR-059 — the PO studio (design purchasing.orders "Record: Purchase order"; 00 §2.2; Owner L1: the tabs always in
 * view), on RecordFrame (B-TH-263; the rule of picture 38, the tabs of 08-tabs O-PUR-PO). The band in the shell's band row:
 * ‹ Purchase orders, "<number> · <supplier>", ONE state pill, its revision and what it is for, the primary by state (Send to
 * supplier — the shared send dialog SCR-037 with the confirm link —, Review proposed changes, Send a new link, Receive goods),
 * the Thread button (⌘J, the frame's), ⋯ What the supplier sees / Preview PDF / Edit details / … / Cancel, with its Keyboard
 * line. The journey (drafted → sent → confirmed → received) and what waits for whom head the body. The thread is docked beside
 * every tab (40 %; one third on Lines under 1600 px); Activity's tools are in its "⋯" (R-ACT). The tabs 7 → 5: Lines (leather
 * by area with ≈ hides, grade, thickness, one dye batch, tolerance, Cr VI; received per line), Delivery schedule, Supplier's
 * answer (confirmed by link, declined, or proposed per line, and the buyer's decision — P2: the buyer always decides; the
 * revisions with each one's PDF), Receipts, Invoices. Documents went: the frozen PDFs are the order's files (the thread's Files
 * view), each mail's delivery is on its thread card. ONE notice in the body column, the rest behind "N more notices".
 */
// B-TH-263: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function OrderRecordView({ model, actions, thread, printThread, invoices }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; /** B-W2a-81: the Invoices tab (Finance's; absent without payables.view: no tab). */ invoices?: ReactNode }) {
  return (
    <WithMessages namespaces={['buying', 'purchasing-orders', DEPTH, 'calendar-kit', 'lists', 'records', 'send']}>
      <OrderRecord model={model} actions={actions} thread={thread} printThread={printThread} invoices={invoices} />
    </WithMessages>
  )
}

function OrderRecord({ model, actions, thread, printThread, invoices }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; invoices?: ReactNode }) {
  const t = useT('buying')
  const listHref = `${model.prefix}/purchasing/orders`
  const loaded = model.order
  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="PurchaseOrder"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('po.record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('po.record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('po.record.dockLabel')}
      >
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('po.record.loading')}
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
              description={loaded.status === 'error' ? t(loaded.problem) : t(`po.record.${loaded.status}`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('po.record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </RecordFrame>
    )
  }
  return <ReadyOrder order={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} invoices={invoices} />
}

function ReadyOrder({ order, model, actions, thread, printThread, invoices }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; invoices?: ReactNode }) {
  const t = useT('buying')
  const td = useT('purchasing-orders')
  const say = useSay()
  const sayOwn = useSay('buying')
  const change = changeHeld(order, model.can)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const recordHref = `${model.prefix}/purchasing/orders/${order.id}`
  const depth = model.depth ?? null
  const tw = useT(DEPTH)
  const sayDepth = useDepthSay()
  // B-W2b-333: the gate's checks count too (the record's own `send` leaves them out); an order waiting for its yes holds Send.
  const checksNow = order.status === 'DRAFT' ? allChecks(order.send?.checks ?? [], depth?.compliance.value ?? null) : (order.send?.checks ?? [])
  const step = nextStep(order, model.can, { checks: checksNow, approval: depth?.approval.value?.state ?? null })
  const stepHeld = step.held ? (step.held.key.startsWith(`${DEPTH}:`) ? sayDepth(step.held) : t(step.held.key, step.held.params)) : model.busy ? t('held.busy') : null
  const cancelReason = cancelHeld(order, model.can)

  const openStep = () => {
    if (step.kind === 'send') actions?.onDialog?.({ kind: 'send' })
    else if (step.kind === 'review') actions?.onDialog?.({ kind: 'review' })
    else if (step.kind === 'newLink') actions?.onDialog?.({ kind: 'newLink', message: '' })
  }

  // Keys: ⌘↵ the next step (never while typing or inside a dialog). ⌘J is the frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if (target?.closest('[role="dialog"]') || model.dialog) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && step.kind !== 'receive' && !stepHeld) {
        event.preventDefault()
        openStep()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const blocking = order.status === 'DRAFT' ? checksNow.filter((check) => check.severity === 'BLOCKS').length : 0
  const laterDeliveries = (depth?.depth.value?.lines ?? []).some((line) => line.confirmedLaterBy > 0 || line.deliveries.some((delivery) => delivery.confirmedLaterBy > 0))
  const tabCount = (tab: OrderTab): number | null => {
    if (tab === 'lines') return order.lines.length
    if (tab === 'receipts') return model.receipts?.value?.length ?? null
    return null
  }
  const dotted = (tab: OrderTab) => (tab === 'lines' && blocking > 0) || (tab === 'answer' && order.status === 'CHANGES_PROPOSED') || (tab === 'schedule' && laterDeliveries)
  const tabWords = (tab: OrderTab) => (tab === 'schedule' ? tw('tab.schedule') : t(`po.tab.${tab}`))
  const dotWords = (tab: OrderTab) => (tab === 'lines' ? t('po.tab.checksOpen', { count: blocking }) : tab === 'schedule' ? tw('tab.later') : t('po.tab.waitsForYou'))
  const tabs: TabItem[] = RECORD_TABS.filter((tab) => (tab !== 'receipts' || model.receipts !== null) && (tab !== 'invoices' || (invoices !== undefined && invoices !== null)) && (tab !== 'schedule' || depth !== null)).map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label: dotted(tab) ? (
      <span className="fw-by-tablabel">
        {tabWords(tab)}
        <span className="fw-by-dot" aria-label={dotWords(tab)} role="img" />
      </span>
    ) : (
      tabWords(tab)
    ),
    count: tabCount(tab),
  }))

  const primary =
    step.kind === 'receive' ? (
      model.can.receive ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={`${model.prefix}/warehouse/receipts/new?order=${order.id}`}>{t('po.step.receive')}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={stepHeld}>
          {t('po.step.receive')}
        </Button>
      )
    ) : step.kind ? (
      <Button size="sm" variant={step.kind === 'newLink' ? 'secondary' : 'primary'} heldReason={stepHeld} onClick={openStep} aria-keyshortcuts="Meta+Enter Control+Enter">
        {step.kind === 'send' && blocking > 0 ? t('po.step.sendOpen', { count: blocking }) : t(`po.step.${step.kind}`)}
      </Button>
    ) : null

  // B-TH-263 (08-tabs O-PUR-PO "the draft preview to the band menu next to What the supplier sees"): the draft's sample PDF in a new
  // tab, as the order stands now (it prints prices: only with the cost grain, else held with why).
  const preview = previewPdf(order.status, model.previewHref)
  const more: MenuItemDef[] = [
    { id: 'supplierView', label: t('po.record.supplierView'), onSelect: () => actions?.onSupplierView?.() },
    ...(preview ? [{ id: 'preview', label: t('po.record.previewPdf'), ...('href' in preview ? { description: t('po.record.previewPdfHint'), href: preview.href, target: '_blank' as const } : { disabled: true, description: t(preview.held) }) }] : []),
    ...(order.status === 'DRAFT' && model.can.poManage ? [{ id: 'details', label: t('po.record.editDetails'), onSelect: () => actions?.onDialog?.({ kind: 'details', draft: detailsOf(order) }) }] : []),
    ...(order.status === 'SENT' && model.can.poSend ? [{ id: 'newLink', label: t('po.step.newLink'), onSelect: () => actions?.onDialog?.({ kind: 'newLink', message: '' }) }] : []),
    // B-W2a-69: Change → the next revision's draft; the confirm-by; a reminder by hand.
    ...(change === null ? [{ id: 'change', label: td('change.open', { revision: order.revision + 1 }), onSelect: () => actions?.onDialog?.({ kind: 'change', note: '' }) }] : []),
    ...(confirmByHeld(order, model.can) === null ? [{ id: 'confirmBy', label: td('confirmBy.move'), onSelect: () => actions?.onDialog?.({ kind: 'confirmBy', confirmBy: order.confirmBy ?? '' }) }] : []),
    ...(remindHeld(order, model.can) === null ? [{ id: 'remind', label: td('remind.open'), onSelect: () => actions?.onDialog?.({ kind: 'remind', message: '' }) }] : []),
    // B-W2b-333: Chase the supplier (a sent order's late or unconfirmed lines) and Duplicate (a new draft from its lines).
    ...(depth && chaseVerbHeld(order.status, depth.can) === null ? [{ id: 'chase', label: tw('chase.open'), onSelect: () => actions?.depth?.chase?.onOpen?.() }] : []),
    ...(depth && duplicateHeld(depth.can) === null && copyableLines(order).length > 0 ? [{ id: 'duplicate', label: tw('duplicate.open'), onSelect: () => actions?.depth?.onDialog?.({ kind: 'duplicate', draft: { lineIds: copyableLines(order).map((line) => line.id), needDate: '' } }) }] : []),
    { id: 'copy', label: t('po.record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(order.number).catch(() => undefined) },
    ...(cancelReason === null ? [{ id: 'cancel', label: t('po.record.cancel'), tone: 'danger' as const, onSelect: () => actions?.daily?.onCancelOrder?.() }] : []),
  ]

  const live = order.confirmLinks.find((link) => link.state === 'LIVE') ?? null
  const waits = waitWords(order, live?.expiresAt ?? null)

  return (
    <>
      <RecordFrame
        recordType="PurchaseOrder"
        personId={model.personId ?? null}
        threadLabel={t('po.record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(model.tab)}
        band={{
          back: <Link href={`${model.prefix}/purchasing/orders`}>{t('po.record.back')}</Link>,
          title: (
            <span className="fw-by-title">
              {order.number} <span className="fw-by-title-sub">· {order.supplier.name}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[order.status]}>{t(`poStatus.${order.status}`)}</Pill>,
          meta: (
            <>
              {order.revision > 1 && <Tag tone="neutral">{t('po.record.revision', { revision: order.revision })}</Tag>}
              {/* B-W2b-347: a PO of type Sample says so and what it buys for (not counted in production spend). */}
              {order.sample && <Tag tone="info">{t('po.record.sampleOrder')}</Tag>}
              {order.sample?.style && <span className="fw-by-hint">{t(order.sample.round ? 'po.record.sampleForRound' : 'po.record.sampleFor', { style: `${order.sample.style.code} ${order.sample.style.name}`, round: order.sample.round?.number ?? '' })}</span>}
              <span className="fw-by-hint">{[`${order.site.code} · ${order.site.name}`, order.currency, order.contact ? order.contact.name : null].filter(Boolean).join(' · ')}</span>
            </>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
        }}
      >
        {/* The journey and what waits for whom head the body (the band is one row). */}
        {order.status !== 'CANCELLED' && (
          <>
            <div className="fw-by-journey">
              <Stepper current={journeyIndex(order.status)} steps={JOURNEY.map((key) => ({ key, label: t(`po.journey.${key}`) }))} />
            </div>
            {/* A phone has no room for five labelled steps: the same journey in one line. */}
            <p className="fw-by-journey-short fw-by-hint">{journeyLine(journeyIndex(order.status), t)}</p>
          </>
        )}
        {waits && <p className="fw-by-hint">{t(waits.key, { ...waits.params, supplier: order.supplier.name, date: waits.params?.date ? formatDate(String(waits.params.date), place) : '' })}</p>}
        <Tabs ariaLabel={t('po.record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-263: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {order.status === 'CANCELLED' && <Banner tone="danger" title={t('po.record.cancelled', { date: order.cancelledAt ? formatDateTime(order.cancelledAt, place) : '—' })}>{order.cancelReason}</Banner>}
          {order.status === 'DECLINED' && <Banner tone="danger" title={t('po.record.declined', { date: order.declinedAt ? formatDateTime(order.declinedAt, place) : '—' })}>{t('po.record.declinedNext')}</Banner>}
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={sayOwn(model.notice.words) ?? ''}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                  {t('common.dismiss')}
                </Button>
              }
            />
          )}
          {/* B-W2b-333: the send's approval (waiting for a yes, approved, refused) — B-W2b-305's API. */}
          {depth && <ApprovalBanner order={order} model={depth} actions={actions?.depth} prefix={model.prefix} />}
          {order.status === 'CHANGES_PROPOSED' && model.tab !== 'answer' && (
            <Banner
              tone="warning"
              title={t('po.record.proposed', { supplier: order.supplier.name })}
              action={
                <Button size="sm" asChild>
                  <Link href={`${recordHref}?tab=answer`}>{t('po.record.seeAnswer')}</Link>
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
          {/* Sent: read-only; Change starts the next revision (B-W2a-69; design Lines "Sent: read-only; 'Change' starts revision 2"). */}
          {['SENT', 'CONFIRMED', 'DECLINED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(order.status) && order.lines.length > 0 && model.tab === 'lines' && (
            <Banner
              tone="info"
              title={t('po.record.frozen')}
              action={
                ['SENT', 'CONFIRMED', 'DECLINED'].includes(order.status) ? (
                  <Button size="sm" heldReason={model.busy ? t('held.busy') : say(change)} onClick={() => actions?.onDialog?.({ kind: 'change', note: '' })}>
                    {td('change.open', { revision: order.revision + 1 })}
                  </Button>
                ) : undefined
              }
            >
              {['SENT', 'CONFIRMED', 'DECLINED'].includes(order.status) ? td('change.bannerHint', { revision: order.revision + 1 }) : td('change.bannerReceived')}
            </Banner>
          )}
          {!model.can.poManage && !model.can.poSend && <Banner tone="info" title={t('po.record.readOnly')} />}
        </RecordNotices>

        <div className="fw-by-main">
          {model.tab === 'lines' && <LinesTab order={order} model={model} actions={actions} />}
          {model.tab === 'schedule' && depth && <ScheduleTab order={order} model={depth} actions={actions?.depth} />}
          {model.tab === 'answer' && <AnswerTab order={order} model={model} actions={actions} />}
          {model.tab === 'receipts' && <ReceiptsTab order={order} model={model} actions={actions} />}
          {model.tab === 'invoices' && invoices}
        </div>
      </RecordFrame>

      <OrderDialogs order={order} model={model} actions={actions} />
      <DailyDialogs order={order} model={model} actions={actions} />
      {depth && <DepthDialogs order={order} model={depth} actions={actions?.depth} />}
      {depth?.chase && <ChaseDialog model={depth.chase} status={order.status} can={depth.can} offline={model.live === 'offline'} actions={actions?.depth?.chase} />}
      {model.send && model.dialog?.kind === 'send' && (
        <DocumentSendView
          open
          model={model.send}
          actions={{ onField: actions?.onSend?.onField, onSend: actions?.onSend?.onSend, onClose: () => actions?.onDialog?.(null), onRetryChecks: actions?.onSend?.onRetryChecks, onNewLink: actions?.onSend?.onNewLink, /* B-TH-202 */ onSendOutside: actions?.onSend?.onSendOutside }}
          extra={
            model.send.result ? null : (
              <>
                <SendApprovalNote model={depth} />
                <SendExtraFields order={order} model={model} actions={actions} defaultConfirmBy={model.sendFacts?.confirmBy ?? null} changes={model.sendFacts?.changes ?? null} />
              </>
            )
          }
        />
      )}
    </>
  )
}

/** What the order waits for, and who: the supplier's answer (until the link's day), the buyer's decision, the goods. */
function waitWords(order: PurchaseOrder, linkUntil: string | null): { key: string; params?: Record<string, string | number> } | null {
  switch (order.status) {
    case 'DRAFT':
      return { key: 'po.waits.draft' }
    case 'SENT':
      return linkUntil ? { key: 'po.waits.supplierUntil', params: { date: linkUntil } } : { key: 'po.waits.supplierNoLink' }
    case 'CHANGES_PROPOSED':
      return { key: 'po.waits.buyer' }
    case 'CONFIRMED':
      return order.earliestNeedDate ? { key: 'po.waits.goods', params: { date: dayAt(order.earliestNeedDate) } } : { key: 'po.waits.goodsNoDate' }
    case 'PARTLY_RECEIVED':
      return { key: 'po.waits.rest' }
    default:
      return null
  }
}

export function detailsOf(order: PurchaseOrder) {
  return { requestedDate: order.requestedDate ?? '', incoterms: order.incoterms ?? '', paymentTerms: order.paymentTerms ?? '', note: order.note ?? '', internalNote: order.internalNote ?? '' }
}

/** A part while it loads or when its read failed (never drawn as empty), with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('buying')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('common.partFailed', { part: label })}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-by-hint" role="status">
        <Spinner size={14} /> {t('common.partLoading', { part: label })}
      </p>
    </Card>
  )
}
