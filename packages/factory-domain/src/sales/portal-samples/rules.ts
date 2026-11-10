import type { ApprovalKind } from '../../approvals-out/kinds'
import { SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD } from '../../approvals-out/kinds'
import { audienceOfLayout } from '../../product/techpack/rules'
import { scanVerdict, techPackCodeOf, formatTechPackCode, type ScanRevision, type ScanState, type ScannedVersion } from '../../product/techpack/scan'
import type { SampleDecision, SampleKind, SampleStage } from '../samples/rules'

/**
 * The brand's samples and tech packs in the portal (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225). Pure: what
 * the brand is shown of the office's sample rounds (B-W2b-246), their decisions (B-W2b-252) and the tech pack versions
 * (B-W2b-230). The brand never sees an instruction, a charge, who decided in the office or a cost: the API never reads them.
 *
 *   Waiting for your decision   the organisation's OPEN approval requests of a product kind (sample, colour, leather,
 *                               artwork) on a sample round, a swatch or a style — answered through B-W2b-184's portal route
 *   Your styles in development  the brand's own private-label styles (Style.brandPartyId = the party) still in development or
 *                               with a round open, and their stage (Proto / Fit / Salesman / … / Approved for production)
 *   Sample rounds               every round of the party with its status in the brand's words and its outbound shipment
 *   Tech pack PDF               a BRAND version (layout TECH_PACK_BRAND/1) of the brand's own style, never INTERNAL or
 *                               SUBCONTRACTOR; each with its verdict against the party's own versions (scanVerdict)
 */

export type PortalLocale = 'it' | 'en'

// ── what waits for the brand ────────────────────────────────────────────────────────────────────────────────────────

/** The approval kinds this page answers (the product's: an order's revised order, a concession or a proof live elsewhere). */
export const WAITING_KINDS = ['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'] as const satisfies readonly ApprovalKind[]
export type WaitingKind = (typeof WAITING_KINDS)[number]
/** The records they are asked on here: a sample round, a swatch, or the style itself (B-W2b-184's style kinds). */
export const WAITING_RECORD_TYPES = [SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, 'Style'] as const
export type WaitingRecordType = (typeof WAITING_RECORD_TYPES)[number]

export const isWaitingKind = (kind: string): kind is WaitingKind => (WAITING_KINDS as readonly string[]).includes(kind)
export const isWaitingRecord = (recordType: string): recordType is WaitingRecordType => (WAITING_RECORD_TYPES as readonly string[]).includes(recordType)

/** Overdue first, then the earliest due, then the oldest asked; the id last (a stable order). */
export function waitingOrder<T extends { readonly dueAt: string; readonly askedAt: string; readonly requestId: string }>(rows: readonly T[], now: Date): T[] {
  const late = (row: T) => (Date.parse(row.dueAt) < now.getTime() ? 0 : 1)
  return [...rows].sort((a, b) => late(a) - late(b) || a.dueAt.localeCompare(b.dueAt) || a.askedAt.localeCompare(b.askedAt) || a.requestId.localeCompare(b.requestId))
}

// ── a round in the brand's words ────────────────────────────────────────────────────────────────────────────────────

/** Design sec:rounds "Being made / Sent / Waiting for you / Approved / Approved with comments / Rejected" (+ received, cancelled). */
export const BRAND_ROUND_STATUSES = ['BEING_MADE', 'SENT', 'RECEIVED', 'WAITING', 'APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED', 'CANCELLED'] as const
export type BrandRoundStatus = (typeof BRAND_ROUND_STATUSES)[number]


/**
 * The round's status for the brand: decided → the decision; cancelled; an OPEN request of the brand names it → waiting for
 * you (whatever the stage: the office may ask once the sample is made); else by stage (requested and in making are "being
 * made"; under review without a request is "received, under review": the office has not asked yet).
 */
export function brandRoundStatus(round: { readonly stage: SampleStage; readonly decision: SampleDecision | null; readonly waiting: boolean }): BrandRoundStatus {
  if (round.stage === 'DECIDED') return round.decision ?? 'APPROVED'
  if (round.stage === 'CANCELLED') return 'CANCELLED'
  if (round.waiting) return 'WAITING'
  if (round.stage === 'SENT') return 'SENT'
  if (round.stage === 'UNDER_REVIEW') return 'RECEIVED'
  return 'BEING_MADE'
}

export const statusTone = (status: BrandRoundStatus): 'neutral' | 'info' | 'success' | 'warning' | 'danger' =>
  status === 'APPROVED' ? 'success' : status === 'APPROVED_WITH_COMMENTS' ? 'success' : status === 'REJECTED' ? 'danger' : status === 'WAITING' ? 'warning' : status === 'SENT' || status === 'RECEIVED' ? 'info' : 'neutral'

/** The outbound shipment the brand follows: the newest sent, else the newest announced (a RETURN is ours to follow). */
export function outboundOf<T extends { readonly direction: string; readonly sentAt: string | null; readonly createdAt: string; readonly id: string }>(shipments: readonly T[]): T | null {
  const outbound = shipments.filter((shipment) => shipment.direction === 'OUTBOUND')
  const newest = (rows: readonly T[]) => [...rows].sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt) || b.id.localeCompare(a.id))[0] ?? null
  return newest(outbound.filter((shipment) => shipment.sentAt !== null)) ?? newest(outbound)
}

/** A tracking page the brand may open: https only (the office's grid checks it too). */
export const safeTrackingUrl = (url: string | null): string | null => (url && /^https:\/\/[^\s]+$/i.test(url) ? url : null)

// ── a style's stage ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Design sec:styles "stage (Proto / Fit / Salesman / Approved for production)": a round's kind, or approved, or in development. */
export const STYLE_STAGES = ['IN_DEVELOPMENT', 'PROTO', 'FIT', 'SALESMAN', 'PRE_PRODUCTION', 'CERTIFICATION', 'BRAND', 'APPROVED'] as const
export type StyleStage = (typeof STYLE_STAGES)[number]


/** A style is still in development before production, or while a round of the brand is open. */
export const DEVELOPMENT_LIFECYCLES = ['CONCEPT', 'DEVELOPMENT', 'SAMPLING', 'APPROVED'] as const
export const APPROVED_LIFECYCLES = ['APPROVED', 'IN_PRODUCTION'] as const

export interface StageRound {
  readonly kind: SampleKind
  readonly stage: SampleStage
  readonly createdAt: string
  readonly id: string
}

const newestFirst = <T extends StageRound>(rounds: readonly T[]): T[] => [...rounds].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
const isOpen = (stage: SampleStage) => stage !== 'DECIDED' && stage !== 'CANCELLED'

export const inDevelopment = (style: { readonly lifecycle: string; readonly status: string }, rounds: readonly StageRound[]): boolean =>
  style.status !== 'ARCHIVED' && ((DEVELOPMENT_LIFECYCLES as readonly string[]).includes(style.lifecycle) || rounds.some((round) => isOpen(round.stage)))

/** The newest open round's kind; else approved for production (the lifecycle); else the newest round's kind; else in development. */
export function styleStageOf(style: { readonly lifecycle: string }, rounds: readonly StageRound[]): StyleStage {
  const live = newestFirst(rounds.filter((round) => round.stage !== 'CANCELLED'))
  const open = live.find((round) => isOpen(round.stage))
  if (open) return open.kind
  if ((APPROVED_LIFECYCLES as readonly string[]).includes(style.lifecycle)) return 'APPROVED'
  return live[0]?.kind ?? 'IN_DEVELOPMENT'
}

/** The newest round (not cancelled first: a cancelled one only when nothing else exists). */
export function latestRoundOf<T extends StageRound>(rounds: readonly T[]): T | null {
  const sorted = newestFirst(rounds)
  return sorted.find((round) => round.stage !== 'CANCELLED') ?? sorted[0] ?? null
}

/** The next date for the brand: the earliest of what it must answer (a request's due day) and an open round's due date. */
export function nextDateOf(dates: readonly (string | null)[]): string | null {
  const days = dates.filter((date): date is string => date !== null).map((date) => date.slice(0, 10))
  return days.sort()[0] ?? null
}

// ── the tech pack the brand may open ────────────────────────────────────────────────────────────────────────────────

export interface TechPackVersionFacts {
  readonly id: string
  readonly revisionId: string
  readonly version: number
  readonly layout: string | null
  readonly language: string
  readonly fingerprint: string
  readonly createdAt: string
  readonly companyId: string
}

export interface BrandTechPack {
  readonly id: string
  readonly revisionId: string
  readonly revision: number
  readonly revisionStatus: ScanRevision['status']
  readonly version: number
  readonly language: string
  readonly code: string
  readonly printed: string
  readonly createdAt: string
  readonly state: ScanState
  readonly words: string
}

/**
 * The BRAND versions of the brand's own style a brand may open: of a private-label style of this party only (never a
 * tenant-wide or another brand's style — `copyPartyProblem` already makes a private-label BRAND copy for its brand alone),
 * made in the portal's company, the BRAND layout only (never INTERNAL or SUBCONTRACTOR). Each says its verdict against
 * the party's own versions (`scanVerdict`), newest first.
 */
export function brandTechPacks(
  style: { readonly brandPartyId: string | null },
  partyId: string,
  companyId: string,
  versions: readonly TechPackVersionFacts[],
  revisions: readonly (ScanRevision & { readonly id: string })[],
): BrandTechPack[] {
  if (style.brandPartyId === null || style.brandPartyId !== partyId) return []
  const revisionOf = new Map(revisions.map((revision) => [revision.id, revision]))
  const mine = versions.filter((version) => audienceOfLayout(version.layout) === 'BRAND' && version.companyId === companyId && revisionOf.has(version.revisionId))
  const scanned: ScannedVersion[] = mine.map((version) => ({ id: version.id, revisionId: version.revisionId, version: version.version, audience: 'BRAND', language: version.language, fingerprint: version.fingerprint, createdAt: version.createdAt }))
  return mine
    .map((version, index): BrandTechPack => {
      const revision = revisionOf.get(version.revisionId)!
      const verdict = scanVerdict(scanned[index]!, revision, scanned, revisions)
      const code = techPackCodeOf(version.id)
      return { id: version.id, revisionId: revision.id, revision: revision.revision, revisionStatus: revision.status, version: version.version, language: version.language, code, printed: formatTechPackCode(code), createdAt: version.createdAt, state: verdict.state, words: verdict.words }
    })
    .sort((a, b) => b.revision - a.revision || b.version - a.version || b.id.localeCompare(a.id))
}

/** The copy to offer first: a current or draft one in the reader's language, else in any language; else the newest. */
export function techPackToOffer(packs: readonly BrandTechPack[], locale: PortalLocale): BrandTechPack | null {
  const usable = packs.filter((pack) => pack.state === 'CURRENT' || pack.state === 'DRAFT')
  return usable.find((pack) => pack.language === locale) ?? usable[0] ?? packs[0] ?? null
}


/** At most this many rounds and styles in one answer (a brand has far fewer). */
export const PORTAL_SAMPLES_LIMITS = Object.freeze({ rounds: 500, styles: 200, waiting: 100, techPacks: 500 })
