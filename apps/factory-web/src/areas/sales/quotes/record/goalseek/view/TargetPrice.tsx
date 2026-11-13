'use client'

import { Target } from 'lucide-react'
import { Banner, Card, Disclosure, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money, percent, unitPrice, type Grains } from '../../../model'
import type { Words } from '../../lines-depth/model'
import { useDepthWords } from '../../lines-depth/words'
import type { GoalAnswer } from '../api'

export type TargetOf = 'line' | 'total'

export interface TargetPriceModel {
  target: TargetOf
  lineId: string
  /** The size-grid lines a target may price ("10 · SEED-JKT-01 BLK"). */
  lines: ReadonlyArray<{ id: string; label: string }>
  /** The target as typed (a unit price for a line, the quote's total for the total). */
  value: string
  currency: string
  priceBasis: 'NET' | 'GROSS'
  grains: Grains
  /** The plan for the target typed (nothing written); null until asked. */
  preview: GoalAnswer | null
  state: 'idle' | 'reading' | 'ready' | 'failed' | 'saving'
  problem: Words | null
  /** Why Apply cannot write (W1's read-only words), or null on a draft the person edits. */
  readOnly: Words | null
  /** The customer's target from the inquiry the quote came from (price grain), or null. */
  inquiry: { number: string; targetUnitPrice: string | null } | null
  /** Open on arrival (design: collapsed until opened). */
  open?: boolean
}

export interface TargetPriceActions {
  onTarget?: (target: TargetOf) => void
  onLine?: (lineId: string) => void
  onValue?: (value: string) => void
  onApply?: () => void
  onRetry?: () => void
}

/**
 * Price & margin › Target price (design quote.price.goalseek, SAL-150; B-W2b-302's goal-seek): type the customer's target —
 * a unit price for one line or the quote's total — and see what it takes before anything is written: the discount needed,
 * the resulting margin (€ only with the cost grain, % with the margin grain), the lines that would fall under the floor,
 * the totals before → after and whether it then needs an approval. Apply writes the prices with the reason "Target price"
 * through B-W2b-330's waterfall; a target under cost is held ("an approver must allow it": price the line by hand).
 */
export function TargetPrice({ model, actions }: { model: TargetPriceModel; actions?: TargetPriceActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const { grains, currency, preview } = model
  const held = preview?.held ?? []
  const applyHeld = model.readOnly
    ? say(model.readOnly)
    : model.value.trim() === ''
      ? t(model.target === 'line' ? 'goal.held.price' : 'goal.held.total')
      : model.state === 'reading'
        ? t('goal.held.reading')
        : model.state === 'failed' || !preview
          ? t('goal.held.noPlan')
          : held.some((entry) => entry.code === 'BELOW_COST')
            ? t('goal.held.belowCost')
            : held.length > 0
              ? t('goal.held.refused')
              : model.state === 'saving'
                ? sales('held.busy')
                : null
  const under = preview?.lines.filter((line) => line.belowFloor) ?? []
  const marginAmount = preview && grains.cost && grains.margin ? preview.lines.reduce<number | null>((sum, line) => (line.to.marginAmount === null || line.to.marginAmount === undefined || sum === null ? null : sum + line.to.marginAmount), 0) : null
  const labelOf = (lineId: string) => model.lines.find((line) => line.id === lineId)?.label ?? '—'

  return (
    <Card padded className="fw-qd-goal">
      <Disclosure summary={<span className="fw-q-inline"><Target size={14} aria-hidden /> {t('goal.title')}</span>} open={model.open}>
        <div className="fw-q-stack">
          <p className="fw-q-hint">{t('goal.intro')}</p>
          {!grains.price ? (
            <p className="fw-q-hint">{sales('price.noPrice.body')}</p>
          ) : (
            <>
              <div className="fw-qd-goal-form">
                <SegmentedControl
                  size="sm"
                  ariaLabel={t('goal.of')}
                  value={model.target}
                  onChange={(value) => actions?.onTarget?.(value === 'total' ? 'total' : 'line')}
                  options={[
                    { value: 'line', label: t('goal.ofLine') },
                    { value: 'total', label: t('goal.ofTotal') },
                  ]}
                />
                {model.target === 'line' && (
                  <Field label={t('goal.line')}>
                    <Select size="sm" value={model.lineId} onChange={(event) => actions?.onLine?.(event.target.value)}>
                      {model.lines.map((line) => (
                        <option key={line.id} value={line.id}>
                          {line.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={t(model.target === 'line' ? (model.priceBasis === 'GROSS' ? 'goal.unitGross' : 'goal.unitNet') : model.priceBasis === 'GROSS' ? 'goal.totalGross' : 'goal.totalNet')} hint={t('goal.valueHint', { currency })}>
                  <Input size="sm" inputMode="decimal" value={model.value} onChange={(event) => actions?.onValue?.(event.target.value)} />
                </Field>
              </div>
              {model.inquiry?.targetUnitPrice && (
                <p className="fw-q-hint">
                  {t('goal.inquiry', { number: model.inquiry.number, price: unitPrice(model.inquiry.targetUnitPrice, currency, locale) })}{' '}
                  {model.target === 'line' && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onValue?.(model.inquiry?.targetUnitPrice ?? '')}>
                      {t('goal.useInquiry')}
                    </Button>
                  )}
                </p>
              )}
              {model.state === 'reading' && (
                <p className="fw-q-hint" role="status">
                  <Spinner size={14} /> {t('goal.reading')}
                </p>
              )}
              {model.state === 'failed' && model.problem && (
                <Banner
                  tone="danger"
                  title={say(model.problem)}
                  action={
                    <Button size="sm" onClick={() => actions?.onRetry?.()}>
                      {t('common.retry')}
                    </Button>
                  }
                />
              )}
              {preview && model.state !== 'failed' && (
                <div className="fw-q-stack" aria-live="polite">
                  <KeyValue
                    dense
                    labelCase="sentence"
                    items={[
                      ...(model.target === 'line' && preview.lines[0]
                        ? [{ label: t('goal.discountNeeded'), value: preview.lines[0].discountPct ? t(Number(preview.lines[0].discountPct) < 0 ? 'goal.raiseValue' : 'goal.discountValue', { pct: percent(String(Math.abs(Number(preview.lines[0].discountPct))), locale) }) : '—' }]
                        : []),
                      ...(preview.totals?.before?.netAmount !== undefined && preview.totals?.after?.netAmount !== undefined ? [{ label: t('goal.net'), value: t('goal.fromTo', { from: money(preview.totals.before.netAmount, currency, locale), to: money(preview.totals.after.netAmount, currency, locale) }) }] : []),
                      ...(preview.totals?.after?.grossAmount !== undefined ? [{ label: t('goal.gross'), value: money(preview.totals.after.grossAmount, currency, locale) }] : []),
                      ...(preview.totals?.gap ? [{ label: t('goal.gap'), value: money(preview.totals.gap, currency, locale) }] : []),
                      ...(grains.margin && preview.margin ? [{ label: t('goal.marginPct'), value: t('goal.fromTo', { from: percent(preview.margin.before ?? null, locale), to: percent(preview.margin.after ?? null, locale) }) }] : []),
                      ...(marginAmount !== null ? [{ label: t('goal.marginAmount'), value: money(marginAmount, currency, locale) }] : []),
                      ...(grains.margin ? [{ label: t('goal.underFloor'), value: under.length === 0 ? t('goal.noneUnder') : under.map((line) => labelOf(line.lineId)).join(' · ') }] : []),
                      { label: t('goal.approval'), value: <Pill tone={preview.approval.neededAfter ? 'warning' : 'success'}>{t(preview.approval.neededAfter ? 'goal.needsApproval' : 'goal.noApproval')}</Pill> },
                    ]}
                  />
                  {model.target === 'total' && preview.lines.length > 0 && (
                    <SummaryTable
                      label={t('goal.linesLabel')}
                      density="compact"
                      stackOnPhone
                      columns={[t('goal.col.line'), t('goal.col.from'), t('goal.col.to'), t('goal.col.discount'), ...(grains.margin ? [t('goal.col.margin')] : [])]}
                      align={['left', 'right', 'right', 'right', 'right']}
                      rows={preview.lines.map((line) => ({
                        id: line.lineId,
                        cells: [
                          labelOf(line.lineId),
                          unitPrice(line.from.unitPrice, currency, locale),
                          unitPrice(line.to.unitPrice, currency, locale),
                          line.discountPct ? percent(line.discountPct, locale) : '—',
                          ...(grains.margin ? [<span key="m" className="fw-q-inline">{percent(line.to.marginPct ?? null, locale)}{line.belowFloor ? <Tag tone="warning">{sales('lines.belowFloor')}</Tag> : null}</span>] : []),
                        ],
                      }))}
                    />
                  )}
                  {held.length > 0 && (
                    <Banner tone="warning" title={t('goal.heldTitle', { count: held.length })}>
                      <ul className="fw-q-list">
                        {held.map((entry) => (
                          <li key={entry.lineId}>{t(`review.held.${entry.code}`, { line: labelOf(entry.lineId) })}</li>
                        ))}
                      </ul>
                    </Banner>
                  )}
                </div>
              )}
              <div className="fw-qd-actions">
                <span className="fw-q-hint">{t('goal.reason')}</span>
                <span className="fw-qd-grow" />
                <Button size="sm" variant="primary" heldReason={applyHeld} onClick={() => actions?.onApply?.()}>
                  {model.state === 'saving' ? <Spinner size={12} /> : null} {t('goal.apply', { count: preview?.lines.length ?? 0 })}
                </Button>
              </div>
            </>
          )}
        </div>
      </Disclosure>
    </Card>
  )
}
