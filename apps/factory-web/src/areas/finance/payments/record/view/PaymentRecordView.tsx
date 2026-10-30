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
    <WithMessages namespaces={['finance', 'lists']}>
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
  const locale = useLocale()
  const recordHref = `${model.prefix}/finance/payments/${payment.id}`
  const state = placedStateOf(payment)
  const m = (value: number | null | undefined) => money(value, payment.currency, locale)
  const voided = payment.status === 'VOIDED'
  const placeHeld = !model.can.recordPayments ? t('held.noRecord') : voided ? t('held.voided') : (payment.unallocated ?? 1) <= 0 ? t('held.allPlaced') : model.busy ? t('held.busy') : null
  const voidHeld = !model.can.voidPayments ? t('held.noVoid') : voided ? t('held.voided') : (payment.allocated ?? 1) !== 0 ? t('held.voidPlaced') : null
  const tabs: TabItem[] = PAYMENT_TABS.map((tab) => ({ id: tab, href: `${recordHref}?tab=${tab}`, label: t(`payment.tab.${tab}`), count: tab === 'allocation' ? payment.allocations.length : null }))
  const more: MenuItemDef[] = [
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
                ...(model.can.price ? [{ label: t('payment.placed'), value: m(payment.allocated) }, { label: t('payment.left'), value: m(payment.unallocated) }] : []),
              ]}
            />
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
    return (
      <DialogFrame title={t('payment.placeTitle', { reference: payment.externalRef })} held={held} go={() => actions?.onPlace?.(plan)} goLabel={model.busy ? t('common.working') : t('payment.placeGo')} onClose={closeDialog} problem={model.dialogProblem} size="lg">
        <p className="fw-fin-hint">{t('payment.placeBody', { amount: model.can.price ? money(left, payment.currency, locale) : '—' })}</p>
        <Placement items={model.items.value} problem={model.items.problem} amount={left} currency={payment.currency} typed={typed} setTyped={setTyped} onRetry={() => actions?.onRetryItems?.()} price={model.can.price} />
      </DialogFrame>
    )
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
