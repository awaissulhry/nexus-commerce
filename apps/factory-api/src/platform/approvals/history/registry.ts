import type { ApprovalEventAction, ApprovalMeaning } from '@nexus/factory-domain/approvals/rules'
import { can } from '@nexus/factory-domain/core/permissions'
import { registeredKinds } from '../kinds'
import type { Reader } from '../store'
import { DOMAIN_SOURCES } from './domain'
import { line, SOURCE_LIMIT, type HistoryLine, type HistorySource } from './source'

/**
 * ONE read registry for a record's approval history (B-W2b-282; PLT-104): the domain approvals' sources (./domain.ts) and
 * one source per registered approval kind's subject (its place from the kind, its view permission), each with the engine's
 * own lines (ApprovalEvent) merged in, newest first (time, then id). A step that keeps a new approval table adds its source
 * to ./domain.ts; a new kind is here by itself.
 */

function kindSources(): HistorySource[] {
  return registeredKinds().map((kind) => ({
    recordType: kind.recordType,
    async place(db: Reader, recordId: string) {
      const subject = await kind.read(db, recordId)
      return subject ? { companyId: subject.companyId, siteId: subject.siteId } : null
    },
    may: (actor, place) => can(actor, kind.view, { companyId: place.companyId, siteId: place.siteId }),
  }))
}

/** The source of a record type (a domain approval's first, then a kind's subject), or undefined: the type has no history. */
export function historySourceOf(recordType: string): HistorySource | undefined {
  return DOMAIN_SOURCES.find((source) => source.recordType === recordType) ?? kindSources().find((source) => source.recordType === recordType)
}

/** The engine's lines of a record (its requests' and a domain step's own). */
export async function engineLines(db: Reader, recordType: string, recordId: string): Promise<HistoryLine[]> {
  const rows = await db.approvalEvent.findMany({
    where: { recordType, recordId },
    orderBy: [{ at: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: SOURCE_LIMIT,
    select: { id: true, taskId: true, action: true, byId: true, byWorkerId: true, at: true, words: true, reasonCode: true, meaning: true },
  })
  return rows.map((row) =>
    line({ id: row.id, source: 'ApprovalEvent', action: row.action as ApprovalEventAction, at: row.at, byId: row.byId, byWorkerId: row.byWorkerId, words: row.words, reasonCode: row.reasonCode, meaning: row.meaning as ApprovalMeaning | null, taskId: row.taskId }),
  )
}

/** Newest first: by time, then id (descending), so two lines of one instant keep one order. */
export const newestFirst = (a: HistoryLine, b: HistoryLine): number => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Every line of a record's history, newest first. */
export async function historyOf(db: Reader, source: HistorySource, recordId: string): Promise<HistoryLine[]> {
  const [own, engine] = await Promise.all([source.lines ? source.lines(db, recordId) : Promise.resolve([]), engineLines(db, source.recordType, recordId)])
  return [...own, ...engine].sort(newestFirst)
}
