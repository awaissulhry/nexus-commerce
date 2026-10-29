'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader, StepUpModal } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import type { Order } from '../../api'
import { dayInstant, depositGate, isFinal, nextStep, promiseHeld, readyHeld, RECORD_TABS, STATUS_TONE, type RecordTab } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { OrderDialogs } from './Dialogs'
import { DatesTab } from './DatesTab'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { MoneyTab } from './MoneyTab'
import { ProductionTab } from './ProductionTab'
import { ShipmentsTab } from './ShipmentsTab'
import '../../orders.css'

export type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order"; 00 §2.2; Owner L1: the tabs always in view).
 * The band: ‹ Orders, "<number> · <customer>", the customer PO and the quote it came from, the state, the deposit and
 * how late it is, the next step by state as the primary (Confirmed → Make work orders, held while production waits for
 * the deposit; In production / Ready / Partly shipped → Change promise date; Shipped → Close order, held until settled
 * unless the person may close it anyway with a reason), the thread (⌘J), ⋯. The tabs: Lines (one size grid per style:
 * ordered · in work orders · released · shipped · to ship; the summary rail with the money by grain and the record chain),
 * Dates & promise, Production (the deposit gate and the work orders), Shipments, Invoices & payments (the deposit:
 * request, the bank-details page, the payment, the TD02 and its SDI state; the invoices; the balance), Documents (the
 * accepted quote and its evidence), Activity (the record panels; beside any tab on a wide screen with ⌘J).
 */
export function OrderRecordView({ model, actions, panels }: { model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists', 'records']}>
      <OrderRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function OrderRecord({ model, actions, panels }: { model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  const t = useT('orders')
  const listHref = `${model.prefix}/sales/orders`
  const loaded = model.order

  if (loaded.status !== 'ready') {
    return (
      <div className="fw-so">
        <div className="fw-so-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-so-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-so-stack">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
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
        )}
      </div>
    )
  }
  return <ReadyRecord order={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyRecord({ order, model, actions, panels }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; panels?: ReactNode }) {
  const t = useT('orders')
  const locale = useLocale()
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const step = nextStep(order, model.can)
  const stepHeld = step.held ? t(step.held.key, step.held.params?.date ? { ...step.held.params, date: formatDate(dayInstant(String(step.held.params.date)), { locale }) } : step.held.params) : model.busy ? t('held.busy') : null
  const makeHref = `${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(order.number)}`
  const gate = depositGate(order)

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
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && !stepHeld) {
        event.preventDefault()
        if (step.kind === 'makeWorkOrders') window.location.assign(makeHref)
        else actions?.onDialog?.({ kind: step.kind === 'close' ? 'close' : 'promise' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const openDeposits = order.chain.depositRequests.filter((request) => request.status === 'OPEN').length
  const tabCount = (tab: RecordTab): number | null => {
    if (tab === 'lines') return order.lines.length
    if (tab === 'production') return order.chain.workOrders.length
    if (tab === 'shipments') return order.chain.shipments.length
    if (tab === 'money') return order.chain.invoices.length + order.chain.depositRequests.length
    return null
  }
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      tab === 'money' && openDeposits > 0 ? (
        <span className="fw-so-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-so-dot" aria-label={t('tab.depositOpen')} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tabCount(tab),
  }))

  const primary =
    step.kind === 'makeWorkOrders' ? (
      stepHeld ? (
        <Button size="sm" variant="primary" heldReason={stepHeld}>
          {t('step.makeWorkOrders')}
        </Button>
      ) : (
        <Button size="sm" variant="primary" asChild aria-keyshortcuts="Meta+Enter Control+Enter">
          <Link href={makeHref}>{t('step.makeWorkOrders')}</Link>
        </Button>
      )
    ) : step.kind ? (
      <Button size="sm" variant="primary" heldReason={stepHeld} onClick={() => actions?.onDialog?.({ kind: step.kind === 'close' ? 'close' : 'promise' })} aria-keyshortcuts="Meta+Enter Control+Enter">
        {t(`step.${step.kind}`)}
      </Button>
    ) : null

  const held = (phrase: { key: string } | null) => (phrase ? t(phrase.key) : undefined)
  const promiseWait = promiseHeld(order, model.can)
  const readyWait = readyHeld(order, model.can)
  const more = [
    ...(!isFinal(order) && step.kind !== 'changePromise' ? [{ id: 'promise', label: t('action.promise'), disabled: !!promiseWait, description: held(promiseWait), onSelect: () => actions?.onDialog?.({ kind: 'promise' }) }] : []),
    ...(order.status === 'IN_PRODUCTION' ? [{ id: 'ready', label: t('action.ready'), disabled: !!readyWait, description: held(readyWait), onSelect: () => actions?.onDialog?.({ kind: 'ready' }) }] : []),
    ...(order.chain.quote && model.can.viewQuotes ? [{ id: 'quote', label: t('action.openQuote', { number: order.chain.quote.number }), href: `${model.prefix}/sales/quotes/${order.chain.quote.id}` }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(order.number).catch(() => undefined)
      },
    },
  ]

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const late = order.daysLate !== null && order.daysLate > 0
  const depositRequest = gate.request

  return (
    <div className="fw-so">
      <div className="fw-so-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/sales/orders`}>{t('record.back')}</Link>}
          title={
            <span className="fw-so-title">
              {order.number} <span className="fw-so-title-sub">· {order.party?.legalName ?? '—'}</span>
            </span>
          }
          actions={
            <span className="fw-so-actions">
              {primary}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-so-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-so-meta-row">
          <span className="fw-so-meta">
            <Pill tone={STATUS_TONE[order.status]}>{t(`status.${order.status}`)}</Pill>
            {gate.state === 'WAITING' && depositRequest && (
              <Pill tone={depositRequest.dueDate < model.today ? 'danger' : 'warning'}>{t('record.depositOpen', { date: formatDate(dayInstant(depositRequest.dueDate), { locale }) })}</Pill>
            )}
            {gate.state === 'PAID' && <Pill tone="success">{t('record.depositPaid')}</Pill>}
            {gate.state === 'MISSING' && <Pill tone="danger">{t('record.depositMissing')}</Pill>}
            {late && <Pill tone="danger">{t('record.late', { count: order.daysLate ?? 0 })}</Pill>}
            {order.customerRef && <Tag tone="neutral">{t('record.customerRef', { ref: order.customerRef })}</Tag>}
            {order.chain.quote &&
              (model.can.viewQuotes ? (
                <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/quotes/${order.chain.quote.id}`}>
                  {t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}
                </Link>
              ) : (
                <span className="fw-so-hint">{t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}</span>
              ))}
          </span>
          <span className="fw-so-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
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
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {order.status === 'CANCELLED' && <Banner tone="danger" title={t('record.cancelled', { reason: order.cancelReason ?? '—' })} />}
      {order.status === 'CLOSED' && <Banner tone="info" title={order.closedAt ? t('record.closed', { date: formatDate(order.closedAt, { locale }) }) : t('record.closedNoDate')} />}
      {!model.can.manage && !model.can.close && !model.can.recordPayment && !model.can.makeWorkOrders && !isFinal(order) && <Banner tone="info" title={t('record.readOnly')} />}

      <div className={showDock ? 'fw-so-body has-dock' : 'fw-so-body'}>
        <div className="fw-so-main">
          {model.tab === 'lines' && <LinesTab order={order} model={model} actions={actions} />}
          {model.tab === 'dates' && <DatesTab order={order} model={model} actions={actions} />}
          {model.tab === 'production' && <ProductionTab order={order} model={model} actions={actions} />}
          {model.tab === 'shipments' && <ShipmentsTab order={order} model={model} actions={actions} />}
          {model.tab === 'money' && <MoneyTab order={order} model={model} actions={actions} />}
          {model.tab === 'documents' && <DocumentsTab order={order} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-so-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-so-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <OrderDialogs order={order} model={model} actions={actions} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}

/** A tab's part while it loads, or when its read failed (never drawn as empty): with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('orders')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('part.failed', { part: label })}
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
      <p className="fw-so-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}
