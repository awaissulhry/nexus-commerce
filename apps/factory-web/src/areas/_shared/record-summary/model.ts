import type { Locale } from '../../../lib/i18n/locales'
import { recordAddress } from '../../../lib/records/record-links'
import type { RecordSummary, SummaryLink, SummaryWords } from './api'

/**
 * B-TH-272 (threads plan TH-6, PL5; O-REC-ANY.summary-F01, O-REC-ANY.thread-F01; picture 41) — the generic record page's rules, pure.
 * `/w/<company>/records/<type>/<id>` opens a record whose own page is not built yet (lib/records/record-links.ts): its six inner tabs
 * (thread, tasks, files, approvals, partners, history) became ONE full-page thread (their doors live in the thread's Head ⋯, View ›
 * Changes and the Files view: rule R-ACT) and a summary — the band's row (type and number, the ONE state pill, the parent as a link)
 * and the side column (~1/3 from 1280 px; behind "Details", an "i" on a phone).
 */

/** The catalogue of the generic record page. */
export const SUMMARY_NS = 'record-summary'

/** What the page knows of its record: still reading, read, outside the reader's scope (404), no right (403), or a problem. */
export type SummaryState = 'loading' | 'ready' | 'missing' | 'noRight' | 'error'

/** The right the summary and the thread need (the API's manifest: threads.read over the record). */
export const SUMMARY_RIGHT = 'threads.read'

/** An API error's kind → what the page says. 404 is "You cannot see this record" (never "it belongs to someone else"). */
export function summaryStateOf(error: unknown): Exclude<SummaryState, 'loading' | 'ready'> {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? (error as { kind?: unknown }).kind : null
  if (kind === 'not_found') return 'missing'
  if (kind === 'forbidden') return 'noRight'
  return 'error'
}

/** Words in the page's language (the API answers both). */
export const wordsIn = (words: SummaryWords, locale: Locale): string => (locale === 'en' ? words.en : words.it)

/** The opener's terms of the address (record-links recordAddress writes them): the label shown until the summary is read, the company and site the thread files under. */
export interface Opener {
  readonly label: string | null
  readonly companyId: string | null
  readonly siteId: string | null
}

export function openerOf(search: { get(name: string): string | null } | null | undefined): Opener {
  const value = (name: string) => {
    const raw = search?.get(name)?.trim()
    return raw ? raw : null
  }
  return { label: value('label'), companyId: value('company'), siteId: value('site') }
}

/**
 * The record's name as the band, the thread and the print show it: "<type> <label>" ("Delivery note DDT-2026-0042"); without a
 * label its type alone ("Request for a yes"); before the summary is read the opener's label, else the type code and the id's start
 * (the old panels' title), so the page never shows an empty name.
 */
export function recordName(input: { readonly summary: RecordSummary | null; readonly opener: Opener; readonly type: string; readonly id: string; readonly locale: Locale }): string {
  if (input.summary) {
    const type = wordsIn(input.summary.type, input.locale)
    return input.summary.label ? `${type} ${input.summary.label}` : type
  }
  return input.opener.label ?? `${input.type} ${input.id.slice(0, 8)}`
}

/** The record's number as the thread's box and Copy link name it: its label, else the opener's, else its name. */
export function recordLabelOf(summary: RecordSummary | null, opener: Opener, name: string): string {
  return summary?.label ?? opener.label ?? name
}

/** A parent in words ("Sales order SO-2026-0101"; without a label its type alone). */
export function linkWords(parent: SummaryLink, locale: Locale): string {
  const type = wordsIn(parent.type, locale)
  return parent.label ? `${type} ${parent.label}` : type
}

/**
 * Where the parent opens: the office's own page of its type once built, else its generic page with its label (X-G01: the API names a
 * parent only when the reader may open it too; null → no link, never a guessed one). Company-prefixed, a real link (⌘-click works).
 */
export function parentHrefOf(summary: RecordSummary | null, prefix: string, built: ReadonlySet<string>): string | null {
  const parent = summary?.parent
  if (!parent) return null
  return `${prefix}${recordAddress({ type: parent.recordType, id: parent.recordId, ...(parent.label ? { label: parent.label } : {}) }, built)}`
}

/** The tone of the ONE state pill: done states green, held or waiting amber, failed or refused red, moving blue, the rest neutral. */
export type StateTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const SUCCESS = new Set(['ACCEPTED', 'ACTIVE', 'APPLIED', 'APPROVED', 'APPROVED_WITH_CHANGES', 'APPROVED_WITH_COMMENTS', 'AUTHORISED', 'COMPLETE', 'COMPLETED', 'CONFIRMED', 'DELIVERED', 'DONE', 'PAID', 'RELEASED', 'REPAIRED', 'RESOLVED', 'SIGNED_OFF', 'VALID'])
const WARNING = new Set(['BLOCKED', 'DISPUTED', 'EXPIRED', 'NEED_INFO', 'ON_HOLD', 'PAUSED', 'PENDING_APPROVAL', 'QUARANTINE', 'STALE', 'SUSPENDED', 'UNDER_MAINTENANCE', 'WAITING_CUSTOMER', 'WAITING_PART', 'WAITING_PARTS'])
const DANGER = new Set(['DO_NOT_USE', 'DOWN', 'ERROR', 'FAILED', 'NOT_DELIVERABLE', 'REFUSED', 'REJECTED'])
const INFO = new Set(['AT_WORKSHOP', 'IN_MAKING', 'IN_PRODUCTION', 'IN_PROGRESS', 'IN_REPAIR', 'IN_REVIEW', 'INVESTIGATING', 'RUNNING', 'SENT', 'SHIPPED', 'SUBMITTED', 'UNDER_REVIEW'])

export function stateTone(code: string): StateTone {
  if (SUCCESS.has(code)) return 'success'
  if (WARNING.has(code)) return 'warning'
  if (DANGER.has(code)) return 'danger'
  if (INFO.has(code)) return 'info'
  return 'neutral'
}

/**
 * Whom the record's party is to us, for the thread's words ("Waiting on customer", "Reply to …"): a customer or brand, a supplier or
 * workshop, else (both sides, a carrier, a consultant) a partner.
 */
export function partyRoleOf(roles: readonly string[]): 'customer' | 'supplier' | 'partner' {
  const customer = roles.includes('CUSTOMER') || roles.includes('BRAND')
  const supplier = roles.includes('SUPPLIER') || roles.includes('SUBCONTRACTOR')
  if (customer && !supplier) return 'customer'
  if (supplier && !customer) return 'supplier'
  return 'partner'
}

/** A live change that names this record (in any of its fields): the page reads its summary again. */
export function namesRecord(fields: Readonly<Record<string, unknown>>, recordId: string): boolean {
  return Object.values(fields).some((value) => value === recordId)
}
