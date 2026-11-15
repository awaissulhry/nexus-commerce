'use client'

import Link from 'next/link'
import { CalendarCheck2 } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../../payments/riba/depth'
import { PROPOSAL_TONE } from '../../proposal/model'
import type { InvoiceBatch } from '../model'
import '../../payables.css'
import '../../../_shared/finance.css'

export interface PaymentBatchModel {
  prefix: string
  /** undefined while read; null: in no proposal read. */
  batch: InvoiceBatch | null | undefined
  /** Older proposals were not read (more than the look-back). */
  more: boolean
  /** A failed read (a `finance` key), never drawn as empty. */
  problem: string | null
  /** money.cost: the amounts are drawn. */
  cost: boolean
}

export interface PaymentBatchActions {
  onRetry?: () => void
}

/**
 * SCR-518 — the supplier invoice's payment section (design finance.payables rec:Supplier invoice › Payment › pay: "Due,
 * terms, in batch of week 46, paid on, IBAN used (masked, usable check)"; empty "Not in a payment batch yet"): the weekly
 * payment proposal that holds the invoice — its week, its state, the line's amount and discount (cost grain) — and the bank
 * account it pays to, masked, with whether it is usable (a verified, active account of the supplier; held lines say why).
 * Due, terms and paid on stay in the card beside it.
 */
export function PaymentBatchCard({ model, actions }: { model: PaymentBatchModel; actions?: PaymentBatchActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: PaymentBatchModel; actions?: PaymentBatchActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const title = (
    <h3 className="fw-fpy-h3">
      <CalendarCheck2 size={14} aria-hidden /> {p('batch.title')}
    </h3>
  )
  if (model.problem) {
    return (
      <Card padded>
        <div className="fw-fpy-stack">
          {title}
          <Banner tone="danger" title={p('batch.failed')}>
            {t(model.problem)}
          </Banner>
          <span className="fw-fpy-inline">
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          </span>
        </div>
      </Card>
    )
  }
  if (model.batch === undefined) {
    return (
      <Card padded aria-busy="true">
        <div className="fw-fpy-stack">
          {title}
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      </Card>
    )
  }
  if (model.batch === null) {
    return (
      <Card padded>
        <div className="fw-fpy-stack">
          {title}
          <p>{p('batch.none')}</p>
          <p className="fw-fpy-muted">{p(model.more ? 'batch.noneOlder' : 'batch.noneBody')}</p>
        </div>
      </Card>
    )
  }
  const { proposal, line } = model.batch
  const href = `${model.prefix}/finance/payables?proposal=${proposal.id}`
  return (
    <Card padded>
      <div className="fw-fpy-stack">
        {title}
        <KeyValue
          dense
          columns={1}
          labelCase="sentence"
          items={[
            {
              label: p('batch.inBatch'),
              value: (
                <span className="fw-fpy-inline">
                  <Link className="fw-fin-link" href={href}>
                    {p('batch.week', { week: proposal.week, from: day(proposal.weekStart), to: day(proposal.weekEnd) })}
                  </Link>
                  <Pill tone={PROPOSAL_TONE[proposal.status]}>{p(`proposal.status.${proposal.status}`)}</Pill>
                </span>
              ),
            },
            ...(model.cost && line.amount !== undefined ? [{ label: p('batch.amount'), value: line.discountAmount ? p('batch.amountDiscount', { amount: money(line.amount, proposal.currency, locale), discount: money(line.discountAmount, proposal.currency, locale) }) : money(line.amount, proposal.currency, locale) }] : []),
            {
              label: p('batch.iban'),
              value: line.account ? (
                <span className="fw-fpy-inline">
                  <span className="fw-fin-code">{line.account.masked}</span>
                  <Pill tone={line.account.usable ? 'success' : 'danger'}>{p(line.account.usable ? 'batch.usable' : 'batch.notUsable')}</Pill>
                </span>
              ) : (
                <Pill tone="danger">{p('batch.noAccount')}</Pill>
              ),
            },
          ]}
        />
        {line.held && <Banner tone="warning" title={p('batch.held')}>{line.problems.length > 0 ? line.problems.map((code) => p(`refusal.proposal.${code}`)).join(' ') : p('batch.heldAccount')}</Banner>}
      </div>
    </Card>
  )
}
