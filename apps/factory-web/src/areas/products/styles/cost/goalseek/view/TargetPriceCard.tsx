'use client'

import { useState } from 'react'
import { Banner, Card, EmptyState, Field, MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Grains } from '../../../model'
import { decimalText, moneyText } from '../../../model'
import { lineWords } from '../../components/model'
import type { GoalSeekView, VersionRow } from '../../versions/api'
import { CS_NS, keepTargetHeld, type CostSheetAbilities, type Phrase, type Read } from '../../versions/model'
import { GOAL_BASES, goalHeldWords, goalProblems, goalStateOf, keepChangesNothing, type GoalAsk } from '../model'

export interface TargetPriceModel {
  /** The version in view (null: no version yet). */
  readonly sheet: VersionRow | null
  readonly sizes: readonly string[]
  readonly can: CostSheetAbilities
  readonly grains: Grains
  /** What the fields hold when the card opens (the version's own target). */
  readonly ask: GoalAsk
  readonly result: Read<GoalSeekView>
  readonly busy: boolean
  readonly problem: Phrase | null
}

export interface TargetPriceActions {
  onSeek?: (ask: GoalAsk) => void
  onKeep?: (ask: GoalAsk) => void
}

/**
 * SCR-503 — Style › Cost › Target price (design products.styles style.cost.goalseek; FIN-013): type a target price or a
 * target margin (each only with its grain) and the cost to read (the weighted cost for the size mix, the base size's or one
 * size's); see the allowed cost, the gap and the biggest lines with the cut each would need alone and shared. "Keep this
 * target" writes it on a draft version (an approved one is locked: a new version). The view fetches nothing.
 */
export function TargetPriceCard({ model, actions }: { model: TargetPriceModel; actions?: TargetPriceActions }) {
  const t = useT(CS_NS)
  const tp = useT('products')
  const locale = useLocale()
  const [ask, setAsk] = useState<GoalAsk>(model.ask)
  const set = <K extends keyof GoalAsk>(key: K, value: GoalAsk[K]) => setAsk((current) => ({ ...current, [key]: value }))
  const header = t('goal.title')
  const sheet = model.sheet
  if (!sheet)
    return (
      <Card header={header}>
        <EmptyState title={t('goal.noVersion')} description={t('goal.noVersionBody')} />
      </Card>
    )
  const problems = goalProblems(ask)
  const firstProblem = problems.targetPrice ?? problems.targetMarginPct
  const seekHeld = model.busy ? t('verHeld.busy') : firstProblem ? t(firstProblem) : null
  const keep = keepTargetHeld(model.can, model.grains, sheet, model.busy)
  const keepHeld = keep ? t(keep.key, keep.params) : firstProblem ? t(firstProblem) : keepChangesNothing(ask, sheet, model.grains) ? t('goal.keepSame') : null
  const money = (value: string | null | undefined, grain: boolean) => (grain && value !== undefined && value !== null ? moneyText(value, sheet.currency, locale) : null)
  const pct = (value: string | null | undefined) => (value === null || value === undefined ? null : `${decimalText(value, locale, 2)} %`)
  const held = goalHeldWords(model.grains)
  return (
    <Card header={header} description={t('goal.intro', { version: sheet.sheetVersion })}>
      <div className="fw-st-stack">
        {held && <Banner tone="info" title={t(held.key, held.params)} />}
        <form
          className="fw-st-form-grid"
          onSubmit={(event) => {
            event.preventDefault()
            if (!seekHeld) actions?.onSeek?.(ask)
          }}
        >
          {model.grains.price && (
            <Field label={t('goal.targetPrice', { currency: sheet.currency })} hint={t('goal.targetPriceHint')} error={problems.targetPrice ? t(problems.targetPrice) : undefined}>
              <Input inputMode="decimal" value={ask.targetPrice} onChange={(event) => set('targetPrice', event.target.value)} />
            </Field>
          )}
          {model.grains.margin && (
            <Field label={t('goal.targetMargin')} hint={t('goal.targetMarginHint')} error={problems.targetMarginPct ? t(problems.targetMarginPct) : undefined}>
              <Input inputMode="decimal" value={ask.targetMarginPct} onChange={(event) => set('targetMarginPct', event.target.value)} />
            </Field>
          )}
          <Field label={t('goal.basis')} hint={t(`goalBasis.hint.${ask.basis}`)}>
            <Select value={ask.basis} onChange={(event) => set('basis', event.target.value as GoalAsk['basis'])}>
              {GOAL_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`goalBasis.${basis}`, { size: sheet.baseSize })}
                </option>
              ))}
            </Select>
          </Field>
          {ask.basis === 'SIZE' && (
            <Field label={t('goal.size')}>
              <Select value={ask.size} onChange={(event) => set('size', event.target.value)}>
                {model.sizes.map((size) => (
                  <option key={size} value={size}>
                    {size === sheet.baseSize ? t('steps.baseSizeOption', { size }) : size}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <span className="fw-st-actions fw-cs-formactions">
            <Button type="submit" variant="primary" size="sm" heldReason={seekHeld}>
              {t('goal.seek')}
            </Button>
            <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeep?.(ask)}>
              {t('goal.keep', { version: sheet.sheetVersion })}
            </Button>
          </span>
        </form>
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        {model.result.status === 'loading' ? (
          <p className="fw-st-hint" role="status">
            <Spinner size={14} /> {t('goal.working')}
          </p>
        ) : model.result.status === 'error' ? (
          <Banner tone="danger" title={t('goal.failed')}>
            {t(model.result.problem)}
          </Banner>
        ) : model.result.status === 'ready' ? (
          <GoalAnswer view={model.result.value} grains={model.grains} money={money} pct={pct} kind={(kind) => tp(`kind.${kind}`)} />
        ) : (
          <p className="fw-st-hint">{t('goal.ask')}</p>
        )}
      </div>
    </Card>
  )
}

function GoalAnswer({ view, grains, money, pct, kind }: { view: GoalSeekView; grains: Grains; money: (value: string | null | undefined, grain: boolean) => string | null; pct: (value: string | null | undefined) => string | null; kind: (kind: string) => string }) {
  const t = useT(CS_NS)
  const state = goalStateOf(view)
  const basis = view.basis.kind === 'SIZE' ? t('goal.basisSize', { size: view.basis.size ?? '—' }) : t(`goalBasis.${view.basis.kind}`, { size: view.sheet.baseSize })
  const metrics: Metric[] = [
    {
      label: t('goal.m.target'),
      value: [money(view.target.price, grains.price), grains.margin ? pct(view.target.marginPct) : null].filter(Boolean).join(' · ') || t('goal.noTarget'),
      hint: t(`goal.from.${view.target.from}`),
    },
    ...(grains.cost
      ? [
          { label: t('goal.m.cost'), value: money(view.cost, true) ?? t('ver.notKnown'), hint: basis },
          { label: t('goal.m.allowed'), value: money(view.allowedCost, true) ?? '—' },
          {
            label: t('goal.m.gap'),
            value: money(view.gap, true) ?? '—',
            delta: view.state === 'ABOVE' ? { value: t('goal.over'), tone: 'negative' as const } : view.state === 'WITHIN' ? { value: t('goal.within'), tone: 'positive' as const } : undefined,
          },
        ]
      : []),
    ...(grains.margin && view.marginAtCost ? [{ label: t('goal.m.marginAtCost'), value: pct(view.marginAtCost) ?? '—' }] : []),
    ...(grains.price && view.priceForMargin ? [{ label: t('goal.m.priceForMargin'), value: money(view.priceForMargin, true) ?? '—' }] : []),
  ]
  return (
    <div className="fw-st-stack">
      <span>
        <Pill tone={state.tone}>{t(state.key)}</Pill>
      </span>
      <MetricStrip metrics={metrics} />
      {view.lines.length > 0 && (
        <>
          <h3 className="fw-cs-h3">{t('goal.lines')}</h3>
          <SummaryTable
            label={t('goal.lines')}
            stackOnPhone
            columns={[t('goal.col.line'), ...(grains.cost ? [t('goal.col.cost'), t('goal.col.share'), t('goal.col.cutAlone'), t('goal.col.cutShared')] : [])]}
            align={[undefined, ...(grains.cost ? (['right', 'right', 'right', 'right'] as const) : [])]}
            widths={grains.cost ? ['36%', '16%', '14%', '16%', undefined] : undefined}
            rows={view.lines.map((line) => {
              const words = lineWords(line, kind)
              return {
                id: line.lineId,
                cells: [
                  <span key="l" className="fw-st-cellstack">
                    <b>{t(words.key, words.params)}</b>
                    <span className="nds-summary-sub">{t(`stepCat.${line.category}`)}</span>
                  </span>,
                  ...(grains.cost ? [money(line.cost, true) ?? '·', pct(line.sharePct) ?? '·', line.cutAlonePct ? `−${pct(line.cutAlonePct)}` : view.state === 'ABOVE' ? t('goal.notEnough') : '—', line.cutShared ? `−${money(line.cutShared, true)}` : '—'] : []),
                ],
              }
            })}
          />
          <p className="fw-st-hint">{t('goal.linesNote')}</p>
        </>
      )}
    </div>
  )
}
