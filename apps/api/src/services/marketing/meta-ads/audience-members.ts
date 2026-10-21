/**
 * Meta ads step 31 — the people of a customer list (Owner decision D8: customer lists only from Nexus customers who gave
 * marketing consent, hashed, refreshed by Nexus).
 *
 *   ADDING people (POST /{audience}/users, /usersreplace): NOBODY. Nexus's customer data carries no marketing consent
 *   (checked 2026-10-21 in packages/database/prisma/schema.prisma: Customer and Order hold no consent field; ConsentRecord
 *   is an operator's own consent; nothing imports a buyer's opt-in from Shopify or a marketplace), so every add or replace
 *   is refused in words (NO_CONSENT). Owner decision 2026-10-21: a later step copies Shopify's "accepts e-mail marketing"
 *   status into Nexus; only then do adds and replaces come, with the consent filtered IN THE DATABASE query.
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
 * What a person reads is counts only. A request is ≤ 10,000 hashes and carries no session (review B1: `session` is
 * optional on these DELETEs and Meta's DELETE examples send the payload only; an id repeated for the same people would
 * be a session Meta closed already), so the preview, the re-check and the run build the same requests.
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

/** Why Nexus adds nobody to a customer list (D8). */
export const NO_CONSENT = 'Nexus adds people to a Meta customer list only from customers who gave marketing consent (Owner decision D8), '
  + 'and Nexus\'s customer records hold no marketing consent yet: no consent field exists (a buyer\'s opt-in at Shopify or a marketplace is '
  + 'not brought into Nexus). So Nexus uploads nobody — no add, no replace, no value-based seed. Website, engagement, video, catalog and '
  + 'lookalike audiences need no upload (create-meta-audience); people who opted out are taken out with mode remove or opt_out_everywhere.'

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

/** The requests that carry these hashes: ≤ 10,000 each, each a removal of its own (no session). */
export function memberBatches(hashes: string[]): MemberBatch[] {
  const out: MemberBatch[] = []
  for (let i = 0; i < hashes.length; i += MEMBERS_PER_REQUEST) {
    const data = hashes.slice(i, i + MEMBERS_PER_REQUEST)
    out.push({ params: { payload: JSON.stringify({ schema: 'EMAIL_SHA256', data }) }, count: data.length })
  }
  return out
}

/** What Meta answered for one request of people: its counts only (never its invalid-entry samples: they are hashes). */
export function memberCounts(node: Record<string, unknown> | null): { received: number | null; invalid: number | null } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)
  return { received: n(node?.num_received), invalid: n(node?.num_invalid_entries) }
}
