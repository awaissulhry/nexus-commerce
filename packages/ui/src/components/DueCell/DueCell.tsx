'use client'

/**
 * DueCell — a due date as a tone and words (B-W2b-28, design part DueCell): training expiry, statutory checks, visits,
 * jobs, PM plans, measures. In a grid and anywhere else.
 *
 *   <DueCell value={{ due: '2026-11-15' }} today={siteToday} formatDate={(d) => formatDate(d, locale)} labels={ds.dueCell} />
 *   // a grid column (no AG import here: the renderer takes AG's params structurally)
 *   { field: 'expiry', cellRenderer: DueCellRenderer, cellRendererParams: { today: siteToday, labels: ds.dueCell },
 *     comparator: dueComparator({ today: siteToday }) }
 *
 * - Overdue / Needed / Due today / Due in 12 days / Valid until … / Done … / — (`dueCellModel.ts`): an icon AND words,
 *   never colour alone; overdue and needed in the danger tone, soon in warning, valid in success, done quiet.
 * - Sorted by urgency with `dueComparator` (most urgent first when ascending), not by the date string.
 * - `today` is the site's date; the default is the browser's local date.
 */
import { createElement } from 'react'
import { AlertTriangle, Check, CheckCircle2, CircleDashed, Clock } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { DUE_CELL_LABELS, type DueCellLabels } from './DueCellLabels'
import { dueDay, dueStatus, dueValueOf, type DueInput, type DueStatus, type DueTone } from './dueCellModel'
import './dueCell.css'

export interface DueCellProps {
  value: DueInput
  /** The site's date today (`YYYY-MM-DD`). Default: the browser's local date. */
  today?: string
  /** Days ahead that count as soon (default 30). */
  soonDays?: number
  /** Writes a `YYYY-MM-DD` date ("12 Mar 2027"). Default: `locale`'s medium date. */
  formatDate?: (isoDate: string) => string
  /** For the default date (default `en-GB`). */
  locale?: string
  labels?: Partial<DueCellLabels>
}

const ICON: Partial<Record<DueTone, typeof Check>> = { overdue: AlertTriangle, needed: CircleDashed, soon: Clock, valid: CheckCircle2, done: Check }

function defaultDate(iso: string, locale: string): string {
  const day = dueDay(iso)
  if (day === null) return iso
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(day * 86_400_000))
}

/** The cell's words for a status. */
export function dueWords(status: DueStatus, input: unknown, words: DueCellLabels, formatDate: (iso: string) => string): string {
  const v = dueValueOf(input)
  switch (status.tone) {
    case 'overdue':
      return words.overdue(-(status.days ?? 0))
    case 'soon':
      return status.days === 0 ? words.today : words.dueIn(status.days ?? 0)
    case 'valid':
      return words.validUntil(formatDate(String(v.due).slice(0, 10)))
    case 'needed':
      return words.needed
    case 'done':
      return v.doneOn && dueDay(v.doneOn) !== null ? words.doneOn(formatDate(v.doneOn.slice(0, 10))) : words.done
    default:
      return words.none
  }
}

export function DueCell({ value, today, soonDays, formatDate, locale = 'en-GB', labels }: DueCellProps) {
  const lw = mergeLabels(DUE_CELL_LABELS, labels)
  const status = dueStatus(value, { today, soonDays })
  const words = dueWords(status, value, lw, formatDate ?? ((iso) => defaultDate(iso, locale)))
  const icon = ICON[status.tone]
  return (
    <span className="nds-duecell" data-tone={status.tone}>
      {icon ? createElement(icon, { className: 'nds-duecell-icon', 'aria-hidden': true }) : null}
      <span className="nds-duecell-words">{words}</span>
    </span>
  )
}

/** What the grid hands the renderer, structurally (no AG types here): the cell's value plus `cellRendererParams`. */
export interface DueCellRendererParams extends Omit<DueCellProps, 'value'> {
  value?: unknown
}

/** `cellRenderer` for a due column; `cellRendererParams` carries `today`, `soonDays`, `formatDate`, `locale`, `labels`. */
export function DueCellRenderer({ value, ...rest }: DueCellRendererParams) {
  return <DueCell value={value as DueInput} {...rest} />
}
