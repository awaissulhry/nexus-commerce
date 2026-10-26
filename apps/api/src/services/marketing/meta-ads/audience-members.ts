/**
 * Meta ads step 31 — the people of a customer list (Owner decision D8: customer lists only from Nexus customers who gave
 * marketing consent, hashed, refreshed by Nexus). Consent PR 2 (2026-10-26; the Owner's picks P1 = B, P2 = A).
 *
 *   ADDING people (POST /{audience}/users, /usersreplace): only Shopify buyers who said yes to the business's e-mail
 *   marketing, and only while the business's switch "Upload customer lists to Meta" is on (customer-lists-switch.ts; off,
 *   every add and replace is refused in words: NO_CONSENT). `consentedPeople` reads them from ShopifyMarketingConsent
 *   (consent PR 1: one row per Shopify customer of a Shopify account, the e-mail's SHA-256 only, rows for buyers only —
 *   at least one Shopify order, any date, P1 = B — so the buyer rule is the table's own), with every filter IN THE
 *   DATABASE query: Shopify's state SUBSCRIBED, a row of an ACTIVE Shopify account this business owns (never a shared or
 *   disconnected one), and not one of the people who opted out of the business's e-mail (below). Amazon, eBay and Etsy
 *   buyers give no consent and have no row: they are never uploaded. E-mail only (P2 = A): no phone, name or address.
 *
 *   TAKING people OUT (DELETE /{audience}/users, DELETE /act_{id}/usersofanyaudience): the people who opted out of the
 *   business's e-mail — Nexus's suppression list (EmailSuppression) rows that hold for every channel (channel null) and
 *   say "no": an unsubscribe link, a spam complaint, a GDPR request or an operator's entry; never a bounce. The query
 *   filters that in the database. Meta asks that a person who opts out leaves every customer list of the account
 *   (reference/custom-audience "Updating"): that is mode opt_out_everywhere. Mode remove takes out, besides them, the
 *   people whose Shopify consent ended (`consentEndedPeople`: a row no longer SUBSCRIBED), unless they still say yes on
 *   another active Shopify account of the business. The undo of an add takes out everyone Nexus holds a Shopify consent
 *   row for (`shopifyConsentPeople`): Nexus keeps no list of whom an add sent, and that is everyone it could have sent.
 *
 * Privacy: each e-mail is normalised (trim, lower case — custom-audiences guide #hash) and hashed with SHA-256 (lowercase
 * hex) the moment it is read; the plain address is never kept, logged, stored or returned, and the hashes live only in
 * the request bodies (the gateway's ledger keeps neither them nor Meta's answer: meta-audience-rules.ts `personal`).
 * What a person reads is counts only. A request is ≤ 10,000 hashes. A removal or an add carries no session (review B1:
 * `session` is optional on /users in Meta's reference and Meta's DELETE examples send the payload only; an id repeated
 * for the same people would be a session Meta closed already), so the preview, the re-check and the run build the same
 * requests. A replace needs one (usersreplace: payload and session both [required]; batch_seq 1 starts the replace):
 * a new random session id each time the requests are built, kept out of the plan's hash (`replaceBatches`).
 */
import { randomInt } from 'node:crypto'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { normalisedEmail, sha256Hex } from '../../../lib/customer-email-hash.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

// The one normaliser (lib/customer-email-hash.ts), so a hash Nexus stores is the hash a customer list gets.
export { normalisedEmail, sha256Hex }

/** Why Nexus adds and replaces nobody: the business's switch "Upload customer lists to Meta" is off (customer-lists-switch.ts). */
export const NO_CONSENT = 'Uploading customer lists to Meta is switched off for this business, so Nexus adds and replaces nobody in a Meta '
  + 'customer list. A person turns it on in Nexus (Settings › Channels › Meta, "Upload customer lists to Meta"); Claude cannot. Even then '
  + 'Nexus uploads only the hashed e-mails of Shopify buyers who said yes to the business\'s e-mail (Owner decision D8): never Amazon, eBay '
  + 'or Etsy buyers, never a value-based seed. Taking people out (mode remove or opt_out_everywhere) needs no switch.'

/** The suppression sources that mean the person said no to the business's e-mail (a hard bounce does not). */
export const OPT_OUT_SOURCES = ['UNSUBSCRIBE_LINK', 'COMPLAINT', 'GDPR_REQUEST', 'MANUAL'] as const

/** At most this many people in one change (10 requests of 10,000): more is asked in parts (`since`). */
export const MAX_PEOPLE = 10 * MEMBERS_PER_REQUEST

export interface HashedPeople {
  /** SHA-256 hashes, sorted, each once (never shown to anyone: they go only into the request bodies). */
  hashes: string[]
  /** Rows that hold no usable e-mail address (counted, never sent). */
  skipped: number
}

/** The Shopify consent state that is a yes (consent PR 1 stores Shopify's states in upper case). */
const YES = 'SUBSCRIBED'
const SHA256_HEX = /^[0-9a-f]{64}$/
/**
 * The most opt-outs `consentedPeople` subtracts in its one database query (each is a bound value; PostgreSQL takes at
 * most 65,535 in a statement). More is refused in words: nobody is uploaded rather than someone who said no.
 */
export const MAX_OPT_OUTS_SUBTRACTED = 30_000

/** Stored hashes as the requests take them: sorted, each once; a stored value that is no SHA-256 is counted, never sent. */
function hashedRows(rows: Array<{ emailSha256: string }>): HashedPeople {
  const hashes = new Set<string>()
  let skipped = 0
  for (const row of rows) {
    if (SHA256_HEX.test(row.emailSha256)) hashes.add(row.emailSha256)
    else skipped += 1
  }
  return { hashes: [...hashes].sort(), skipped }
}

const recordedSince = (since: Date | null) => (since ? { updatedAt: { gte: since } } : {})

/**
 * The rows that say yes on an ACTIVE Shopify account this business owns (row-level security: this business's rows only;
 * the account named in the query too, so a shared or disconnected account's rows never count), optionally recorded
 * since a day, without the hashes given.
 */
async function sayingYes(since: Date | null, without: string[]): Promise<Array<{ emailSha256: string }>> {
  return prisma.shopifyMarketingConsent.findMany({
    where: {
      emailState: YES,
      connection: { is: { channelType: 'SHOPIFY', isActive: true, workspaceId: workspaceIdForQuery() } },
      ...recordedSince(since),
      ...(without.length ? { emailSha256: { notIn: without } } : {}),
    },
    select: { emailSha256: true },
  })
}

/**
 * The people a customer list may get (D8, P1 = B, P2 = A): Shopify buyers of an active Shopify account this business
 * owns who said yes to its e-mail marketing (SUBSCRIBED), never one who opted out of its e-mail (EmailSuppression,
 * `optedOutPeople`) — every filter in the database query. `since`: only rows Nexus recorded or changed from then on (to
 * send a long list in parts). Refused in words when the opt-outs are too many to subtract in one query.
 */
export async function consentedPeople(since: Date | null): Promise<HashedPeople | { refusal: string }> {
  const optedOut = await optedOutPeople(null)
  if (optedOut.hashes.length > MAX_OPT_OUTS_SUBTRACTED) {
    return { refusal: `${optedOut.hashes.length} people opted out of the business's e-mail: Nexus subtracts at most ${MAX_OPT_OUTS_SUBTRACTED} in one database query, so it uploads nobody rather than someone who said no.` }
  }
  return hashedRows(await sayingYes(since, optedOut.hashes))
}

/**
 * The people whose Shopify consent ended: a row that no longer says yes (UNSUBSCRIBED, NOT_SUBSCRIBED, PENDING, INVALID,
 * REDACTED), recorded or changed since a day — unless the same person still says yes on an active Shopify account of the
 * business (then the business still has their yes, and an add would send them again).
 */
export async function consentEndedPeople(since: Date | null): Promise<HashedPeople> {
  const ended = hashedRows(await prisma.shopifyMarketingConsent.findMany({ where: { emailState: { not: YES }, ...recordedSince(since) }, select: { emailSha256: true } }))
  if (!ended.hashes.length) return ended
  const stillYes = new Set(hashedRows(await sayingYes(null, [])).hashes)
  return { hashes: ended.hashes.filter((h) => !stillYes.has(h)), skipped: ended.skipped }
}

/**
 * Everyone Nexus holds a Shopify consent row for (any state, any of the business's Shopify accounts), recorded or changed
 * since a day: the undo of an add takes them out — Nexus keeps no list of whom an add sent, and everyone it sent has
 * such a row (unless Shopify asked to erase them since, or their shop was uninstalled: their hash is gone with the row).
 */
export async function shopifyConsentPeople(since: Date | null): Promise<HashedPeople> {
  return hashedRows(await prisma.shopifyMarketingConsent.findMany({ where: recordedSince(since), select: { emailSha256: true } }))
}

/** Two lists of people as one (each once, sorted). */
export function unionOf(a: HashedPeople, b: HashedPeople): HashedPeople {
  return { hashes: [...new Set([...a.hashes, ...b.hashes])].sort(), skipped: a.skipped + b.skipped }
}

/**
 * The people who opted out of this business's e-mail (row-level security: this business's rows only), hashed at once.
 * `since`: only opt-outs recorded from then on. The plain addresses never leave this function.
 */
export async function optedOutPeople(since: Date | null): Promise<HashedPeople> {
  const rows = await prisma.emailSuppression.findMany({
    where: { channel: null, source: { in: [...OPT_OUT_SOURCES] }, ...(since ? { createdAt: { gte: since } } : {}) },
    select: { email: true },
  })
  const hashes = new Set<string>()
  let skipped = 0
  for (const row of rows) {
    const email = normalisedEmail(row.email)
    if (email) hashes.add(sha256Hex(email))
    else skipped += 1
  }
  return { hashes: [...hashes].sort(), skipped }
}

export interface MemberBatch {
  /** The form field of one request: the payload, a JSON string in Nexus's canonical form (no session: review B1). */
  params: { payload: string }
  count: number
}

/** The requests that carry these hashes: ≤ 10,000 each, each an add or a removal of its own (no session). */
export function memberBatches(hashes: string[]): MemberBatch[] {
  const out: MemberBatch[] = []
  for (let i = 0; i < hashes.length; i += MEMBERS_PER_REQUEST) {
    const data = hashes.slice(i, i + MEMBERS_PER_REQUEST)
    out.push({ params: { payload: JSON.stringify({ schema: 'EMAIL_SHA256', data }) }, count: data.length })
  }
  return out
}

export interface ReplaceBatch {
  /** The payload and the session, JSON strings in Nexus's canonical form, as sent. */
  params: { payload: string; session: string }
  /** The same without the session id: what the plan's hash reads (the id is new each time the requests are built). */
  planParams: { payload: string; session: string }
  count: number
}

/**
 * A new session id for a replace: Meta needs one "unique in the same ad account" (a positive int64; Nexus keeps it below
 * 2^48 so it stays an exact JSON number). Random, so two replaces never share one.
 */
export const newSessionId = (): number => randomInt(1, 2 ** 48)

/**
 * The requests of ONE replace session (POST /{audience}/usersreplace): ≤ 10,000 hashes each, batch_seq from 1 (Meta: the
 * first batch starts the replace), the last marked last_batch_flag true (else Meta ends the session 90 minutes after the
 * first batch), and the total, all with one session id.
 */
export function replaceBatches(hashes: string[], sessionId: number = newSessionId()): ReplaceBatch[] {
  const parts = memberBatches(hashes)
  return parts.map((part, i) => {
    const session = { batch_seq: i + 1, last_batch_flag: i === parts.length - 1, estimated_num_total: hashes.length }
    return {
      params: { payload: part.params.payload, session: JSON.stringify({ session_id: sessionId, ...session }) },
      planParams: { payload: part.params.payload, session: JSON.stringify(session) },
      count: part.count,
    }
  })
}

/** What Meta answered for one request of people: its counts only (never its invalid-entry samples: they are hashes). */
export function memberCounts(node: Record<string, unknown> | null): { received: number | null; invalid: number | null } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)
  return { received: n(node?.num_received), invalid: n(node?.num_invalid_entries) }
}
