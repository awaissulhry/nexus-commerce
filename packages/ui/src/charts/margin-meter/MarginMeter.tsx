'use client'

/**
 * MarginMeter — a margin % against the floor and the target (B-W2b-09; design "MarginMeter" on styles, orders, price
 * lists and quotes): a bar with the floor and target marks, a tone and the words ("18.2 % — under the 20 % floor").
 *
 *   <MarginMeter value={18.2} floor={20} target={30} allowed={can.margin} format={(n) => pct(n, locale)} labels={ds.marginMeter} />
 *   <MarginMeter size="mini" value={row.marginPct} floor={20} allowed={can.margin} />      // a grid cell
 *
 * - **Grain**: renders NOTHING when `allowed` is false (the person lacks the margin grain) — not a dash, not a hint
 *   that something is hidden. An unknown margin (`value` null) says "Margin not known", never 0.
 * - **Never colour alone**: the words always say where the margin is; the marks have names; `role="meter"` carries the
 *   value and the sentence for a screen reader.
 * - `mini`: the bar and the value only, one line, for a grid cell (the sentence is its name and its tooltip).
 * Its own entry point (`charts/margin-meter`). Words: `labels`; numbers: `format` (the person's language).
 */
import { mergeLabels } from '../../lib/labels'
import { MARGIN_METER_LABELS, type MarginMeterLabels } from './MarginMeterLabels'
import { marginMeterView, marginPercent } from './marginMeterModel'
import './margin-meter.css'

export interface MarginMeterProps {
  /** The margin in percent; null when not known. */
  value: number | null | undefined
  floor?: number | null
  target?: number | null
  /** The person holds the margin grain. False: nothing is drawn. Default true. */
  allowed?: boolean
  /** `mini`: one line for a grid cell. */
  size?: 'md' | 'mini'
  /** Writes a percent ("18,2 %"). Default: one decimal in `locale`. */
  format?: (value: number) => string
  locale?: string
  /** A fixed scale (a column of meters that must compare). Default: from the values. */
  scale?: { min: number; max: number }
  /** The meter's name: "Margin now". Default `labels.label`. */
  label?: string
  labels?: Partial<MarginMeterLabels>
  className?: string
}

export function MarginMeter({ value, floor, target, allowed = true, size = 'md', format, locale, scale, label, labels, className }: MarginMeterProps) {
  if (!allowed) return null
  const words = mergeLabels(MARGIN_METER_LABELS, labels)
  const view = marginMeterView({ value, floor, target }, { words, format: format ?? ((n) => marginPercent(n, locale)), scale })
  const name = label ?? words.label
  const cls = ['nds-marginmeter', size === 'mini' ? 'mini' : '', `tone-${view.tone}`, view.known ? '' : 'is-unknown', className ?? ''].filter(Boolean).join(' ')
  const left = view.fill === null ? 0 : Math.min(view.zero, view.fill)
  const width = view.fill === null ? 0 : Math.abs(view.fill - view.zero)
  const bar = (
    <span className="nds-marginmeter-track" aria-hidden>
      {view.fill !== null && <span className="nds-marginmeter-fill" style={{ left: `${left}%`, width: `${width}%` }} />}
      {view.floorAt !== null && <span className="nds-marginmeter-mark is-floor" style={{ left: `${view.floorAt}%` }} />}
      {view.targetAt !== null && <span className="nds-marginmeter-mark is-target" style={{ left: `${view.targetAt}%` }} />}
    </span>
  )
  const meter = {
    role: 'meter' as const,
    'aria-label': name,
    'aria-valuemin': view.min,
    'aria-valuemax': view.max,
    ...(view.known && typeof value === 'number' ? { 'aria-valuenow': value } : {}),
    'aria-valuetext': view.words,
  }
  if (size === 'mini') {
    return (
      <span className={cls} {...meter} title={view.words}>
        {bar}
        <span className="nds-marginmeter-value">{view.valueText}</span>
      </span>
    )
  }
  return (
    <div className={cls}>
      <div className="nds-marginmeter-bar" {...meter}>
        {bar}
      </div>
      <p className="nds-marginmeter-words">{view.words}</p>
      {(view.floorText || view.targetText) && (
        <p className="nds-marginmeter-key">
          {view.floorText && (
            <span className="nds-marginmeter-keyitem">
              <span className="nds-marginmeter-swatch is-floor" aria-hidden />
              {words.floorMark(view.floorText)}
            </span>
          )}
          {view.targetText && (
            <span className="nds-marginmeter-keyitem">
              <span className="nds-marginmeter-swatch is-target" aria-hidden />
              {words.targetMark(view.targetText)}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
