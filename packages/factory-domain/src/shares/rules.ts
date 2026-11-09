import type { Issue } from '../core/errors'
import { PURPOSE_RULES } from '../links/purposes'

/**
 * Inviting a partner to one record (B-W2b-200; COL-061 "invite a partner contact to one record", COL-062 "external
 * permissions: view, comment, upload"; design links.invite, SCR-270; shell.panels "the record's followers and external
 * participants"). Pure: apps/factory-api's platform/shares applies these rules; the database holds the rest underneath
 * (links-depth.prisma RecordShare and its guard, the partner role's wall).
 *
 *   - A share is ONE contact of the record's own partner (its customer, supplier, workshop or brand: the party the record's
 *     thread reaches, platform/threads/records.ts) on ONE record, with what they may do — VIEW always, COMMENT and UPLOAD when
 *     given — until a day the inviter picks (at most 180 days), carried by a RECORD_INVITE link that expires with it. No
 *     portal account: the link is the key ("an agent, a brand's designer, a lab").
 *   - The invited person reads the record's PARTNER summary (each record type names the fields it shares, below: never a
 *     price, a cost, a margin, pay or an office person), the files of the record shared with its party's links, and the
 *     record's PARTNER thread; writes in it with COMMENT; adds a file with UPLOAD; switches "E-mail me" (new messages by
 *     e-mail) on or off.
 *   - The office narrows or widens what they may do while the share lives (every use checks the share as it is now), and
 *     revokes it: the share and its link stop together. A new end date is a new invitation (a link's terms never change).
 */

/** What an invited partner may do (the database's RecordSharePermission). VIEW is always part of a share. */
export const SHARE_PERMISSIONS = ['VIEW', 'COMMENT', 'UPLOAD'] as const
export type SharePermission = (typeof SHARE_PERMISSIONS)[number]

/** The records a partner can be invited to: the ones a RECORD_INVITE link opens (factory-domain links/purposes). */
export const SHARE_RECORD_TYPES: readonly string[] = PURPOSE_RULES.RECORD_INVITE.recordTypes

/** Days until a share ends: the default, and the most the office may give (the link's own rule). */
export const SHARE_DAYS = PURPOSE_RULES.RECORD_INVITE.expiryDays

/** The languages of the invitation and the mails. */
export const SHARE_LOCALES = ['it', 'en'] as const
export type ShareLocale = (typeof SHARE_LOCALES)[number]
export const shareLocaleOf = (value: string | null | undefined): ShareLocale => (value?.toLowerCase().startsWith('en') ? 'en' : 'it')

/** A share's state now: LIVE until it ends or is revoked. */
export const SHARE_STATES = ['LIVE', 'EXPIRED', 'REVOKED'] as const
export type ShareState = (typeof SHARE_STATES)[number]

const DAY_MS = 86_400_000
/** A share ends at least an hour after it is made. */
const MIN_SPAN_MS = 60 * 60_000
/** The words the inviter adds to the invitation. */
export const SHARE_NOTE_MAX = 1000

/** VIEW first, then COMMENT and UPLOAD when asked, each once, in this order (the database refuses anything else). */
export function sharePermissionsOf(asked: readonly string[] | null | undefined): SharePermission[] {
  const wanted = new Set(asked ?? [])
  return SHARE_PERMISSIONS.filter((permission) => permission === 'VIEW' || wanted.has(permission))
}

export function shareStateOf(share: { readonly revokedAt: Date | null; readonly expiresAt: Date }, now: Date): ShareState {
  if (share.revokedAt !== null) return 'REVOKED'
  return share.expiresAt.getTime() > now.getTime() ? 'LIVE' : 'EXPIRED'
}

/** The default end of a new share: 30 days from now. */
export const defaultShareEnd = (now: Date): Date => new Date(now.getTime() + SHARE_DAYS.default * DAY_MS)

/** The latest end the office may give a share made now (180 days). */
export const latestShareEnd = (now: Date): Date => new Date(now.getTime() + SHARE_DAYS.max * DAY_MS)

/** What is wrong with a share's end: at least an hour from now, at most 180 days. */
export function shareEndProblems(expiresAt: Date, now: Date): Issue[] {
  if (Number.isNaN(expiresAt.getTime())) return [{ path: 'body/expiresAt', message: 'Until when: an instant.' }]
  if (expiresAt.getTime() < now.getTime() + MIN_SPAN_MS) return [{ path: 'body/expiresAt', message: 'The share ends at least an hour from now.' }]
  if (expiresAt.getTime() > latestShareEnd(now).getTime()) return [{ path: 'body/expiresAt', message: `A share lasts at most ${SHARE_DAYS.max} days.` }]
  return []
}

/** What is wrong with the inviter's note (optional, at most 1000 characters). */
export function shareNoteProblems(note: string | null | undefined): Issue[] {
  const text = note?.trim() ?? ''
  return text.length > SHARE_NOTE_MAX ? [{ path: 'body/note', message: `At most ${SHARE_NOTE_MAX} characters.` }] : []
}

/**
 * Why the invited person may not post or upload now (null: they may). The share is read as it is NOW on every use: a share
 * narrowed by the office stops the next post, a revoked or ended one opens nothing at all (the link's 404).
 */
export const SHARE_HELD_REASONS = ['NO_COMMENT', 'NO_UPLOAD', 'CLOSED', 'OTHER_PARTY'] as const
export type ShareHeldReason = (typeof SHARE_HELD_REASONS)[number]

export interface ShareFacts {
  readonly permissions: readonly string[]
  /** The record's thread status, or null when it has none yet (the first post makes it). */
  readonly threadStatus: 'OPEN' | 'CLOSED' | null
  /** The share's party is the record's own (its thread reaches it). */
  readonly sameParty: boolean
}

export function postHeld(facts: ShareFacts): ShareHeldReason | null {
  if (!facts.permissions.includes('COMMENT')) return 'NO_COMMENT'
  if (!facts.sameParty) return 'OTHER_PARTY'
  if (facts.threadStatus === 'CLOSED') return 'CLOSED'
  return null
}

export function uploadHeld(facts: Pick<ShareFacts, 'permissions'>): ShareHeldReason | null {
  return facts.permissions.includes('UPLOAD') ? null : 'NO_UPLOAD'
}

/** The name an invited person's post carries: the contact's name on file, else the address the invitation went to. */
export function authorNameOf(share: { readonly contactName?: string | null | undefined; readonly email: string }): string {
  const name = share.contactName?.trim()
  return (name && name.length > 0 ? name : share.email).slice(0, 200)
}

/**
 * The fields each record type shares with an invited partner (plan: "each record type registers the fields it shares;
 * never cost, margin or pay"). The API reads exactly these, in this order, in the tenant's system scope after the share was
 * checked, and answers each as a value with its kind: `text` (a number, a code, a name, as typed), `code` (a status or a kind:
 * the screens say it in their words), `date` (a day, YYYY-MM-DD), `instant` (an ISO time), `count` (a whole number). A key
 * that names money or pay is refused by the test: nothing of the sort is ever registered.
 */
export const SHARE_FIELD_KINDS = ['text', 'code', 'date', 'instant', 'count'] as const
export type ShareFieldKind = (typeof SHARE_FIELD_KINDS)[number]

export const SHARE_FIELDS: Readonly<Record<string, ReadonlyArray<readonly [key: string, kind: ShareFieldKind]>>> = Object.freeze({
  Style: [['code', 'text'], ['name', 'text'], ['season', 'text'], ['productType', 'code'], ['status', 'code']],
  Quote: [['number', 'text'], ['theirRef', 'text'], ['status', 'code'], ['revision', 'count']],
  SalesOrder: [['number', 'text'], ['theirRef', 'text'], ['status', 'code'], ['orderDate', 'date'], ['requestedDate', 'date'], ['promiseDate', 'date']],
  PurchaseOrder: [['number', 'text'], ['theirRef', 'text'], ['status', 'code'], ['revision', 'count'], ['orderDate', 'date'], ['requestedDate', 'date']],
  SubcontractOrder: [['number', 'text'], ['status', 'code'], ['orderDate', 'date'], ['expectedBackDate', 'date']],
  Shipment: [['number', 'text'], ['status', 'code'], ['carrier', 'text'], ['shippedAt', 'instant'], ['expectedDeliveryAt', 'instant'], ['deliveredAt', 'instant']],
  Complaint: [['number', 'text'], ['theirRef', 'text'], ['status', 'code'], ['category', 'code'], ['receivedAt', 'instant'], ['answerDueOn', 'date']],
  ReturnAuthorisation: [['number', 'text'], ['theirRef', 'text'], ['status', 'code'], ['requestedAt', 'instant'], ['goodsDueBy', 'date']],
  SupplierClaim: [['number', 'text'], ['kind', 'code'], ['status', 'code'], ['remedy', 'code'], ['sentAt', 'instant']],
})

/** Words that never name a shared field (money, cost, margin, pay, an office person or note). */
export const NEVER_SHARED = /price|cost|margin|amount|vat|pay|wage|salary|freight|internal|note|owner|createdBy|ById|ByName/i

/** The field keys of a record type (empty when it is not shareable). */
export const shareFieldKeys = (recordType: string): string[] => (SHARE_FIELDS[recordType] ?? []).map(([key]) => key)
