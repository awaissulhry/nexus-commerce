import type { VersionLineKind } from './versionCompareModel'

/**
 * `VersionCompare`'s words (B-W2b-207). English by default; a host passes the words it translates. A word with a name or
 * a number in it is a function; quantities come written in the page's language.
 */
export interface VersionCompareLabels {
  /** Each line's kind, said beside its mark. */
  kinds: Record<VersionLineKind, string>
  /** The compare's name for assistive technology: "Rev 3 compared with Rev 4". */
  title: (before: string, after: string) => string
  /** The fields table's first column. */
  field: string
  /** An absent value ("—"). */
  none: string
  /** A line not in a version, said for its empty side: "Not in Rev 3". */
  notIn: (version: string) => string
  /** The per-size changes' name. */
  sizes: string
  /** One size's change for a screen reader: "Size M: from 1.1 to 1.2, +0.1". */
  sizeChange: (size: string, from: string, to: string, delta: string | null) => string
  /** The totals table's name. */
  totals: string
  /** "1 added · 1 removed · 2 changed" (only the kinds there are). */
  summary: (added: number, removed: number, changed: number) => string
  /** Nothing differs. */
  same: string
  /** Show the unchanged lines ("Show 4 unchanged lines"). */
  showUnchanged: (count: number) => string
  /** Hide them again. */
  hideUnchanged: string
  /** The button that hands the note to the page. */
  useAsNote: string
  /** Why "Use as change note" is held: nothing changed. */
  nothingToNote: string
  /** The note's first line: "Rev 3 → Rev 4". */
  noteHead: (before: string, after: string) => string
  noteAdded: (line: string) => string
  noteRemoved: (line: string) => string
  /** "20 · LEA-001: Quantity 1.20 → 1.30; size M 1.1 → 1.2". */
  noteChanged: (line: string, parts: string) => string
  noteField: (field: string, from: string, to: string) => string
  noteSize: (size: string, from: string, to: string) => string
  noteTotal: (total: string, from: string, to: string) => string
  /** Between the parts of a changed line in the note. */
  join: string
}

export const VERSION_COMPARE_LABELS: VersionCompareLabels = {
  kinds: { added: 'Added', removed: 'Removed', changed: 'Changed', unchanged: 'Unchanged' },
  title: (before, after) => `${before} compared with ${after}`,
  field: 'What',
  none: '—',
  notIn: (version) => `Not in ${version}`,
  sizes: 'Per size',
  sizeChange: (size, from, to, delta) => `Size ${size}: from ${from} to ${to}${delta ? `, ${delta}` : ''}`,
  totals: 'Totals',
  summary: (added, removed, changed) =>
    [added ? `${added} added` : null, removed ? `${removed} removed` : null, changed ? `${changed} changed` : null].filter(Boolean).join(' · ') || 'No line changed',
  same: 'The two versions are the same.',
  showUnchanged: (count) => (count === 1 ? 'Show 1 unchanged line' : `Show ${count} unchanged lines`),
  hideUnchanged: 'Hide the unchanged lines',
  useAsNote: 'Use as change note',
  nothingToNote: 'Nothing changed between the two versions.',
  noteHead: (before, after) => `${before} → ${after}`,
  noteAdded: (line) => `Added ${line}`,
  noteRemoved: (line) => `Removed ${line}`,
  noteChanged: (line, parts) => `${line}: ${parts}`,
  noteField: (field, from, to) => `${field} ${from} → ${to}`,
  noteSize: (size, from, to) => `size ${size} ${from} → ${to}`,
  noteTotal: (total, from, to) => `${total} ${from} → ${to}`,
  join: '; ',
}
