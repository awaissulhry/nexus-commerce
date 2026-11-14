import { GRAINS, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { isMarkedJson, looksLikeMoney } from '@nexus/factory-domain/money/marked'

/**
 * Field history on every record (B-W2b-399; PLT-076): an audit row as lines of "field from → to", so the record's timeline
 * shows "price 480 → 520 by Marco, 10:42" between its comments (W0's History panel showed them apart), and the audit search
 * opens the same lines. One line per top-level field whose value changed, sorted by name, exactly the fields the timeline's
 * `fields` names (factory-domain threads/timeline changeSummary):
 *
 *   values     shown only to a reader who may see them (audit.read over the row, and not while the site's gate keeps back a
 *              worker the row is about); otherwise each line keeps its field and says `hidden: 'VALUES'`
 *   money      a value marked with a grain the reader holds travels as it was marked (the app's grain filter checks it again on
 *              the way out); one of a grain the reader lacks, or an unmarked field whose name looks like money for a reader
 *              without every grain (fail closed, as the grain filter does), is left out (`unheldMoney: 'omit'`, the timeline:
 *              such a field is not even named) or named with `hidden: 'GRAIN'` (`'name'`, the audit search: "changed the
 *              cost (hidden)")
 *
 * Values are what the command recorded (plain JSON): strings, numbers, true/false, null, lists and objects; the screens say
 * them in words. A field the row added has `from` null, one it removed `to` null.
 */

export type FieldLineHidden = 'GRAIN' | 'VALUES'

export interface FieldLine {
  readonly field: string
  readonly from: unknown
  readonly to: unknown
  /** Why the values are not shown; null: shown. */
  readonly hidden: FieldLineHidden | null
}

export interface FieldLineOptions {
  /** The grains the reader holds (factory-domain heldGrains). */
  readonly held: ReadonlySet<Grain>
  /** The reader may see this row's values. */
  readonly values: boolean
  /** A money field the reader may not see: left out, or named as hidden. */
  readonly unheldMoney: 'omit' | 'name'
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function fieldLinesOf(before: unknown, after: unknown, options: FieldLineOptions): FieldLine[] {
  const from = isPlainObject(before) ? before : {}
  const to = isPlainObject(after) ? after : {}
  const everyGrain = GRAINS.every((grain) => options.held.has(grain))
  const lines: FieldLine[] = []
  for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    const previous = from[field]
    const next = to[field]
    if (JSON.stringify(previous) === JSON.stringify(next)) continue
    const marked = [previous, next].find(isMarkedJson)
    const moneyHidden = marked ? !options.held.has(marked.$money) : looksLikeMoney(field) && !everyGrain
    if (moneyHidden) {
      if (options.unheldMoney === 'name') lines.push({ field, from: null, to: null, hidden: 'GRAIN' })
      continue
    }
    lines.push(options.values ? { field, from: previous ?? null, to: next ?? null, hidden: null } : { field, from: null, to: null, hidden: 'VALUES' })
  }
  return lines
}

/** A line as one short text (an export's "What changed" cell): `field: from → to`, hidden ones in words of the caller. */
export function fieldLineText(line: FieldLine, hiddenWords: string): string {
  if (line.hidden) return `${line.field} (${hiddenWords})`
  const shown = (value: unknown): string => {
    if (value === null || value === undefined) return '—'
    if (isMarkedJson(value)) return shown(value.value)
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }
  return `${line.field}: ${shown(line.from)} → ${shown(line.to)}`
}
