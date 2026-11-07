import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalRecordPath } from '@nexus/factory-domain/portal/home/links'
import { KIND_RULES, taskWords } from '@nexus/factory-domain/portal/tasks/kinds'
import { dueStateOf, UNDO_WINDOW_MS } from '@nexus/factory-domain/portal/tasks/rules'
import type { TaskRow } from './store'
import { sourceOf } from './sources'

/** A task as the office and the portal read it (B-W2b-167). */
export function taskView(row: TaskRow, now: Date) {
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
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The partner's row: the record's page at the task, whether it can be marked done here, whether Undo is still offered. */
export function partnerTaskView(row: TaskRow, now: Date, facts: { readonly partyCode: string; readonly personId: string; readonly preview: boolean }) {
  const source = sourceOf(row.sourceKey)
  return {
    ...taskView(row, now),
    link: portalRecordPath(facts.partyCode, row.recordType, row.recordId, `task:${row.id}`),
    canMarkDone: !facts.preview && row.status === 'OPEN' && source?.partnerDone === true,
    canUndo: !facts.preview && row.status === 'DONE' && row.doneById === facts.personId && row.closedAt !== null && now.getTime() - row.closedAt.getTime() <= UNDO_WINDOW_MS,
  }
}
