import { parseScanId, SCAN_TYPES, type ScanIdProblem, type ScanType } from '@nexus/factory-domain/numbering/scan-id'
import type { SearchMatch } from '@nexus/factory-domain/search/contracts'

/**
 * What the command palette (SCR-004; PLT-153, PLT-155, PLT-161) finds for what the person typed or scanned. Pure: the
 * view draws it, the tests hold it. Groups in the design's order (shell.search/sec:palette):
 *
 *  - LABELS: a scanned (or typed) label code — `HD-7K-0003RJ-M` — read by the domain's scannable-id parser
 *    (factory-domain numbering/scan-id: type, tenant tag, reference, check symbol) and said in words: what kind of
 *    thing it is, or why the code was refused (a typo, another factory's label). When the search index has a record
 *    with that code as its number (a hide's tag), the label opens it.
 *  - EXACT NUMBER (B-W2a-32): a document number typed or pasted whole (`ORD-2026-00042`) opens its record at once —
 *    "ORD-2026-00042 · Order · Pista Racing · In production". While the search answers, the number is "being looked
 *    for"; when no record has it, the palette says so.
 *  - RECORDS (B-W2a-32): the person's records by number and name, typos forgiven (GET /search), at most 8, then "See
 *    all results" → the All results page. Only records the person may open; never money.
 *  - PAGES: every page of the Office navigation the person may open, matched on its name and its area's name.
 */

export interface PalettePage {
  id: string
  label: string
  /** The area's name. */
  area: string
  /** The full address (with `/w/<company>`). */
  href: string
}

/** A record the search found, ready to open (its full address). Type and status are codes; the view says them. */
export interface PaletteRecord {
  recordType: string
  recordId: string
  number: string | null
  title: string
  subtitle: string | null
  status: string | null
  match: SearchMatch
  href: string
}

/** What the search answered for the palette (the container keeps it; the view only reads it). */
export interface PaletteRecords {
  /** The query this answers (trimmed); results of an older query are not shown. */
  query: string
  /** idle: nothing asked (empty or too short) · loading · slow (still loading after about a second) · error · ready */
  state: 'idle' | 'loading' | 'slow' | 'error' | 'ready'
  hits: readonly PaletteRecord[]
  /** Every match of the query (the results page's count). */
  total: number
  /** The All results page for the query, or null. */
  allHref: string | null
}

export type PaletteResult =
  | { kind: 'page'; id: string; page: PalettePage }
  | { kind: 'label'; id: string; type: ScanType; text: string; ref: number; record: PaletteRecord | null; looking: boolean }
  | { kind: 'label-refused'; id: string; problem: ScanIdProblem; text: string; type: ScanType | null }
  | { kind: 'number'; id: string; text: string; looking: boolean }
  | { kind: 'record'; id: string; record: PaletteRecord; group: 'exact' | 'records' }
  | { kind: 'records-state'; id: string; state: 'loading' | 'slow' | 'error' }
  | { kind: 'all'; id: string; query: string; total: number; href: string }

export type PaletteGroup = 'labels' | 'exact' | 'records' | 'pages'

export const GROUP_OF: Readonly<Record<PaletteResult['kind'], PaletteGroup>> = Object.freeze({
  label: 'labels',
  'label-refused': 'labels',
  number: 'exact',
  record: 'records',
  'records-state': 'records',
  all: 'records',
  page: 'pages',
})

/** The group a result is drawn in (an exact-number record sits under Exact number). */
export const groupOf = (result: PaletteResult): PaletteGroup => (result.kind === 'record' ? result.group : GROUP_OF[result.kind])

export const PALETTE_GROUPS: readonly PaletteGroup[] = Object.freeze(['labels', 'exact', 'records', 'pages'])

export interface PaletteSource {
  pages: readonly PalettePage[]
  /** The signed-in tenant's tag (`tenantTag(tenantId)`): a label of another factory is refused. Null: not checked. */
  tenantTag: string | null
  /** The search's answer (absent: no record search here, as in W0's design cases). */
  records?: PaletteRecords | null
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

/** The search's answer for this query, or null while it answers another (or none was asked). */
function recordsFor(source: PaletteSource, trimmed: string): PaletteRecords | null {
  const records = source.records
  if (!records || records.state === 'idle' || trimmed === '') return null
  return records.query === trimmed ? records : { ...records, state: records.state === 'slow' ? 'slow' : 'loading', hits: [], total: 0 }
}

const sameNumber = (record: PaletteRecord, text: string) => record.number !== null && record.number.toUpperCase() === text.toUpperCase()
const compactSame = (record: PaletteRecord, text: string) => record.number !== null && compactOf(record.number) === compactOf(text)

/** Everything the palette shows for a query, in the order shown: label, exact number, records, all results, pages. */
export function paletteResults(query: string, source: PaletteSource): PaletteResult[] {
  const trimmed = query.trim()
  const records = recordsFor(source, trimmed)
  const waiting = records !== null && (records.state === 'loading' || records.state === 'slow')
  const results: PaletteResult[] = []
  if (trimmed !== '' && looksLikeLabel(trimmed)) {
    const read = parseScanId(trimmed, source.tenantTag ? { tenantTag: source.tenantTag } : {})
    if (read.ok) {
      const record = records?.state === 'ready' ? (records.hits.find((hit) => compactSame(hit, read.text)) ?? null) : null
      results.push({ kind: 'label', id: `label:${read.text}`, type: read.type, text: read.text, ref: read.ref, record, looking: waiting })
    } else results.push({ kind: 'label-refused', id: `label:${compactOf(trimmed)}`, problem: read.problem, text: trimmed.toUpperCase(), type: TYPE_BY_CODE.get(compactOf(trimmed).slice(0, 2)) ?? null })
    return results
  }
  const exact = records?.state === 'ready' ? records.hits.filter((hit) => hit.match === 'number' && sameNumber(hit, trimmed)) : []
  if (exact.length > 0) for (const record of exact) results.push({ kind: 'record', id: `record:${record.recordType}:${record.recordId}`, record, group: 'exact' })
  // A number nobody has is said only once it was looked for (or where the palette has no record search at all).
  else if (/\d/.test(trimmed) && (source.records == null || waiting || records?.state === 'ready')) results.push({ kind: 'number', id: `number:${trimmed}`, text: trimmed, looking: waiting })
  if (records) {
    if (records.state === 'loading' || records.state === 'slow' || records.state === 'error') results.push({ kind: 'records-state', id: 'records:state', state: records.state })
    else {
      const shown = new Set(exact.map((record) => record.recordId))
      for (const record of records.hits) if (!shown.has(record.recordId)) results.push({ kind: 'record', id: `record:${record.recordType}:${record.recordId}`, record, group: 'records' })
      if (records.allHref && records.total > 0) results.push({ kind: 'all', id: 'records:all', query: trimmed, total: records.total, href: records.allHref })
    }
  }
  for (const page of matchPages(source.pages, trimmed)) results.push({ kind: 'page', id: `page:${page.id}`, page })
  return results
}

/** The address a result opens, or null when it is said, not opened (a label or number without its record, a state). */
export function hrefOf(result: PaletteResult): string | null {
  switch (result.kind) {
    case 'page':
      return result.page.href
    case 'record':
      return result.record.href
    case 'all':
      return result.href
    case 'label':
      return result.record?.href ?? null
    default:
      return null
  }
}

/** Results a person can open now. */
export function isOpenable(result: PaletteResult): boolean {
  return hrefOf(result) !== null
}

/** The next highlighted index for an arrow key, wrapping; -1 when there is nothing. */
export function moveHighlight(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return step === 1 ? 0 : count - 1
  return (current + step + count) % count
}

/** Tab: the first result of the next group (Shift+Tab: of the previous one), wrapping; -1 when there is nothing. */
export function nextGroupStart(results: readonly PaletteResult[], current: number, step: 1 | -1): number {
  if (results.length === 0) return -1
  const starts: number[] = []
  results.forEach((result, index) => {
    if (index === 0 || groupOf(results[index - 1]!) !== groupOf(result)) starts.push(index)
  })
  const currentGroup = starts.filter((start) => start <= Math.max(current, 0)).length - 1
  const next = (currentGroup + step + starts.length) % starts.length
  return starts[next]!
}
