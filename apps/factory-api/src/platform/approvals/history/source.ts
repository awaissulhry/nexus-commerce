import type { ApprovalEventAction, ApprovalMeaning } from '@nexus/factory-domain/approvals/rules'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { Reader } from '../store'

/**
 * The approval history of a record (B-W2b-282; PLT-104; design home.approvals review "History", the record panels'
 * Approvals): the engine's lines (ApprovalEvent: its requests' lines, and the lines a domain step writes there) and the
 * domain approvals that keep their own tables (a quote's approvals, a change order's approvers, an operation's SMV
 * versions, an NCR's dispositions that need a yes, a scan's scrap above the limit, a timesheet, an inspection plan's and a
 * work instruction's versions), read through ONE registry (./registry.ts), newest first. A source reads its record's place
 * and says whether the reader may see it (the record's own view permission there); an unknown record type is a 404.
 */

export interface Place {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId?: string | null
}

export interface HistoryLine {
  readonly id: string
  /** The table it comes from ("ApprovalEvent", "QuoteApproval" …). */
  readonly source: string
  readonly action: ApprovalEventAction
  readonly at: Date
  readonly byId: string | null
  readonly byWorkerId: string | null
  readonly words: string | null
  readonly reasonCode: string | null
  readonly meaning: ApprovalMeaning | null
  readonly taskId: string | null
}

export interface HistorySource {
  readonly recordType: string
  place(db: Reader, recordId: string): Promise<Place | null>
  /** The record's own view permission over its place. */
  may(actor: Actor, place: Place): boolean
  /** The domain approvals of the record (none: only the engine's lines). */
  lines?(db: Reader, recordId: string): Promise<HistoryLine[]>
}

/** At most this many lines per source and record (a record's history is short; the page is cut after the merge). */
export const SOURCE_LIMIT = 500

export const line = (input: Omit<HistoryLine, 'byWorkerId' | 'reasonCode' | 'meaning' | 'taskId'> & Partial<Pick<HistoryLine, 'byWorkerId' | 'reasonCode' | 'meaning' | 'taskId'>>): HistoryLine => ({
  byWorkerId: null,
  reasonCode: null,
  meaning: null,
  taskId: null,
  ...input,
})

/** "v2: the note" — a version's words with its number. */
export const versionWords = (number: number, words: string | null | undefined): string => (words && words.trim() ? `v${number}: ${words.trim()}` : `v${number}`)
