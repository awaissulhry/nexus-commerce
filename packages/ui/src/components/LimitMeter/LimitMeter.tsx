/**
 * LimitMeter — a measured value against a limit, or against a nominal ± tolerance (B-W2b-78, design part LimitMeter):
 * a lab result against the legal or brand limit (Cr VI, pH, tear strength), a point of measure against the size spec.
 *
 *   <LimitMeter label="Cr VI" value={1.2} unit="mg/kg" limit={3} loq={0.5} labels={ds.limitMeter} />
 *       → bar with the limit line, "1.2 mg/kg · limit 3 · ✓ Pass"
 *   <LimitMeter value={null} belowDetection loq={3} limit={3} unit="mg/kg" />   → "< 3 mg/kg · limit 3 · ✓ Below detection"
 *   <LimitMeter value={53.3} nominal={52} tolerance={0.5} unit="cm" />          → band, "53.3 cm · 52 ± 0.5 · ✕ over by 1.3 cm"
 *   <ToleranceCell value={53.3} nominal={52} tolerance={0.5} unit="cm" />       → "53.3 ✕ over by 1.3 cm" (a grid cell)
 *   <LimitMeter variant="cell" value={1.2} limit={3} unit="mg/kg" />            → "1.2 / 3 mg/kg ✓" (a list cell)
 *
 * - Never colour alone: every verdict is an icon shape (✓ ✕ ? –) AND a word (on screen, or for a screen reader in the
 *   cell where the column already says the verdict); the bar repeats the words and is hidden from screen readers.
 * - The rules (which side passes, below detection, the LOQ, tolerance and deviation) are `limitMeterModel.ts`.
 * - Numbers are written by `format` (the page's language), else `locale` (default en-GB), up to 3 decimals.
 * - Sized by the density (`--nds-density-*`): console size at standard, bigger on the floor tier.
 */
import { createElement, type CSSProperties, type ReactNode } from 'react'
import { CheckCircle2, CircleHelp, MinusCircle, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { LIMIT_METER_LABELS, type LimitMeterLabels } from './LimitMeterLabels'
import {
  LIMIT_TONE,
  isBelowDetection,
  isMaximum,
  limitVerdict,
  positionOn,
  scaleMax,
  toleranceResult,
  toleranceScale,
  type LimitRule,
  type LimitVerdict,
  type ToleranceVerdict,
} from './limitMeterModel'
import './limitMeter.css'

export interface LimitMeterProps {
  /** The parameter's name ("Cr VI", "Chest ½"), drawn first. */
  label?: ReactNode
  /** The measured value; null or undefined = not measured. */
  value?: number | null
  /** The unit written after numbers ("mg/kg", "cm", "%"). */
  unit?: string
  // ---- against a limit ----
  limit?: number | null
  /** Which side passes (default `below`: at or above the limit fails). */
  rule?: LimitRule
  /** The method's limit of quantification (detection). */
  loq?: number | null
  /** The lab reported "below the limit of quantification" (no value). */
  belowDetection?: boolean
  // ---- against a nominal ± tolerance (set `nominal`) ----
  nominal?: number | null
  tolerance?: number | null
  minus?: number | null
  plus?: number | null
  /** `bar` (default): the drawing and the words; `cell`: one compact line for a grid or a list cell. */
  variant?: 'bar' | 'cell'
  /** Where the bar's scale ends (default: a round number past the largest value drawn). */
  max?: number
  /** Writes a number in the page's language. */
  format?: (n: number) => string
  /** For the default number format (default `en-GB`). */
  locale?: string
  labels?: Partial<LimitMeterLabels>
  className?: string
  id?: string
}

type Verdict = LimitVerdict | ToleranceVerdict

const ICON: Record<'success' | 'danger' | 'warning' | 'neutral', typeof CheckCircle2> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: CircleHelp,
  neutral: MinusCircle,
}

const numberFormat = (locale = 'en-GB') => {
  const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 })
  return (n: number) => f.format(n)
}

const withUnit = (text: string, unit?: string) => (!unit ? text : unit === '%' ? `${text}%` : `${text} ${unit}`)

/** What the meter says, worked out once for both variants (and for the tests). */
export interface LimitMeterView {
  mode: 'limit' | 'tolerance'
  verdict: Verdict
  tone: 'success' | 'danger' | 'warning' | 'neutral'
  /** "1.2 mg/kg", "< 3 mg/kg", "53.3 cm"; null when not measured. */
  valueText: string | null
  /** "limit 3", "minimum 40", "52 ± 0.5"; null without a limit. */
  targetText: string | null
  /** The verdict's word for the full line ("Pass", "over by 1.3 cm"). */
  verdictText: string
  /** The cell's compact words ("1.2 / 3 mg/kg", "53.3"). */
  cellText: string
  /** The cell's visible verdict words (only when it fails a tolerance: "over by 1.3 cm"). */
  cellVerdict: string | null
  /** The whole sentence in one line ("1.2 mg/kg · limit 3 · Pass"). */
  line: string
}

export function limitMeterView(props: LimitMeterProps): LimitMeterView {
  const lw = mergeLabels(LIMIT_METER_LABELS, props.labels)
  const fmt = props.format ?? numberFormat(props.locale)
  const { value, unit } = props
  const measured = typeof value === 'number' && Number.isFinite(value)

  if (typeof props.nominal === 'number' && Number.isFinite(props.nominal)) {
    const r = toleranceResult({ value, nominal: props.nominal, tolerance: props.tolerance, minus: props.minus, plus: props.plus })
    const down = Math.abs(props.minus ?? props.tolerance ?? 0)
    const up = Math.abs(props.plus ?? props.tolerance ?? 0)
    const targetText = lw.nominal(fmt(props.nominal), fmt(down), fmt(up), down === up)
    const by = withUnit(fmt(Math.abs(r.deviation)), unit)
    const verdictText = r.verdict === 'over' ? lw.overBy(by) : r.verdict === 'under' ? lw.underBy(by) : lw.tolerance[r.verdict]
    const valueText = measured ? withUnit(fmt(value), unit) : null
    return {
      mode: 'tolerance',
      verdict: r.verdict,
      tone: LIMIT_TONE[r.verdict],
      valueText,
      targetText,
      verdictText,
      cellText: measured ? fmt(value) : lw.tolerance.notMeasured,
      cellVerdict: r.verdict === 'over' || r.verdict === 'under' ? verdictText : null,
      line: [valueText, targetText, verdictText].filter(Boolean).join(' · '),
    }
  }

  const rule = props.rule ?? 'below'
  const verdict = limitVerdict({ value, limit: props.limit, rule, loq: props.loq, belowDetection: props.belowDetection })
  const below = isBelowDetection({ value, loq: props.loq, belowDetection: props.belowDetection })
  const hasLimit = typeof props.limit === 'number' && Number.isFinite(props.limit)
  const valueText = below && typeof props.loq === 'number' ? withUnit(lw.belowLoq(fmt(props.loq)), unit) : measured ? withUnit(fmt(value), unit) : null
  const targetText = hasLimit ? (isMaximum(rule) ? lw.limit(fmt(props.limit as number)) : lw.minimum(fmt(props.limit as number))) : null
  const verdictText = lw.verdicts[verdict]
  const cellValue = below && typeof props.loq === 'number' ? lw.belowLoq(fmt(props.loq)) : measured ? fmt(value) : null
  const cellText = cellValue === null ? verdictText : hasLimit ? withUnit(lw.cellOf(cellValue, fmt(props.limit as number)), unit) : withUnit(cellValue, unit)
  return {
    mode: 'limit',
    verdict,
    tone: LIMIT_TONE[verdict],
    valueText,
    targetText,
    verdictText,
    cellText,
    cellVerdict: null,
    line: [valueText, targetText, verdictText].filter(Boolean).join(' · '),
  }
}

const at = (name: string, percent: number) => ({ [name]: `${percent.toFixed(2)}%` }) as CSSProperties

function Bar(props: LimitMeterProps & { view: LimitMeterView }) {
  const { view } = props
  if (view.mode === 'tolerance') {
    const r = toleranceResult({ value: props.value, nominal: props.nominal as number, tolerance: props.tolerance, minus: props.minus, plus: props.plus })
    const { min, max } = toleranceScale(r, props.nominal as number, props.value)
    const lo = positionOn(r.low, min, max)
    const hi = positionOn(r.high, min, max)
    return (
      <span className="nds-limit-bar" aria-hidden>
        <span className="nds-limit-band" style={{ ...at('--nds-limit-from', lo), ...at('--nds-limit-to', 100 - hi) }} />
        <span className="nds-limit-nominal" style={at('--nds-limit-at', positionOn(props.nominal as number, min, max))} />
        {typeof props.value === 'number' ? <span className="nds-limit-mark" style={at('--nds-limit-at', positionOn(props.value, min, max))} /> : null}
      </span>
    )
  }
  const top = props.max ?? scaleMax(props.value, props.limit, props.loq)
  const below = view.verdict === 'belowDetection' || (view.verdict === 'inconclusive' && isBelowDetection(props))
  return (
    <span className="nds-limit-bar" aria-hidden>
      {below && typeof props.loq === 'number' ? (
        <span className="nds-limit-hatch" style={at('--nds-limit-to', 100 - positionOn(props.loq, 0, top))} />
      ) : typeof props.value === 'number' ? (
        <span className="nds-limit-fill" style={at('--nds-limit-to', 100 - positionOn(props.value, 0, top))} />
      ) : null}
      {typeof props.loq === 'number' ? <span className="nds-limit-loq" style={at('--nds-limit-at', positionOn(props.loq, 0, top))} /> : null}
      {typeof props.limit === 'number' ? <span className="nds-limit-line" style={at('--nds-limit-at', positionOn(props.limit, 0, top))} /> : null}
    </span>
  )
}

export function LimitMeter(props: LimitMeterProps) {
  const view = limitMeterView(props)
  const icon = createElement(ICON[view.tone], { 'aria-hidden': true, className: 'nds-limit-icon' })
  const cls = ['nds-limit', props.className ?? ''].filter(Boolean).join(' ')
  if (props.variant === 'cell') {
    return (
      <span id={props.id} className={cls} data-variant="cell" data-tone={view.tone} data-verdict={view.verdict}>
        {props.label ? <span className="nds-limit-name">{props.label}</span> : null}
        <span className="nds-limit-value">{view.cellText}</span>
        <span className="nds-limit-verdict">
          {icon}
          {view.cellVerdict ? <span>{view.cellVerdict}</span> : view.cellText === view.verdictText ? null : <span className="nds-limit-sr">{view.verdictText}</span>}
        </span>
      </span>
    )
  }
  return (
    <div id={props.id} className={cls} data-variant="bar" data-tone={view.tone} data-verdict={view.verdict}>
      {props.label ? <span className="nds-limit-name">{props.label}</span> : null}
      <Bar {...props} view={view} />
      <span className="nds-limit-words">
        {view.valueText ? <span className="nds-limit-value">{view.valueText}</span> : null}
        {view.targetText ? <span className="nds-limit-target">{view.targetText}</span> : null}
        <span className="nds-limit-verdict">
          {icon}
          {view.verdictText}
        </span>
      </span>
    </div>
  )
}

/** The tolerance's grid-cell form (the design's ToleranceCell): "53.3 ✕ over by 1.3 cm". */
export function ToleranceCell(props: Omit<LimitMeterProps, 'variant' | 'limit' | 'rule' | 'loq' | 'belowDetection'> & { nominal: number }) {
  return <LimitMeter {...props} variant="cell" />
}

export interface LimitMeterCellRendererParams extends Omit<LimitMeterProps, 'value' | 'variant'> {
  /** The cell's value: a number, or an object with the row's own limit or nominal (`{ value, nominal, tolerance }`). */
  value?: unknown
}

/**
 * `cellRenderer` for a result or measurement column (no AG Grid import: the params are read structurally).
 * `cellRendererParams` carries `unit`, `format`, `labels` and the column's limit; a row's own target comes in the value.
 */
export function LimitMeterCellRenderer({ value, ...rest }: LimitMeterCellRendererParams) {
  if (value && typeof value === 'object') return <LimitMeter {...rest} {...(value as Partial<LimitMeterProps>)} variant="cell" />
  return <LimitMeter {...rest} value={typeof value === 'number' ? value : null} variant="cell" />
}
