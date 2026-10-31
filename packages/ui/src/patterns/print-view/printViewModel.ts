/**
 * The rules of `PrintView` (B-W2b-09; design 00-page-anatomy §3.14 "a list's Print is a print stylesheet of the current
 * view, with the filters written at the top"; B-W2a-38, -46, -51 and others composed it) — pure, tested in Node.
 *
 * Paper says what it shows: the title, who printed it and when, and the filters that were on — or that none was, so a
 * reader never takes a filtered list for the whole one. Paper is white: the view draws light whatever the person's
 * theme, and their theme comes back after.
 */
import { PRINT_VIEW_LABELS, type PrintViewLabels } from './PrintViewLabels'

export interface PrintFilter {
  /** "Status". */
  label: string
  /** "Open, Released". Empty: the filter is not on. */
  value: string
}

/** The filters line: "Filters: Status: Open · Site: Bologna", or "No filters: every row". */
export function printFiltersLine(filters: readonly PrintFilter[], words: PrintViewLabels = PRINT_VIEW_LABELS): string {
  const on = filters.filter((filter) => filter.value.trim() !== '')
  if (on.length === 0) return words.noFilters
  return words.filters(on.map((filter) => words.filter(filter.label, filter.value)).join(words.join))
}

/** "Printed by … on …" or "Printed on …"; null without a time. */
export function printedLine(when: string | null | undefined, person: string | null | undefined, words: PrintViewLabels = PRINT_VIEW_LABELS): string | null {
  if (!when) return null
  return person ? words.printedBy(person, when) : words.printedOn(when)
}

/** The attribute that keeps a part of the app's frame off paper (the rail, the top bar, a toolbar). */
export const PRINT_HIDE_ATTR = 'data-print-hide' as const
/** Spread on an element to keep it off paper: `<header {...printHide}>`. */
export const printHide: Readonly<Record<typeof PRINT_HIDE_ATTR, ''>> = { [PRINT_HIDE_ATTR]: '' }

/** The slice of `<html>` the light switch needs, so the rule is tested in Node. */
export interface ThemeRoot {
  classList: { contains(name: string): boolean; add(name: string): void; remove(name: string): void }
}

/** Draw light now; the returned function puts the person's theme back (a no-op when it was light already). */
export function forceLight(root: ThemeRoot | null | undefined, darkClass = 'dark'): () => void {
  if (!root || !root.classList.contains(darkClass)) return () => {}
  root.classList.remove(darkClass)
  return () => root.classList.add(darkClass)
}
