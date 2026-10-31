'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Stepper, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { DocumentSendView } from '../../../../_shared/document-send/view/DocumentSendView'
import { dayAt } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import { cancelHeld, journeyIndex, nextStep, RECORD_TABS, STATUS_TONE, type OrderRecordActions, type OrderRecordModel, type OrderTab } from '../../model'
import { changeHeld, confirmByHeld, remindHeld } from '../../daily-model'
import { AnswerTab } from './AnswerTab'
import { DailyDialogs, SendExtraFields, useSay } from './DailyDialogs'
import { DocumentsTab, ReceiptsTab } from './ReceiptsDocsTabs'
import { LinesTab } from './LinesTab'
import { OrderDialogs } from './OrderDialogs'
import '../../../../_shared/buying/buying.css'

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
 * view). The band: ‹ Purchase orders, "<number> · <supplier>", the state, its revision, the journey (drafted → sent →
 * confirmed → received) with what waits and for whom, the primary by state (Send to supplier — the shared send dialog
 * SCR-037 with the confirm link —, Review proposed changes, Send a new link, Receive goods), the thread (⌘J), ⋯ What the
 * supplier sees / Edit details / Cancel. The tabs: Lines (leather by area with ≈ hides, grade, thickness, one dye batch,
 * tolerance, Cr VI; received per line), Supplier's answer (confirmed by link, declined, or proposed per line, and the
 * buyer's decision — P2: the buyer always decides), Receipts, Documents (the frozen PDFs, links, mails), Activity.
 */
export function OrderRecordView({ model, actions, panels }: { model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['buying', 'purchasing-orders', 'lists', 'records', 'send']}>
      <OrderRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function OrderRecord({ model, actions, panels }: { model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  const t = useT('buying')
  const listHref = `${model.prefix}/purchasing/orders`
  const loaded = model.order
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-by">
        <div className="fw-by-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('po.record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('po.record.title')} />
        </div>
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
      </div>
    )
  }
  return <ReadyOrder order={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyOrder({ order, model, actions, panels }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  const t = useT('buying')
  const td = useT('purchasing-orders')
  const say = useSay()
  const sayOwn = useSay('buying')
  const change = changeHeld(order, model.can)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const recordHref = `${model.prefix}/purchasing/orders/${order.id}`
  const step = nextStep(order, model.can)
  const stepHeld = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null
  const cancelReason = cancelHeld(order, model.can)

  const openStep = () => {
    if (step.kind === 'send') actions?.onDialog?.({ kind: 'send' })
    else if (step.kind === 'review') actions?.onDialog?.({ kind: 'review' })
    else if (step.kind === 'newLink') actions?.onDialog?.({ kind: 'newLink', message: '' })
  }

  // Keys: ⌘J the thread; ⌘↵ the next step (never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (target?.closest('[role="dialog"]') || model.dialog) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && step.kind !== 'receive' && !stepHeld) {
        event.preventDefault()
        openStep()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const blocking = order.status === 'DRAFT' ? (order.send?.checks.filter((check) => check.severity === 'BLOCKS').length ?? 0) : 0
  const tabCount = (tab: OrderTab): number | null => {
    if (tab === 'lines') return order.lines.length
    if (tab === 'receipts') return model.receipts?.value?.length ?? null
    if (tab === 'documents') return model.documents.value?.documents.length ?? null
    return null
  }
  const dotted = (tab: OrderTab) => (tab === 'lines' && blocking > 0) || (tab === 'answer' && order.status === 'CHANGES_PROPOSED')
  const tabs: TabItem[] = RECORD_TABS.filter((tab) => tab !== 'receipts' || model.receipts !== null).map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label: dotted(tab) ? (
      <span className="fw-by-tablabel">
        {t(`po.tab.${tab}`)}
        <span className="fw-by-dot" aria-label={t(tab === 'lines' ? 'po.tab.checksOpen' : 'po.tab.waitsForYou', { count: blocking })} role="img" />
      </span>
    ) : (
      t(`po.tab.${tab}`)
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

  const more = [
    { id: 'supplierView', label: t('po.record.supplierView'), onSelect: () => actions?.onSupplierView?.() },
    ...(order.status === 'DRAFT' && model.can.poManage ? [{ id: 'details', label: t('po.record.editDetails'), onSelect: () => actions?.onDialog?.({ kind: 'details', draft: detailsOf(order) }) }] : []),
    ...(order.status === 'SENT' && model.can.poSend ? [{ id: 'newLink', label: t('po.step.newLink'), onSelect: () => actions?.onDialog?.({ kind: 'newLink', message: '' }) }] : []),
    // B-W2a-69: Change → the next revision's draft; the confirm-by; a reminder by hand.
    ...(change === null ? [{ id: 'change', label: td('change.open', { revision: order.revision + 1 }), onSelect: () => actions?.onDialog?.({ kind: 'change', note: '' }) }] : []),
    ...(confirmByHeld(order, model.can) === null ? [{ id: 'confirmBy', label: td('confirmBy.move'), onSelect: () => actions?.onDialog?.({ kind: 'confirmBy', confirmBy: order.confirmBy ?? '' }) }] : []),
    ...(remindHeld(order, model.can) === null ? [{ id: 'remind', label: td('remind.open'), onSelect: () => actions?.onDialog?.({ kind: 'remind', message: '' }) }] : []),
    { id: 'copy', label: t('po.record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(order.number).catch(() => undefined) },
    ...(cancelReason === null ? [{ id: 'cancel', label: t('po.record.cancel'), tone: 'danger' as const, onSelect: () => actions?.daily?.onCancelOrder?.() }] : []),
  ]

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const live = order.confirmLinks.find((link) => link.state === 'LIVE') ?? null
  const waits = waitWords(order, live?.expiresAt ?? null)

  return (
    <div className="fw-by">
      <div className="fw-by-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/purchasing/orders`}>{t('po.record.back')}</Link>}
          title={
            <span className="fw-by-title">
              {order.number} <span className="fw-by-title-sub">· {order.supplier.name}</span>
            </span>
          }
          actions={
            <span className="fw-by-actions">
              {primary}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-by-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-by-meta-row">
          <span className="fw-by-meta">
            <Pill tone={STATUS_TONE[order.status]}>{t(`poStatus.${order.status}`)}</Pill>
            {order.revision > 1 && <Tag tone="neutral">{t('po.record.revision', { revision: order.revision })}</Tag>}
            <span className="fw-by-hint">{[`${order.site.code} · ${order.site.name}`, order.currency, order.contact ? order.contact.name : null].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="fw-by-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        {order.status !== 'CANCELLED' && (
          <>
            <div className="fw-by-journey">
              <Stepper current={journeyIndex(order.status)} steps={JOURNEY.map((key) => ({ key, label: t(`po.journey.${key}`) }))} />
            </div>
            {/* A phone has no room for five labelled steps: the same journey in one line. */}
            <p className="fw-by-journey-short fw-by-hint">
              {journeyLine(journeyIndex(order.status), t)}
            </p>
          </>
        )}
        {waits && <p className="fw-by-hint">{t(waits.key, { ...waits.params, supplier: order.supplier.name, date: waits.params?.date ? formatDate(String(waits.params.date), place) : '' })}</p>}
        <Tabs ariaLabel={t('po.record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

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
      {order.status === 'CANCELLED' && <Banner tone="danger" title={t('po.record.cancelled', { date: order.cancelledAt ? formatDateTime(order.cancelledAt, place) : '—' })}>{order.cancelReason}</Banner>}
      {order.status === 'DECLINED' && <Banner tone="danger" title={t('po.record.declined', { date: order.declinedAt ? formatDateTime(order.declinedAt, place) : '—' })}>{t('po.record.declinedNext')}</Banner>}
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
      {!model.can.poManage && !model.can.poSend && <Banner tone="info" title={t('po.record.readOnly')} />}
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

      <div className={showDock ? 'fw-by-body has-dock' : 'fw-by-body'}>
        <div className="fw-by-main">
          {model.tab === 'lines' && <LinesTab order={order} model={model} actions={actions} />}
          {model.tab === 'answer' && <AnswerTab order={order} model={model} actions={actions} />}
          {model.tab === 'receipts' && <ReceiptsTab order={order} model={model} actions={actions} />}
          {model.tab === 'documents' && <DocumentsTab order={order} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-by-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-by-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <OrderDialogs order={order} model={model} actions={actions} />
      <DailyDialogs order={order} model={model} actions={actions} />
      {model.send && model.dialog?.kind === 'send' && (
        <DocumentSendView
          open
          model={model.send}
          actions={{ onField: actions?.onSend?.onField, onSend: actions?.onSend?.onSend, onClose: () => actions?.onDialog?.(null), onRetryChecks: actions?.onSend?.onRetryChecks, onNewLink: actions?.onSend?.onNewLink }}
          extra={model.send.result ? null : <SendExtraFields order={order} model={model} actions={actions} defaultConfirmBy={model.sendFacts?.confirmBy ?? null} changes={model.sendFacts?.changes ?? null} />}
        />
      )}
    </div>
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
