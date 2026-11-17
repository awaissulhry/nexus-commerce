import type { Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { movesFrom, OFFICE_OPEN_WORDS, OUTCOME_WORDS, STATUS_WORDS, targetStateOf, targetWords, type ProjectOutcome, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { dayOf, mayManage, mayPost, namesOf, type ProjectRow, type Reader } from './store'

/**
 * A project as the office reads it (B-TH-066; PROJ.record-F01, F02, F04): number, name, status in one word, the outside company
 * (none: office only), the lead, the target date with its state in words (never colour alone), the season, the goal, the
 * outcome once closed, who made and closed it, its thread's last message, and what the reader may do now. No money anywhere.
 */

export interface ProjectView {
  readonly id: string
  readonly number: string
  readonly name: string
  readonly goal: string | null
  readonly companyId: string
  readonly company: { readonly id: string; readonly code: string }
  readonly party: { readonly id: string; readonly code: string; readonly name: string; readonly roles: string[] } | null
  readonly lead: { readonly id: string; readonly name: string }
  readonly seasonCode: string | null
  readonly targetDate: string
  readonly target: { readonly state: string; readonly days: number; readonly words: { readonly it: string; readonly en: string } | null }
  readonly status: ProjectStatus
  readonly statusWords: { readonly it: string; readonly en: string }
  readonly outcome: ProjectOutcome | null
  readonly outcomeWords: { readonly it: string; readonly en: string } | null
  readonly outcomeNote: string | null
  readonly closedAt: string | null
  readonly closedBy: { readonly id: string; readonly name: string } | null
  readonly createdAt: string
  readonly createdBy: { readonly id: string; readonly name: string } | null
  readonly lastMessageAt: string | null
  readonly threadStatus: string | null
  readonly version: number
  readonly officeOnly: boolean
  /** Said plainly while every office reader of threads may open a project (B-TH-099 later). */
  readonly openToOfficeWords: { readonly it: string; readonly en: string }
  readonly may: { readonly manage: boolean; readonly post: boolean; readonly moves: string[] }
}

const named = (names: ReadonlyMap<string, string>, id: string | null): { id: string; name: string } | null => (id ? { id, name: names.get(id) ?? '' } : null)

/** The views of these rows, in their order, for this reader (one read per kind of name). */
export async function projectViewsOf(db: Reader, actor: Actor, rows: readonly ProjectRow[], today: string): Promise<ProjectView[]> {
  if (rows.length === 0) return []
  const names = await namesOf(
    db,
    rows.flatMap((row) => [row.leadId, row.closedById, row.createdById]),
  )
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const partyIds = [...new Set(rows.flatMap((row) => (row.partyId ? [row.partyId] : [])))]
  const parties = new Map(
    (partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true } })).map((row) => [
      row.id,
      { id: row.id, code: row.code, name: row.tradeName ?? row.legalName, roles: row.roles as string[] },
    ]),
  )
  const threads = new Map(
    (await db.thread.findMany({ where: { recordType: 'Project', recordId: { in: rows.map((row) => row.id) } }, select: { recordId: true, status: true, lastMessageAt: true } })).map((row) => [row.recordId, row]),
  )
  return rows.map((row) => {
    const status = row.status as ProjectStatus
    const targetDate = dayOf(row.targetDate)
    const target = targetStateOf(status, targetDate, today)
    const thread = threads.get(row.id)
    const manage = mayManage(actor, row)
    return {
      id: row.id,
      number: row.number,
      name: row.name,
      goal: row.goal,
      companyId: row.companyId,
      company: { id: row.companyId, code: companies.get(row.companyId) ?? '' },
      party: row.partyId ? (parties.get(row.partyId) ?? { id: row.partyId, code: '', name: '', roles: [] }) : null,
      lead: named(names, row.leadId)!,
      seasonCode: row.seasonCode,
      targetDate,
      target: { state: target.state, days: target.days, words: targetWords(target.state, target.days) },
      status,
      statusWords: STATUS_WORDS[status],
      outcome: (row.outcome as ProjectOutcome | null) ?? null,
      outcomeWords: row.outcome ? OUTCOME_WORDS[row.outcome as ProjectOutcome] : null,
      outcomeNote: row.outcomeNote,
      closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
      closedBy: named(names, row.closedById),
      createdAt: toUtcIso(row.createdAt),
      createdBy: named(names, row.createdById),
      lastMessageAt: thread?.lastMessageAt ? toUtcIso(thread.lastMessageAt) : null,
      threadStatus: thread?.status ?? null,
      version: row.version,
      officeOnly: row.partyId === null,
      openToOfficeWords: OFFICE_OPEN_WORDS,
      may: { manage, post: mayPost(actor, row), moves: manage ? movesFrom(status) : [] },
    }
  })
}
