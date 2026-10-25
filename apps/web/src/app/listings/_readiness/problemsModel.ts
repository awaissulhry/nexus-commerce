/**
 * Listings — the Problems view's words (step 7 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): fix by
 * problem, not product by product. One row per problem × destination, as `GET …/readiness/problems` answers it — the
 * API decides every row, count and order; this file only says them.
 *
 *   Problem   the label and one tag: readiness — why it is a problem (Required · Translation · Setup · Rule · Check), red
 *             when it blocks, amber when it warns; a channel message — its severity (Error · Warning · Info) and code;
 *             Ready, not listed — "Not listed".
 *   Where     the store and market, in the chips' words.
 *   Show products → back to Products with `problem=<id>` and a removable chip ("Size chart · Amazon DE").
 *
 * Pure — no React, no fetch — so every word is a test.
 */
import type { ReadinessProblemRow, ReadinessProblemsPage, ReadinessDestination } from '@nexus/shared/listing-readiness'
import type { Tone } from '@/design-system/primitives'

import { PROBLEM_KIND_LABELS } from './fixDialogModel'
import { channelLabel, destinationFromKey, plural } from './marketChips'
import { apiFilterParams, type ReadinessPageQuery } from './readinessQuery'

export const PROBLEMS_PATH = 'catalog-transfer/readiness/problems'
export const NO_PROBLEMS = 'No problems in this view.'

/** `GET …/readiness/problems`: the page's own filters; the problem chip is the Products view's, never a filter of this list. */
export function problemsParams(query: ReadinessPageQuery): URLSearchParams {
  const { problem: _problem, ...params } = apiFilterParams(query)
  return new URLSearchParams(params)
}

const SEVERITY_WORDS = { error: 'Error', warning: 'Warning', info: 'Info' } as const
const SEVERITY_TONES = { error: 'danger', warning: 'warning', info: 'neutral' } as const

/** The tag beside the problem's label: what kind of problem, in the tone of how much it stops. */
export function problemTag(row: Pick<ReadinessProblemRow, 'source' | 'state' | 'kind' | 'severity'>): { text: string; tone: Tone } {
  if (row.source === 'readiness') {
    return { text: row.kind ? PROBLEM_KIND_LABELS[row.kind] ?? String(row.kind) : 'Check', tone: row.state === 'blocked' ? 'danger' : 'warning' }
  }
  if (row.source === 'channel') {
    const severity = row.severity ?? 'info'
    return { text: SEVERITY_WORDS[severity], tone: SEVERITY_TONES[severity] }
  }
  return { text: 'Not listed', tone: 'info' }
}

/** A channel message in a chip: its first words. */
export function excerpt(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** The chip on Products after Show products: "Size chart · Amazon DE", "90220 The value … · Amazon IT", "Ready, not listed · eBay IT". */
export function problemChipText(row: Pick<ReadinessProblemRow, 'source' | 'label' | 'code' | 'message' | 'destination'>): string {
  const where = row.destination.label
  if (row.source === 'channel') return `${row.code ? `${row.code} ` : ''}“${excerpt(row.message)}” · ${where}`
  return `${row.label} · ${where}`
}

/**
 * The chip's words before the Problems list has named the problem (a link opened with `?problem=`): what the id itself
 * says — the field, a channel message, Ready-not-listed — and where. Null when it is no id.
 */
export function problemFallbackText(id: string, describe: (key: string) => ReadinessDestination = destinationFromKey): string | null {
  const source = id.charAt(0)
  if (id.charAt(1) !== ':' || !['r', 'c', 'n'].includes(source)) return null
  const rest = id.slice(2)
  for (let at = rest.indexOf(']'); at >= 0; at = rest.indexOf(']', at + 1)) {
    let parts: unknown
    try { parts = JSON.parse(rest.slice(0, at + 1)) } catch { continue }
    if (!Array.isArray(parts) || parts.length !== 4) return null
    const key = JSON.stringify(parts)
    const where = describe(key).label
    if (source === 'n') return `Ready, not listed · ${where}`
    if (source === 'c') return `A message from ${channelLabel(typeof parts[0] === 'string' ? parts[0] : null)} · ${where}`
    return `${rest.slice(at + 2) || 'A readiness check'} · ${where}`
  }
  return null
}

/** The toolbar's count: "6 problems", or "500 of 812 problems" when the list was cut. */
export function problemsCountWords(page: Pick<ReadinessProblemsPage, 'rows' | 'total'> | null): { shown: string; unit: string } {
  if (!page) return { shown: '—', unit: 'problems' }
  const words = page.total === 1 ? 'problem' : 'problems'
  return page.total > page.rows.length
    ? { shown: `${page.rows.length.toLocaleString('en')} of ${page.total.toLocaleString('en')}`, unit: words }
    : { shown: page.total.toLocaleString('en'), unit: words }
}

/** Said above the list when the API cut it at its limit. */
export function cappedWords(page: Pick<ReadinessProblemsPage, 'rows' | 'total'>): string | null {
  if (page.total <= page.rows.length) return null
  return `Showing the first ${page.rows.length.toLocaleString('en')} of ${plural(page.total, 'problem')}. Narrow the filters to see the rest.`
}

/** "Listings" in words, for the screen reader and the hover: what the number counts for this source. */
export function listingsUnit(row: Pick<ReadinessProblemRow, 'source'>): string {
  return row.source === 'channel' ? 'listings on the channel with this message' : 'listings (one product on one market) with this problem'
}

/** Show products' accessible name. */
export function showProductsLabel(row: Pick<ReadinessProblemRow, 'source' | 'label' | 'code' | 'message' | 'destination' | 'products'>): string {
  return `Show the ${plural(row.products, 'product')} with ${problemChipText(row)}`
}
