/**
 * Meta ads step 31 — the people of a customer list (Owner decision D8: customer lists only from Nexus customers who gave
 * marketing consent, hashed, refreshed by Nexus).
 *
 *   ADDING people (POST /{audience}/users, /usersreplace): NOBODY. Nexus's customer data carries no marketing consent
 *   (checked 2026-10-21 in packages/database/prisma/schema.prisma: Customer and Order hold no consent field; ConsentRecord
 *   is an operator's own consent; nothing imports a buyer's opt-in from Shopify or a marketplace). So the consent query
 *   has nothing to filter on and every add or replace is refused in words (consentedCustomers). When a consent field
 *   exists, the query filters on it IN THE DATABASE (never after reading the customers), and adds and replaces go out as
 *   the removals below do (hashed, in sessions of at most 10,000 per request, one replace session at a time).
 *
 *   TAKING people OUT (DELETE /{audience}/users, DELETE /act_{id}/usersofanyaudience): the people who opted out of the
 *   business's e-mail — Nexus's suppression list (EmailSuppression) rows that hold for every channel (channel null) and
 *   say "no": an unsubscribe link, a spam complaint, a GDPR request or an operator's entry; never a bounce. The query
 *   filters that in the database. Meta asks that a person who opts out leaves every customer list of the account
 *   (reference/custom-audience "Updating"): that is mode opt_out_everywhere.
 *
 * Privacy: each e-mail is normalised (trim, lower case — custom-audiences guide #hash) and hashed with SHA-256 (lowercase
 * hex) the moment it is read; the plain address is never kept, logged, stored or returned, and the hashes live only in
 * the request bodies (the gateway's ledger keeps neither them nor Meta's answer: meta-audience-rules.ts `personal`).
 * What a person reads is counts only. A batch is ≤ 10,000 hashes with its session (session_id, batch_seq from 1,
 * last_batch_flag on the last, estimated_num_total); the session id is derived from what is sent, so the preview, the
 * re-check and the run build the same requests.
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

/** Why Nexus adds nobody to a customer list (D8). */
export const NO_CONSENT = 'Nexus adds people to a Meta customer list only from customers who gave marketing consent (Owner decision D8), '
  + 'and Nexus\'s customer records hold no marketing consent yet: no consent field exists (a buyer\'s opt-in at Shopify or a marketplace is '
  + 'not brought into Nexus). So Nexus uploads nobody — no add, no replace, no value-based seed. Website, engagement, video, catalog and '
  + 'lookalike audiences need no upload (create-meta-audience); people who opted out are taken out with mode remove or opt_out_everywhere.'

/** THE consent query (D8): today it has no field to filter on, so it refuses — never a list read and filtered afterwards. */
export function consentedCustomers(): { refusal: string } {
  return { refusal: NO_CONSENT }
}

/** The suppression sources that mean the person said no to the business's e-mail (a hard bounce does not). */
export const OPT_OUT_SOURCES = ['UNSUBSCRIBE_LINK', 'COMPLAINT', 'GDPR_REQUEST', 'MANUAL'] as const

/** At most this many people in one change (10 requests of 10,000): more is asked in parts (`since`). */
export const MAX_PEOPLE = 10 * MEMBERS_PER_REQUEST

/** An e-mail as Meta matches it (trim, lower case), or null when it is no e-mail address at all. */
export function normalisedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export interface HashedPeople {
  /** SHA-256 hashes, sorted, each once (never shown to anyone: they go only into the request bodies). */
  hashes: string[]
  /** Rows that hold no usable e-mail address (counted, never sent). */
  skipped: number
  /** One hash of the whole list: what the change stands on (a new opt-out moves it). */
  fingerprint: string
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
  const sorted = [...hashes].sort()
  return { hashes: sorted, skipped, fingerprint: sha256Hex(sorted.join('\n')) }
}

export interface MemberBatch {
  /** The form fields of one request: payload and session, as JSON strings in Nexus's canonical form. */
  params: { payload: string; session: string }
  count: number
}

/**
 * The requests that carry these hashes: ≤ 10,000 each, one session (its id derived from where they go and what they
 * are, so building it again gives the same requests; a positive 52-bit whole number, unique enough within an ad account).
 */
export function memberBatches(hashes: string[], where: string): MemberBatch[] {
  const sessionId = Number.parseInt(sha256Hex(`${where}|${sha256Hex(hashes.join('\n'))}`).slice(0, 13), 16) || 1
  const out: MemberBatch[] = []
  const total = Math.ceil(hashes.length / MEMBERS_PER_REQUEST)
  for (let i = 0; i < total; i++) {
    const data = hashes.slice(i * MEMBERS_PER_REQUEST, (i + 1) * MEMBERS_PER_REQUEST)
    out.push({
      params: {
        payload: JSON.stringify({ schema: 'EMAIL_SHA256', data }),
        session: JSON.stringify({ session_id: sessionId, batch_seq: i + 1, last_batch_flag: i === total - 1, estimated_num_total: hashes.length }),
      },
      count: data.length,
    })
  }
  return out
}

/** What Meta answered for one request of people: its counts only (never its invalid-entry samples: they are hashes). */
export function memberCounts(node: Record<string, unknown> | null): { received: number | null; invalid: number | null } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)
  return { received: n(node?.num_received), invalid: n(node?.num_invalid_entries) }
}
