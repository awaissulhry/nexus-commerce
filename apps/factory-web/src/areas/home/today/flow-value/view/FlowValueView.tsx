'use client'

import { Coins } from 'lucide-react'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { FlowValue } from '../api'
import { stageValueText, totalOf } from '../model'
import '../flow-value.css'

/** Today's value per stage's model (design home.today `flow`, W2b). */
export interface FlowValueModel {
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: FlowValue }
}

/**
 * SCR-644 — Today's flow with its value per stage (B-W2b-435; design home.today `flow`: "Counts only; value per stage (cost) for
 * people with cost rights, W2b"): under the work-order flow strip, what sits on the work orders of each stage at cost (the
 * work-order cost ledger: the same ledger the WIP value of the metric layer sums), in the company's currency, with how many work
 * orders. Drawn only for a person with the cost grain (the container leaves it out otherwise: the strip stays counts only).
 * One view model, nothing fetched.
 */
export function FlowValueView({ model, onRetry }: { model: FlowValueModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['home-digest', 'home']}>
      <View model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function View({ model, onRetry }: { model: FlowValueModel; onRetry?: () => void }) {
  const t = useT('home-digest')
  const th = useT('home')
  const locale = useLocale()
  const read = model.read
  if (read.status === 'loading') {
    return (
      <div className="fw-flowv" aria-busy="true">
        <Skeleton width={260} height={16} />
      </div>
    )
  }
  if (read.status === 'error') {
    return (
      <p className="fw-flowv fw-flowv-muted">
        {t(read.problem)}{' '}
        <Button size="sm" variant="quiet" onClick={onRetry}>
          {t('digest.retry')}
        </Button>
      </p>
    )
  }
  const flow = read.data
  if (flow.mixedCurrencies) return <p className="fw-flowv fw-flowv-muted">{t('flowValue.mixed')}</p>
  const total = stageValueText(totalOf(flow), flow.currency, locale)
  return (
    <div className="fw-flowv" role="group" aria-label={t('flowValue.label')}>
      <span className="fw-flowv-title">
        <Coins size={14} aria-hidden /> {t('flowValue.title')}
      </span>
      <ul className="fw-flowv-stages">
        {flow.stages.map((stage) => (
          <li key={stage.key} className="fw-flowv-stage">
            <span className="fw-flowv-muted">{th(`today.flow.stage.WORK_ORDERS.${stage.key}`)}</span> <strong>{stageValueText(stage.value, flow.currency, locale) ?? '—'}</strong>{' '}
            <span className="fw-flowv-muted">{t('flowValue.workOrders', { count: stage.workOrders })}</span>
          </li>
        ))}
      </ul>
      {total && <span className="fw-flowv-muted">{t('flowValue.total', { value: total })}</span>}
      {!flow.complete && <span className="fw-flowv-muted">{t('flowValue.partial')}</span>}
    </div>
  )
}
