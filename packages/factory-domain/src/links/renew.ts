import { linkTerms, PURPOSE_RULES, type LinkPurpose, type LinkState } from './purposes'

/**
 * "Ask for a new link" on every dead link (design links.frame "Ask for a new link": "A dead link is not a dead end";
 * B-W1-49's renew made general, plan B-W2b-163). The page of any link that no longer opens sends the dead link's token to
 * ONE public route; it answers the same words at once, whatever the token (none, garbage, another tenant's, live, dead),
 * and the work runs after the answer, so neither the words nor the time tell anything about a link. The route is held by
 * the abuse guard (policy links.renew: per token and per network; a challenge after suspicious traffic).
 *
 * The work, as the tenant's system: the token must be the link's (its hash, its party). Then
 *   - a purpose whose module renews its own links (links/purposes `renewal: 'module'`: the module knows whether the
 *     record still waits for its answer) goes to that module's renewer (W1: the shipment's documents, the purchase order's
 *     confirm link); none registered: nothing happens (NO_RENEWER);
 *   - a set of files (`renewal: 'files'`: DOCUMENT_VIEW, SECURE_FILE of a StoredFile) is renewed here, by these rules,
 *     else nothing happens (the reason is logged by its code only, never the token, the link or the address):
 *
 *   NOT_A_FILE_LINK        not a set of files (another record type, or no file in the set)
 *   WITHDRAWN              the link was revoked: the sender stopped it on purpose
 *   STILL_LIVE             it still opens (a password hold passes by itself)
 *   NO_ADDRESS             the link was sent to no address
 *   ADDRESS_NOT_ON_FILE    its address is no longer an ACTIVE contact's of the party (its own contact's, when it names
 *                          one): a new link never goes to an address typed on the page, nor to one that left
 *   NEWER_LINK             a live link of the same set of files (same record, purpose and files) went to that address
 *                          already, or a renewal of this link still opens (an earlier request, the office)
 *   ASKED_RECENTLY         this link was renewed in the last ten minutes
 *   NOTHING_TO_SHARE       none of its files is available any more
 *   PAY_FIGURES            one of its files now holds pay figures (links/pay)
 *
 * The new link: the same company, party, contact, address, purpose, record and password (the one sent apart still opens
 * it), the files of the set that are still available (in their order), the old link's span and use limit within the
 * purpose's maximum, made by the system, naming the link it renews (OneOffLink.renewalOfId); sent by mail to the address
 * on file only. The old link stays as it is (dead already).
 *
 * B-W2b-F17 (Owner answer 11-09 = B): a dead link whose purpose and record type have NO renewer (QUOTE_ACCEPT,
 * DEPOSIT_INFO, PAYMENT, JOB_ACCEPT, APPROVAL, RECORD_INVITE, the payroll file …) tells the person who MADE the link
 * instead (their bell), with the record and the reader's optional note, so the one answer is true on every dead link. It
 * never makes or sends a new link: whether to send again is that person's decision. Refused silently (logged by code):
 *
 *   STILL_LIVE             it still opens (and what it stands for still lives)
 *   NO_MAKER               nobody made it, or its maker is no longer an active office person
 *   ASKED_RECENTLY         its maker was told about this link in the last ten minutes
 */

/** The one answer, whatever the token (links.frame). */
export const LINK_RENEW_ANSWER = 'We passed this on. If the link was ours, the sender will write to the address it was sent to.'

/** Two requests within this window make one new link. */
export const LINK_RENEW_COALESCE_MS = 10 * 60 * 1000

export const FILE_RENEW_REFUSALS = [
  'NOT_A_FILE_LINK',
  'WITHDRAWN',
  'STILL_LIVE',
  'NO_ADDRESS',
  'ADDRESS_NOT_ON_FILE',
  'NEWER_LINK',
  'ASKED_RECENTLY',
  'NOTHING_TO_SHARE',
  'PAY_FIGURES',
] as const
export type FileRenewRefusal = (typeof FILE_RENEW_REFUSALS)[number]

export interface FileRenewalFacts {
  readonly purpose: string
  readonly recordType: string
  readonly state: LinkState
  readonly email: string | null
  /** The address is an ACTIVE contact's of the link's party now (its own contact's, when the link names one). */
  readonly addressOnFile: boolean
  /** Files in the set, and how many of them are still available. */
  readonly files: number
  readonly filesAvailable: number
  /** A live link of the same set of files went to that address, or a renewal of this link still opens. */
  readonly liveSibling: boolean
  /** This link was renewed within LINK_RENEW_COALESCE_MS. */
  readonly askedRecently: boolean
  /** links/pay's words for a file of the set, or null. */
  readonly payProblem: string | null
}

const isFilePurpose = (purpose: string): boolean => purpose in PURPOSE_RULES && PURPOSE_RULES[purpose as LinkPurpose].renewal === 'files'

/** Why no new link goes out for a dead set of files, or null when one does (the order of the table above). */
export function fileRenewalRefusal(facts: FileRenewalFacts): FileRenewRefusal | null {
  if (!isFilePurpose(facts.purpose) || facts.recordType !== 'StoredFile' || facts.files === 0) return 'NOT_A_FILE_LINK'
  if (facts.state === 'REVOKED') return 'WITHDRAWN'
  if (facts.state === 'LIVE') return 'STILL_LIVE'
  if (!facts.email) return 'NO_ADDRESS'
  if (!facts.addressOnFile) return 'ADDRESS_NOT_ON_FILE'
  if (facts.liveSibling) return 'NEWER_LINK'
  if (facts.askedRecently) return 'ASKED_RECENTLY'
  if (facts.filesAvailable === 0) return 'NOTHING_TO_SHARE'
  if (facts.payProblem) return 'PAY_FIGURES'
  return null
}

// ---- B-W2b-F17: no renewer → the link's maker is told ---------------------------------------------------------------

/** How a dead link is answered: its module's renewer, a set of files renewed here, else its maker told. */
export type RenewalRoute = 'module' | 'files' | 'maker'

/** The route for a link of this purpose and record type (`hasRenewer`: a module registered one for that pair). */
export function renewalRoute(purpose: LinkPurpose, recordType: string, hasRenewer: boolean): RenewalRoute {
  if (hasRenewer) return 'module'
  return PURPOSE_RULES[purpose].renewal === 'files' && recordType === 'StoredFile' ? 'files' : 'maker'
}

/** The reader's note the request may carry to the link's maker: at most this many characters (trimmed). */
export const LINK_RENEW_NOTE_MAX = 500

export const MAKER_TOLD_REFUSALS = ['STILL_LIVE', 'NO_MAKER', 'ASKED_RECENTLY'] as const
export type MakerToldRefusal = (typeof MAKER_TOLD_REFUSALS)[number]

export interface MakerToldFacts {
  readonly state: LinkState
  /** What the link stands for still lives (its purpose's live check; true when it has none). */
  readonly standsFor: boolean
  /** The maker is an ACTIVE office person of the tenant. */
  readonly makerActive: boolean
  /** When the maker was last told about this link (null: never). */
  readonly lastToldAt: Date | null
  readonly now: Date
}

/** Why the maker is not told about a dead link now, or null when they are (the order of the table above). */
export function makerToldRefusal(facts: MakerToldFacts): MakerToldRefusal | null {
  if (facts.state === 'LIVE' && facts.standsFor) return 'STILL_LIVE'
  if (!facts.makerActive) return 'NO_MAKER'
  if (facts.lastToldAt && facts.lastToldAt.getTime() > facts.now.getTime() - LINK_RENEW_COALESCE_MS) return 'ASKED_RECENTLY'
  return null
}

/** A second ask inside ten minutes, in words (the log's line; the page keeps its one answer). */
export function askedRecentlyWords(lastToldAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((lastToldAt.getTime() + LINK_RENEW_COALESCE_MS - now.getTime()) / 60_000))
  return `The person who made this link was told about it already; it is passed on again in ${minutes} minute${minutes === 1 ? '' : 's'} at the earliest.`
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The renewal's terms: the old link's span (whole days, at least 1) and use limit, within the purpose's maximum. */
export function renewalTerms(purpose: LinkPurpose, old: { readonly createdAt: Date; readonly expiresAt: Date; readonly maxUses: number }, now: Date) {
  const rule = PURPOSE_RULES[purpose]
  const days = Math.min(rule.expiryDays.max, Math.max(1, Math.round((old.expiresAt.getTime() - old.createdAt.getTime()) / DAY_MS)))
  const uses = Math.min(rule.uses.max, Math.max(1, old.maxUses))
  return linkTerms(purpose, { expiresInDays: days, maxUses: uses }, now)
}
