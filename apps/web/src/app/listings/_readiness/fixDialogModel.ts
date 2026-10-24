/**
 * The Fix window's words and links (Listing readiness rebuild, 2026-10-23 — docs/listings/READINESS-REBUILD-2026-10-23.md
 * §2). Pure, so the node tests reach them; `FixDialog.tsx` only draws what these say.
 *
 * Readiness labels and tones come from `readinessMeta(state, 'scope')` and nowhere else.
 */
import type {
  ReadinessDetail,
  ReadinessProblemKind,
  ReadinessScopeState,
  ReadinessStateCounts,
} from '@nexus/shared/listing-readiness'
import { readinessMeta, SCOPE_READINESS_STATES, type ReadinessTone } from '@/design-system/grid/renderers/readiness'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'

/** Why a problem is a problem, as the tag on it says. */
export const PROBLEM_KIND_LABELS: Record<ReadinessProblemKind, string> = {
  required: 'Required',
  translation: 'Translation',
  setup: 'Setup',
  rule: 'Rule',
  check: 'Check',
}

/** An unknown kind is named as it came, never dressed up as one of ours. */
export function problemKindLabel(kind: ReadinessProblemKind): string {
  return PROBLEM_KIND_LABELS[kind] ?? String(kind)
}

const count = (n: number) => n.toLocaleString('en')

/** "1 listing" / "20 listings". */
export function listingWords(n: number): string {
  return `${count(n)} ${n === 1 ? 'listing' : 'listings'}`
}

/** "and 30 more" when the API sent fewer listings than the problem touches; null when it sent them all. */
export function moreWords(shown: number, total: number): string | null {
  const more = total - shown
  return more > 0 ? `and ${count(more)} more` : null
}

/** "Required by Amazon category JACKET, eBay item specifics"; null when nobody is named. */
export function requiredByWords(requiredBy: readonly string[]): string | null {
  const names = requiredBy.map((name) => name.trim()).filter(Boolean)
  return names.length ? `Required by ${names.join(', ')}` : null
}

/** A bare studio path, inside the current business (`/w/<id>/…`), like `issueHref.ts`. */
export function inBusiness(href: string, workspaceId: string | null = browserWorkspaceId()): string {
  return workspaceHref(workspaceId, href)
}

/** Paging is the page's, not a filter: the window asks for one product on one destination. */
const NOT_FILTERS = new Set(['page', 'pageSize'])

/**
 * `catalog-transfer/readiness/detail?…` for `transferApi`: the page's filters, then the product, family and destination.
 * The window's own three keys win over a filter of the same name.
 */
export function fixDetailPath(query: Record<string, string>, target: { productId: string; family: boolean; destinationKey: string }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (!NOT_FILTERS.has(key) && value !== '') params.set(key, value)
  params.set('productId', target.productId)
  params.set('family', target.family ? '1' : '0')
  params.set('destination', target.destinationKey)
  return `catalog-transfer/readiness/detail?${params}`
}

export interface StatePart { state: ReadinessScopeState; count: number; label: string; tone: ReadinessTone; text: string }

/** Listings by state, worst first, only the states that have any: "3 blocked", "17 ready" (the DS words, lower case). */
export function stateParts(counts: ReadinessStateCounts): StatePart[] {
  return SCOPE_READINESS_STATES
    .filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => {
      const meta = readinessMeta(state, 'scope')
      return { state, count: counts[state], label: meta.label, tone: meta.tone, text: `${count(counts[state])} ${meta.label.toLowerCase()}` }
    })
}

/** The summary's listings line: "21 listings, all blocked", or "21 listings: 18 blocked · 3 ready". */
export function stateLine(counts: ReadinessStateCounts): string {
  const parts = stateParts(counts)
  const total = listingTotal(counts)
  const listings = `${count(total)} ${total === 1 ? 'listing' : 'listings'}`
  if (parts.length === 1) return total === 1 ? `${listings}, ${parts[0].label.toLowerCase()}` : `${listings}, all ${parts[0].label.toLowerCase()}`
  return `${listings}: ${parts.map((part) => part.text).join(' · ')}`
}

/** Listings in the counts. */
export function listingTotal(counts: ReadinessStateCounts): number {
  return SCOPE_READINESS_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0)
}

/** "GALE-JACKET · Amazon DE". */
export function fixTitle(name: string, destinationLabel: string): string {
  return `${name} · ${destinationLabel}`
}

/**
 * The product's name for the title: the caller's, else the product itself among the listings the problems name, else
 * plain words. Never another product's name.
 */
export function productTitle(productName: string | null | undefined, detail: Pick<ReadinessDetail, 'productId' | 'problems'> | null, family: boolean): string {
  if (productName?.trim()) return productName.trim()
  for (const problem of detail?.problems ?? []) {
    const self = problem.products.find((product) => product.id === detail?.productId)
    if (self) return self.name?.trim() || self.sku
  }
  return family ? 'This family' : 'This product'
}

/**
 * What the window says when there is nothing in the list. "Nothing to fix" only when the check says Ready; a state that
 * was never measured, or one that is not set up, says so; a Blocked or Warnings state without problem details says that
 * the details did not come, rather than "nothing to fix" under a red pill.
 */
export function emptyWords(state: ReadinessScopeState, destinationLabel: string): { title: string; description: string | null } {
  const meta = readinessMeta(state, 'scope')
  if (state === 'ready') return { title: `Nothing to fix on ${destinationLabel}`, description: null }
  if (state === 'notComputed' || state === 'absent') return { title: `${meta.label} on ${destinationLabel}`, description: `${meta.hint}.` }
  return { title: `${meta.label} on ${destinationLabel}`, description: 'The check named no fields here. Open the studio to see its checks.' }
}
