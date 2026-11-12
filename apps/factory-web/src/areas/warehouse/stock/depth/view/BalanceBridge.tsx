'use client'

import { Waterfall } from '@nexus/ui/charts/waterfall/index'
import { formatDate } from '../../../../../lib/i18n/format'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity, signed } from '../../../../_shared/stock/model'
import type { Why } from '../api'
import { bridgeSteps, DEPTH_NAMESPACE, movesAddressOfLink } from '../model'

/**
 * The balance bridge of one stock figure (design warehouse.moves sec:mv-why "W2b: BalanceBridge chart (start → each reason
 * → on hand)"; composed in the app from the DS Waterfall, the design's BalanceBridge being new): the balance at the start of
 * the period, one bar per reason with its signed sum (its name a link that filters the ledger to it, its moves under it),
 * the balance at the end — read apart from the steps, so a figure that does not add up says so in words. Quantities are
 * the material's base unit (leather's hides are not in the bridge).
 */
export function BalanceBridge({ why, prefix }: { why: Why; prefix: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  const ds = useDsWords()
  const unit = s(`uom.${why.uom}`)
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone: 'UTC' })
  const steps = bridgeSteps(why).map((step) => {
    if (step.kind === 'start') return { id: step.id, kind: step.kind, label: why.period.from ? t('wd.bridge.startOn', { day: day(why.period.from) }) : t('wd.bridge.start'), amount: step.amount }
    if (step.kind === 'total') return { id: step.id, kind: step.kind, label: t('wd.bridge.endOn', { day: day(why.period.to) }), amount: step.amount }
    const own = why.steps.find((entry) => entry.reason === step.reason)!
    return { id: step.id, kind: step.kind, label: s(`reason.${own.reason}`), amount: step.amount, href: movesAddressOfLink(prefix, own.link), note: s('moves', { count: own.moves }) }
  })
  return (
    <div className="fw-wd-bridge">
      <Waterfall
        label={t('wd.bridge.label')}
        steps={steps}
        format={(value) => `${quantity(value, locale)} ${unit}`}
        good="none"
        labels={ds.waterfall}
        mismatchWords={(total) => t('wd.bridge.mismatch', { total, gap: `${signed(why.gap, locale)} ${unit}` })}
      />
    </div>
  )
}
