'use client'

import { useMemo, type ReactNode } from 'react'
import { DetailPopover } from '../../components/DetailPopover'
import { LOAD_BAR_WORDS, loadAfterSentence, loadView, minutesFormatter, type LoadBarWords } from './loadBarModel'
import './planning-board.css'

export interface LoadBarProps {
  /** Standard minutes booked now. */
  booked: number
  /** Standard minutes available; `null` = no working time set, `undefined` = not known ("—", never 0). */
  available: number | null | undefined
  /** The booked minutes after a move being made: the bar shows them, marked as a preview, and says both. */
  after?: number | null
  /** Whose load this is ("Line 2, Tue 12 Nov"): the first words a screen reader hears. */
  label?: string
  /** `sm` is a board cell (the figure over the bar, the minutes under it); `md` puts them on one line beside the label. */
  size?: 'sm' | 'md'
  /** `md` shows the label beside the figure; false when the place already names it (a column head, a list row). */
  labelVisible?: boolean
  words?: Partial<LoadBarWords>
  /** The page's language for the numbers (default `en-GB`). */
  locale?: string
  /** Formats minutes (wins over `locale`). */
  formatMinutes?: (minutes: number) => string
  /** A popover opened from the bar — how the capacity is made, what is booked in it. The bar becomes its button. */
  detail?: ReactNode | ((api: { close: (options?: { returnFocus?: boolean }) => void }) => ReactNode)
  /** The popover's name (default: the label). */
  detailLabel?: string
  className?: string
}

/**
 * LoadBar — one lane-and-bucket capacity cell (gap D18, "LoadBar (new)"): booked against available standard minutes,
 * the percent written, and over capacity SAID ("+640 min over") with a hatched part past the capacity line, never by
 * colour alone. Unknown is "—", no working time is said, and a preview (`after`) shows the load after a move with
 * both sentences for a screen reader. With `detail` the bar is a DetailPopover button (the formula, the work in it).
 * Every word comes in through `words` (English by default); `loadBarModel.ts` holds the rule.
 */
export function LoadBar({ booked, available, after, label = '', size = 'sm', labelVisible = true, words: own, locale, formatMinutes, detail, detailLabel, className }: LoadBarProps) {
  const words = useMemo(() => ({ ...LOAD_BAR_WORDS, ...own }), [own])
  const format = useMemo(() => formatMinutes ?? minutesFormatter(locale), [formatMinutes, locale])
  const now = loadView({ booked, available }, words, format, label)
  const preview = typeof after === 'number' && Number.isFinite(after) && after !== booked ? loadView({ booked: after, available }, words, format, label) : null
  const shown = preview ?? now
  const sentence = preview ? loadAfterSentence(now, preview, words) : now.sentence
  const cls = ['nds-loadbar', size === 'md' ? 'md' : 'sm', `is-${shown.state}`, preview ? 'is-preview' : '', className ?? ''].filter(Boolean).join(' ')
  const face = (
    <span className={cls} data-load-state={shown.state}>
      <span className="nds-loadbar-head" aria-hidden="true">
        {size === 'md' && label && labelVisible ? <span className="nds-loadbar-label">{label}</span> : null}
        <span className="nds-loadbar-value">{shown.value}</span>
        {preview ? <span className="nds-loadbar-after">{words.after}</span> : null}
        {shown.overText ? <span className="nds-loadbar-over">{shown.overText}</span> : null}
      </span>
      <span className="nds-loadbar-track" aria-hidden="true">
        <span className="nds-loadbar-fill" style={{ width: `${Math.min(shown.bookedAt, shown.capacityAt)}%` }} />
        {shown.state === 'over' ? <span className="nds-loadbar-excess" style={{ left: `${shown.capacityAt}%`, width: `${100 - shown.capacityAt}%` }} /> : null}
        {shown.state === 'over' && shown.capacityAt > 0 ? <span className="nds-loadbar-cap" style={{ left: `${shown.capacityAt}%` }} /> : null}
      </span>
      <span className="nds-loadbar-minutes" aria-hidden="true">{shown.minutes}</span>
      {detail ? null : <span className="nds-vh">{sentence}</span>}
    </span>
  )
  if (!detail) return face
  return (
    <DetailPopover trigger={face} triggerLabel={sentence} triggerClassName="nds-loadbar-trigger" label={detailLabel ?? (label || sentence)} hoverDelay={0}>
      {detail}
    </DetailPopover>
  )
}
