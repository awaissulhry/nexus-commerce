'use client'

import { Banner, Card, EmptyState, Field, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money, type Phrase } from '../../../_shared/model'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../test-mode/depth'
import type { Quarter, Quarters } from '../api'
import { currentQuarter, paidOnProblem, payHeld, QUARTER_TONE, quarterName, recountHeld, type TaxAbilities } from '../model'
import '../../../_shared/finance.css'

export interface StampDutyModel {
  can: TaxAbilities
  /** The price grain: totals drawn (absent without it). */
  price: boolean
  today: string
  year: number
  years: number[]
  quarters: { value: Quarters | null; problem: string | null }
  /** The quarter whose payment is being recorded, and the day typed. */
  paying: Quarter | null
  paidOn: string
  busy: boolean
  problem: DepthProblem | null
  notice: Phrase | null
}

export interface StampDutyActions {
  onYear?: (year: number) => void
  onRecount?: (quarter: Quarter) => void
  onPay?: (quarter: Quarter | null) => void
  onPaidOn?: (day: string) => void
  onConfirmPay?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/**
 * Stamp duty this quarter (design finance.invoices page.h ⋯ "Stamp duty this quarter"; FIN-101): the quarter running now —
 * the stamp duty its invoices carry so far, how many, the day it is due and its F24 tax code — and the year's four
 * quarters: what was counted, a count that no longer matches its invoices (Recount), late or to pay (Record the payment,
 * on a day after the quarter ended), paid. While the company's stamp duty switch is off the quarters still show what the
 * issued invoices carry, and the dialog says what waits for the accountant. The due days and codes are said as waiting for
 * the accountant's confirmation. Totals only with the price grain.
 */
export function StampDutyDialog({ model, actions }: { model: StampDutyModel; actions?: StampDutyActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Quarters model={model} actions={actions} />
    </WithMessages>
  )
}

function Quarters({ model, actions }: { model: StampDutyModel; actions?: StampDutyActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const s = useScopedT('finance')
  const locale = useLocale()
  const answer = model.quarters.value
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const name = (quarter: Quarter) => {
    const named = quarterName(quarter)
    return w('stamp.quarter', { n: named.n, year: named.year })
  }
  const current = answer ? currentQuarter(answer.quarters, model.today) : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={w('stamp.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {w('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-dialog">
        {model.problem && <Banner tone="danger" title={s(model.problem.key, model.problem.params)} />}
        {model.notice && <Banner tone="success" title={w(model.notice.key, model.notice.params)} />}
        <div className="fw-fin-head">
          <p className="fw-fin-hint">{w('stamp.explain')}</p>
          <Select size="sm" aria-label={w('stamp.year')} value={String(model.year)} onChange={(event) => actions?.onYear?.(Number(event.target.value))}>
            {model.years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </div>
        {model.quarters.problem ? (
          <EmptyState
            title={w('stamp.failed')}
            description={t(model.quarters.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : !answer ? (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {w('stamp.reading')}
          </p>
        ) : (
          <>
            {!answer.stampDutyOn && <Banner tone="info" title={w('stamp.waits')} />}
            {current && (
              <MetricStrip
                minTileWidth={130}
                metrics={[
                  { label: name(current), value: model.price && current.liveTotal !== undefined ? money(current.liveTotal, 'EUR', locale) : String(current.liveCount), hint: w(`stamp.state.${current.state}`) },
                  { label: w('stamp.col.invoices'), value: String(current.liveCount) },
                  { label: w('stamp.col.due'), value: day(current.dueOn), hint: current.deferred ? w('stamp.deferred') : undefined },
                  { label: w('stamp.col.f24'), value: current.f24Code },
                ]}
              />
            )}
            <SummaryTable
              label={w('stamp.tableLabel', { year: answer.year })}
              columns={[w('stamp.col.quarter'), w('stamp.col.invoices'), ...(model.price ? [w('stamp.col.total')] : []), w('stamp.col.due'), w('stamp.col.state'), w('stamp.col.actions')]}
              rows={answer.quarters.map((quarter) => {
                const recount = recountHeld(quarter, model.can, answer.stampDutyOn, model.busy)
                const pay = payHeld(quarter, model.can, model.busy)
                return {
                  id: quarter.quarterStart,
                  cells: [
                    <span key="q" className="fw-fin-cell">
                      <b>{name(quarter)}</b>
                      <span className="fw-fin-cell-sub">
                        {day(quarter.quarterStart)} – {day(quarter.quarterEnd)}
                      </span>
                    </span>,
                    <span key="n" className="fw-fin-cell">
                      <span>{quarter.liveCount}</span>
                      {quarter.stale && <Tag tone="warning">{w('stamp.stale', { count: quarter.invoiceCount })}</Tag>}
                    </span>,
                    ...(model.price ? [money(quarter.liveTotal, 'EUR', locale)] : []),
                    <span key="d" className="fw-fin-cell">
                      <span>{day(quarter.dueOn)}</span>
                      <span className="fw-fin-cell-sub">{w('stamp.f24', { code: quarter.f24Code })}</span>
                    </span>,
                    <Pill key="s" tone={QUARTER_TONE[quarter.state]}>
                      {quarter.state === 'PAID' && quarter.paidAt ? w('stamp.paidOn', { date: formatDate(quarter.paidAt, { locale }) }) : w(`stamp.state.${quarter.state}`)}
                    </Pill>,
                    <span key="a" className="fw-fin-actions">
                      {quarter.stale && (
                        <Button size="sm" heldReason={recount ? w(recount.key) : null} onClick={() => actions?.onRecount?.(quarter)}>
                          {w('stamp.recount')}
                        </Button>
                      )}
                      {quarter.state !== 'PAID' && (
                        <Button size="sm" heldReason={pay ? w(pay.key) : null} onClick={() => actions?.onPay?.(quarter)}>
                          {w('stamp.pay')}
                        </Button>
                      )}
                    </span>,
                  ],
                }
              })}
              stackOnPhone
            />
            {model.paying && <PayForm model={model} quarter={model.paying} actions={actions} name={name(model.paying)} />}
            <p className="fw-fin-hint">{w('stamp.rule')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

function PayForm({ model, quarter, actions, name }: { model: StampDutyModel; quarter: Quarter; actions?: StampDutyActions; name: string }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const problem = paidOnProblem(model.paidOn, quarter, model.today)
  const held = model.busy ? w('held.busy') : problem ? w(problem.key) : null
  return (
    <Card padded className="fw-fin-card">
      <h3 className="fw-fin-h3">{w('stamp.payTitle', { quarter: name })}</h3>
      <p className="fw-fin-hint">{w('stamp.payExplain', { code: quarter.f24Code })}</p>
      <Field label={w('stamp.paidOnLabel')} error={model.paidOn && problem ? w(problem.key) : undefined}>
        <DateField value={model.paidOn} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} onChange={(value) => actions?.onPaidOn?.(value ?? '')} />
      </Field>
      <span className="fw-fin-actions">
        <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onConfirmPay?.()}>
          {model.busy ? t('common.working') : w('stamp.payConfirm')}
        </Button>
        <Button size="sm" onClick={() => actions?.onPay?.(null)}>
          {t('common.cancel')}
        </Button>
      </span>
    </Card>
  )
}
