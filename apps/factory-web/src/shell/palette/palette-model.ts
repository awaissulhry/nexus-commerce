import { parseScanId, SCAN_TYPES, type ScanIdProblem, type ScanType } from '@nexus/factory-domain/numbering/scan-id'

/**
 * What the command palette (SCR-004; PLT-153, PLT-155, PLT-161) finds for what the person typed or scanned. Pure: the
 * view draws it, the tests hold it.
 *
 *  - PAGES: every page of the Office navigation the person may open, matched on its name and its area's name.
 *  - LABELS: a scanned (or typed) label code — `HD-7K-0003RJ-M` — read by the domain's scannable-id parser
 *    (factory-domain numbering/scan-id: type, tenant tag, reference, check symbol) and said in words: what kind of
 *    thing it is, or why the code was refused (a typo, another factory's label). Opening the thing comes with the
 *    module that owns it (W1): the palette calls the API only once a record lookup exists.
 *  - NUMBERS: anything else with a digit (a document number, `FT-2026-00042`) is shown as "find this number", held
 *    until record search exists, so the person learns where it will be.
 */

export interface PalettePage {
  id: string
  label: string
  /** The area's name. */
  area: string
  /** The full address (with `/w/<company>`). */
  href: string
}

export type PaletteResult =
  | { kind: 'page'; id: string; page: PalettePage }
  | { kind: 'label'; id: string; type: ScanType; text: string; ref: number }
  | { kind: 'label-refused'; id: string; problem: ScanIdProblem; text: string; type: ScanType | null }
  | { kind: 'number'; id: string; text: string }

export interface PaletteSource {
  pages: readonly PalettePage[]
  /** The signed-in tenant's tag (`tenantTag(tenantId)`): a label of another factory is refused. Null: not checked. */
  tenantTag: string | null
}

const TYPE_BY_CODE: ReadonlyMap<string, ScanType> = new Map(Object.entries(SCAN_TYPES).map(([type, code]) => [code, type as ScanType]))

/** The query as a label code would be read: upper case, no spaces or hyphens. */
const compactOf = (query: string) => query.toUpperCase().replace(/[\s-]+/g, '')

/**
 * Whether the query is shaped like a label code: two letters that name a label type, then 9 to 11 Crockford symbols
 * (tag 2 + reference 6–8 + check 1). Only then is it read as one; anything else is a page search or a number.
 */
export function looksLikeLabel(query: string): boolean {
  const compact = compactOf(query)
  return /^[A-Z]{2}[0-9A-Z]{9,11}$/.test(compact) && TYPE_BY_CODE.has(compact.slice(0, 2))
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Pages whose name or area matches every word of the query; names that start with it first. Empty query: all pages. */
export function matchPages(pages: readonly PalettePage[], query: string): PalettePage[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...pages]
  const scored = pages.flatMap((page) => {
    const label = fold(page.label)
    const haystack = `${label} ${fold(page.area)}`
    if (!words.every((word) => haystack.includes(word))) return []
    const score = label.startsWith(words.join(' ')) ? 0 : words.every((word) => label.includes(word)) ? 1 : 2
    return [{ page, score }]
  })
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.page)
}

/** Everything the palette shows for a query, in the order shown: the label (if it is one), a number, then pages. */
export function paletteResults(query: string, source: PaletteSource): PaletteResult[] {
  const trimmed = query.trim()
  const results: PaletteResult[] = []
  if (trimmed !== '' && looksLikeLabel(trimmed)) {
    const read = parseScanId(trimmed, source.tenantTag ? { tenantTag: source.tenantTag } : {})
    if (read.ok) results.push({ kind: 'label', id: `label:${read.text}`, type: read.type, text: read.text, ref: read.ref })
    else results.push({ kind: 'label-refused', id: `label:${compactOf(trimmed)}`, problem: read.problem, text: trimmed.toUpperCase(), type: TYPE_BY_CODE.get(compactOf(trimmed).slice(0, 2)) ?? null })
    return results
  }
  if (/\d/.test(trimmed)) results.push({ kind: 'number', id: `number:${trimmed}`, text: trimmed })
  for (const page of matchPages(source.pages, trimmed)) results.push({ kind: 'page', id: `page:${page.id}`, page })
  return results
}

/** Results a person can open now (pages). Labels and numbers are said, not opened, until their record lookup exists. */
export function isOpenable(result: PaletteResult): result is Extract<PaletteResult, { kind: 'page' }> {
  return result.kind === 'page'
}

/** The next highlighted index for an arrow key, wrapping; -1 when there is nothing. */
export function moveHighlight(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return step === 1 ? 0 : count - 1
  return (current + step + count) % count
}
