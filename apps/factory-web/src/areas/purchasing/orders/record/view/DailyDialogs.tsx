'use client'

import Link from 'next/link'
import { Banner, DateTimeField, Field, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity, type Phrase } from '../../../../_shared/buying/model'
import type { OrderReach, PurchaseOrder } from '../../api'
import { addedInDraft, reachHeld, reachLineHeld, type DailyDialog, type SendExtra } from '../../daily-model'
import type { OrderRecordActions, OrderRecordModel } from '../../model'

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * A phrase in words: a `buying:` key from the buying catalogue, a `purchasing-orders:` key from this step's, an unprefixed
 * key from the screen's own namespace (`purchasing-orders` for the daily rules; the record's notices pass `buying`).
 */
export function useSay(own: 'purchasing-orders' | 'buying' = 'purchasing-orders') {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  return (words: Phrase | null | undefined): string | null => {
    if (!words) return null
    if (words.key.startsWith('buying:')) return tb(words.key.slice('buying:'.length), words.params)
    if (words.key.startsWith('purchasing-orders:')) return t(words.key.slice('purchasing-orders:'.length), words.params)
    return own === 'buying' ? tb(words.key, words.params) : t(words.key, words.params)
  }
}

/**
 * The PO studio's daily dialogs (B-W2a-69, on B-W2a-52): Change (the next revision's draft: the supplier's links stop, the
 * supplier sees it after the send), Counter-propose, Cancel the order with its reach (lines, the plan lines that open
 * again, the work and sales orders that lose this supply, the supplier told, a confirmed order is a contract), Cancel lines
 * / Close short with the same reach per line, Move the confirm-by time and Remind the supplier. Every refusal is said inside
 * its dialog in this app's words; one Idempotency-Key per dialog (the container).
 */
export function DailyDialogs({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'change':
    case 'counter':
      return <ChangeDialog order={order} model={model} actions={actions} dialog={dialog} />
    case 'cancelOrder':
      return <CancelOrderDialog order={order} model={model} actions={actions} dialog={dialog} />
    case 'endLines':
      return <EndLinesDialog order={order} model={model} actions={actions} dialog={dialog} />
    case 'confirmBy':
      return <ConfirmByDialog order={order} model={model} actions={actions} dialog={dialog} />
    case 'remind':
      return <RemindDialog order={order} model={model} actions={actions} dialog={dialog} />
    default:
      return null
  }
}

function Footer({ model, actions, label, held, tone, onConfirm }: { model: OrderRecordModel; actions?: OrderRecordActions; label: string; held: string | null; tone?: 'danger'; onConfirm?: () => void }) {
  const tb = useT('buying')
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? tb('held.busy') : null}>
        {tb('common.cancel')}
      </Button>
      <Button size="sm" variant="primary" tone={tone} heldReason={model.busy ? tb('held.busy') : held} onClick={onConfirm}>
        {model.busy && <Spinner size={12} />} {label}
      </Button>
    </>
  )
}

function Problem({ model }: { model: OrderRecordModel }) {
  // A write's refusal: writeProblem's keys are buying's; this step's own are prefixed `purchasing-orders:`.
  const say = useSay('buying')
  return model.dialogProblem ? <Banner tone="danger" title={say(model.dialogProblem) ?? ''} /> : null
}

function ChangeDialog({ order, model, actions, dialog }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; dialog: Extract<DailyDialog, { kind: 'change' | 'counter' }> }) {
  const t = useT('purchasing-orders')
  const counter = dialog.kind === 'counter'
  const next = order.revision + 1
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(counter ? 'counter.title' : 'change.title', { number: order.number, revision: next })}
      size="md"
      footer={<Footer model={model} actions={actions} label={t(counter ? 'counter.confirm' : 'change.confirm', { revision: next })} held={null} onConfirm={() => (counter ? actions?.daily?.onCounter?.() : actions?.daily?.onChange?.())} />}
    >
      <div className="fw-by-dialog">
        <ul className="fw-by-list">
          <li>{t('change.becomesDraft', { revision: next })}</li>
          <li>{t('change.linksStop', { supplier: order.supplier.name })}</li>
          {order.status === 'CONFIRMED' && <li>{t('change.confirmedAgain', { supplier: order.supplier.name })}</li>}
          {counter && <li>{t('counter.fromAsked', { revision: next })}</li>}
          <li>{t('change.sendAfter')}</li>
        </ul>
        <Field label={t('change.note')} hint={t('change.noteHint')}>
          <Textarea rows={3} maxLength={1000} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/** The reach of a cancel or a close short: per line what came and what is still expected, the plan, the orders it supplies. */
function ReachTable({ order, model, reach, action }: { order: PurchaseOrder; model: OrderRecordModel; reach: OrderReach; action: OrderReach['action'] }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const say = useSay()
  const locale = useLocale()
  const added = addedInDraft(model.revisions.value)
  return (
    <SummaryTable
      label={t('reach.tableLabel')}
      density="compact"
      stackOnPhone
      columns={[tb('po.col.seq'), tb('po.col.material'), t('reach.col.ordered'), t('reach.col.received'), t('reach.col.outstanding'), t('reach.col.supplies'), ...(action === 'CANCEL_ORDER' ? [] : [t('reach.col.held')])]}
      align={['right', 'left', 'right', 'right', 'right', 'left', ...(action === 'CANCEL_ORDER' ? [] : ['left' as const])]}
      rows={reach.lines.map((entry) => {
        const line = order.lines.find((candidate) => candidate.id === entry.lineId)
        const unit = tb(`uom.${entry.baseUom}`)
        const supplies = [...new Set(entry.pegged.map((peg) => peg.workOrder?.number ?? peg.salesOrder?.number ?? t(`reach.demand.${peg.kind === 'SAFETY_STOCK' || peg.kind === 'REORDER' ? peg.kind : 'OTHER'}`)))]
        const held = line && action !== 'CANCEL_ORDER' ? say(reachLineHeld(order, action, line, reach.status, added)) : null
        return {
          id: entry.lineId,
          cells: [
            String(entry.seq),
            line ? `${line.item.code} · ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}` : '—',
            `${quantity(entry.orderedBase, locale)} ${unit}`,
            `${quantity(entry.receivedBase, locale)} ${unit}`,
            `${quantity(entry.outstandingBase, locale)} ${unit}`,
            <span key="supplies" className="fw-by-cell">
              <span>{supplies.length > 0 ? supplies.join(' · ') : t('reach.suppliesNothing')}</span>
              {entry.planLineIds.length > 0 && <span className="fw-by-cell-sub">{t('reach.planLines', { count: entry.planLineIds.length })}</span>}
            </span>,
            ...(action === 'CANCEL_ORDER' ? [] : [held ?? t('reach.lineOk')]),
          ],
        }
      })}
    />
  )
}

/** Who loses this supply: the work and sales orders the plan pegs on the lines (links), or none. */
function ReachOrders({ model, reach }: { model: OrderRecordModel; reach: OrderReach }) {
  const t = useT('purchasing-orders')
  if (reach.workOrders.length === 0 && reach.salesOrders.length === 0) return <li>{reach.runId ? t('reach.noOrders') : t('reach.noPlan')}</li>
  return (
    <>
      {reach.workOrders.length > 0 && (
        <li>
          {t('reach.workOrders', { count: reach.workOrders.length })}{' '}
          {reach.workOrders.map((order, index) => (
            <span key={order.id}>
              {index > 0 && ', '}
              <Link className="fw-by-link" href={`${model.prefix}/production/work-orders/${order.id}`}>
                {order.number ?? t('reach.unnumbered')}
              </Link>
            </span>
          ))}
        </li>
      )}
      {reach.salesOrders.length > 0 && (
        <li>
          {t('reach.salesOrders', { count: reach.salesOrders.length })}{' '}
          {reach.salesOrders.map((order, index) => (
            <span key={order.id}>
              {index > 0 && ', '}
              <Link className="fw-by-link" href={`${model.prefix}/sales/orders/${order.id}`}>
                {order.number ?? t('reach.unnumbered')}
              </Link>
            </span>
          ))}
        </li>
      )}
    </>
  )
}

function ReachLoading({ reach, onRetry }: { reach: Extract<DailyDialog, { kind: 'cancelOrder' }>['reach']; onRetry?: () => void }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  if (reach.status === 'loading')
    return (
      <p className="fw-by-hint" role="status">
        <Spinner size={14} /> {t('reach.loading')}
      </p>
    )
  return (
    <Banner
      tone="danger"
      title={t('reach.failed')}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {tb('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {reach.status === 'error' ? tb(reach.problem) : tb('problem.gone')}
    </Banner>
  )
}

function CancelOrderDialog({ order, model, actions, dialog }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; dialog: Extract<DailyDialog, { kind: 'cancelOrder' }> }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const say = useSay()
  const reach = dialog.reach.status === 'ready' ? dialog.reach.value : null
  const held = !reach ? t(dialog.reach.status === 'loading' ? 'reach.waiting' : 'reach.failed') : (say(reachHeld(order, 'CANCEL_ORDER', reach, addedInDraft(model.revisions.value), model.can)) ?? (dialog.reason.trim() === '' ? tb('po.cancel.reasonNeeded') : null))
  const planned = reach ? reach.lines.reduce((sum, line) => sum + line.planLineIds.length, 0) : 0
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={tb('po.cancel.title', { number: order.number })}
      size="xl"
      footer={<Footer model={model} actions={actions} label={tb('po.cancel.confirm')} tone="danger" held={held} onConfirm={() => actions?.daily?.onConfirmCancel?.()} />}
    >
      <div className="fw-by-dialog">
        {!reach ? (
          <ReachLoading reach={dialog.reach} onRetry={() => actions?.daily?.onCancelOrder?.()} />
        ) : (
          <>
            {reach.confirmed && <Banner tone="warning" title={t('cancel.confirmed', { supplier: order.supplier.name })} />}
            <ul className="fw-by-list">
              <li>{tb('po.cancel.reach', { count: reach.lines.length })}</li>
              {planned > 0 && <li>{tb('po.cancel.plan', { count: planned })}</li>}
              <ReachOrders model={model} reach={reach} />
              <li>{reach.supplierTold ? tb('po.cancel.supplierTold', { supplier: order.supplier.name }) : tb('po.cancel.draftOnly')}</li>
              <li>{tb('po.cancel.final')}</li>
            </ul>
            {reach.lines.length > 0 && <ReachTable order={order} model={model} reach={reach} action="CANCEL_ORDER" />}
          </>
        )}
        <Field label={tb('po.cancel.reason')} required hint={tb('po.cancel.reasonHint')}>
          <Textarea rows={3} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
        {reach?.supplierTold && (
          <Field label={tb('po.cancel.message')} hint={tb('po.cancel.messageHint')}>
            <Textarea rows={3} maxLength={2000} value={dialog.message} onChange={(event) => actions?.onDialog?.({ ...dialog, message: event.target.value })} />
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function EndLinesDialog({ order, model, actions, dialog }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; dialog: Extract<DailyDialog, { kind: 'endLines' }> }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const say = useSay()
  const close = dialog.action === 'CLOSE_SHORT'
  const reach = dialog.reach.status === 'ready' ? dialog.reach.value : null
  const held = !reach ? t(dialog.reach.status === 'loading' ? 'reach.waiting' : 'reach.failed') : (say(reachHeld(order, dialog.action, reach, addedInDraft(model.revisions.value), model.can)) ?? (dialog.reason.trim() === '' ? tb('po.cancel.reasonNeeded') : null))
  const planned = reach ? reach.lines.reduce((sum, line) => sum + line.planLineIds.length, 0) : 0
  const count = dialog.lineIds.length
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(close ? 'end.closeTitle' : 'end.cancelTitle', { count, number: order.number })}
      size="xl"
      footer={<Footer model={model} actions={actions} label={t(close ? 'end.closeConfirm' : 'end.cancelConfirm', { count })} tone="danger" held={held} onConfirm={() => actions?.daily?.onConfirmEnd?.()} />}
    >
      <div className="fw-by-dialog">
        {!reach ? (
          <ReachLoading reach={dialog.reach} onRetry={() => actions?.daily?.onEndLines?.(dialog.action, dialog.lineIds)} />
        ) : (
          <>
            <ul className="fw-by-list">
              <li>{t(close ? 'end.closeMeans' : 'end.cancelMeans', { count })}</li>
              {planned > 0 && <li>{t('end.plan', { count: planned })}</li>}
              <ReachOrders model={model} reach={reach} />
              <li>{reach.supplierTold ? t('end.supplierTold', { supplier: order.supplier.name }) : order.status === 'DRAFT' ? t('end.withRevision', { revision: order.revision }) : t('end.supplierNotTold')}</li>
            </ul>
            <ReachTable order={order} model={model} reach={reach} action={dialog.action} />
          </>
        )}
        <Field label={tb('po.cancel.reason')} required hint={tb('po.cancel.reasonHint')}>
          <Textarea rows={3} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
        {reach?.supplierTold && (
          <Field label={tb('po.cancel.message')} hint={tb('po.cancel.messageHint')}>
            <Textarea rows={3} maxLength={2000} value={dialog.message} onChange={(event) => actions?.onDialog?.({ ...dialog, message: event.target.value })} />
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function ConfirmByDialog({ order, model, actions, dialog }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; dialog: Extract<DailyDialog, { kind: 'confirmBy' }> }) {
  const t = useT('purchasing-orders')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const held = dialog.confirmBy === '' ? t('confirmBy.pick') : order.confirmBy && Date.parse(dialog.confirmBy) === Date.parse(order.confirmBy) ? t('confirmBy.same') : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('confirmBy.title', { number: order.number })} size="md" footer={<Footer model={model} actions={actions} label={t('confirmBy.confirm')} held={held} onConfirm={() => actions?.daily?.onConfirmBy?.()} />}>
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{order.confirmBy ? t('confirmBy.now', { time: formatDateTime(order.confirmBy, place) }) : t('confirmBy.none')}</p>
        <Field label={t('confirmBy.label')} hint={t('confirmBy.hint')}>
          <DateTimeField value={dialog.confirmBy} onChange={(value) => actions?.onDialog?.({ ...dialog, confirmBy: value })} min={model.now ?? undefined} locale={dateLocale(locale)} ariaLabel={t('confirmBy.label')} />
        </Field>
        <ul className="fw-by-list">
          <li>{t('confirmBy.nothingSent', { supplier: order.supplier.name })}</li>
          <li>{t('confirmBy.alert')}</li>
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RemindDialog({ order, model, actions, dialog }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; dialog: Extract<DailyDialog, { kind: 'remind' }> }) {
  const t = useT('purchasing-orders')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const reminders = model.reminders.value
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('remind.title', { supplier: order.supplier.name })} size="md" footer={<Footer model={model} actions={actions} label={t('remind.confirm')} held={order.contact?.email ? null : t('remind.held.noEmail')} onConfirm={() => actions?.daily?.onRemind?.()} />}>
      <div className="fw-by-dialog">
        <ul className="fw-by-list">
          <li>{t('remind.to', { name: order.contact?.name ?? '—', email: order.contact?.email ?? '—' })}</li>
          <li>{order.confirmBy ? t('remind.asked', { time: formatDateTime(order.confirmBy, place) }) : t('remind.askedNone')}</li>
          <li>{t('remind.noLink')}</li>
          {reminders && reminders.reminders.length > 0 && <li>{t('remind.before', { count: reminders.reminders.filter((entry) => entry.revision === order.revision).length })}</li>}
          <li>{t('remind.fake')}</li>
        </ul>
        <Field label={t('remind.message')} hint={t('remind.messageHint')}>
          <Textarea rows={3} maxLength={2000} value={dialog.message} onChange={(event) => actions?.onDialog?.({ ...dialog, message: event.target.value })} autoFocus />
        </Field>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/**
 * The send dialog's own fields of a purchase order (the shared dialog's `extra`): when the supplier is asked to answer by
 * (default 48 h, longer by its closed days — the API's default; editable), and a later revision's note to the supplier with
 * what changed in the supplier's words.
 */
export function SendExtraFields({ order, model, actions, defaultConfirmBy, changes }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; defaultConfirmBy: string | null; changes: readonly string[] | null }) {
  const t = useT('purchasing-orders')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const extra: SendExtra = model.sendExtra ?? { confirmBy: '', changeNote: '' }
  const shown = extra.confirmBy || defaultConfirmBy || ''
  return (
    <div className="fw-by-stack">
      <Field label={t('send.confirmBy')} hint={defaultConfirmBy ? t('send.confirmByHint', { time: formatDateTime(defaultConfirmBy, place) }) : t('send.confirmByHintNone')}>
        <DateTimeField value={shown} onChange={(value) => actions?.daily?.onSendExtra?.({ ...extra, confirmBy: value })} min={model.now ?? undefined} locale={dateLocale(locale)} ariaLabel={t('send.confirmBy')} disabled={!model.can.poSend} />
      </Field>
      {order.revision > 1 && (
        <>
          {changes && changes.length > 0 && (
            <div className="fw-by-stack">
              <span className="fw-by-hint">{t('send.changesTold', { revision: order.revision })}</span>
              <ul className="fw-by-list">
                {changes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <Field label={t('send.changeNote')} hint={t('send.changeNoteHint')}>
            <Textarea rows={3} maxLength={1000} value={extra.changeNote} onChange={(event) => actions?.daily?.onSendExtra?.({ ...extra, changeNote: event.target.value })} readOnly={!model.can.poSend} />
          </Field>
        </>
      )}
    </div>
  )
}
