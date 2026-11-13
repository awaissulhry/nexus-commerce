import { versionChangeNote, versionLineViews, type VersionCompareLabels, type VersionField, type VersionHead, type VersionLine, type VersionTotal } from '@nexus/ui/patterns/VersionCompare/index'
import type { QuoteVersionRow } from '../../api'
import type { CompareSection, VersionsCompared } from './api'

/**
 * Compare two versions (design quote.versions.compare and pop:quotes.compare, SAL-158), pure: which two versions (two rows
 * selected, or the current one against the one before), the sections the person may see in the order the design names
 * them (terms, lines, prices with the price grain, margin with the margin grain), each field and total relabelled by its id
 * in this screen's words, the written values said in the page's language, and ONE change note from every section shown
 * (VersionCompare's own words: never the API's English `changeNote`).
 */

/** W1's change note holds at most 1000 characters. */
export const CHANGE_NOTE_MAX = 1000

export const TERMS_FIELDS = ['validUntil', 'firmOffer', 'promiseDate', 'paymentTerms', 'deposit', 'acceptanceMode', 'incoterm', 'shipComplete', 'language', 'currency', 'termsVersion'] as const
export const LINE_FIELDS = ['seq', 'section', 'description', 'note', 'revision', 'deliveries', 'options', 'quantity'] as const
export const PRICE_FIELDS = ['unitPrice', 'listUnitPrice', 'discountPct', 'sizePrices', 'net', 'adjustmentReason'] as const
export const MARGIN_FIELDS = ['marginPct'] as const
export const TOTAL_IDS = ['lines', 'pieces', 'net', 'vat', 'gross', 'deposit', 'marginPct'] as const

/** The two revisions two selected rows compare: the older first; null unless exactly two are selected. */
export function pairOf(versions: readonly Pick<QuoteVersionRow, 'id' | 'revision'>[], selected: readonly string[]): { from: number; to: number } | null {
  if (selected.length !== 2) return null
  const revisions = versions.filter((version) => selected.includes(version.id)).map((version) => version.revision)
  if (revisions.length !== 2) return null
  const [a, b] = revisions.sort((x, y) => x - y) as [number, number]
  return { from: a, to: b }
}

/** The current version against the one before; null with one version. */
export function latestPair(versions: readonly Pick<QuoteVersionRow, 'revision'>[]): { from: number; to: number } | null {
  const revisions = versions.map((version) => version.revision).sort((a, b) => b - a)
  return revisions.length >= 2 ? { from: revisions[1]!, to: revisions[0]! } : null
}

/** The sections to show: terms, lines, then prices and margin when the answer carries them (the grains), in that order. */
export function sectionsOf(compared: Pick<VersionsCompared, 'sections' | 'prices' | 'margin'>): CompareSection[] {
  const byId = new Map(compared.sections.map((entry) => [entry.id, entry]))
  return [byId.get('terms'), byId.get('lines'), compared.prices, compared.margin].filter((entry): entry is CompareSection => !!entry)
}

/** A section differs: a line added, removed or changed, or a total that moved. */
export const sectionDiffers = (section: Pick<CompareSection, 'summary' | 'totals'>): boolean => section.summary.added + section.summary.removed + section.summary.changed > 0 || section.totals.some((total) => total.before !== total.after)

export interface CompareWords {
  field: (id: string) => string
  total: (id: string) => string
  /** A written value said in the page's language (a day, a code). */
  value: (field: string, value: string | null) => string | null
}

/** One section in VersionCompare's shape, relabelled in the page's words. */
export function sectionShape(section: CompareSection, words: CompareWords): { fields: VersionField[]; lines: VersionLine[]; totals: VersionTotal[]; sizes: string[] } {
  const said = (side: CompareSection['lines'][number]['before']) => (side ? { fields: Object.fromEntries(Object.entries(side.fields).map(([field, value]) => [field, words.value(field, value)])), ...(side.sizes ? { sizes: side.sizes } : {}) } : null)
  return {
    fields: section.fields.map((field) => ({ id: field.id, label: words.field(field.id) })),
    lines: section.lines.map((line) => ({ id: line.id, label: line.id === 'terms' ? words.field('terms') : line.label, detail: line.detail, before: said(line.before), after: said(line.after) })),
    totals: section.totals.map((total) => ({ id: total.id, label: words.total(total.id), before: words.value(`total:${total.id}`, total.before), after: words.value(`total:${total.id}`, total.after) })),
    sizes: section.sizes,
  }
}

/** One change note from every section shown: one head line, then each section's lines (VersionCompare's words). */
export function fullChangeNote(before: VersionHead, after: VersionHead, sections: readonly CompareSection[], words: CompareWords, labels: VersionCompareLabels): string {
  const lines: string[] = []
  for (const section of sections) {
    const shape = sectionShape(section, words)
    const note = versionChangeNote(before, after, versionLineViews(shape.lines, shape.fields, shape.sizes), shape.totals, labels)
    if (note) lines.push(...note.split('\n').slice(1))
  }
  if (lines.length === 0) return ''
  const text = [labels.noteHead(before.label, after.label), ...lines].join('\n')
  return text.length <= CHANGE_NOTE_MAX ? text : `${text.slice(0, CHANGE_NOTE_MAX - 1)}…`
}
