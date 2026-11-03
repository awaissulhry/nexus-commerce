'use client'

import { Card, MetricStrip } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Minutes } from '../model'
import { SHIFT_NAMESPACE } from '../model'
import '../every-shift.css'

/**
 * Labour & cost › Minutes (design wo-minutes): standard minutes planned and earned per operation, the two lists on one
 * scale, and the work order's totals. Never per person: a worker's minutes live only in their own record. Off-standard
 * minutes have their own card (B-W2b-81, labour/view/OffStandardCard).
 */
export function MinutesCard({ minutes }: { minutes: Minutes }) {
  return (
    <WithMessages namespaces={[SHIFT_NAMESPACE]}>
      <Body minutes={minutes} />
    </WithMessages>
  )
}

function Body({ minutes }: { minutes: Minutes }) {
  const t = useT(SHIFT_NAMESPACE)
  const ds = useDsWords()
  const locale = useLocale()
  const format = (value: number) => t('minutes.value', { minutes: formatNumber(value, locale, { maximumFractionDigits: 1 }) })
  const max = Math.max(1, ...minutes.rows.map((row) => row.planned))
  const label = (row: Minutes['rows'][number]) => `${row.seq} · ${row.code}`
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('minutes.title')}</h2>
        <span className="fw-pr-hint">{t('minutes.hint')}</span>
      </div>
      <MetricStrip
        metrics={[
          { label: t('minutes.planned'), value: format(minutes.planned) },
          { label: t('minutes.earned'), value: format(minutes.earned) },
        ]}
      />
      <div className="fw-es-pair">
        <BarList label={t('minutes.planned')} format={format} max={max} labels={ds.barList} items={minutes.rows.map((row) => ({ id: String(row.seq), label: label(row), sub: row.name, value: row.planned }))} />
        <BarList label={t('minutes.earned')} format={format} max={max} labels={ds.barList} items={minutes.rows.map((row) => ({ id: String(row.seq), label: label(row), sub: row.earned === null ? t('minutes.notScanned') : row.name, value: row.earned }))} />
      </div>
      <p className="fw-pr-hint">{t('minutes.neverPerson')}</p>
    </Card>
  )
}
