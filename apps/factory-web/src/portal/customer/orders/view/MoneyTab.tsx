'use client'

import type { ReactNode } from 'react'
import { Banner, Card, Disclosure, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill } from '@nexus/ui/primitives'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { Overview } from '../../../../lib/record-overview/Overview'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import type { OrderRecord } from '../api'
import { dueStepOf, stepOpen, toldOn, type MoneyRead, type NoticeDraft, type PlanStep } from '../money'
import { overviewOf } from '../overview/model'
import { usePageWords } from '../page-words'
import { useOrderWords } from '../words'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'
import { PayCard } from './overview/Cards'
import { PriceCheckCard, PriceCheckDialog } from './PriceCheck'

/**
 * owb-po6.2 (plan § 5m "Money (price holders)"; design `moneyTab`) — Order › Money, for a person who sees prices only (the customer's
 * Designer has no tab). From the money read: Totals (Order total · Invoiced · Paid · Still to pay; How it adds up) · Payments plan (each
 * step, its state; ONE button on the step that is due: "I paid: tell the factory…" — a notice that changes nothing owed; the step then
 * says "You told the factory on …") · Invoices & credit notes (the customer's own documents) · the customer's Price check. Until the
 * money read answers (or when it is refused) the round-1 cards: "What you pay" and the Price check. Never a margin, a cost or a person.
 */

/** The "I paid" window, open on a step. */
export interface NoticeWindowModel {
  step: PlanStep | null
  draft: NoticeDraft
  /** A word key of what is wrong (shown after a try), or null. */
  problem: string | null
  tried: boolean
  busy: boolean
  failed: string | null
}

const STATE_TONE: Readonly<Record<PlanStep['state'], 'success' | 'info' | 'warning' | 'danger' | 'neutral'>> = { PAID: 'success', PART_PAID: 'info', DUE: 'warning', LATE: 'danger', LATER: 'neutral' }

export function MoneyTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }): ReactNode {
  const words = useOrderWords()
  const page = usePageWords()
  if (!record.seesPrices) return null
  const read = model.money?.state === 'ready' ? model.money.read : null
  const check = (
    <>
      {model.priceCheck ? <PriceCheckCard model={model.priceCheck} actions={actions?.priceCheck} /> : null}
      {model.priceCheck?.dialog && model.priceCheck.check ? <PriceCheckDialog model={model.priceCheck.dialog} check={model.priceCheck.check} actions={actions?.priceCheck?.dialog} /> : null}
    </>
  )
  if (!read) {
    // Round 1 (the read not built yet, refused, or reading): what the order costs and what is paid, and the price check.
    const cards = overviewOf({ ...model, record, words })
    return (
      <div className="fw-pord-tab">
        {model.money?.state === 'error' ? (
          <Banner tone="warning" title={page('money.failed')} action={<Button size="sm" onClick={() => actions?.onRetryMoney?.()}>{page('money.retry')}</Button>} />
        ) : null}
        {cards.pay ? (
          <Overview>
            <PayCard model={cards.pay} />
          </Overview>
        ) : null}
        {check}
      </div>
    )
  }
  const money = (minor: number) => words.money(minor, read.currency) ?? '—'
  const day = (iso: string | null) => (iso ? words.day(iso.slice(0, 10)) : '—')
  const due = dueStepOf(read.plan)
  const stepName = (step: PlanStep) => (step.percent !== null ? page('money.kindPercent', { kind: page(`money.kind.${step.kind}`), percent: step.percent }) : page(`money.kind.${step.kind}`))
  return (
    <div className="fw-pord-tab">
      <Card header={page('money.totals')} headingLevel={2}>
        <SummaryTable
          label={page('money.totals')}
          columns={[page('money.cols.what'), page('money.cols.amount')]}
          rows={[
            { id: 'order', cells: [page('money.order'), money(read.totals.order)] },
            { id: 'invoiced', cells: [page('money.invoiced'), money(read.totals.invoiced)] },
            { id: 'paid', cells: [page('money.paid'), money(read.totals.paid)] },
            { id: 'still', cells: [page('money.stillToPay'), money(read.totals.stillToPay)] },
          ]}
        />
        {read.addsUp.length > 0 ? (
          <Disclosure id="fw-pord-adds-up" summary={page('money.addsUp')}>
            <SummaryTable label={page('money.addsUp')} columns={[page('money.cols.what'), page('money.cols.amount')]} rows={read.addsUp.map((row) => ({ id: row.key, cells: [page(`money.addsUpKey.${row.key}`), money(row.amount)] }))} />
          </Disclosure>
        ) : null}
      </Card>
      <Card header={page('money.plan')} headingLevel={2}>
        {read.plan.length === 0 ? (
          <p className="fw-pord-quiet">{page('money.noPlan')}</p>
        ) : (
          <ul className="fw-pord-plan">
            {read.plan.map((step) => {
              const told = step.noticeOpen ? toldOn(read, step.id) : null
              return (
                <li key={step.id} className="fw-pord-step">
                  <span className="fw-pord-step-text">
                    <span className="fw-pord-strong">{stepName(step)}</span>
                    <span>
                      {money(step.amount)} · {step.due ? page('money.due', { date: day(step.due) }) : page('money.noDue')}
                      {step.paid > 0 && step.state !== 'PAID' ? ` · ${page('money.stepOpen', { amount: money(stepOpen(step)) })}` : ''}
                    </span>
                    {told ? <span className="fw-pord-quiet">{page('money.told', { date: day(told) })}</span> : null}
                  </span>
                  <span className="fw-pord-step-acts">
                    <Pill tone={STATE_TONE[step.state]}>{page(`money.state.${step.state}`)}</Pill>
                    {due?.id === step.id && read.may.notify && !step.noticeOpen ? (
                      <Button size="sm" variant="secondary" heldReason={model.offlineSince ? words.t('held.offline') : null} onClick={() => actions?.onNotify?.(step.id)}>
                        {page('money.notify')}
                      </Button>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      <Card header={page('money.invoices')} headingLevel={2}>
        {read.invoices.length === 0 ? (
          <p className="fw-pord-quiet">{page('money.noInvoices')}</p>
        ) : (
          <SummaryTable
            label={page('money.invoices')}
            columns={[page('money.cols.document'), page('money.cols.date'), page('money.cols.amount'), page('money.cols.open')]}
            rows={read.invoices.map((invoice) => ({ id: invoice.id, cells: [`${page(`money.invoice.${invoice.kind}`)} ${invoice.number}`, day(invoice.date), money(invoice.amount), money(invoice.open)] }))}
          />
        )}
      </Card>
      {check}
      {model.noticeWindow ? <NoticeWindow window={model.noticeWindow} money={money} stepName={stepName} actions={actions} /> : null}
    </div>
  )
}

/** "I paid: tell the factory…": the amount, the day, how, a note → the notice (nothing owed changes; the factory records the payment). */
function NoticeWindow({ window, money, stepName, actions }: { window: NoticeWindowModel; money: (minor: number) => string; stepName: (step: PlanStep) => string; actions?: OrderRecordActions }) {
  const page = usePageWords()
  const draft = window.draft
  const set = (patch: Partial<NoticeDraft>) => actions?.onNoticeDraft?.({ ...draft, ...patch })
  const problem = window.tried && window.problem ? page(window.problem) : null
  return (
    <WindowShell
      open
      onClose={() => actions?.onNoticeClose?.()}
      title={page('money.window')}
      subtitle={window.step ? `${stepName(window.step)} · ${page('money.stepOpen', { amount: money(stepOpen(window.step)) })}` : undefined}
      act={{ words: page('money.send'), onAct: () => actions?.onNoticeSend?.(), busy: window.busy, held: null }}
      size="md"
    >
      <p className="fw-pord-quiet">{page('money.windowLine')}</p>
      {window.failed ? <Banner tone="danger" title={window.failed} /> : null}
      <Field label={page('money.field.amount')} error={problem && window.problem !== 'money.problem.day' ? problem : undefined}>
        <Input inputMode="decimal" value={draft.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field label={page('money.field.paidOn')} error={problem && window.problem === 'money.problem.day' ? problem : undefined}>
        <Input type="date" value={draft.paidOn} onChange={(event) => set({ paidOn: event.target.value })} />
      </Field>
      <Field label={page('money.field.method')}>
        <Input value={draft.method} maxLength={100} onChange={(event) => set({ method: event.target.value })} />
      </Field>
      <Field label={page('money.field.note')}>
        <Textarea value={draft.note} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </WindowShell>
  )
}
