import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { personalPhrase } from '@nexus/factory-domain/insights/personal'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * REMINDER (B-W2b-388; COL-041; design home.today needs-me "reminders that came back (W2b)"): my reminders that came back — their
 * moment came, or their record changed — and that I have not finished (platform/tasks/reminders). The person's own rows, read
 * only when Today is asked for them (`include=TASKS`). MEDIUM, newest back first; the sentence names the record (and that it is
 * about a message) with the person's note; Done and Put off go through the reminder (its id is the row's sub key), the record
 * opens at the message. The condition holds the moment it came back, so a reminder put off and back again is a new row.
 */
export const reminders: Source = async ({ caller, viewer }) => {
  const rows = await caller.withClient((db) =>
    db.reminder.findMany({
      where: { userId: viewer.personId, doneAt: null, cameBackAt: { not: null } },
      orderBy: [{ cameBackAt: 'desc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, companyId: true, recordType: true, recordId: true, recordLabel: true, messageId: true, kind: true, note: true, cameBackAt: true },
    }),
  )
  const { rows: shown, complete } = capped(rows, SOURCE_LIMIT)
  const candidates: AttentionCandidate[] = shown.map((row) => {
    const about = row.messageId ? 'REMINDER.MESSAGE' : 'REMINDER.BACK'
    return {
      kind: 'REMINDER',
      state: row.kind === 'AT_TIME' ? 'AT_TIME' : 'ON_CHANGE',
      severity: 'MEDIUM',
      record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
      subKey: row.id,
      scope: { companyId: row.companyId, siteId: null, partyId: null },
      sentence: row.note ? personalPhrase(`${about}_NOTE`, { record: row.recordLabel, note: row.note }) : personalPhrase(about, { record: row.recordLabel }),
      blocks: null,
      due: null,
      since: row.cameBackAt!,
      why: () => personalPhrase(row.kind === 'AT_TIME' ? 'why.REMINDER.AT_TIME' : 'why.REMINDER.ON_CHANGE'),
      condition: [row.cameBackAt!.toISOString()],
    }
  })
  return { kind: 'REMINDER', candidates, complete }
}
