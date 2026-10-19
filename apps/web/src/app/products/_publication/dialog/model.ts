import { blockedChanges, type StudioPublishIssue, type StudioPublishResult, type StudioPublishReview, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import type { PublishPlan } from '@nexus/shared/publish-plan'
import { aliasMarkGlyph } from '@/design-system/primitives'

/**
 * The markets the dialog can publish to, as any surface describes them (the studio's `MarketplaceLite` fits). Kept
 * structural so the shared dialog never imports a studio type.
 */
export interface PublicationMarket {
  id?: string
  channel: string
  code: string
  name: string
  connected?: boolean
  accounts?: Array<{ id: string; label: string }>
}

/**
 * Aliases in the Publish window (Owner 2026-10-05): a second (third…) listing of the family on one channel, market and
 * account. Its destination's `scope.listingId` is the ALIAS id (`ProductListingAlias.id`, the publish-actions cell's
 * `aliasKey`) — never a ChannelListing id; the main listing has no `listingId`. `position` is its place in the sheet's
 * bands (1 = ①, 2 = ②…).
 */
export interface PublicationAlias {
  channel: string
  marketplace: string
  accountId: string
  id: string
  label: string
  position: number
}

/**
 * One place the dialog can publish to: a market of a channel on one connected account — its main listing, or one of
 * its listing aliases (`alias`), or (rarely) a listing the dialog was asked for and knows nothing more about.
 */
export interface PublicationDestinationOption {
  key: string
  scope: StudioPublishScope
  /** "Amazon Italy · Xavia Racing" — the old one-line label ("… · ① Racing edition" on an alias). */
  label: string
  /** The market's own name ("Amazon Italy"). */
  marketName: string
  accountLabel: string
  /** The listing alias this destination publishes (`scope.listingId` is its id); null or absent on the main listing. */
  alias?: { id: string; label: string; position: number } | null
  /**
   * How many listings of the family this market and account offers here (the main listing, its aliases, a listing asked
   * for): the main listing shows ★ only when there is more than one, as the sheet's bands do (`AliasMark`).
   */
  listings?: number
}

export const publicationScopeKey = (scope: StudioPublishScope) => JSON.stringify([scope.channel, scope.marketplace, scope.accountId, scope.listingId ?? null])

/**
 * The main listing's name beside its ★ when its market has aliases — one word everywhere (review 2026-10-05, m3): the
 * studio's listing picker, the window, its tabs, the toolbar mark and the toast all say "Main listing".
 */
export const MAIN_LISTING_LABEL = 'Main listing'

/** The server's older names for the main listing: a review's or a run's `aliasLabel`, the Media pages' listing options. */
const SERVER_MAIN_LISTING_NAMES: ReadonlySet<string> = new Set(['Primary listing', 'Primary'])

/**
 * A listing's name as the studio shows it: the server's "Primary listing" / "Primary" read "Main listing" (one word,
 * review 2026-10-05, m3); every other name as it is. DISPLAY ONLY — never a value sent to the server or matched on import.
 */
export function listingDisplayLabel(label: string): string {
  return SERVER_MAIN_LISTING_NAMES.has(label.trim()) ? MAIN_LISTING_LABEL : label
}
/** A listing the window was asked for (a retry) that is neither the main listing nor a known alias. */
export const SELECTED_LISTING_LABEL = 'Selected listing'

/**
 * Which listing of its market a destination is, in the sheet band's words (`AliasBandCell`): "① Racing edition" for an
 * alias, "★ Main listing" for the main listing when its market has aliases, null for a market's only listing.
 */
export function optionListingLabel(option: Pick<PublicationDestinationOption, 'scope' | 'alias' | 'listings'>): string | null {
  if (option.alias) return `${aliasMarkGlyph(option.alias.position)} ${option.alias.label}`
  if (option.scope.listingId) return SELECTED_LISTING_LABEL
  return (option.listings ?? 1) > 1 ? `${aliasMarkGlyph(0)} ${MAIN_LISTING_LABEL}` : null
}

/** Out-of-order selection responses cannot enable a different review or checkbox set. */
export function matchesPublicationSelection(value: unknown, review: StudioPublishReview | null, selectedIds: string[]): value is StudioPublishSelection {
  const selection = value as StudioPublishSelection | null
  if (!review?.id || !review.changes || !selection || selection.reviewId !== review.id || typeof selection.token !== 'string' || !selection.token
    || !Array.isArray(selection.selectedIds) || new Set(selection.selectedIds).size !== selection.selectedIds.length
    || selection.selectedIds.length !== selectedIds.length || new Set(selectedIds).size !== selectedIds.length
    || selection.selectedIds.some(id => !selectedIds.includes(id) || !review.changes!.some(c => c.id === id && c.selectable))
    || selection.fieldCount !== selectedIds.length || !Array.isArray(selection.products)
    || selection.products.some(p => !p || typeof p.sku !== 'string' || !review.rows.some(r => r.productId === p.productId))
    || new Set(selection.products.map(p => p.productId)).size !== selection.products.length
    || !selection.payload || !['json', 'xml'].includes(selection.payload.format) || typeof selection.payload.content !== 'string') return false
  if (selectedIds.length && (!selection.products.length || !selection.payload.content.trim()
    || review.changes.filter(c => selectedIds.includes(c.id)).some(c => !selection.products.some(p => p.productId === c.productId && p.sku === c.sku)))) return false
  if (!selectedIds.length && (selection.products.length > 0 || selection.payload.content.trim())) return false
  return true
}

/** A tick belongs to one durable review; refreshing or changing destination needs a new tick. */
export function publicationOverwriteAcknowledged(review: StudioPublishReview | null, confirmedReviewId: string | null): boolean {
  if (!review) return false
  if (!review.rows.some(row => row.existing) && !review.overwrite?.requiresConfirmation) return true
  return !!review.id && review.overwrite?.requiresConfirmation === true && confirmedReviewId === review.id
}

/** A status read without durable provider results cannot erase a receipt already received by this dialog. */
export function retainPublicationReceipt(previous: StudioPublishResult | null, next: StudioPublishResult): StudioPublishResult {
  if (!previous || previous.id !== next.id || next.results.length) return next
  const references = [...new Set(previous.results.map(row => row.reference).filter(Boolean))]
  if (!references.length) return next
  return { ...next, results: previous.results, warnings: [...new Set([...(previous.warnings ?? []), ...(next.warnings ?? [])])],
    message: `${next.message} Previously received channel reference: ${references.join(', ')}.` }
}

/**
 * Every destination of the connected markets: each market's main listing on each account, followed by its listing
 * aliases (`aliases`, see `listedAliases`) in their position order. The surface's current listing (`current`, the
 * studio's sheet) never replaces the main listing: an alias the window knows is already there; a listing it does not
 * know (not read yet) is added after the market's aliases, so it can start ticked.
 */
export function publicationDestinations(markets: PublicationMarket[], current?: StudioPublishScope, aliases: readonly PublicationAlias[] = []): PublicationDestinationOption[] {
  const out = new Map<string, PublicationDestinationOption>()
  for (const m of markets) {
    if (m.connected === false) continue
    for (const a of m.accounts ?? []) {
      const where: StudioPublishScope = { channel: m.channel, marketplace: m.code, accountId: a.id }
      const own = [...new Map(aliases.filter(x => x.channel === m.channel && x.marketplace === m.code && x.accountId === a.id).map(x => [x.id, x])).values()]
        .sort((x, y) => x.position - y.position || x.label.localeCompare(y.label))
      const asked = current?.listingId && current.channel === m.channel && current.marketplace === m.code && current.accountId === a.id
        && !own.some(x => x.id === current.listingId) ? current.listingId : null
      const listings = 1 + own.length + (asked ? 1 : 0)
      const add = (scope: StudioPublishScope, alias: PublicationDestinationOption['alias']) => {
        const key = publicationScopeKey(scope)
        if (out.has(key)) return
        const option: PublicationDestinationOption = { key, scope, label: '', marketName: m.name, accountLabel: a.label, alias, listings }
        const listing = optionListingLabel(option)
        out.set(key, { ...option, label: `${m.name} · ${a.label}${listing ? ` · ${listing}` : ''}` })
      }
      add(where, null)
      for (const x of own) add({ ...where, listingId: x.id }, { id: x.id, label: x.label, position: x.position })
      if (asked) add({ ...where, listingId: asked }, null)
    }
  }
  return [...out.values()]
}
export function matchesPublicationReview(value: unknown, productId: string, scope: StudioPublishScope): value is StudioPublishReview {
  const review = value as StudioPublishReview | null
  return !!review && review.productId === productId && !!review.scope && publicationScopeKey(review.scope) === publicationScopeKey(scope)
    && Array.isArray(review.rows) && Array.isArray(review.issues) && typeof review.expiresAt === 'string'
    && (review.id === null || typeof review.id === 'string')
}

/**
 * Build shape v2 (P10) — the Publish window reads ONE destination per plan request: the answer must be for this product
 * and exactly this destination, and its content review (when there is one) must pass the review guard above. A plan
 * from an older server, or for another destination, is refused rather than shown.
 */
export function matchesPublishPlan(value: unknown, productId: string, scope: StudioPublishScope): value is PublishPlan {
  const plan = value as PublishPlan | null
  if (!plan || plan.productId !== productId || typeof plan.familySku !== 'string'
    || !Array.isArray(plan.destinations) || plan.destinations.length !== 1) return false
  const destination = plan.destinations[0]
  return !!destination?.scope && publicationScopeKey(destination.scope) === publicationScopeKey(scope)
    && Array.isArray(destination.lifecycle) && Array.isArray(destination.outgrown) && Array.isArray(destination.contentHeld)
    && (destination.review === null || matchesPublicationReview(destination.review, productId, scope))
}

/** One row of the review's problem table: the SKU (or the whole listing) and what to fix, with the channel's own words. */
export interface PublicationProblemRow { id: string; sku: string; message: string; detail?: string }

/** An issue's words without its SKU in front: a message that already starts with its SKU does not repeat it. */
const issueText = (issue: StudioPublishIssue) => issue.sku && issue.message.startsWith(`${issue.sku}: `) ? issue.message.slice(issue.sku.length + 2) : issue.message

/**
 * Audit D4 (2026-10-01) — the review's issues as ONE table of problems (SKU · what to fix) and a list of notes. A problem
 * that names no SKU is about the whole listing. A message that already starts with its SKU does not repeat it.
 */
export function publicationProblems(issues: readonly StudioPublishIssue[]): { problems: PublicationProblemRow[]; notes: string[] } {
  const problems = issues.filter(issue => issue.severity === 'error')
    .map((issue, index) => ({ id: `${index}`, sku: issue.sku ?? 'Whole listing', message: issueText(issue), ...(issue.detail ? { detail: issue.detail } : {}) }))
  const notes = [...new Set(issues.filter(issue => issue.severity === 'warning').map(issue => issue.sku ? `${issue.sku}: ${issueText(issue)}` : issue.message))]
  return { problems, notes }
}

/**
 * One problem to fix, however many SKUs it is on: the same words (and the channel's same detail) on 20 SKUs are ONE
 * problem — one row of the review, counted once everywhere (`problemCount`).
 */
export interface ProblemGroup {
  id: string
  /** The SKUs it is on, in order; none when it is about the whole listing. */
  skus: string[]
  message: string
  detail: string | null
  /** The first product it names and that issue's field: where the sheet can land ("Show in sheet"). Null when it names none. */
  productId: string | null
  field: string | null
  /** The review's errors behind it, one per SKU: what a left-out change points back to (`blockedChanges`). */
  issues: StudioPublishIssue[]
}

/**
 * A review's problems, one per distinct message. Measured on a large family (local copy, four Amazon markets): 1,501
 * problems were 1,501 rows — the window froze for 45 s drawing them — and read as one list of the same few sentences.
 */
export function problemGroups(issues: readonly StudioPublishIssue[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>()
  issues.forEach((issue, index) => {
    if (issue.severity !== 'error') return
    const message = issueText(issue), detail = issue.detail ?? null
    const key = `${message}\u0000${detail ?? ''}`
    const group = groups.get(key) ?? { id: `${index}`, skus: [], message, detail, productId: null, field: null, issues: [] }
    groups.set(key, group)
    group.issues.push(issue)
    if (issue.sku && !group.skus.includes(issue.sku)) group.skus.push(issue.sku)
    if (!group.productId && issue.productId) { group.productId = issue.productId; group.field = issue.field ?? null }
  })
  return [...groups.values()]
}

/** How many problems, counted ONE way everywhere (tab, status, tiles, filter, banner): distinct problems, and the SKUs they are on. */
export interface ProblemCount { problems: number; skus: number }

export function problemCount(issues: readonly StudioPublishIssue[]): ProblemCount {
  const groups = problemGroups(issues)
  return { problems: groups.length, skus: new Set(groups.flatMap(group => group.skus)).size }
}

const countWords = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** "2 problems on 14 SKUs", "1 problem on 1 SKU", "1 problem" (about the whole listing). */
export function problemCountWords(count: ProblemCount): string {
  return `${countWords(count.problems, 'problem', 'problems')}${count.skus ? ` on ${countWords(count.skus, 'SKU', 'SKUs')}` : ''}`
}

/**
 * Option A (Owner 2026-10-19), counted the table's way: the changes a problem leaves out that the table lists as "Left
 * out: …" (a field that changes; a value the channel already holds is never a row), and the distinct problems behind
 * them. The publish gate itself stays `blockedChanges`.
 */
export function leftOutCount(review: Parameters<typeof blockedChanges>[0]): { changes: number; problems: number } {
  const blocked = blockedChanges(review)
  const shown = (review?.changes ?? []).filter(change => blocked.has(change.id) && change.status !== 'SAME')
  const issues = [...new Set(shown.map(change => blocked.get(change.id)!))]
  return { changes: shown.length, problems: problemCount(issues).problems }
}
