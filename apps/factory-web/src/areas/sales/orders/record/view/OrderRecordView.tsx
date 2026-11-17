'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { amendHeld, closeLinesHeld, copyHeld, reopenHeld } from '../../daily-model'
import { cancelHeld, createShipmentHref, dayInstant, depositGate, isFinal, isWideTab, mayCreateShipment, nextStep, promiseHeld, readyHeld, recordTabs, STATUS_TONE, type RecordTab } from '../../model'
import { ChangesTab } from '../changes/view/ChangesTab'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { OrderDialogs } from './Dialogs'
import { DatesTab } from './DatesTab'
import { DocumentsTab } from './DocumentsTab'
import { MarginTab } from '../margin/view/MarginTab'
import { LinesTab } from './LinesTab'
import { MoneyTab } from './MoneyTab'
import { ProductionTab } from './ProductionTab'
import { ShipmentsTab } from './ShipmentsTab'
// ---- B-W2b-323 (orders in depth on screen) ----
import { depthMenuItems, DepthNotice, DepthPills, WaitingBanner } from '../../depth/view/DepthBand'
import { DepthDialogs } from '../../depth/view/DepthDialogs'
import { NAMESPACE as DEPTH } from '../../depth/model'
import { TechPackCard } from '../../confirmation/view/ConfirmationCard'
// ---- B-TH-214: the order on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import '../../orders.css'

export type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order"; 00 §2.2; Owner L1: the tabs always in view), on RecordFrame
 * (B-TH-214; threads plan O-SAL-ORD-REC, picture 29). The band in the shell's band row: ‹ Orders, "<number> · <customer>", ONE status
 * pill, the customer PO and the quote it came from, the next step by state as the primary (Confirmed → Make work orders, held while
 * production waits for the deposit; In production / Ready / Partly shipped → Change promise date; Shipped → Close order, held until
 * settled unless the person may close it anyway with a reason), the Thread button (⌘J), ⋯ with its Keyboard line. The thread is
 * docked beside every tab (40 %; one third on Lines under 1600 px); Activity's tools are in the thread's "⋯" (R-ACT), its files in
 * the Files view. The tabs 9 → 5: Lines (one size grid per style), Production & dates (the work orders and the deposit gate, the
 * promise and its history, the brand tech pack in force), Shipments & invoices (the shipments; the deposit — request, the
 * bank-details page, the payment, the TD02 and its SDI state —, the invoices, the balance), Confirmation & changes (the order
 * confirmation and the accepted quote's evidence; the amendments), Margin (the margin grain only). ONE notice in the body column,
 * the most serious first, the rest behind "N more notices".
 */
// B-W2b-398: `delivered` is the Shipments tab's card "Delivered (from carrier)". B-TH-214: `thread` the docked thread (the
// office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function OrderRecordView({ model, actions, thread, printThread, delivered }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; delivered?: ReactNode }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists', 'records', DEPTH /* B-W2b-323 */]}>
      <OrderRecord model={model} actions={actions} thread={thread} printThread={printThread} delivered={delivered} />
    </WithMessages>
  )
}

function OrderRecord({ model, actions, thread, printThread, delivered }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; delivered?: ReactNode }) {
  const t = useT('orders')
  const listHref = `${model.prefix}/sales/orders`
  const loaded = model.order

  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="SalesOrder"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
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
      </RecordFrame>
    )
  }
  return <ReadyRecord order={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} delivered={delivered} />
}

function ReadyRecord({ order, model, actions, thread, printThread, delivered }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; delivered?: ReactNode }) {
  const t = useT('orders')
  const d = useT(DEPTH) // B-W2b-323
  const locale = useLocale()
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const step = nextStep(order, model.can)
  const stepHeld = step.held ? t(step.held.key, step.held.params?.date ? { ...step.held.params, date: formatDate(dayInstant(String(step.held.params.date)), { locale }) } : step.held.params) : model.busy ? t('held.busy') : null
  const makeHref = `${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(order.number)}`
  const gate = depositGate(order)

  // Keys: ⌘↵ the next step (never while typing or inside a dialog). ⌘J is the frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
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
  // B-TH-214: the five tabs (Margin only with the margin grain), each counting what it lists.
  const tabCount = (tab: RecordTab): number | null => {
    if (tab === 'lines') return order.lines.length
    if (tab === 'production') return order.chain.workOrders.length
    if (tab === 'shipments') return order.chain.shipments.length + order.chain.invoices.length
    if (tab === 'changes') return order.amendments.count
    return null
  }
  const tabs: TabItem[] = recordTabs(model.can).map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      tab === 'shipments' && openDeposits > 0 ? (
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
  // B-W2a-50: the order every day — amend, close and reopen lines, cancel, copy as a new quote (each held with its reason).
  const amendWait = amendHeld(order, model.can)
  const closeLinesWait = closeLinesHeld(order, model.can)
  const reopenWait = reopenHeld(order, model.can)
  const cancelWait = cancelHeld(order, model.can)
  const copyWait = copyHeld(model.can)
  const daily = [
    ...(!isFinal(order) && model.can.manage
      ? [
          { id: 'amend', label: t('action.amend'), disabled: !!amendWait || !!model.amend, description: model.amend ? t('held.amending') : held(amendWait), onSelect: () => actions?.onAmendStart?.() },
          { id: 'closeLines', label: t('action.closeLines'), disabled: !!closeLinesWait, description: held(closeLinesWait), onSelect: () => actions?.onDialog?.({ kind: 'closeLines' }) },
          ...(order.lines.some((line) => line.closedShort) ? [{ id: 'reopenLines', label: t('action.reopenLines'), disabled: !!reopenWait, description: held(reopenWait), onSelect: () => actions?.onDialog?.({ kind: 'reopenLines' }) }] : []),
        ]
      : []),
    ...(model.can.manageQuotes || model.can.viewQuotes ? [{ id: 'copyQuote', label: t('action.copyAsQuote'), disabled: !!copyWait, description: held(copyWait), onSelect: () => actions?.onDialog?.({ kind: 'copyQuote' }) }] : []),
    ...(!isFinal(order) && model.can.manage ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, disabled: !!cancelWait, description: held(cancelWait), onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) }] : []),
  ]
  const more: MenuItemDef[] = [
    ...(!isFinal(order) && step.kind !== 'changePromise' ? [{ id: 'promise', label: t('action.promise'), disabled: !!promiseWait, description: held(promiseWait), onSelect: () => actions?.onDialog?.({ kind: 'promise' }) }] : []),
    ...(order.status === 'IN_PRODUCTION' ? [{ id: 'ready', label: t('action.ready'), disabled: !!readyWait, description: held(readyWait), onSelect: () => actions?.onDialog?.({ kind: 'ready' }) }] : []),
    ...(mayCreateShipment(order, model.can) ? [{ id: 'ship', label: t('action.createShipment'), href: createShipmentHref(model.prefix, order.id) }] : []),
    ...(order.chain.quote && model.can.viewQuotes ? [{ id: 'quote', label: t('action.openQuote', { number: order.chain.quote.number }), href: `${model.prefix}/sales/quotes/${order.chain.quote.id}` }] : []),
    // B-W2b-180 (design conn "Portal › Orders & tracking"): the order as the customer sees it in their portal, read-only.
    ...(model.portal ? [{ id: 'portal', label: t('action.portal'), disabled: !!model.portal.held || model.portal.opening, description: model.portal.opening ? t('held.portalOpening') : held(model.portal.held), onSelect: () => actions?.onPortal?.() }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(order.number).catch(() => undefined)
      },
    },
    ...daily,
    // B-W2b-323: Set priority…, Set season…
    ...depthMenuItems(order, model.depth, actions?.depth, d),
  ]

  const late = order.daysLate !== null && order.daysLate > 0
  const depositRequest = gate.request
  const depositOverdue = gate.state === 'WAITING' && !!depositRequest && depositRequest.dueDate < model.today
  const toShipments = (
    <Button size="sm" variant="quiet" asChild>
      <Link href={`${recordHref}?tab=shipments`}>{t('tab.shipments')}</Link>
    </Button>
  )

  return (
    <>
      <RecordFrame
        recordType="SalesOrder"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(model.tab)}
        band={{
          back: <Link href={ordersHref(model.prefix)}>{t('record.back')}</Link>,
          title: (
            <span className="fw-so-title">
              {order.number} <span className="fw-so-title-sub">· {order.party?.legalName ?? '—'}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[order.status]}>{t(`status.${order.status}`)}</Pill>,
          meta: (
            <>
              {order.customerRef && <Tag tone="neutral">{t('record.customerRef', { ref: order.customerRef })}</Tag>}
              {!order.chain.quote && <Tag tone="neutral">{t('record.typed')}</Tag>}
              {order.chain.quote &&
                (model.can.viewQuotes ? (
                  <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/quotes/${order.chain.quote.id}`}>
                    {t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}
                  </Link>
                ) : (
                  <span className="fw-so-hint">{t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}</span>
                ))}
              {/* B-W2b-323: priority (URGENT with its reason), season, the confirmation sent. */}
              {model.depth && <DepthPills model={model.depth} />}
            </>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-214: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
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
          {model.depth && <DepthNotice model={model.depth} actions={actions?.depth} />}
          {order.status === 'CANCELLED' && <Banner tone="danger" title={t('record.cancelled', { reason: order.cancelReason ?? '—' })} />}
          {/* B-W2b-323: the yes the order waits for. */}
          {model.depth && <WaitingBanner model={model.depth} actions={actions?.depth} prefix={model.prefix} />}
          {/* B-W2b-368: the made-to-measure units the order waits for, each with its factory review. */}
          {model.reviewBanner}
          {order.reapprovalNeededAt && !isFinal(order) && (
            <Banner
              tone="warning"
              title={t('record.reapproval')}
              action={
                order.amendments.count > 0 && order.amendments.latestRevision !== null ? (
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={`${recordHref}?tab=changes`}>{t('record.amended', { revision: order.amendments.latestRevision })}</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
          {depositOverdue && depositRequest && <Banner tone="danger" title={t('record.depositOpen', { date: formatDate(dayInstant(depositRequest.dueDate), { locale }) })} action={toShipments} />}
          {gate.state === 'MISSING' && !isFinal(order) && <Banner tone="danger" title={t('record.depositMissing')} action={toShipments} />}
          {late && <Banner tone="warning" title={t('record.late', { count: order.daysLate ?? 0 })} />}
          {gate.state === 'WAITING' && !depositOverdue && depositRequest && <Banner tone="info" title={t('record.depositOpen', { date: formatDate(dayInstant(depositRequest.dueDate), { locale }) })} action={toShipments} />}
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
          {order.status === 'CLOSED' && <Banner tone="info" title={order.closedAt ? t('record.closed', { date: formatDate(order.closedAt, { locale }) }) : t('record.closedNoDate')} />}
          {!model.can.manage && !model.can.close && !model.can.recordPayment && !model.can.makeWorkOrders && !isFinal(order) && <Banner tone="info" title={t('record.readOnly')} />}
        </RecordNotices>

        <div className="fw-so-main">
          {model.tab === 'lines' && <LinesTab order={order} model={model} actions={actions} />}
          {/* B-TH-214: Production & dates — the production lane's tab bodies as they are, then the promise, then the tech pack in force. */}
          {model.tab === 'production' && (
            <div className="fw-so-merged">
              <ProductionTab order={order} model={model} actions={actions} />
              <DatesTab order={order} model={model} actions={actions} />
              <TechPackCard model={model.depth} actions={actions?.depth} />
            </div>
          )}
          {model.tab === 'shipments' && (
            <div className="fw-so-merged">
              <ShipmentsTab order={order} model={model} actions={actions} delivered={delivered} />
              <MoneyTab order={order} model={model} actions={actions} />
            </div>
          )}
          {model.tab === 'changes' && (
            <div className="fw-so-merged">
              <DocumentsTab order={order} model={model} actions={actions} />
              <ChangesTab order={order} model={model} actions={actions} />
            </div>
          )}
          {model.tab === 'margin' && <MarginTab margin={model.margin} prefix={model.prefix} orderId={order.id} onRetry={actions?.onRetryMargin} />}
        </div>
      </RecordFrame>

      <OrderDialogs order={order} model={model} actions={actions} />
      {model.depth && <DepthDialogs order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />}
      {/* W1 browser repair: no labels here — ds-parts' StepUpModal takes the DS words itself (this page loads no ds-words catalogue). */}
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
    </>
  )
}

const ordersHref = (prefix: string) => `${prefix}/sales/orders`

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
