'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Banknote, Factory, Hand, Info, Receipt, Send, Truck } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, ExpandToggle, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { money } from '../../../../quotes/model'
import type { DepositRequest, Order, PlanPayment } from '../../../api'
import { dayInstant, depositInvoicesOf, depositSteps, SDI_TONE, sdiSendHeld, type DepositStepState } from '../../../model'
import { discussAboutOf } from '../../dock/discuss'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { isHandAct, type PlanAct, type PlanRow } from '../plan'
import type { Say } from './say'

const financePayHref = (prefix: string, invoiceId: string) => `${prefix}/finance/payments?new=1&invoice=${encodeURIComponent(invoiceId)}`

/**
 * F-OM-103 (order MONEY tab, 10-design §5) — one row of the payment plan: [▸] title · share + pill + tags | due | notes | amount
 * (+ what is left) | ONE next act | ⋯ — the columns by the list's own room (money.css: stacked under 560 px, the act full width and
 * 44 px to tap; 4 columns from 560, 5 from 1000, 6 from 1500), the act column a fixed width so the doors line up row to row. A row
 * with a request unfolds (open while it waits, folded when paid): its steps (Asked → Page sent → Paid → Deposit invoice (TD02) → SDI)
 * and its payments. The row's id is its anchor (`about-DepositRequest-<id>`, else `about-Step-<id>`: the dock's "Show on the page").
 * Acts hidden without their right (plan.ts), held with words only by state; Discuss (an office note) needs threads.post.
 */
export function PlanRowView({ row, order, model, actions, say, final }: { row: PlanRow; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; say: Say; final: boolean }) {
  const t = useT('orders')
  const f = useT('record-frame')
  const locale = useLocale()
  const frame = useRecordFrame()
  const search = useSearchParams()?.toString() ?? ''
  // Open while it waits (plan.ts), and while its TD02 waits to be sent by a reader who sends it (the SDI read comes after the row:
  // the reader's own toggle wins once made).
  const td02 = row.request ? (depositInvoicesOf(row.request, order.chain.invoices).find((invoice) => invoice.status !== 'DRAFT') ?? null) : null
  const sendNext = td02 ? model.sdi?.[td02.id]?.value?.state.next.action : undefined
  const sdiWaits = model.can.issueInvoices && (sendNext === 'SEND' || sendNext === 'SEND_AGAIN')
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? (row.openAtFirst || sdiWaits)
  const busy = model.busy || model.scheduleSteps?.busy ? t('schedule.verbs.held.busy') : null
  const heldOf = (act: PlanAct): string | null => (act.held ? say(act.held) : busy)
  const title = say(row.title)
  const step = row.step
  const request = row.request
  const run = (act: PlanAct) => {
    // F-OM-201: a hand act opens its window (mounted once by the page: MoneyDialogs).
    if (isHandAct(act.id)) return actions?.onDialog?.({ kind: 'moneyPlan', act: act.id, stepId: step?.id ?? null, requestId: request?.id ?? null })
    if (act.id === 'record' && request) return actions?.onDialog?.({ kind: 'depositPayment', requestId: request.id })
    if (act.id === 'send' && request) return actions?.onDialog?.({ kind: 'depositLink', requestId: request.id })
    if (act.id === 'stopPage' && request) return actions?.onDialog?.({ kind: 'stopPage', requestId: request.id }) // F-OM-202 (B-OM-022)
    if (act.id === 'open' && step) return act.needsDay ? actions?.scheduleSteps?.onOpen?.(step) : actions?.scheduleSteps?.onConfirmOpen?.(step, null)
    if (act.id === 'invoiceStep' && step) return actions?.scheduleSteps?.onInvoice?.(step)
    if (act.id === 'waive') {
      const stepKind = row.kind === 'BEFORE_SHIPPING' ? ('BEFORE_SHIPPING' as const) : ('DEPOSIT' as const)
      const target = step ? { kind: 'step' as const, id: step.id, version: step.version } : request ? { kind: 'request' as const, id: request.id, version: request.version } : null
      if (target) actions?.scheduleSteps?.onWaive?.({ target, label: title, stepKind })
    }
    return undefined
  }
  const invoiceHref = (id: string, number: string | null) => `${model.prefix}${recordAddress({ type: 'Invoice', id, label: number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`

  // ---- the ONE act ----
  const act = row.act
  const primary = act ? (
    act.id === 'payInvoice' && row.invoice ? (
      <Button size="sm" asChild>
        <Link href={financePayHref(model.prefix, row.invoice.id)}>
          <Banknote size={13} aria-hidden /> {say(act.label)}
        </Link>
      </Button>
    ) : (
      <Button size="sm" variant={act.id === 'record' || act.id === 'send' || act.id === 'ACCEPT_SHORT' /* F-OM-fx3 (W-01) */ ? 'primary' : 'secondary'} heldReason={heldOf(act)} onClick={() => run(act)}>
        {act.id === 'send' ? <Send size={13} aria-hidden /> : act.id === 'record' ? <Banknote size={13} aria-hidden /> : null} {say(act.label)}
      </Button>
    )
  ) : null

  // ---- its ⋯: the other acts, the invoice, Discuss (threads.post), Copy link ----
  const items: MenuItemDef[] = row.more.map((entry) => {
    const held = heldOf(entry)
    if (entry.id === 'payInvoice' && row.invoice) return { id: entry.id, label: say(entry.label), href: financePayHref(model.prefix, row.invoice.id) }
    return { id: entry.id, label: say(entry.label), disabled: !!held, description: held ?? undefined, onSelect: () => void run(entry) }
  })
  if (row.invoice && model.can.viewInvoices) items.push({ id: 'invoice', label: t('moneyTab.plan.menu.openInvoice', { number: row.invoice.number }), href: invoiceHref(row.invoice.id, row.invoice.number) })
  if (model.can.threadsPost && frame?.discuss) {
    const part = say(row.discuss.part)
    // F-SA-266: Money's rows are discussed in office notes only (a chip here never goes into a reply).
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part, target: row.discuss.target, officeOnly: true })
    items.push({ id: 'discuss', label: f('discuss.of', { thing: part }), onSelect: () => frame.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about }) })
  }
  // F-OM-fx3 (W-08): Show in the thread — a read door (Read-only keeps it): the feed at this row's newest moment.
  const showAt = row.showAt
  if (showAt && frame?.showInThread) items.push({ id: 'show', label: f('discuss.showInThread'), onSelect: () => frame.showInThread?.({ record: { type: 'SalesOrder', id: order.id }, at: showAt }) })
  items.push({
    id: 'link',
    label: t('moneyTab.menu.copyLinkRow'),
    onSelect: () => void navigator.clipboard?.writeText(new URL(`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'money', search)}#${row.anchor}`, window.location.href).toString()),
  })

  const noteIcon = (tone: 'warning' | 'neutral', key: string) => (key.includes('production') || key.includes('extraWaits') || key.includes('depositMissing') ? <Factory size={13} aria-hidden /> : key.includes('holdsShipment') ? <Truck size={13} aria-hidden /> : tone === 'neutral' ? <Receipt size={13} aria-hidden /> : null)
  return (
    <div className={`fw-om-pr${row.done ? ' is-done' : ''}`} id={row.anchor} tabIndex={-1}>
      {row.alias ? <span id={row.alias} className="fw-om-alias" tabIndex={-1} /> : null}
      <div className="fw-om-pr-g">
        <div className="fw-om-pr-k">
          {row.unfolds ? <ExpandToggle expanded={open} label={t(open ? 'moneyTab.plan.fold' : 'moneyTab.plan.unfold')} onClick={() => setToggled(!open)} /> : <span className="fw-om-pr-sp" aria-hidden />}
          <span className="fw-om-pr-kt">
            <b>{title}</b>
            <Pill tone={row.pill.tone}>{say(row.pill.word)}</Pill>
            {row.byHand ? (
              <Tag tone="info">
                <Hand size={12} aria-hidden /> {t('moneyTab.plan.setByHand')}
              </Tag>
            ) : null}
            {row.sub ? <span className="fw-pt-sub">{say(row.sub)}</span> : null}
            {/* L8: a priced change's extra deposit names its change (Changes › What changed). */}
            {row.fromChange ? (
              <Link className="fw-pt-link" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'changes', search)}#history`}>
                {t('moneyTab.plan.fromChange', { revision: row.fromChange.revision })}
              </Link>
            ) : null}
          </span>
        </div>
        <div className="fw-om-pr-m">
          {row.amount !== null ? <span className="fw-om-amt">{money(row.amount, order.currency, locale)}</span> : null}
          {row.left !== null && row.left > 0 ? <span className="fw-om-left">{t('deposit.left', { amount: money(row.left, order.currency, locale) })}</span> : null}
        </div>
        <div className="fw-om-pr-d">
          <span>{say(row.due)}</span>
          {row.dueSub ? <span className="fw-pt-sub">{say(row.dueSub)}</span> : null}
        </div>
        <div className="fw-om-pr-n">
          {row.notes.map((note) => (
            <span key={note.word.key} className={note.tone === 'warning' ? 'is-warning' : undefined}>
              {noteIcon(note.tone, note.word.key)}
              {say(note.word)}
            </span>
          ))}
          {row.byHand ? (
            <span className="is-hand">
              <Hand size={13} aria-hidden />
              {say(row.byHand.word)}
              {row.byHand.reason ? ` · “${row.byHand.reason}”` : ''}
            </span>
          ) : null}
        </div>
        <div className="fw-om-pr-a">{final ? null : primary}</div>
        <div className="fw-om-pr-o">
          <LineMenuButton label={t('moneyTab.plan.more', { row: title })} items={items} />
        </div>
      </div>
      {row.unfolds && open && request ? <RequestBox row={row} request={request} order={order} model={model} actions={actions} invoiceHref={invoiceHref} say={say} /> : null}
    </div>
  )
}

/**
 * F-OM-202 (B-OM-017): one payment's ⋯ — Undo this payment… (the server's verdict: a door when it may; held in its words when the
 * state holds it — a TD02 issued for it: a credit note first, in Finance; hidden without the rights), Open in Finance › Payments ›
 * (payments.view), Copy the bank reference. A closed order: no undo.
 */
function PaymentMenu({ payment, request, model, actions }: { payment: PlanPayment; request: DepositRequest; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const order = model.order.status === 'ready' ? model.order.value : null
  const final = !order || order.status === 'CLOSED' || order.status === 'CANCELLED'
  const items: MenuItemDef[] = []
  const undo = payment.undo
  if (!final && undo && (undo.may || undo.why)) {
    const why = undo.why ? undo.why[locale === 'it' ? 'it' : 'en'] : null
    items.push(undo.may ? { id: 'undo', label: t('moneyTab.payment.undo'), onSelect: () => actions?.onDialog?.({ kind: 'undoPayment', requestId: request.id, paymentId: payment.paymentId }) } : { id: 'undo', label: t('moneyTab.payment.undo'), disabled: true, description: why ?? undefined })
  }
  if (model.can.viewPayments) items.push({ id: 'open', label: t('moneyTab.payment.open'), href: `${model.prefix}${recordAddress({ type: 'Payment', id: payment.paymentId, label: payment.externalRef, companyId: order?.companyId }, OFFICE_PAGES)}` })
  items.push({ id: 'ref', label: t('moneyTab.payment.copyRef'), onSelect: () => void navigator.clipboard?.writeText(payment.externalRef) })
  return <LineMenuButton label={t('moneyTab.payment.more', { date: formatDate(dayInstant(payment.receivedOn), { locale }) })} items={items} />
}

function StepDot({ state }: { state: DepositStepState }) {
  return <span className={`fw-om-sx-dot is-${state}`} aria-hidden />
}

/**
 * The request's steps and its payments, inside its row: Italy Asked → Page sent → Paid → Deposit invoice (TD02) → SDI (a deposit
 * that needs no TD02 says so on its last two). Without invoices.view the TD02 step says "Issued", never its number (P0-B3). Its
 * payments come with the plan read (payments.view; amounts with the price grain); before it, the request's paid sum.
 */
function RequestBox({ row, request, order, model, actions, invoiceHref, say }: { row: PlanRow; request: DepositRequest; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; invoiceHref: (id: string, number: string | null) => string; say: Say }) {
  const t = useT('orders')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const td02s = depositInvoicesOf(request, order.chain.invoices)
  const issued = td02s.find((invoice) => invoice.status !== 'DRAFT') ?? null
  const draft = td02s.find((invoice) => invoice.status === 'DRAFT') ?? null
  const sdiPart = issued && model.sdi ? (model.sdi[issued.id] ?? null) : null
  const sdi = sdiPart?.value ?? null
  const steps = depositSteps(request, order.chain.invoices, sdi?.state.code ?? null)
  const left = request.amount !== undefined && request.paidAmount !== undefined ? Math.max(0, request.amount - request.paidAmount) : null
  const busy = model.busy ? t('held.busy') : null
  const sendWait = sdi ? sdiSendHeld(model.can, sdi.canSend && sdi.state.next.action === 'SEND') : null
  const linkWords = request.link ? t(`link.${request.link.state}`, { to: request.link.to ?? t('link.contact'), date: formatDate(request.link.sentAt, { locale }), until: formatDate(request.link.expiresAt, { locale }) }) : null
  const asked = row.fromChange
    ? t('moneyTab.plan.step.byChange', { date: formatDate(request.createdAt, { locale }), revision: row.fromChange.revision })
    : t(request.quoteVersionId ? 'deposit.step.requestedWords' : 'deposit.step.requestedTyped', { date: formatDate(request.createdAt, { locale }) })
  const paidWords =
    request.status === 'PAID'
      ? request.paidAt
        ? t('deposit.step.paidOn', { date: formatDate(request.paidAt, { locale }) })
        : t('deposit.step.paidDone')
      : request.status === 'OPEN'
        ? (request.paidAmount ?? 0) > 0 && model.can.price
          ? t('deposit.step.partPaid', { paid: money(request.paidAmount, request.currency, locale), left: money(left, request.currency, locale) })
          : t('deposit.step.waitingTransfer')
        : t(`requestStatus.${request.status}`)
  const invoiceWords =
    steps.invoice === 'notNeeded' ? (
      t('deposit.step.invoiceNotNeeded')
    ) : issued ? (
      model.can.viewInvoices ? (
        <>
          <Link className="fw-pt-link" href={invoiceHref(issued.id, issued.number)}>
            {t('deposit.step.td02', { number: issued.number ?? '—' })}
          </Link>
          {issued.issueDate ? ` · ${t('deposit.step.issuedOn', { date: day(issued.issueDate) })}` : ''}
        </>
      ) : (
        t('moneyTab.plan.step.issued')
      )
    ) : draft ? (
      model.can.viewInvoices ? (
        <Link className="fw-pt-link" href={invoiceHref(draft.id, draft.number)}>
          {t('deposit.step.td02Draft')}
        </Link>
      ) : (
        t('deposit.step.td02Draft')
      )
    ) : steps.invoice === 'current' ? (
      t('deposit.step.invoiceWaits')
    ) : (
      t('deposit.step.invoiceAfterPayment')
    )
  const sdiWords =
    steps.sdi === 'notNeeded' ? (
      t('deposit.step.sdiNotNeeded')
    ) : !issued ? (
      t('deposit.step.sdiAfterInvoice')
    ) : !model.sdi ? (
      t('deposit.step.sdiNoRight')
    ) : !sdiPart || (sdiPart.value === null && sdiPart.problem === null) ? (
      <span className="fw-pt-inline">
        <Spinner size={12} /> {t('deposit.step.sdiReading')}
      </span>
    ) : sdi ? (
      <span className="fw-pt-inline">
        <Pill tone={SDI_TONE[sdi.state.code]}>{t(`sdi.state.${sdi.state.code}`)}</Pill> {t(`sdi.next.${sdi.state.next.action}`)}
      </span>
    ) : (
      <span className="fw-pt-inline">
        {t(sdiPart.problem ?? 'problem.read.internal')}
        <Button size="sm" variant="link" onClick={() => actions?.onRetryPart?.('sdi')}>
          {t('common.retry')}
        </Button>
      </span>
    )
  // Send to SDI (invoices.issue, a fresh code): hidden without the right; held by the TD02's state in words.
  const sendSdi = issued && sdi && model.can.issueInvoices && (sdi.state.next.action === 'SEND' || sdi.state.next.action === 'SEND_AGAIN') ? (
    <Button size="sm" heldReason={sendWait ? t(sendWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'sdiSend', invoiceId: issued.id })}>
      <Send size={13} aria-hidden /> {t('deposit.sendSdi')}
    </Button>
  ) : null
  const tracker: { key: string; state: DepositStepState; label: string; words: ReactNode; door: ReactNode }[] = [
    { key: 'requested', state: steps.requested, label: t('deposit.step.requested'), words: asked, door: null },
    { key: 'page', state: steps.page, label: t('moneyTab.plan.step.page'), words: linkWords ?? (request.status === 'OPEN' ? t('deposit.step.pageNotSent') : t('deposit.step.pageNotNeeded')), door: null },
    { key: 'paid', state: steps.paid, label: t('deposit.step.paid'), words: paidWords, door: null },
    { key: 'invoice', state: steps.invoice, label: t('deposit.step.invoice'), words: invoiceWords, door: null },
    { key: 'sdi', state: steps.sdi, label: t('deposit.step.sdi'), words: sdiWords, door: sendSdi },
  ]
  const payments = row.payments
  // F-OM-fx3 (W-17): "Its payments" is never a heading over nothing — "No payment yet." whenever the read says so.
  const paymentLines = payments ? (
    payments.length === 0 ? (
      <p className="fw-pt-quiet">{t('moneyTab.plan.payments.none')}</p>
    ) : (
      payments.map((payment) => {
        const method = t(`moneyTab.plan.method.${payment.method}`)
        const how = method === `moneyTab.plan.method.${payment.method}` ? null : method
        // F-OM-fx3 (B-OM-027, W-14): the deposit invoice issued for it — its number for a reader of invoices, else in words.
        const td02 = payment.td02 ? (model.can.viewInvoices && payment.td02.number ? t('moneyTab.payment.td02', { number: payment.td02.number }) : t('moneyTab.payment.td02Words')) : null
        return (
          <div key={payment.allocationId} className="fw-om-py-r">
            <span className="fw-om-py-w">{[day(payment.receivedOn), how, t('moneyTab.plan.payments.ref', { ref: payment.externalRef })].filter(Boolean).join(' · ')}</span>
            <span className="fw-om-py-a">
              {model.can.price && payment.amount !== undefined ? money(payment.amount, request.currency, locale) : null}
              <PaymentMenu payment={payment} request={request} model={model} actions={actions} />
            </span>
            {td02 ? <span className="fw-om-py-x">{td02}</span> : null}
          </div>
        )
      })
    )
  ) : model.can.price && (request.paidAmount ?? 0) > 0 ? (
    <p className="fw-pt-quiet">{t('moneyTab.plan.payments.paidSoFar', { amount: money(request.paidAmount, request.currency, locale) })}</p>
  ) : request.status === 'OPEN' && request.paidAmount === 0 /* known only with the price grain: never "none" when it is not known */ ? (
    <p className="fw-pt-quiet">{t('moneyTab.plan.payments.none')}</p>
  ) : null
  return (
    <div className="fw-om-rq">
      <ol className="fw-om-sx" aria-label={t('deposit.stepsLabel')}>
        {tracker.map((entry) => (
          <li key={entry.key} className={`is-${entry.state}`}>
            <StepDot state={entry.state} />
            <span className="fw-om-sx-b">
              <b>{entry.label}</b>
              <span className="fw-om-sx-w">{entry.words}</span>
              {entry.door}
            </span>
          </li>
        ))}
      </ol>
      {/* F-OM-fx3 (W-01): short within the company's tolerance — the hint (price grain), for a reader of its payments. */}
      {row.hint && model.can.viewPayments ? (
        <p className="fw-om-rq-hint">
          <Info size={13} aria-hidden />
          <span>{say(row.hint)}</span>
        </p>
      ) : null}
      {model.can.viewPayments && paymentLines ? (
        <div className="fw-om-py">
          <span className="fw-om-py-h">{t('moneyTab.plan.payments.title')}</span>
          {paymentLines}
        </div>
      ) : null}
    </div>
  )
}
