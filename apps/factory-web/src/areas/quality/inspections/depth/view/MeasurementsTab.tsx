'use client'

import { type KeyboardEvent } from 'react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { ToleranceCell } from '@nexus/ui/components/LimitMeter/index'
import { Button, Input, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Section } from '../../../_shared/parts'
import type { Read } from '../../../_shared/model'
import type { ChartPoint, Sheet } from '../api'
import { chartPages, valueAt } from '../model'
import { useDepthT } from '../parts'
import type { SaveMark } from '../use-final-depth'
import { DepthMark } from './PlanChecks'

export interface MeasurementsModel {
  /** null: W1's fixed checklist (no chart). */
  readonly sheet: Read<Sheet> | null
  readonly marks: Readonly<Record<string, SaveMark>>
  /** Why the chart is read only here (a key of `inspections-depth`), or null. */
  readonly held: string | null
  /** The first unit of the page shown (a large sample turns by ten). */
  readonly from: number
  /** "Create defect" is held (the defects are read only): a key of `inspections-depth`, or null. */
  readonly defectHeld: string | null
  /** The lot's sizes (the work order's cells) and the one measured now: a point without its own size is measured in it. */
  readonly sizes?: readonly string[]
  readonly size?: string | null
}

export interface MeasurementsActions {
  onSize?: (size: string) => void
  onMeasure?: (point: ChartPoint, unit: number, text: string) => void
  onPage?: (from: number) => void
  onCreateDefect?: (point: ChartPoint, unit: number, words: string) => void
  onRetry?: () => void
}

const cellKey = (point: Pick<ChartPoint, 'pointCode' | 'size'>, unit: number) => `cell:${point.pointCode}:${point.size ?? ''}:${unit}`

/**
 * Inspection › Measurements (design ins-measure-grid, QHS-014 on B-W2b-97's chart): the points of measure — the plan's
 * nominal ± tolerance for the size, a size chart or the rider's profile — down, the sample's units across (ten at a time),
 * each value with its verdict in words beside the mark ("over by 0.8 cm"; never colour alone: the DS ToleranceCell). While
 * the inspection is open and the viewer's, a cell saves when it is left (one PUT; arrows move between cells); an
 * out-of-tolerance value offers "Create defect" (a measurement defect with the value). Footer: "2 of 60 values out of
 * tolerance". W1's checklist has no chart.
 */
export function MeasurementsTab({ model, actions }: { model: MeasurementsModel; actions?: MeasurementsActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const sheet = model.sheet
  if (!sheet) {
    return (
      <Section id="measurements" title={td('chart.heading')}>
        <EmptyState title={td('chart.w1')} />
      </Section>
    )
  }
  if (sheet.value === null && !sheet.problem) {
    return (
      <Section id="measurements" title={td('chart.heading')}>
        <Skeleton width="100%" height={160} />
      </Section>
    )
  }
  if (sheet.problem || !sheet.value) {
    return (
      <Section id="measurements" title={td('chart.heading')}>
        <EmptyState
          title={td('chart.failed')}
          description={t(sheet.problem ?? 'problem.unknown')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  }
  const value = sheet.value
  // A point the plan does not size is measured in the size picked (the API asks it for a lot of several sizes).
  const sizes = model.sizes ?? []
  const sized = (point: ChartPoint): ChartPoint => (point.size === null && model.size ? { ...point, size: model.size } : point)
  const chart = { ...value.chart, points: value.chart.points.map(sized) }
  const needsSize = value.chart.points.some((point) => point.size === null) && sizes.length > 1 && !model.size
  const editable = model.held === null && !needsSize
  const pages = chartPages(value.inspection.sampleSize)
  const page = pages.find((entry) => entry.from === model.from) ?? pages[0] ?? { from: 1, to: 0 }
  const units = Array.from({ length: Math.max(0, page.to - page.from + 1) }, (_, index) => page.from + index)
  const number = (text: string) => (Number.isFinite(Number(text)) ? Number(text) : null)
  // B-W2b-283 (FU1:05): a value's band (nominal − minus … nominal + plus) as one centre ± half for the DS ToleranceCell.
  const bandOf = (entry: ChartPoint['values'][number]): { nominal: number | null; tolerance: number | null } => {
    if (entry.toleranceMinus == null || entry.tolerancePlus == null) return { nominal: number(entry.nominal), tolerance: number(entry.tolerance) }
    const [minus, plus, nominal] = [Number(entry.toleranceMinus), Number(entry.tolerancePlus), Number(entry.nominal)]
    return { nominal: nominal + (plus - minus) / 2, tolerance: (plus + minus) / 2 }
  }
  const format = (n: number) => formatNumber(n, locale, { maximumFractionDigits: 3 })
  const outOf: { point: ChartPoint; unit: number; measured: string; words: string }[] = []
  for (const point of chart.points) {
    for (const entry of point.values) {
      if (entry.pass) continue
      const nominal = number(entry.nominal)
      const measured = number(entry.measured)
      const diff = nominal !== null && measured !== null ? measured - nominal : null
      const words = diff === null ? '' : td(diff > 0 ? 'chart.over' : 'chart.under', { by: format(Math.abs(diff)), uom: point.uom ?? '' })
      outOf.push({ point, unit: entry.sampleIndex, measured: entry.measured, words })
    }
  }
  // Arrows move between the chart's inputs (left and right only at the text's ends, so the caret still moves inside a value).
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const input = event.target as HTMLInputElement
    const at = input.dataset?.cell
    if (!at) return
    const [row, col] = at.split(':').map(Number) as [number, number]
    const end = input.selectionStart === input.value.length && input.selectionEnd === input.value.length
    const start = input.selectionStart === 0 && input.selectionEnd === 0
    const next = event.key === 'ArrowDown' ? [row + 1, col] : event.key === 'ArrowUp' ? [row - 1, col] : event.key === 'ArrowRight' && end ? [row, col + 1] : event.key === 'ArrowLeft' && start ? [row, col - 1] : null
    if (!next) return
    const target = event.currentTarget.querySelector<HTMLInputElement>(`[data-cell="${next[0]}:${next[1]}"]`)
    if (!target) return
    event.preventDefault()
    target.focus()
    target.select()
  }
  return (
    <div className="fw-q-stack">
      <Section
        id="measurements"
        title={td('chart.heading')}
        sub={chart.points.length > 0 ? td('chart.words', { out: chart.outOfTolerance, values: chart.values }) : undefined}
        actions={
          <span className="fw-q-actions">
            {sizes.length > 1 && value.chart.points.some((point) => point.size === null) && (
              <Select size="sm" aria-label={td('chart.sizePick')} value={model.size ?? ''} onChange={(event) => event.target.value && actions?.onSize?.(event.target.value)}>
                <option value="">{td('chart.sizeNone')}</option>
                {sizes.map((entry) => (
                  <option key={entry} value={entry}>
                    {td('chart.sizeOption', { size: entry })}
                  </option>
                ))}
              </Select>
            )}
            {pages.length > 1 && (
              <SegmentedControl size="sm" ariaLabel={td('chart.pages')} value={String(page.from)} onChange={(next) => actions?.onPage?.(Number(next))} options={pages.map((entry) => ({ value: String(entry.from), label: td('chart.range', { from: entry.from, to: entry.to }) }))} />
            )}
          </span>
        }
      >
        {model.held && <p className="fw-q-hint">{td(model.held)}</p>}
        {!model.held && needsSize && <p className="fw-q-hint">{td('chart.sizeFirst')}</p>}
        {chart.madeToMeasure && <Banner tone="info" title={td('chart.mtm', { garment: chart.madeToMeasure.garmentType, revision: chart.madeToMeasure.revision, size: chart.madeToMeasure.size })}>{chart.madeToMeasure.pointsWithout.length > 0 ? td('chart.mtmWithout', { points: chart.madeToMeasure.pointsWithout.join(', ') }) : null}</Banner>}
        {chart.points.length === 0 ? (
          <EmptyState title={td('chart.none')} />
        ) : (
          <div className="fw-qd-chart" onKeyDown={onKey}>
            <SummaryTable
              label={td('chart.heading')}
              columns={[td('chart.col.point'), td('chart.col.spec'), ...units.map((unit) => td('chart.unit', { unit }))]}
              rows={chart.points.map((point, row) => ({
                id: `${point.pointCode}:${point.size ?? ''}`,
                cells: [
                  <span key="p" className="fw-q-cell">
                    <span>{point.label}</span>
                    <span className="fw-q-hint">
                      {point.size ? td('chart.size', { size: point.size }) : null} {td(`chart.source.${point.source}`)}
                    </span>
                  </span>,
                  <span key="s" className="fw-q-num">
                    {point.nominal !== null ? td('chart.spec', { nominal: format(Number(point.nominal)), tolerance: point.tolerance !== null ? format(Number(point.tolerance)) : '—', uom: point.uom ?? '' }) : point.source === 'SPEC' && point.spec ? point.spec /* B-W2b-283 */ : td('chart.specTyped')}
                  </span>,
                  ...units.map((unit, col) => {
                    const entry = valueAt(point, unit)
                    const nominal = entry ? number(entry.nominal) : null
                    const shown =
                      entry && nominal !== null ? (
                        // B-W2b-283 (FU1:05): a band drawn as its centre ± half (the same band the database judges).
                        <ToleranceCell value={number(entry.measured)} nominal={bandOf(entry).nominal ?? nominal} tolerance={bandOf(entry).tolerance} unit={point.uom ?? undefined} format={format} labels={ds.limitMeter} />
                      ) : null
                    if (!editable) return <span key={unit}>{shown ?? <span className="fw-q-hint">—</span>}</span>
                    return (
                      <span key={unit} className="fw-q-cell fw-qd-cell">
                        <Input
                          size="sm"
                          inputMode="decimal"
                          className="fw-qd-value"
                          data-cell={`${row}:${col}`}
                          aria-label={td('chart.cellFor', { point: point.label, unit })}
                          defaultValue={entry ? format(Number(entry.measured)) : ''}
                          key={`${point.pointCode}:${unit}:${entry?.measured ?? ''}`}
                          onBlur={(event) => {
                            const text = event.target.value.trim()
                            const before = entry ? format(Number(entry.measured)) : ''
                            if (text !== before) actions?.onMeasure?.(point, unit, text)
                          }}
                        />
                        {shown}
                        <DepthMark mark={model.marks[cellKey(point, unit)]} />
                      </span>
                    )
                  }),
                ],
              }))}
              align={[undefined, 'right']}
            />
          </div>
        )}
        <p className="fw-q-hint">{td('chart.keys')}</p>
      </Section>
      {outOf.length > 0 && (
        <Section id="out-of-tolerance" title={td('chart.outHeading', { count: outOf.length })}>
          <ul className="fw-qd-out">
            {outOf.map((entry) => (
              <li key={`${entry.point.pointCode}:${entry.point.size ?? ''}:${entry.unit}`} className="fw-q-cell-row">
                <Tag tone="danger">{td('chart.outTag')}</Tag>
                <span>{td('chart.outLine', { point: entry.point.label, unit: entry.unit, measured: format(Number(entry.measured)), uom: entry.point.uom ?? '', words: entry.words })}</span>
                <Button size="sm" onClick={() => actions?.onCreateDefect?.(entry.point, entry.unit, td('chart.defectNote', { point: entry.point.label, unit: entry.unit, measured: format(Number(entry.measured)), uom: entry.point.uom ?? '', words: entry.words }))} heldReason={model.defectHeld ? td(model.defectHeld) : null}>
                  {td('chart.createDefect')}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
