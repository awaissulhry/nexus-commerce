'use client'

import { Card, KeyValue } from '@nexus/ui/components'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { languageOf } from '../../overview/facts'
import type { OrderRecordModel } from '../../record-model'

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged (its language rule is facts.ts').
 *
 * O7 Order facts (loaded, never shown before): ordered on, requested, the customer PO, the season, the language, the tax mode, made · changed.
 */
export function FactsCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const season = model.depth?.depth.value?.season ?? null
  const language = t(languageOf(order).key)
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.facts.title')}</h2>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('dates.ordered'), value: day(order.orderDate) },
          { label: t('dates.requested'), value: day(order.requestedDate) },
          { label: t('overview.facts.customerRef'), value: order.customerRef ?? '—' },
          ...(season ? [{ label: d('season.label'), value: season.code }] : []),
          { label: t('overview.facts.language'), value: language },
          { label: t('newOrder.taxMode'), value: t(`newOrder.taxModes.${order.taxMode}`) },
          { label: t('overview.facts.made'), value: t('overview.facts.madeValue', { made: formatDate(order.createdAt, { locale }), changed: formatDate(order.updatedAt, { locale }) }) },
        ]}
      />
    </Card>
  )
}
