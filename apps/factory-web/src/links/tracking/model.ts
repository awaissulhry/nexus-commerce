import type { MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import type { BrandingTokens } from '@nexus/ui/tokens/branding'
import { normalPostcode, normalReference, SEARCH_LIMITS } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { Paper, SearchAnswer, TrackingPage } from './api'

/**
 * Track an order, pure (B-W2b-170; design links.tracking, SCR-194; LOG-062). The page model the containers fill and the
 * view draws: the tracking page of a link (`/l#token=…`) or of a shipment the public search found (`/t`), and the search
 * itself. Every word is the page's own catalogue (`link-tracking`), chosen here from the API's codes and numbers.
 */

export type Load = 'loading' | 'ready' | 'error' | 'dead'
export type PaperState = 'idle' | 'busy' | 'failed'
/** "Report a problem": opening a claim link, done (a new tab), refused in words, or the network failed. */
export type ClaimState = 'idle' | 'busy' | 'opened' | 'too-many' | 'failed'
export type AskState = 'idle' | 'busy' | 'done' | 'failed'

export interface SearchSender extends BrandingTokens {
  readonly companyId: string
  readonly contactEmail: string | null
}

export type SearchState = 'idle' | 'searching' | 'checking' | 'miss' | 'several' | 'wait' | 'error'

export interface SearchModel {
  /** Whose search (the address's tenant and company): loading, ready, missing (no tenant in the address), failed. */
  readonly head: 'loading' | 'ready' | 'missing' | 'failed'
  readonly sender: SearchSender | null
  readonly reference: string
  readonly postcode: string
  /** The field problems shown after a try (codes; the view says them). */
  readonly problems: { readonly reference?: FieldProblem; readonly postcode?: FieldProblem }
  readonly state: SearchState
  /** Minutes to wait after a 429 (`wait`). */
  readonly waitMinutes: number | null
  /** More than one shipment of the order: the visitor picks one. */
  readonly found: SearchAnswer['shipments']
}

export type FieldProblem = 'EMPTY' | 'LONG' | 'FORMAT'

export interface TrackingViewModel {
  /** The tracking part (a link's page, or the one the search found). `idle`: nothing to show yet (the search alone). */
  readonly load: Load | 'idle'
  readonly slow: boolean
  readonly page: TrackingPage | null
  readonly papers: Readonly<Record<string, PaperState>>
  readonly claim: ClaimState
  readonly ask: AskState
  /** The tracking number last copied (its button says Copied). */
  readonly copied: string | null
  /** When the page was last read (live: read again every minute while on the way). */
  readonly readAt: string | null
  /** The public search (`/t`); null on a link's page. */
  readonly search: SearchModel | null
  /** The time zone of the page's times before the page is read (the API's site zone wins once read). */
  readonly timeZone?: string
}

export interface TrackingActions {
  onRetry?: () => void
  onCopy?: (trackingNumber: string) => void
  onPaper?: (fileId: string) => void
  onClaim?: () => void
  onAskNewLink?: () => void
  onSearchField?: (field: 'reference' | 'postcode', value: string) => void
  onSearch?: () => void
  onPick?: (token: string) => void
  onSearchAgain?: () => void
}

export const EMPTY_SEARCH: SearchModel = { head: 'loading', sender: null, reference: '', postcode: '', problems: {}, state: 'idle', waitMinutes: null, found: [] }

export const initialTracking = (search: SearchModel | null): TrackingViewModel => ({
  load: search ? 'idle' : 'loading',
  slow: false,
  page: null,
  papers: {},
  claim: 'idle',
  ask: 'idle',
  copied: null,
  readAt: null,
  search,
})

// ---- the tracking part --------------------------------------------------------------------------------------------

/** The page's title: the customer's own order reference first, then ours, then the shipment. */
export const orderLabel = (page: TrackingPage): string => page.order.customerRef ?? page.order.number ?? page.shipment.number

/** The DS tracker: every step reached is done, the furthest reached is "now" (B-W2b-191's rule). */
export function trackerSteps(page: TrackingPage, label: (code: TrackingPage['steps'][number]['code']) => string, at: (iso: string) => string): MilestoneStep[] {
  return page.steps.map((step) => ({
    id: step.code,
    label: label(step.code),
    state: step.state === 'TODO' ? 'todo' : 'done',
    current: step.state === 'CURRENT' || (step.code === 'DELIVERED' && step.state === 'DONE'),
    date: step.at ? at(step.at) : null,
  }))
}

export type PillTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const PILL_TONE: Readonly<Record<TrackingPage['pill'], PillTone>> = {
  PACKED: 'neutral',
  COLLECTED: 'info',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  PROBLEM: 'warning',
}

export const EVENT_TONE: Readonly<Record<TrackingPage['events'][number]['status'], PillTone>> = {
  LABEL_CREATED: 'neutral',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  EXCEPTION: 'warning',
  RETURNED: 'warning',
}

/** The carrier's own page, only when it is https (the API keeps no other; checked again here). */
export const carrierPageOf = (url: string | null | undefined): string | null => (url && /^https:\/\/\S+$/i.test(url) ? url : null)

/** The header's "Track on the carrier's site": the only parcel's page, or the first one when every parcel has the same. */
export function headerCarrierPage(page: TrackingPage): string | null {
  const pages = [...new Set(page.parcels.map((parcel) => carrierPageOf(parcel.carrierPage)).filter((url): url is string => url !== null))]
  return pages.length === 1 ? pages[0]! : null
}

/** The delivery's place: "Bologna 40100 · IT" (no name, no street: the API sends none). */
export function placeLine(delivery: TrackingPage['delivery']): string | null {
  const town = [delivery.postcode, delivery.city].filter((part): part is string => !!part).join(' ')
  const parts = [town, delivery.country].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Where it was delivered: the place of the carrier's DELIVERED event, when it said one. */
export const deliveredPlace = (page: TrackingPage): string | null => page.events.find((event) => event.status === 'DELIVERED')?.place ?? null

/** The page reads again every minute while the goods are packed or on the way (no live channel for a link). */
export const POLL_MS = 60_000
export const keepsPolling = (page: TrackingPage | null): boolean => !!page && (page.shipment.status === 'PACKED' || page.shipment.status === 'SHIPPED')

/** A read that failed: the link died (the one 404), or anything else (Try again). */
export const loadOfError = (error: unknown): Load => (isApiError(error) && error.kind === 'not_found' ? 'dead' : 'error')

/** "Report a problem" refused: too many claim links (409), the link died (404), else try again. */
export function claimOfError(error: unknown): ClaimState | 'dead' {
  if (!isApiError(error)) return 'failed'
  if (error.kind === 'not_found') return 'dead'
  if (error.kind === 'conflict') return 'too-many'
  return 'failed'
}

/** A paper's line under its name: kind words + number / style + language. */
export interface PaperLine {
  readonly kind: Paper['kind']
  readonly number: string | null
  readonly style: string | null
  readonly language: string | null
}
export const paperLine = (paper: Paper): PaperLine => ({ kind: paper.kind, number: paper.number, style: paper.style ? `${paper.style.code} · ${paper.style.name}` : null, language: paper.language })

/** Saves bytes as a file in the browser (a paper downloaded). */
export function saveBytes(data: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- the public search ----------------------------------------------------------------------------------------------

/** The fields' problems before anything is sent (the API's own rule, factory-domain searchProblems). */
export function searchFieldProblems(reference: string, postcode: string): SearchModel['problems'] {
  const problems: { reference?: FieldProblem; postcode?: FieldProblem } = {}
  const ref = normalReference(reference)
  const code = normalPostcode(postcode)
  if (ref === '') problems.reference = 'EMPTY'
  else if (ref.length > SEARCH_LIMITS.reference) problems.reference = 'LONG'
  if (code === '') problems.postcode = 'EMPTY'
  else if (code.length > SEARCH_LIMITS.postcode || !/^[A-Z0-9]+$/.test(code)) problems.postcode = 'FORMAT'
  return problems
}

export const hasProblems = (problems: SearchModel['problems']): boolean => problems.reference !== undefined || problems.postcode !== undefined

/** What a refused search means: wait (429 retryAfter), a proof of work to solve first (429 challenge), else an error. */
export function searchRefusal(error: unknown): { readonly kind: 'wait'; readonly minutes: number } | { readonly kind: 'challenge' } | { readonly kind: 'error' } {
  if (!isApiError(error) || error.kind !== 'rate_limited') return { kind: 'error' }
  const paths = error.issues.map(issuePath)
  if (paths.includes('challenge')) return { kind: 'challenge' }
  const seconds = Number(error.issues.find((issue) => issuePath(issue) === 'retryAfter')?.message ?? 60)
  return { kind: 'wait', minutes: Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60)) }
}

/** The address's tenant and company (`/t?tenant=…&company=…`): a slug and a code, or nothing usable. */
export function searchAddress(tenant: string | null | undefined, company: string | null | undefined): { readonly tenant: string; readonly company: string | null } | null {
  const slug = (tenant ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null
  const code = (company ?? '').trim()
  return { tenant: slug, company: /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null }
}
