'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { Pencil, Plus, SlidersHorizontal, Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { PartReading, Quiet, Section } from '../../../../lib/record-sections/Kit'
import type { RuleRow } from '../api'
import { FROM_TONE, fromWordsOf, ORDER_STRUCTURES_NS, type OrderPartModel } from '../model'
import { RuleSentence } from './RuleSentence'
import '../order-structures.css'

/**
 * owb-ss8 (8.4; design § 5zj C "on every order: the part Structure names the structure of each line and its rule"; "the customer: Terms
 * & requirements › How its orders are handled") — the order's part "Order structure" (each line's structure and why, kept after the first
 * print; "Another structure for this order…" and "Back to the rules" before it, with the right) and the customer's part (the rules that
 * name this customer, in reading order; "New rule for this customer…"). Office only. They draw; they fetch nothing.
 */

export interface OrderStructurePartViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  readonly part: OrderPartModel | null
  readonly ruleNo: (ruleId: string) => number
  /** Order structures' address. */
  readonly pageHref: string
}

export function OrderStructurePartView({ model, actions }: { model: OrderStructurePartViewModel; actions?: { onChange: () => void; onBack: () => void; onRetry: () => void } }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const part = model.part
  const first = part?.lines[0] ?? null
  const firstFrom = first ? fromWordsOf(first, first.rule ? model.ruleNo(first.rule.id) : 0) : null
  const buttons = [
    ...(part?.button === 'CHANGE'
      ? [
          <Button key="change" size="sm" onClick={() => actions?.onChange()}>
            <SlidersHorizontal size={14} aria-hidden />
            {t('order.another')}
          </Button>,
        ]
      : []),
    ...(part?.back
      ? [
          <Button key="back" size="sm" onClick={() => actions?.onBack()}>
            <Undo2 size={14} aria-hidden />
            {t('order.back')}
          </Button>,
        ]
      : []),
    <Button key="page" size="sm" variant="quiet" asChild>
      <Link href={model.pageHref}>{t('order.page')}</Link>
    </Button>,
  ]
  return (
    <Section id="order-structure" title={t('order.title')} answer={part ? `${t(part.answer.key, part.answer.params)}${part.one && firstFrom ? ` ${t(firstFrom.key, firstFrom.params)}` : ''}` : undefined} buttons={buttons}>
      {model.state === 'reading' ? (
        <PartReading rows={1} />
      ) : model.state === 'failed' || !part ? (
        <Banner
          tone="danger"
          title={t('order.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : part.one ? null : (
        <ul className="fw-os-lines">
          {part.lines.map((line) => {
            const from = fromWordsOf(line, line.rule ? model.ruleNo(line.rule.id) : 0)
            return (
              <li key={line.salesOrderLineId}>
                <span className="fw-os-line-l">{line.label}</span>
                <span className="fw-os-sub">{line.structure?.name ?? t('rules.normalWay')}</span>
                <Tag tone={FROM_TONE[line.from]}>{t(from.key, from.params)}</Tag>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

export interface CustomerStructurePartViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  /** The rules that name this customer (and their place in the list). */
  readonly rules: readonly RuleRow[]
  readonly ruleNo: (ruleId: string) => number
  readonly write: boolean
  readonly pageHref: string
}

export function CustomerStructurePartView({ model, actions }: { model: CustomerStructurePartViewModel; actions?: { onNewRule: () => void; onEditRule: (rule: RuleRow) => void; onRetry: () => void } }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const buttons = [
    ...(model.write
      ? [
          <Button key="new" size="sm" onClick={() => actions?.onNewRule()}>
            <Plus size={14} aria-hidden />
            {t('customer.newRule')}
          </Button>,
        ]
      : []),
    <Button key="page" size="sm" variant="quiet" asChild>
      <Link href={model.pageHref}>{t('order.page')}</Link>
    </Button>,
  ]
  return (
    <Section id="order-structures" title={t('customer.title')} answer={model.state === 'ready' ? (model.rules.length ? t('customer.rules', { count: model.rules.length }) : t('customer.none')) : undefined} buttons={buttons}>
      {model.state === 'reading' ? (
        <PartReading rows={1} />
      ) : model.state === 'failed' ? (
        <Banner
          tone="danger"
          title={t('customer.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : model.rules.length === 0 ? (
        <Quiet>{t('customer.noneHint')}</Quiet>
      ) : (
        <ol className="fw-os-rules">
          {model.rules.map((rule) => (
            <li key={rule.id} className={`fw-os-rule${rule.dead || rule.structure.closed ? ' is-dead' : ''}`}>
              <span className="fw-os-no">{model.ruleNo(rule.id) || '–'}</span>
              <span className="fw-os-rule-t">
                <RuleSentence rule={rule} />
              </span>
              <span className="fw-os-rule-m">{rule.dead ? <Tag tone="warning">{t('rules.neverUsed')}</Tag> : rule.structure.closed ? <Tag tone="warning">{t('rules.closedStructure')}</Tag> : null}</span>
              {model.write ? (
                <span className="fw-os-rule-acts">
                  <Button size="xs" variant="quiet" className="icon" aria-label={t('rules.edit', { n: model.ruleNo(rule.id) })} title={t('rules.edit', { n: model.ruleNo(rule.id) })} onClick={() => actions?.onEditRule(rule)}>
                    <Pencil size={14} aria-hidden />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
