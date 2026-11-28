'use client'

import { RotateCcw } from 'lucide-react'
import { Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Words } from '../../now/model'
import type { WhatIfAnswer, WhatIfInput } from '../model'
import '../../now/cost.css'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "What if"; prototype cost.js prodCostTab › what) — a calculator: materials %, work %, a price
 * → the new cost, the margin at that price (keeps the target · under the target · under the cost, in words), the price for the target.
 * Nothing is saved; it counts with the cost now, not with the standard cost (the card says it). Draws its model; fetches nothing.
 */

export interface WhatIfModel {
  readonly input: WhatIfInput
  readonly answer: WhatIfAnswer
  readonly targetPct: number
  /** The cost now is only known so far (an input is missing). */
  readonly partial: boolean
  readonly money: (amount: string | null | undefined) => string
}

const VERDICT_TONE = { KEEPS: 'success', UNDER_TARGET: 'warning', UNDER_COST: 'danger' } as const

export function WhatIfCard({ model, onInput, onClear }: { model: WhatIfModel; onInput: (input: WhatIfInput) => void; onClear: () => void }) {
  const t = useT('products-cost')
  const say = (words: Words) => t(words.key, words.params)
  const { input, answer } = model
  const set = (patch: Partial<WhatIfInput>) => onInput({ ...input, ...patch })
  const change = answer.change === null || Number(answer.change) === 0 ? null : Number(answer.change) > 0 ? t('whatif.more', { amount: model.money(answer.change) }) : t('whatif.less', { amount: model.money(String(Math.abs(Number(answer.change)))) })
  return (
    <Card
      header={t('whatif.title')}
      headingLevel={2}
      description={t('whatif.intro')}
      headerAction={
        answer.touched ? (
          <Button size="sm" variant="quiet" onClick={onClear}>
            <RotateCcw size={13} aria-hidden /> {t('whatif.clear')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-ct-body">
        <div className="fw-ct-fields">
          <Field label={t('whatif.materials')} error={answer.problems.materialsPct ? say(answer.problems.materialsPct) : undefined}>
            <Input value={input.materialsPct} inputMode="decimal" placeholder="+10" suffix="%" onChange={(event) => set({ materialsPct: event.target.value })} />
          </Field>
          <Field label={t('whatif.work')} error={answer.problems.workPct ? say(answer.problems.workPct) : undefined}>
            <Input value={input.workPct} inputMode="decimal" placeholder="+5" suffix="%" onChange={(event) => set({ workPct: event.target.value })} />
          </Field>
          <Field label={t('whatif.price')} error={answer.problems.price ? say(answer.problems.price) : undefined}>
            <Input value={input.price} inputMode="decimal" prefix="€" onChange={(event) => set({ price: event.target.value })} />
          </Field>
        </div>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('whatif.cost'), value: answer.cost === null ? '—' : <span className="fw-ct-name"><b>{model.money(answer.cost)}</b>{change}</span> },
            {
              label: t('whatif.margin'),
              value:
                answer.margin === null ? (
                  t('whatif.noPrice')
                ) : (
                  <span className="fw-ct-name">
                    <b>{`${answer.margin < 0 ? '− ' : ''}${Math.abs(answer.margin)} %`}</b>
                    {answer.verdict && <Tag tone={VERDICT_TONE[answer.verdict]}>{t(`whatif.verdict.${answer.verdict}`, { target: model.targetPct })}</Tag>}
                  </span>
                ),
            },
            { label: t('whatif.forTarget', { target: model.targetPct }), value: answer.priceForTarget === null ? '—' : <b>{model.money(answer.priceForTarget)}</b> },
          ]}
        />
        <p className="fw-ct-hint">{t(model.partial ? 'whatif.nothingSavedPartial' : 'whatif.nothingSaved', { target: model.targetPct })}</p>
      </div>
    </Card>
  )
}
