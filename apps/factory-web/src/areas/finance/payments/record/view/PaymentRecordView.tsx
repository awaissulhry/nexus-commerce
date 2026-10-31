'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileX, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, SummaryTable, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Payment } from '../../../_shared/api'
import { allocationsOf, dayInstant, money, PLACED_TONE, placedLabel, placedStateOf, placementProblems, standing } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { Placement, planOf } from '../../../_shared/placement'
import { moveHeld, REFUND_TONE, refundHeld, type RefundMove, type RefundTarget } from '../../refunds/model'
import { RefundDialog, RefundMoveDialog } from '../../refunds/view/RefundDialogs'
import { PAYMENT_TABS, type PaymentRecordActions, type PaymentRecordModel } from '../record-model'
import '../../../_shared/finance.css'

export type { PaymentRecordActions, PaymentRecordModel } from '../record-model'

/**
 * SCR-082 — a payment (design finance.payments "Record: Payment"): the band (‹ Payments, "<bank reference> · <customer>",
 * Placed · Partly placed · Not placed · Voided, the primary "Place the rest", ⋯ Void — only once nothing is placed — and
 * Copy reference); Allocation: what arrived (amount, day, method, reference) and where it went — every placement with
 * when and who, a take-back said as one (with its reason) — and what is left; Bank line: how it was recorded (by hand in
 * W1: no bank statement is linked yet). An allocation is taken back with a reason (the ledger never changes). Money by
 * grain. A payment has no thread of its own yet (the API's thread records do not list it): its history is this ledger.
 */
export function PaymentRecordView({ model, actions }: { model: PaymentRecordModel; actions?: PaymentRecordActions }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', 'lists']}>
      <PaymentRecord model={model} actions={actions} />
    </WithMessages>
  )
}

function PaymentRecord({ model, actions }: { model: PaymentRecordModel; actions?: PaymentRecordActions }) {
  const t = useT('finance')
  const listHref = `${model.prefix}/finance/payments`
  const loaded = model.payment
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fin">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('payment.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('payment.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fin-hint" role="status">
              <Spinner size={14} /> {t('payment.loading')}
            </p>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`payment.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`payment.state.${loaded.status}.body`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('payment.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return <ReadyPayment payment={loaded.value} model={model} actions={actions} />
}

function ReadyPayment({ payment, model, actions }: { payment: Payment; model: PaymentRecordModel; actions?: PaymentRecordActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const recordHref = `${model.prefix}/finance/payments/${payment.id}`
  const state = placedStateOf(payment)
  const m = (value: number | null | undefined) => money(value, payment.currency, locale)
  const voided = payment.status === 'VOIDED'
  const placeHeld = !model.can.recordPayments ? t('held.noRecord') : voided ? t('held.voided') : (payment.unallocated ?? 1) <= 0 ? t('held.allPlaced') : model.busy ? t('held.busy') : null
  const voidHeld = !model.can.voidPayments ? t('held.noVoid') : voided ? t('held.voided') : (payment.allocated ?? 1) !== 0 ? t('held.voidPlaced') : null
  const tabs: TabItem[] = PAYMENT_TABS.map((tab) => ({ id: tab, href: `${recordHref}?tab=${tab}`, label: t(`payment.tab.${tab}`), count: tab === 'allocation' ? payment.allocations.length : null }))
  // B-W2a-80 (design rec:Payment match "Overpayment → customer credit balance"): what is not placed is the customer's
  // credit balance — placed later, or refunded from here.
  const refundCan = model.refundCan ?? { view: model.can.viewPayments, refund: false, void: model.can.voidPayments, price: model.can.price }
  const refundRight = refundHeld(refundCan, model.live === 'offline')
  const balanceHeld = refundRight ? d(refundRight.key, refundRight.params) : voided ? t('held.voided') : (payment.unallocated ?? 0) <= 0 ? d('balance.held.nothing') : null
  const more: MenuItemDef[] = [
    { id: 'refund', label: d('balance.refund'), disabled: !!balanceHeld, description: balanceHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'refund' }) },
    { id: 'void', label: t('payment.void'), tone: 'danger', disabled: !!voidHeld, description: voidHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'void' }) },
    {
      id: 'copy',
      label: t('payment.copyReference'),
      onSelect: () => {
        void navigator.clipboard?.writeText(payment.externalRef).catch(() => undefined)
      },
    },
  ]
  const nameOf = (id: string | null) => (id ? (payment.people.find((person) => person.id === id)?.name ?? t('payment.someone')) : t('payment.system'))
  const live = standing(payment)

  return (
    <div className="fw-fin">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/finance/payments`}>{t('payment.back')}</Link>}
          title={
            <span className="fw-fin-title">
              {payment.externalRef} <span className="fw-fin-title-sub">· {payment.party.legalName}</span>
            </span>
          }
          actions={
            <span className="fw-fin-actions">
              <Button size="sm" variant="primary" heldReason={placeHeld} onClick={() => actions?.onDialog?.({ kind: 'place' })}>
                {t('payment.placeRest')}
              </Button>
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-fin-meta-row">
          <span className="fw-fin-meta">
            {state ? <Pill tone={PLACED_TONE[state]}>{t(`placed.${state}`)}</Pill> : <Pill tone="neutral">{t(`paymentStatus.${payment.status}`)}</Pill>}
            <span className="fw-fin-hint">{t('payment.meta', { date: formatDate(dayInstant(payment.receivedOn), { locale }), method: t('payments.method.BANK_TRANSFER') })}</span>
          </span>
          <span className="fw-fin-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('payment.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

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
      {voided && <Banner tone="info" title={t('payment.voidedBanner', { reason: payment.voidReason ?? '—', date: payment.voidedAt ? formatDate(payment.voidedAt, { locale }) : '—' })} />}

      {model.tab === 'allocation' && (
        <div className="fw-fin-cards">
          <Card padded className="fw-fin-card">
            <h2 className="fw-fin-h2">{t('payment.what')}</h2>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                ...(model.can.price ? [{ label: t('recordPay.amount'), value: m(payment.amount) }] : []),
                { label: t('recordPay.receivedOn'), value: formatDate(dayInstant(payment.receivedOn), { locale }) },
                { label: t('recordPay.method'), value: t('payments.method.BANK_TRANSFER') },
                { label: t('recordPay.reference'), value: <span className="fw-fin-code">{payment.externalRef}</span> },
                ...(model.can.price ? [{ label: t('payment.placed'), value: m(payment.allocated) }, { label: t('payment.left'), value: m(payment.unallocated), hint: (payment.unallocated ?? 0) > 0 && !voided ? d('balance.hint') : undefined }] : []),
                ...(model.can.price && (payment.refunded ?? 0) > 0 ? [{ label: d('balance.refunded'), value: m(payment.refunded) }] : []),
              ]}
            />
            {!voided && (payment.unallocated ?? 0) > 0 && (
              <Banner
                tone="info"
                title={model.can.price ? d('balance.banner', { amount: m(payment.unallocated) }) : d('balance.bannerPlain')}
                action={
                  <Button size="sm" heldReason={balanceHeld} onClick={() => actions?.onDialog?.({ kind: 'refund' })}>
                    {d('balance.refund')}
                  </Button>
                }
              >
                {d('balance.bannerBody')}
              </Banner>
            )}
          </Card>
          <Card padded className="fw-fin-card">
            <h2 className="fw-fin-h2">{t('payment.where')}</h2>
            {payment.allocations.length === 0 ? (
              <EmptyState title={t('payment.nothing.title')} description={t(voided ? 'payment.nothing.voided' : 'payment.nothing.body')} />
            ) : (
              <SummaryTable
                label={t('payment.where')}
                columns={[t('payment.col.target'), t('payment.col.when'), ...(model.can.price ? [t('payment.col.amount')] : []), t('payment.col.action')]}
                rows={payment.allocations.map((allocation) => {
                  const label = placedLabel({ target: allocation.target, number: allocation.label?.number ?? null, orderNumber: allocation.label?.orderNumber ?? null })
                  const canTakeBack = live.some((entry) => entry.id === allocation.id)
                  return {
                    id: allocation.id,
                    cells: [
                      <span key="t" className="fw-fin-cell">
                        {allocation.target === 'INVOICE' ? (
                          <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${allocation.targetId}`}>
                            {t(label.key, label.params)}
                          </Link>
                        ) : (
                          <span>{t(label.key, label.params)}</span>
                        )}
                        <span className="nds-summary-sub">{allocation.reversalOfId ? t('payment.reversal', { note: allocation.note ?? '—' }) : allocation.reversed ? t('payment.reversed') : t('payment.placedRow')}</span>
                      </span>,
                      <span key="w" className="fw-fin-cell">
                        <span>{formatDateTime(allocation.createdAt, { locale })}</span>
                        <span className="nds-summary-sub">{nameOf(allocation.createdById)}</span>
                      </span>,
                      ...(model.can.price ? [m(allocation.amount)] : []),
                      canTakeBack ? (
                        <Button key="a" size="sm" variant="link" heldReason={!model.can.recordPayments ? t('held.noRecord') : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'reverse', allocationId: allocation.id })}>
                          {t('payment.takeBack')}
                        </Button>
                      ) : (
                        '—'
                      ),
                    ],
                  }
                })}
                density="roomy"
                stackOnPhone
              />
            )}
          </Card>
        </div>
      )}

      {model.tab === 'allocation' && model.refunds && <RefundsCard payment={payment} model={model} actions={actions} />}

      {model.tab === 'bank' && (
        <Card padded className="fw-fin-card">
          <h2 className="fw-fin-h2">{t('payment.bankTitle')}</h2>
          <KeyValue
            dense
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('payment.recordedBy'), value: t('payment.byHand', { name: nameOf(payment.createdById), date: formatDateTime(payment.createdAt, { locale }) }) },
              { label: t('payment.bankLine'), value: t('payment.noBankLine') },
              { label: t('recordPay.note'), value: payment.internalNote ?? '—' },
            ]}
          />
        </Card>
      )}

      <PaymentDialogs key={model.dialog ? `${model.dialog.kind}-${model.dialog.kind === 'reverse' ? model.dialog.allocationId : ''}` : 'none'} payment={payment} model={model} actions={actions} />
    </div>
  )
}

function PaymentDialogs({ payment, model, actions }: { payment: Payment; model: PaymentRecordModel; actions?: PaymentRecordActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const [typed, setTyped] = useState<Record<string, string>>(model.draft?.plan ?? {})
  const [note, setNote] = useState(model.draft?.note ?? '')
  const dialog = model.dialog
  if (!dialog) return null
  const closeDialog = () => actions?.onDialog?.(null)
  if (dialog.kind === 'place') {
    const left = payment.unallocated ?? 0
    const plan = planOf(typed)
    const problems = model.items.value ? placementProblems(model.items.value, plan, left) : { items: {}, total: null }
    const allocations = model.items.value ? allocationsOf(model.items.value, plan) : []
    const held = model.busy ? t('held.busy') : allocations.length === 0 ? t('match.problem.none') : Object.keys(problems.items).length > 0 ? t('match.problem.fix') : problems.total ? t(problems.total) : null
    const after = left - Object.values(plan).reduce((sum, value) => sum + value, 0)
    return (
      <DialogFrame title={t('payment.placeTitle', { reference: payment.externalRef })} held={held} go={() => actions?.onPlace?.(plan)} goLabel={model.busy ? t('common.working') : t('payment.placeGo')} onClose={closeDialog} problem={model.dialogProblem} size="lg">
        <p className="fw-fin-hint">{t('payment.placeBody', { amount: model.can.price ? money(left, payment.currency, locale) : '—' })}</p>
        <Placement items={model.items.value} problem={model.items.problem} amount={left} currency={payment.currency} typed={typed} setTyped={setTyped} onRetry={() => actions?.onRetryItems?.()} price={model.can.price} />
        {/* B-W2a-80: what stays unplaced is the customer's credit balance (its total from the matcher's answer). */}
        {model.can.price && model.items.value && after > 0 && <p className="fw-fin-hint">{d('balance.afterPlace', { amount: money(after, payment.currency, locale) })}</p>}
        {model.can.price && typeof model.creditBalance === 'number' && model.creditBalance > 0 && <p className="fw-fin-hint">{d('balance.customerTotal', { amount: money(model.creditBalance, payment.currency, locale) })}</p>}
      </DialogFrame>
    )
  }
  if (dialog.kind === 'refund') {
    const target: RefundTarget = { kind: 'payment', paymentId: payment.id, label: payment.externalRef, partyName: payment.party.legalName, currency: payment.currency, cap: payment.unallocated ?? null }
    const refundCan = model.refundCan ?? { view: model.can.viewPayments, refund: false, void: model.can.voidPayments, price: model.can.price }
    return (
      <RefundDialog
        model={{ targets: [target], targetsProblem: null, start: payment.id, can: refundCan, today: model.today, busy: model.busy, problem: model.dialogProblem, draft: model.draft?.refund }}
        onRecord={(picked, draft) => actions?.onRefund?.(picked, draft)}
        onClose={closeDialog}
      />
    )
  }
  if (dialog.kind === 'refundMove') {
    const refundCan = model.refundCan ?? { view: model.can.viewPayments, refund: false, void: model.can.voidPayments, price: model.can.price }
    return <RefundMoveDialog refund={dialog.refund} move={dialog.move} can={refundCan} today={model.today} busy={model.busy} problem={model.dialogProblem} onMove={(input) => actions?.onRefundMove?.(dialog.refund, dialog.move, input)} onClose={closeDialog} />
  }
  if (dialog.kind === 'reverse') {
    const allocation = payment.allocations.find((entry) => entry.id === dialog.allocationId)
    const label = allocation ? placedLabel({ target: allocation.target, number: allocation.label?.number ?? null, orderNumber: allocation.label?.orderNumber ?? null }) : null
    const held = model.busy ? t('held.busy') : note.trim().length < 3 ? t('payment.reasonNeeded') : null
    return (
      <DialogFrame title={t('payment.takeBackTitle', { target: label ? t(label.key, label.params) : '—' })} held={held} go={() => actions?.onReverse?.(dialog.allocationId, note.trim())} goLabel={model.busy ? t('common.working') : t('payment.takeBackGo')} onClose={closeDialog} problem={model.dialogProblem} tone="danger">
        <p className="fw-fin-hint">{t('payment.takeBackBody')}</p>
        <Field label={t('payment.reason')}>
          <Textarea value={note} rows={3} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </DialogFrame>
    )
  }
  const held = model.busy ? t('held.busy') : note.trim().length < 3 ? t('payment.reasonNeeded') : null
  return (
    <DialogFrame title={t('payment.voidTitle', { reference: payment.externalRef })} held={held} go={() => actions?.onVoid?.(note.trim())} goLabel={model.busy ? t('common.working') : t('payment.voidGo')} onClose={closeDialog} problem={model.dialogProblem} tone="danger" size="sm">
      <p className="fw-fin-hint">{t('payment.voidBody')}</p>
      <Field label={t('payment.reason')}>
        <Textarea value={note} rows={3} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </Field>
    </DialogFrame>
  )
}

/** B-W2a-80: the refunds of this payment's credit balance — made, due (Made… / Cancel…), cancelled or voided (Void… once paid). */
function RefundsCard({ payment, model, actions }: { payment: Payment; model: PaymentRecordModel; actions?: PaymentRecordActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const part = model.refunds
  const refundCan = model.refundCan ?? { view: model.can.viewPayments, refund: false, void: model.can.voidPayments, price: model.can.price }
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{d('balance.refundsTitle')}</h2>
      {!part?.value ? (
        part?.problem ? (
          <EmptyState title={d('refunds.failed')} description={t(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetryRefunds?.()}>{t('common.retry')}</Button>} />
        ) : (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {d('refunds.loading')}
          </p>
        )
      ) : (
        <SummaryTable
          label={d('balance.refundsTitle')}
          columns={[d('refunds.col.state'), d('refunds.col.when'), ...(model.can.price ? [t('col.amount')] : []), t('payment.col.action')]}
          rows={part.value.map((refund) => ({
            id: refund.id,
            cells: [
              <span key="s" className="fw-fin-cell">
                <Pill tone={REFUND_TONE[refund.status]}>{d(`refunds.state.${refund.status}`)}</Pill>
                {(refund.cancelReason || refund.voidReason) && <span className="nds-summary-sub">{refund.cancelReason ?? refund.voidReason}</span>}
              </span>,
              <span key="w" className="fw-fin-cell">
                <span>{refund.status === 'PAID' || refund.status === 'VOIDED' ? d('refunds.paidOn', { date: day(refund.paidOn) }) : refund.dueDate ? d('refunds.dueOn', { date: day(refund.dueDate) }) : '—'}</span>
                {refund.externalRef && <span className="nds-summary-sub fw-fin-code">{refund.externalRef}</span>}
              </span>,
              ...(model.can.price ? [money(refund.amount, payment.currency, locale)] : []),
              <span key="a" className="fw-fin-inline">
                {(['paid', 'cancel', 'void'] as RefundMove[])
                  .filter((move) => moveHeld(refund, move, { ...refundCan, refund: true, void: true }) === null)
                  .map((move) => {
                    const wait = moveHeld(refund, move, refundCan)
                    return (
                      <Button key={move} size="sm" variant="link" heldReason={wait ? d(wait.key, wait.params) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'refundMove', refund, move })}>
                        {d(`refunds.move.${move}.verb`)}
                      </Button>
                    )
                  })}
              </span>,
            ],
          }))}
          density="roomy"
          stackOnPhone
        />
      )}
    </Card>
  )
}
