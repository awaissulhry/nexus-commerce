'use client'

import { Users } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../../payments/riba/depth'
import type { InvoiceDual } from '../api'
import { DUAL_TONE, dualState } from '../model'
import '../../payables.css'
import '../../../_shared/finance.css'

export interface DualApprovalModel {
  /** The answer (null while read). */
  value: InvoiceDual | null
  /** A failed read (a `finance` key), never drawn as empty. */
  problem: string | null
  /** The person looking (their own first yes says so). */
  me: string | null
  /** money.cost: the amount is drawn. */
  cost: boolean
}

export interface DualApprovalActions {
  onRetry?: () => void
}

/**
 * SCR-517 — dual approval on a supplier invoice's Approval tab (design finance.payables rec:Supplier invoice › Approval ›
 * approve "dual approval above 10,000 (W2b)"): whether the total is above the amount that needs two people (the amount with
 * the cost grain; the design's figure, said as not yet decided by the Owner), the first yes — who, when — and whether it still
 * stands (any change of the invoice after it lapses it), and who may give the second (never the person of the first). The
 * Approve button above asks each yes. No money in this section but the amount, with its grain.
 */
export function DualApprovalCard({ model, actions }: { model: DualApprovalModel; actions?: DualApprovalActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: DualApprovalModel; actions?: DualApprovalActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const title = (
    <h3 className="fw-fpy-h3">
      <Users size={14} aria-hidden /> {p('dual.title')}
    </h3>
  )
  if (model.problem) {
    return (
      <Card padded>
        <div className="fw-fpy-stack">
          {title}
          <Banner tone="danger" title={p('dual.failed')}>
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
  const value = model.value
  if (!value) {
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
  const state = dualState(value, model.me)
  const amount = model.cost && value.threshold.amount !== undefined ? money(value.threshold.amount, value.threshold.currency, locale) : null
  const first = value.first
  const firstName = first?.by.name ?? p('riba.someone')
  return (
    <Card padded>
      <div className="fw-fpy-stack">
        {title}
        <span className="fw-fpy-inline">
          <Pill tone={DUAL_TONE[state]}>{p(`dual.state.${state}`)}</Pill>
        </span>
        <p className="fw-fpy-muted">{amount ? p(`dual.body.${state}`, { amount, name: firstName }) : p(`dual.bodyPlain.${state}`, { name: firstName })}</p>
        <KeyValue
          dense
          columns={1}
          labelCase="sentence"
          items={[
            ...(amount ? [{ label: p('dual.amount'), value: amount }] : []),
            { label: p('dual.first'), value: first ? p(first.standing ? 'dual.firstBy' : 'dual.firstLapsed', { name: firstName, date: formatDateTime(first.at, { locale }) }) : p('dual.firstNone') },
          ]}
        />
        {!value.threshold.decided && <p className="fw-fpy-muted">{p('dual.undecided')}</p>}
      </div>
    </Card>
  )
}
