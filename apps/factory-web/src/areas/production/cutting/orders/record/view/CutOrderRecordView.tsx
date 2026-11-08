'use client'

import Link from 'next/link'
import { CheckCheck, FileText, FileX, MoreHorizontal, Send, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { LiveState } from '../../../../_shared/hooks'
import type { Part, Phrase } from '../../../model'
import type { CutOrderRecord, Printer, PrintAnswer, Reconciliation, RollCandidates } from '../../api'
import { backHeld, cancelHeld, liveLays, ORDER_TABS, ORDER_TONE, ORDERS_NAMESPACE, orderMaterial, planPhrase, releaseHeld, sheetHref, type OrderTab, type OrdersCan, type ReconcileDraft } from '../../model'
import { OrdersMessages, useSay } from '../../view/parts'
import { PrintDialog, ReasonDialog, ReconcileDialog, RollsDialog, VoidDialog } from './dialogs'
import { LaysTab, PiecesTab, TicketsTab, YieldTab } from './tabs'
import '../../../cutting.css'

export type OrderDialog =
  | { readonly kind: 'rolls'; readonly layId: string }
  | { readonly kind: 'reconcile' }
  | { readonly kind: 'print'; readonly ticketIds: readonly string[] }
  | { readonly kind: 'void'; readonly ticketId: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'cancel' }

export interface CutOrderRecordModel {
  readonly prefix: string
  readonly can: OrdersCan
  readonly tab: OrderTab
  readonly timeZone: string
  readonly record: { readonly status: 'loading' | 'ready' | 'forbidden' | 'missing' | 'error'; readonly value: CutOrderRecord | null; readonly problem: string | null }
  /** Ordered, cut and recut per line and size, the fabric per lay (Pieces, Yield, Reconcile cut). */
  readonly recon: Part<Reconciliation>
  readonly live: LiveState
  readonly dialog: OrderDialog | null
  /** Allocate rolls: the rolls of the fabric (read when the dialog opens). */
  readonly candidates: Part<RollCandidates>
  /** Print: the site's label printers (read when the dialog opens). */
  readonly printers: Part<readonly Printer[]>
  readonly reconcile: ReconcileDraft
  /** The label of a ticket shown, not printed (`printerId: null`). */
  readonly shown: PrintAnswer | null
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly notice: { readonly tone: 'success' | 'danger' | 'info' | 'warning'; readonly words: Phrase } | null
  /** Design cases: the rolls ticked in Allocate rolls, the tickets selected. */
  readonly rollsPicked?: readonly string[]
  readonly ticketsSelected?: readonly string[]
}

export interface CutOrderRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'recon' | 'candidates' | 'printers') => void
  onDialog?: (dialog: OrderDialog | null) => void
  onRelease?: () => void
  onBack?: (reason: string) => void
  onCancel?: (reason: string) => void
  onAllocate?: (layId: string, rolls: { rollId: string; plies: number }[]) => void
  onRemoveRoll?: (layId: string, layRollId: string) => void
  onPrint?: (ticketIds: readonly string[], printerId: string | null | undefined, language: 'it' | 'en') => void
  onVoid?: (ticketId: string, reason: string, replace: boolean) => void
  onReconcileDraft?: (draft: ReconcileDraft) => void
  onReconcile?: () => void
  onDismissNotice?: () => void
  onDismissShown?: () => void
}

/**
 * SCR-238-order — a cut order (design production.cutting "Record: Cut", opens as a record page, W2b: a cut order of several work
 * orders, MES-034): the band (‹ Cutting, "Cut order · CO-…", its status, kind, material and colour, the plan in words, the work
 * orders; Release while planned, Reconcile cut once cut — the record's primary —, the lay sheet / cut ticket PDF in a new tab,
 * ⋯ Back to planning and Cancel with a reason), the tabs Lay or hides (the marker; the Lays grid: lay · marker · sizes in the
 * marker · plies · length · rolls, Allocate rolls where mixing shade or shrinkage groups in one lay is refused with the reason;
 * leather: the work orders' hides), Pieces (ordered, cut and recut per line and size), Yield (fabric issued vs used vs returned,
 * per lay and summed) and Tickets (each lay's cut ticket: print, show the label, void with a reason). Never who cut, spread or
 * counted. No money.
 */
export function CutOrderRecordView({ model, actions }: { model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  return (
    <OrdersMessages>
      <Record model={model} actions={actions} />
    </OrdersMessages>
  )
}

function Record({ model, actions }: { model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const listHref = `${model.prefix}/production/cutting`
  const loaded = model.record
  const missing = !model.can.view ? 'production.cutting.view' : null
  if (missing || loaded.status !== 'ready' || !loaded.value) {
    const busy = loaded.status === 'loading' && !missing
    return (
      <div className="fw-ct">
        <DetailHeader dense backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={busy ? <Skeleton width={240} height={22} /> : t('record.title')} />
        <Card padded aria-busy={busy}>
          {busy ? (
            <div className="fw-ct-body">
              <p className="fw-ct-hint" role="status">
                <Spinner size={14} /> {t('record.loading')}
              </p>
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={missing || loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={missing ? t('record.state.forbidden.title') : t(`record.state.${loaded.status === 'ready' ? 'missing' : loaded.status}.title`)}
              description={missing ? t('noAccess.body', { permission: missing }) : loaded.status === 'error' ? t(loaded.problem ?? 'problem.read') : t(`record.state.${loaded.status === 'ready' ? 'missing' : loaded.status}.body`)}
              action={
                loaded.status === 'error' && !missing ? (
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
          )}
        </Card>
      </div>
    )
  }
  return <Ready record={loaded.value} model={model} actions={actions} />
}

function Ready({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const order = record.cutOrder
  const recordHref = `${model.prefix}/production/cutting/orders/${order.id}`
  const lays = liveLays(record)
  const plan = planPhrase(order)
  const count = (tab: OrderTab): number | null => {
    if (tab === 'lay') return order.kind === 'FABRIC' ? lays.length : null
    if (tab === 'tickets') return record.tickets.filter((ticket) => ticket.status === 'OPEN' || ticket.status === 'STARTED').length || null
    return null
  }
  const tabs: TabItem[] = ORDER_TABS.map((tab) => ({ id: tab, href: tab === 'lay' ? recordHref : `${recordHref}?tab=${tab}`, label: t(`tab.${tab}`), count: count(tab) }))
  const releaseWhy = say(releaseHeld(record, model.can, model.busy))
  const reconcileWhy = !model.can.manage ? t('held.permission', { permission: 'production.cutorders.manage' }) : order.status === 'RECONCILED' ? t('held.reconcile.done') : order.status !== 'CUT' ? t('held.reconcile.notCut') : null
  const backWhy = say(backHeld(record, model.can, model.busy))
  const cancelWhy = say(cancelHeld(record, model.can, model.busy))
  const held = record.lines.filter((line) => line.workOrder.status === 'ON_HOLD')
  const more = [
    { id: 'back', label: t('record.toPlanning'), disabled: !!backWhy, description: backWhy ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'back' }) },
    { id: 'cancel', label: t('record.cancelAction'), tone: 'danger' as const, disabled: !!cancelWhy, description: cancelWhy ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) },
    {
      id: 'copy',
      label: t('record.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(order.number).catch(() => undefined)
      },
    },
  ]
  return (
    <div className="fw-ct">
      <div className="fw-ct-band">
        <DetailHeader
          dense
          backAsChild
          backLabel={<Link href={`${model.prefix}/production/cutting`}>{t('record.back')}</Link>}
          title={t('record.titleOf', { number: order.number })}
          meta={
            <span className="fw-ct-inline">
              <Pill tone={ORDER_TONE[order.status]}>{t(`status.${order.status}`)}</Pill>
              <span className="fw-ct-hint">
                {t(`kind.${order.kind}`)} · {orderMaterial(order)} · {t(plan.key, plan.params)}
                {order.dueDate ? ` · ${t('record.due', { date: formatDate(`${order.dueDate}T12:00:00Z`, { locale, timeZone: model.timeZone }) })}` : ''}
              </span>
            </span>
          }
          status={<span className="fw-ct-status">{t(`live.${model.live}`)}</span>}
          actions={
            <span className="fw-ct-actions">
              <Button size="sm" asChild>
                <a href={sheetHref(model.prefix, order.id)} target="_blank" rel="noopener noreferrer">
                  <FileText size={14} aria-hidden /> {t('record.sheet')}
                </a>
              </Button>
              {order.status === 'PLANNED' ? (
                <Button size="sm" variant="primary" heldReason={releaseWhy} onClick={() => actions?.onRelease?.()}>
                  {model.busy ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {t('record.release')}
                </Button>
              ) : (
                <Button size="sm" variant={order.status === 'CUT' ? 'primary' : undefined} heldReason={reconcileWhy} onClick={() => actions?.onDialog?.({ kind: 'reconcile' })}>
                  <CheckCheck size={14} aria-hidden /> {t('record.reconcile')}
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={more} />
            </span>
          }
        />
        <p className="fw-ct-hint">{t('record.workOrders', { list: order.workOrders.map((workOrder) => workOrder.number).join(', '), styles: order.styles.map((style) => style.code).join(', ') })}</p>
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} size="sm" />
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {order.status === 'CANCELLED' && <Banner tone="neutral" title={t('record.cancelled.title')}>{t('record.cancelled.body', { reason: order.cancelReason ?? t('common.noReason') })}</Banner>}
      {held.length > 0 && <Banner tone="warning" title={t('record.held.title', { count: held.length })}>{held.map((line) => t('record.held.line', { number: line.workOrder.number, reason: line.workOrder.holdReason ?? t('common.noReason') })).join(' · ')}</Banner>}
      {record.warnings.map((warning) => (
        <Banner key={warning.code} tone="warning" title={t(`warning.${warning.code}`)} />
      ))}

      <div className="fw-ct-body">
        {model.tab === 'lay' && <LaysTab record={record} model={model} actions={actions} />}
        {model.tab === 'pieces' && <PiecesTab record={record} model={model} actions={actions} />}
        {model.tab === 'yield' && <YieldTab record={record} model={model} actions={actions} />}
        {model.tab === 'tickets' && <TicketsTab record={record} model={model} actions={actions} />}
      </div>

      {model.dialog?.kind === 'rolls' && <RollsDialog record={record} model={model} layId={model.dialog.layId} actions={actions} />}
      {model.dialog?.kind === 'reconcile' && <ReconcileDialog record={record} model={model} actions={actions} />}
      {model.dialog?.kind === 'print' && <PrintDialog record={record} model={model} ticketIds={model.dialog.ticketIds} actions={actions} />}
      {model.dialog?.kind === 'void' && <VoidDialog record={record} model={model} ticketId={model.dialog.ticketId} actions={actions} />}
      {(model.dialog?.kind === 'back' || model.dialog?.kind === 'cancel') && <ReasonDialog record={record} model={model} kind={model.dialog.kind} actions={actions} />}
    </div>
  )
}
