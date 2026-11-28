'use client'

import type { ReactElement } from 'react'
import { ArrowRight } from 'lucide-react'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { RuleRow } from '../api'
import { categoryKeyOf, ORDER_STRUCTURES_NS, sentenceOf } from '../model'
import '../order-structures.css'

/**
 * owb-ss8 (8.3; design § 5zj C "a rule: one sentence") — "When an order line is from ⟨customer | any⟩ and is ⟨category | any⟩ → ⟨structure⟩",
 * the customer and the category as chips, the structure after the arrow. Draws what it is given.
 */
export function RuleSentence({ rule }: { rule: Pick<RuleRow, 'party' | 'category' | 'structure'> }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const parts = sentenceOf(rule)
  const category = parts.category ? (categoryKeyOf(parts.category) ? t(categoryKeyOf(parts.category)) : parts.category) : null
  return (
    <span className="fw-os-sent">
      <span className="fw-os-sent-w">{t('rule.when')}</span>
      <Tag tone={parts.customer ? 'info' : 'neutral'}>{parts.customer ?? t('rule.anyCustomer')}</Tag>
      <span className="fw-os-sent-w">{t('rule.andIs')}</span>
      <Tag tone={category ? 'info' : 'neutral'}>{category ?? t('rule.anyCategory')}</Tag>
      <ArrowRight size={14} aria-label={t('rule.handleAs')} />
      <b className="fw-os-sent-s">{parts.structure}</b>
    </span>
  )
}
