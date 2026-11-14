'use client'

import { Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useFollowupsT } from '../words'
import { unitPrice } from '../../../quotes/model'
import { costChangeWords } from '../model'
import '../cost-changed.css'

/**
 * The mark beside a line's cost (B-W2b-380, XF6:02): "Cost +4,00 € since priced" (dearer, warning) or "Cost −2,50 € since
 * priced" (cheaper, info), its hover saying what to do; nothing when the cost did not move or is not known. Shown only where the
 * cost grain is: the container passes nothing otherwise.
 */
export function CostChangedMark({ change, currency }: { change: number | null | undefined; currency: string }) {
  const t = useFollowupsT()
  const locale = useLocale()
  const words = costChangeWords(change)
  if (!words) return null
  const amount = unitPrice(String(words.amount), currency, locale)
  return (
    <Tag tone={words.key === 'cost.up' ? 'warning' : 'info'} title={t(`${words.key}Hint`, { amount })}>
      {t(words.key, { amount })}
    </Tag>
  )
}
