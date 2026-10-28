/**
 * GDS — before → after (gap G1, the approvals grid, 2026-10-05). The WORDS of a change, as pure rules.
 *
 * One request changes one or more values: a price, a stock count, a title per language. The grid shows the first
 * change on one line ("Price: €49.90 → €44.90 · +2 more"), a drawer or a list shows every line. This file decides
 * what each line says to a screen reader, to the cell's tooltip and to the CSV / quick filter, so the three never
 * disagree; `ChangeCell.tsx` only draws.
 *
 * A null is a fact here, not a gap: `from: null` means there was no value before (the change sets a NEW value),
 * `to: null` means the change REMOVES the value. Neither is ever drawn as an empty string or as "0".
 */

export interface ChangeLine {
  /** What changes, in the operator's words: "Price", "Stock", "Title (IT)". */
  label: string
  /** The value before, already formatted ("€49.90"). `null` = there was none: the change sets a new value. */
  from: string | null
  /** The value after, already formatted ("€44.90"). `null` = the change removes the value. */
  to: string | null
}

export interface ChangeValueData {
  /** The lines this surface has, in order. A grid row draws the first; a drawer draws them all. */
  changes: readonly ChangeLine[]
  /** How many further lines exist that are NOT in `changes` (the server sent a capped list). Drawn as "+N more". */
  more?: number
}

export type ChangeKind = 'changed' | 'added' | 'removed' | 'unchanged' | 'empty'

/** Which of the five shapes a line has. `unchanged` is said, not hidden: an edit that lands on the same value is still an edit. */
export function changeKind(line: ChangeLine): ChangeKind {
  if (line.from === null && line.to === null) return 'empty'
  if (line.from === null) return 'added'
  if (line.to === null) return 'removed'
  return line.from === line.to ? 'unchanged' : 'changed'
}

const extra = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/**
 * "+N more" for a surface: a compact (one-line) surface draws only the first line, so the lines it leaves out count
 * too; a full surface draws every line it has and counts only `more`.
 */
export function changeMoreCount(data: ChangeValueData, compact: boolean): number {
  return (compact ? Math.max(0, data.changes.length - 1) : 0) + extra(data.more)
}

/** One line, for a screen reader: "Price: from €49.90 to €44.90". */
export function changeLineText(line: ChangeLine): string {
  const label = line.label.trim()
  const head = label ? `${label}: ` : ''
  switch (changeKind(line)) {
    case 'changed': return `${head}from ${line.from} to ${line.to}`
    case 'added': return `${head}new value ${line.to}`
    case 'removed': return `${head}${line.from} removed`
    case 'unchanged': return `${head}unchanged, ${line.to}`
    case 'empty': return `${head}no value`
  }
}

const moreWords = (n: number) => `${n} more change${n === 1 ? '' : 's'}`

/**
 * Everything this surface KNOWS, for a screen reader — every line in `changes`, then "and N more changes" for `more`.
 * Never cut to the first line in a compact cell: a pointer user can hover the tooltip, a screen-reader user cannot.
 */
export function changeAccessibleText(data: ChangeValueData): string {
  const lines = data.changes.map(changeLineText)
  const more = extra(data.more)
  if (lines.length === 0) return more > 0 ? moreWords(more) : 'No change'
  return more > 0 ? `${lines.join('; ')}; and ${moreWords(more)}` : lines.join('; ')
}

/** One line as the tooltip and the CSV say it, with the arrow: "Price: €49.90 → €44.90". */
export function changeLineArrowText(line: ChangeLine): string {
  const label = line.label.trim()
  const head = label ? `${label}: ` : ''
  switch (changeKind(line)) {
    case 'changed': return `${head}${line.from} → ${line.to}`
    case 'added': return `${head}→ ${line.to} (new)`
    case 'removed': return `${head}${line.from} → removed`
    case 'unchanged': return `${head}${line.to} (unchanged)`
    case 'empty': return `${head}no value`
  }
}

/** The cell's tooltip: every line on its own line, then "+N more". Empty string when there is nothing to say. */
export function changeTooltipText(data: ChangeValueData | null): string {
  if (!data) return ''
  const lines = data.changes.map(changeLineArrowText)
  const more = extra(data.more)
  if (more > 0) lines.push(`+${more} more`)
  return lines.join('\n')
}

/** The same lines on ONE line — the CSV, the clipboard and the quick filter. */
export function changeSummaryText(data: ChangeValueData | null): string {
  if (!data) return ''
  const lines = data.changes.map(changeLineArrowText)
  const more = extra(data.more)
  if (more > 0) lines.push(`+${more} more`)
  return lines.join('; ')
}

const isLine = (v: unknown): v is ChangeLine => {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  return typeof l.label === 'string'
    && (l.from === null || typeof l.from === 'string')
    && (l.to === null || typeof l.to === 'string')
}

/**
 * A cell value in either shape a column may hold — `ChangeLine[]` or `{ changes, more }` — or null when it is
 * neither. Malformed lines are dropped rather than drawn as "undefined".
 */
export function asChangeValueData(value: unknown): ChangeValueData | null {
  if (Array.isArray(value)) return { changes: value.filter(isLine) }
  if (value && typeof value === 'object' && Array.isArray((value as ChangeValueData).changes)) {
    const v = value as ChangeValueData
    return { changes: v.changes.filter(isLine), more: extra(v.more) }
  }
  return null
}
