'use client'

import Link from 'next/link'
import { Card, EmptyState, MetricStrip } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { reasonWords } from '../../../../../lib/line-board/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { SHIFT_NAMESPACE } from '../../every-shift/model'
import type { OffStandardMinutes } from '../api'
import type { LabourModel } from '../model'
import '../../every-shift/every-shift.css'

/**
 * Labour & cost › Off-standard minutes (B-W2b-81; OffStandardEntry.workOrderId): the time this work order lost to waiting and
 * indirect work, approved, waiting for a decision and running, and per code. Never per person and no money, so it needs no
 * cost grain: production.offstandard.view (without it, the card says why). A rejected block is no off-standard time. Only
 * blocks that name the work order count: time on the line with no work order stays on the line's day in Labour & corrections.
 */
export function OffStandardCard({ part, labourHref = null, onRetry }: { part: NonNullable<LabourModel['offStandard']>; labourHref?: string | null; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[SHIFT_NAMESPACE]}>
      <Body part={part} labourHref={labourHref} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ part, labourHref, onRetry }: { part: NonNullable<LabourModel['offStandard']>; labourHref: string | null; onRetry?: (() => void) | undefined }) {
  const t = useT(SHIFT_NAMESPACE)
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('offStandard.title')}</h2>
        <span className="fw-pr-hint">{t('offStandard.hint')}</span>
      </div>
      {part.held ? (
        <p className="fw-pr-hint">{t('offStandard.held')}</p>
      ) : part.value ? (
        <Figures value={part.value} />
      ) : part.problem ? (
        <EmptyState
          title={t('offStandard.failed')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('offStandard.retry')}
            </Button>
          }
        />
      ) : (
        <p className="fw-pr-hint" role="status" aria-busy="true">
          <Spinner size={14} /> {t('offStandard.loading')}
        </p>
      )}
      <p className="fw-pr-hint">
        {t('offStandard.scope')}
        {labourHref && (
          <>
            {' '}
            <Link className="fw-pr-link" href={labourHref}>
              {t('minutes.toLabour')}
            </Link>
          </>
        )}
      </p>
    </Card>
  )
}

function Figures({ value }: { value: OffStandardMinutes }) {
  const t = useT(SHIFT_NAMESPACE)
  const ds = useDsWords()
  const locale = useLocale()
  const format = (minutes: number) => t('minutes.value', { minutes: formatNumber(minutes, locale, { maximumFractionDigits: 0 }) })
  if (value.blocks === 0) return <p className="fw-pr-hint">{t('offStandard.none')}</p>
  return (
    <>
      <MetricStrip
        metrics={[
          { label: t('offStandard.total'), value: format(value.minutes) },
          { label: t('offStandard.approved'), value: format(value.approved) },
          { label: t('offStandard.waiting'), value: format(value.waiting) },
          { label: t('offStandard.running'), value: format(value.running) },
        ]}
      />
      <BarList label={t('offStandard.perCode')} format={format} labels={ds.barList} items={value.codes.map((row) => ({ id: row.code.code, label: reasonWords(row.code, locale), sub: t('offStandard.blocks', { count: row.blocks }), value: row.minutes }))} />
    </>
  )
}
