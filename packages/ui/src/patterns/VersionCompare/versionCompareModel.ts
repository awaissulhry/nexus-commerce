/**
 * VersionCompare's rules (B-W2b-207, design part VersionCompare), pure: two versions of a structured record — a style's
 * revisions (BOM, spec, operations), a change order's redline, a quote's or an order's versions, a price list's — compared
 * line by line: which lines were added, removed or changed, which of their fields changed (before → after, written by the
 * app), how each size's quantity moved, and the totals before → after; and the same facts as a plain change note.
 *
 * Lines are matched by `id` by the app (the same BOM line, quote line, price row in both versions). A field's values are
 * already written ("1.20 m²", "€ 41.20"); a size's quantity is a decimal string or a number, compared exactly.
 */
import type { VersionCompareLabels } from './VersionCompareLabels'

export interface VersionHead {
  /** "Rev 3", "Version 2". */
  label: string
  /** "Released 03/11/2026", "Draft". */
  note?: string | null
}

export interface VersionLineSide {
  /** The line's fields in this version, written ("1.20 m²"); null or absent = no value. */
  fields?: Readonly<Record<string, string | null | undefined>>
  /** Quantity per size in this version (decimal strings or numbers); null or absent = none. */
  sizes?: Readonly<Record<string, string | number | null | undefined>>
}

export interface VersionLine {
  /** The same id in both versions. */
  id: string
  /** What the line is: "20 · LEA-001 Cowhide 1.2 mm". */
  label: string
  /** Where or what more: "Body · front panels". */
  detail?: string | null
  /** The line in the first version; null: the line is new in the second. */
  before: VersionLineSide | null
  /** The line in the second version; null: the line was removed. */
  after: VersionLineSide | null
}

export interface VersionField {
  id: string
  /** "Quantity", "Supplier", "Unit price". */
  label: string
}

export interface VersionTotal {
  id: string
  /** "Total cost", "Units". */
  label: string
  before: string | null
  after: string | null
}

export type VersionLineKind = 'added' | 'removed' | 'changed' | 'unchanged'

export interface VersionFieldChange {
  id: string
  label: string
  from: string | null
  to: string | null
}

export interface VersionSizeChange {
  size: string
  from: string | null
  to: string | null
  /** after − before (exact), when both are there. */
  delta: string | null
}

export interface VersionLineView {
  line: VersionLine
  kind: VersionLineKind
  /** The fields to show: the changed ones (a changed line) or every one with a value (an added or removed line). */
  fields: VersionFieldChange[]
  /** The sizes to show: the changed ones, or every one with a quantity (added / removed). */
  sizes: VersionSizeChange[]
}

export interface VersionSummary {
  added: number
  removed: number
  changed: number
  unchanged: number
  /** Totals that moved. */
  totals: number
}

// ---- exact decimals ------------------------------------------------------------------------------------------------

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/

/** A quantity as an exact decimal text ("1.2000" → "1.2"); null for none or not a number. */
export function quantityOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = (typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value).trim().replace(',', '.')
  if (!NUMBER.test(text)) return null
  const negative = text.startsWith('-')
  const [whole = '', fraction = ''] = text.replace('-', '').split('.')
  const cleanWhole = (whole || '0').replace(/^0+(?=\d)/, '')
  const cleanFraction = fraction.replace(/0+$/, '')
  const body = cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

const scaleOf = (value: string) => (value.split('.')[1] ?? '').length
const toScaled = (value: string, scale: number): bigint => {
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
  const digits = BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
  return negative ? -digits : digits
}

/** b − a, exactly ("0.1"); signs kept ("-0.25"). */
export function quantityDelta(a: string, b: string): string {
  const scale = Math.max(scaleOf(a), scaleOf(b))
  const d = toScaled(b, scale) - toScaled(a, scale)
  const negative = d < 0n
  const digits = (negative ? -d : d).toString().padStart(scale + 1, '0')
  const whole = scale ? digits.slice(0, -scale) : digits
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : ''
  const body = fraction ? `${whole}.${fraction}` : whole
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

// ---- the comparison ------------------------------------------------------------------------------------------------

const valueOf = (side: VersionLineSide | null, field: string): string | null => {
  const value = side?.fields?.[field]
  return value === undefined || value === null || value === '' ? null : value
}

/** Every line compared, in the given order, with its changed fields and sizes. */
export function versionLineViews(lines: readonly VersionLine[], fields: readonly VersionField[], sizes: readonly string[] = []): VersionLineView[] {
  return lines.map((line) => {
    const fieldChanges: VersionFieldChange[] = []
    for (const field of fields) {
      const from = valueOf(line.before, field.id)
      const to = valueOf(line.after, field.id)
      if (from === to) continue
      fieldChanges.push({ id: field.id, label: field.label, from: line.before ? from : null, to: line.after ? to : null })
    }
    const sizeChanges: VersionSizeChange[] = []
    const sizeIds = sizes.length ? sizes : [...new Set([...Object.keys(line.before?.sizes ?? {}), ...Object.keys(line.after?.sizes ?? {})])]
    for (const size of sizeIds) {
      const from = quantityOf(line.before?.sizes?.[size])
      const to = quantityOf(line.after?.sizes?.[size])
      if (from === to) continue
      sizeChanges.push({ size, from, to, delta: from !== null && to !== null ? quantityDelta(from, to) : null })
    }
    const kind: VersionLineKind = !line.before ? 'added' : !line.after ? 'removed' : fieldChanges.length || sizeChanges.length ? 'changed' : 'unchanged'
    return { line, kind, fields: fieldChanges, sizes: sizeChanges }
  })
}

/** How many lines of each kind, and how many totals moved. */
export function versionSummary(views: readonly VersionLineView[], totals: readonly VersionTotal[] = []): VersionSummary {
  const count = (kind: VersionLineKind) => views.filter((view) => view.kind === kind).length
  return { added: count('added'), removed: count('removed'), changed: count('changed'), unchanged: count('unchanged'), totals: totals.filter((total) => total.before !== total.after).length }
}

/** Is there anything to tell? */
export function versionHasChanges(summary: VersionSummary): boolean {
  return summary.added + summary.removed + summary.changed + summary.totals > 0
}

export interface VersionNoteWords {
  /** A quantity written in the page's language ("1,2"). */
  formatQuantity?: (value: string) => string
}

/**
 * The plain change note ("Use as change note"): the head, one line per added, removed and changed line (its fields and
 * sizes from → to), then the totals that moved. Unchanged lines are left out. Empty when nothing changed.
 */
export function versionChangeNote(
  before: VersionHead,
  after: VersionHead,
  views: readonly VersionLineView[],
  totals: readonly VersionTotal[],
  labels: VersionCompareLabels,
  words: VersionNoteWords = {},
): string {
  const q = (value: string | null) => (value === null ? labels.none : (words.formatQuantity ?? String)(value))
  const lines: string[] = []
  for (const view of views) {
    if (view.kind === 'unchanged') continue
    if (view.kind === 'added') lines.push(labels.noteAdded(view.line.label))
    else if (view.kind === 'removed') lines.push(labels.noteRemoved(view.line.label))
    else {
      const parts = [
        ...view.fields.map((change) => labels.noteField(change.label, change.from ?? labels.none, change.to ?? labels.none)),
        ...view.sizes.map((change) => labels.noteSize(change.size, q(change.from), q(change.to))),
      ]
      lines.push(labels.noteChanged(view.line.label, parts.join(labels.join)))
    }
  }
  for (const total of totals) {
    if (total.before === total.after) continue
    lines.push(labels.noteTotal(total.label, total.before ?? labels.none, total.after ?? labels.none))
  }
  if (lines.length === 0) return ''
  return [labels.noteHead(before.label, after.label), ...lines.map((line) => `- ${line}`)].join('\n')
}
