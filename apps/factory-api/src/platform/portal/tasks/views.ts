import type { FactoryClient } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalRecordPath } from '@nexus/factory-domain/portal/home/links'
import { KIND_RULES, taskArea, taskWords } from '@nexus/factory-domain/portal/tasks/kinds'
import { dueStateOf, UNDO_WINDOW_MS } from '@nexus/factory-domain/portal/tasks/rules'
import type { CommandTx } from '../../../core/command'
import type { TaskRow } from './store'
import { sourceOf } from './sources'

const NO_NAMES: ReadonlyMap<string, string> = new Map()

/** The display names of the people tasks are handed to (B-W2b-F14), read in the caller's scope (the partner reads its own party's people). */
export async function assigneeNames(client: FactoryClient | CommandTx, rows: readonly Pick<TaskRow, 'assigneeId'>[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.assigneeId ? [row.assigneeId] : [])))]
  if (ids.length === 0) return new Map()
  return new Map((await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((person) => [person.id, person.displayName]))
}

/** A task as the office and the portal read it (B-W2b-167); B-W2b-F14: who of the party has it (null: anyone). */
export function taskView(row: TaskRow, now: Date, names: ReadonlyMap<string, string> = NO_NAMES) {
  const rule = KIND_RULES[row.kind]
  return {
    id: row.id,
    kind: row.kind,
    verb: { it: rule.verb.it, en: rule.verb.en },
    words: { it: taskWords(row.kind, row.recordLabel, 'it'), en: taskWords(row.kind, row.recordLabel, 'en') },
    record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
    companyId: row.companyId,
    dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
    due: row.status === 'OPEN' ? dueStateOf(row.dueAt, now) : ('NONE' as const),
    askedBy: row.askedByName,
    status: row.status,
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    area: rule.area,
    assignee: row.assigneeId ? { id: row.assigneeId, displayName: names.get(row.assigneeId) ?? null } : null,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/**
 * The partner's row: the record's page at the task, whether it can be marked done here, whether Undo is still offered;
 * B-W2b-F14: whether it is handed to this person (`mine`) and whether they may take it or hand it on (an open task, not a
 * preview).
 */
export function partnerTaskView(row: TaskRow, now: Date, facts: { readonly partyCode: string; readonly personId: string; readonly preview: boolean; readonly names?: ReadonlyMap<string, string>; readonly partnerKind?: string | null }) {
  const source = sourceOf(row.sourceKey)
  return {
    ...taskView(row, now, facts.names),
    // B-W2b-F17: the area as the person's partner kind has it (a supplier's approvals on Home), as the badges count it.
    area: taskArea(row.kind, facts.partnerKind),
    mine: row.assigneeId === facts.personId,
    canAssign: !facts.preview && row.status === 'OPEN',
    link: portalRecordPath(facts.partyCode, row.recordType, row.recordId, `task:${row.id}`),
    canMarkDone: !facts.preview && row.status === 'OPEN' && source?.partnerDone === true,
    canUndo: !facts.preview && row.status === 'DONE' && row.doneById === facts.personId && row.closedAt !== null && now.getTime() - row.closedAt.getTime() <= UNDO_WINDOW_MS,
  }
}
