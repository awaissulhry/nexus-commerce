import type { QuoteVersionStatus } from '../quotes/quotes'

/**
 * Proofs signed with the quote (B-W2b-165; SAL-199; design links.quote "Proofs you accept with it", sales.quotes
 * "Documents"), pure. The office attaches proof files to a quote version — an artwork proof, a size chart, a measurement
 * sheet: whatever the customer must see and agree to besides the priced document — and the customer accepts them WITH
 * the quote: the accept link lists them under Proofs, and the acceptance's evidence names each one's SHA-256 and version.
 *
 *   attach    a PDF or a picture (JPEG, PNG, WebP: what a browser shows in place; HEIC keeps camera and position data and
 *             is never shown outside the office), a StoredFile of record type `QuoteVersion`, category PROOF, while the
 *             version is not sent yet (DRAFT, PENDING_APPROVAL, APPROVED: a proof is not priced, so it changes no
 *             approval); at most MAX_PROOFS per version. A proof may get a new version (B-W2b-160's series) while unsent.
 *   send      freezes them with the version: every proof's current version must be available (none uploading, held
 *             for its scan, or refused); the send shares each one with the customer (portal and link, the party's) and
 *             keeps it as long as the quote's PDF; nothing is added, replaced or removed afterwards.
 *   accept    the page names the proofs it showed; an acceptance of a set that changed meanwhile is refused, so the
 *             customer never accepts a proof they did not see. The evidence lists each proof: name, SHA-256, version.
 *   order     the accepted version's proofs go with the order (SalesOrder.quoteVersionId) to its work orders (through
 *             their sizes' order lines): read there, never copied.
 *
 * Nothing here reads or writes the database.
 */

/** What a proof may be: what the link page shows in place (a PDF viewer, a picture). */
export const PROOF_CONTENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const)
export type ProofContentType = (typeof PROOF_CONTENT_TYPES)[number]

/** At most this many proofs (series) per quote version. */
export const MAX_PROOFS = 12

/** The record type of a proof's StoredFile: the quote version it is frozen with. */
export const PROOF_RECORD_TYPE = 'QuoteVersion'

/** The versions whose proofs may still change: not sent yet. */
export const PROOFS_OPEN_STATUSES: readonly QuoteVersionStatus[] = Object.freeze(['DRAFT', 'PENDING_APPROVAL', 'APPROVED'])

export type ProofShape = 'PDF' | 'PICTURE'

const normalised = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase()

export const isProofType = (contentType: string): contentType is ProofContentType => (PROOF_CONTENT_TYPES as readonly string[]).includes(normalised(contentType))

/** How the page shows it: a PDF in the viewer, a picture in the lightbox. */
export const proofShapeOf = (contentType: string): ProofShape => (normalised(contentType) === 'application/pdf' ? 'PDF' : 'PICTURE')

/** The StoredFile kind a proof is stored as: a PDF is a DOCUMENT, a picture a PHOTO (each kind's size limit applies). */
export const proofFileKindOf = (contentType: string): 'DOCUMENT' | 'PHOTO' => (proofShapeOf(contentType) === 'PDF' ? 'DOCUMENT' : 'PHOTO')

/** Why the proofs of a version in this state cannot change, in words; null while they can. */
export function proofsFrozenRefusal(status: QuoteVersionStatus, revision: number): string | null {
  if (PROOFS_OPEN_STATUSES.includes(status)) return null
  if (status === 'SENT') return `Version ${revision} was sent: its proofs went with it and are frozen. Make a new version to change them.`
  return `Version ${revision} is ${status.toLowerCase().replace('_', ' ')}: its proofs are frozen with it.`
}

/** Why this file cannot be added as a proof, in words; null when it can. */
export function proofTypeRefusal(contentType: string): string | null {
  return isProofType(contentType) ? null : 'A proof is a PDF or a picture (JPEG, PNG or WebP): the customer sees it in the browser before accepting.'
}

/** Why one more proof does not fit, in words; null when it does. `held` = the version's proofs now (not deleted). */
export function tooManyRefusal(held: number): string | null {
  return held >= MAX_PROOFS ? `A version takes at most ${MAX_PROOFS} proofs: remove one first.` : null
}

/** A proof file as the rules see it: one version of a series (B-W2b-160). */
export interface ProofFileFacts {
  readonly id: string
  readonly seriesId: string | null
  readonly versionNo: number
  readonly originalName: string
  readonly status: 'PENDING_UPLOAD' | 'AVAILABLE' | 'QUARANTINED' | 'DELETED'
  readonly supersededAt: Date | string | null
  readonly quarantineReason?: string | null
}

export const seriesOfProof = (file: Pick<ProofFileFacts, 'id' | 'seriesId'>): string => file.seriesId ?? file.id

/**
 * The version's proofs, one per series: its newest version not deleted (an upload in progress or held is newer than the
 * current one and shows as such), in the order the first versions were added (`files` in creation order). A series whose
 * every version is deleted is gone.
 */
export function proofSeries<T extends ProofFileFacts>(files: readonly T[]): Array<{ readonly root: string; readonly newest: T; readonly current: T | null }> {
  const roots: string[] = []
  const bySeries = new Map<string, T[]>()
  for (const file of files) {
    const root = seriesOfProof(file)
    if (!bySeries.has(root)) {
      bySeries.set(root, [])
      roots.push(root)
    }
    bySeries.get(root)!.push(file)
  }
  return roots.flatMap((root) => {
    const kept = bySeries.get(root)!.filter((file) => file.status !== 'DELETED')
    if (kept.length === 0) return []
    const newest = kept.reduce((a, b) => (b.versionNo > a.versionNo ? b : a))
    const current = kept.find((file) => file.status === 'AVAILABLE' && file.supersededAt === null) ?? null
    return [{ root, newest, current }]
  })
}

/** What a proof's newest version is doing, as the office reads it. */
export type ProofState = 'READY' | 'UPLOADING' | 'CHECKING' | 'REFUSED'

export function proofStateOf(file: Pick<ProofFileFacts, 'status' | 'quarantineReason'>): ProofState {
  if (file.status === 'AVAILABLE') return 'READY'
  if (file.status === 'PENDING_UPLOAD') return 'UPLOADING'
  if (file.status === 'QUARANTINED' && file.quarantineReason === 'scan_pending') return 'CHECKING'
  return 'REFUSED'
}

/** A send blocker: a proof whose newest version is not ready (the code is the send check's PROOF_NOT_READY). */
export interface ProofSendBlocker {
  readonly fileId: string
  readonly name: string
  readonly state: Exclude<ProofState, 'READY'>
  readonly message: string
}

const NOT_READY: Record<Exclude<ProofState, 'READY'>, string> = {
  UPLOADING: 'is still uploading: finish it or remove it',
  CHECKING: 'is being checked for viruses: wait a moment',
  REFUSED: 'was refused (it did not match what was announced, or the check found a problem): remove it or upload it again',
}

/** What stops a send because of the proofs: every proof's newest version must be the available current one. */
export function proofSendBlockers(files: readonly ProofFileFacts[]): ProofSendBlocker[] {
  return proofSeries(files).flatMap(({ newest }) => {
    const state = proofStateOf(newest)
    if (state === 'READY') return []
    return [{ fileId: newest.id, name: newest.originalName, state, message: `The proof "${newest.originalName}" ${NOT_READY[state]}.` }]
  })
}

/** The proofs the send freezes: each series' current version (the blockers say none is newer). */
export function frozenProofs<T extends ProofFileFacts>(files: readonly T[]): T[] {
  return proofSeries(files).flatMap(({ current }) => (current ? [current] : []))
}

/**
 * Why an acceptance of `shown` (the proofs the page showed, by file id; undefined: the page did not say) is refused
 * against the version's proofs now; null when the customer saw exactly these.
 */
export function shownProofsRefusal(shown: readonly string[] | undefined, current: readonly string[]): string | null {
  if (shown === undefined) return null
  const a = [...new Set(shown)].sort()
  const b = [...new Set(current)].sort()
  if (a.length === b.length && a.every((id, index) => id === b[index])) return null
  return 'The proofs of this quote changed while you were reading it: read them again before you accept.'
}

/** One proof as the acceptance's evidence names it. */
export interface AcceptedProof {
  readonly fileId: string
  readonly name: string
  readonly sha256: string
  readonly versionNo: number
  readonly sizeBytes: number
  readonly contentType: string
}

/** The evidence's list, in the page's order, from the stored audit entry (an unknown shape gives none). */
export function acceptedProofsOf(after: unknown): AcceptedProof[] {
  if (typeof after !== 'object' || after === null) return []
  const list = (after as { proofs?: unknown }).proofs
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { fileId, name, sha256, versionNo, sizeBytes, contentType } = entry as Record<string, unknown>
    if (typeof fileId !== 'string' || typeof name !== 'string' || typeof sha256 !== 'string' || typeof versionNo !== 'number') return []
    return [{ fileId, name, sha256, versionNo, sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : 0, contentType: typeof contentType === 'string' ? contentType : '' }]
  })
}

/** The audit action that keeps the acceptance's proofs (one row per acceptance, record QuoteVersion). */
export const ACCEPTED_PROOFS_ACTION = 'quotes.acceptProofs'
/** The audit action of the send's freeze (one row per send that froze proofs, record QuoteVersion). */
export const FROZEN_PROOFS_ACTION = 'quotes.freezeProofs'
