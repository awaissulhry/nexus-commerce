'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { Card, KeyValue } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { decimalText, moneyText } from '../../styles/model'
import type { ProductSettingsActions, ProductSettingsModel } from '../view-model'
import { CardFailed } from './parts'

/**
 * psettings.costing — Costing defaults (one home: Finance settings): the labour rates in force per department (cost per
 * minute and planned efficiency) and the overhead, read only, and the way to Finance settings. The cost per minute is the
 * cost grain: "Not in your role" without money.cost (the server drops it too). Without costing.view the card says where the
 * values live and who reads them; nothing here is changed.
 */
export function CostingCard({ model, actions }: { model: ProductSettingsModel; actions?: ProductSettingsActions }) {
  const t = useT('products-settings')
  const locale = useLocale()
  const link = model.can.finance ? (
    <Button size="sm" variant="secondary" asChild>
      <Link href={`${model.prefix}/finance/settings`}>
        {t('costing.open')} <ArrowUpRight size={13} aria-hidden />
      </Link>
    </Button>
  ) : undefined
  const body = (): ReactNode => {
    if (!model.can.costing || !model.costing) return <p className="fw-pst-hint">{t('costing.noRight')}</p>
    if (model.costing.problem) return <CardFailed title={t('costing.failed')} problem={model.costing.problem} onRetry={actions?.onRetryCosting} />
    const value = model.costing.value
    if (!value) return <Skeleton height={140} />
    const rates = value.rates.filter((rate) => rate.inForce && rate.status === 'ACTIVE')
    // The overhead row in force (the company's own, else every company's; a company row that follows every company is not).
    const overhead = [value.settings.company, value.settings.tenant].find((row) => row !== null && row.id === value.settings.inForce) ?? null
    const items = [
      ...rates.map((rate) => ({
        label: t(`workCentre.${rate.workCentreKind}`),
        value: (
          <span className="fw-pst-cell">
            <span>{rate.costPerMinute === undefined || !model.can.cost ? t('costing.notInRole') : t('costing.perMinute', { amount: moneyText(rate.costPerMinute as string, rate.currency, locale) })}</span>
            <span className="fw-pst-sub">{t('costing.efficiency', { percent: decimalText(rate.plannedEfficiencyPct, locale) })}</span>
          </span>
        ),
        hint: rate.companyId === null ? t('costing.everyCompany') : t('costing.thisCompany'),
      })),
      {
        label: t('costing.overhead'),
        value: overhead ? t('costing.overheadPct', { percent: decimalText(overhead.overheadPct, locale) }) : t('costing.noOverhead'),
        hint: overhead ? (overhead.companyId === null ? t('costing.everyCompany') : t('costing.thisCompany')) : undefined,
      },
    ]
    return (
      <div className="fw-pst-stack">
        {rates.length === 0 && <p className="fw-pst-hint">{t('costing.noRates')}</p>}
        <KeyValue items={items} columns={2} dense labelCase="sentence" />
        {!model.can.cost && <p className="fw-pst-hint">{t('costing.noGrain')}</p>}
      </div>
    )
  }
  return (
    <Card header={t('costing.title')} description={t('costing.description')} headerAction={link} headingLevel={2} className="fw-pst-card">
      <div className="fw-pst-stack">
        {body()}
        <p className="fw-pst-hint">{model.can.finance ? t('costing.where') : t('costing.whereNoRight')}</p>
      </div>
    </Card>
  )
}
