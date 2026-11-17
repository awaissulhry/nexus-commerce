import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { events as projectEvents } from '@nexus/factory-domain/projects/events'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { recordLabelOf } from '../../threads/labels'
import { mayOnThread, wallScopeOf } from '../../threads/records'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * People added to and taken out of a record by a colleague (threads plan TH-5, B-TH-068; PROJ-G05; PROJ.members-F04, F06):
 *
 *   thread.follower_added    ASSIGNMENT "Marco added you to PRJ-26-012 FW27 airbag line" to the office person added (any record a
 *                            colleague added them to: a project, an order …), while they may read its thread; added twice
 *                            makes no second event, so no second notice
 *   project.person_removed   SYSTEM "Marco took you out of …" to the office colleague the lead removed, once
 *
 * A portal person of the outside company is told in their own portal (platform/portal/notifications/rules/records.ts), never
 * here (the fan-out tells office people only). Never told about what one did oneself.
 */

const payloadOf = <T>(list: readonly { type: string; payload: { parse(raw: unknown): unknown } }[], type: string, raw: unknown): T => list.find((event) => event.type === type)!.payload.parse(raw) as T

async function drafted(context: RuleContext, input: { readonly recordType: string; readonly recordId: string; readonly userId: string; readonly byId: string; readonly category: Draft['category']; readonly messageKey: Draft['messageKey'] }): Promise<Draft[]> {
  if (input.userId === input.byId) return []
  const reader = await context.reader(input.userId)
  if (!reader) return []
  const thread = await context.tx.thread.findFirst({ where: { recordType: input.recordType, recordId: input.recordId }, select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } })
  const project = input.recordType === 'Project' && !thread ? await context.tx.project.findUnique({ where: { id: input.recordId }, select: { companyId: true, partyId: true } }) : null
  const place = thread ?? (project ? { recordType: 'Project', recordId: input.recordId, companyId: project.companyId, siteId: null, partyId: project.partyId } : null)
  if (place && !mayOnThread(reader.actor, THREADS_READ, place.recordType, await wallScopeOf(context.tx, place))) return []
  const label = await recordLabelOf(context.tx, input.recordType, input.recordId)
  if (label === null) return []
  return [
    {
      userId: input.userId,
      category: input.category,
      record: { type: input.recordType, id: input.recordId, label },
      companyId: place?.companyId ?? null,
      anchor: null,
      messageKey: input.messageKey,
      params: { actorId: input.byId },
      actorId: input.byId,
    },
  ]
}

export const PROJECT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'projects.addedYou',
    events: ['thread.follower_added'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = payloadOf<{ recordType: string; recordId: string; userId: string; byId: string }>(threadEvents, 'thread.follower_added', raw)
      return drafted(context, { ...event, category: 'ASSIGNMENT', messageKey: 'notifications.projects.addedYou' })
    },
  },
  {
    name: 'projects.removedYou',
    events: ['project.person_removed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = payloadOf<{ projectId: string; userId: string; outside: boolean; byId: string }>(projectEvents, 'project.person_removed', raw)
      if (event.outside) return []
      return drafted(context, { recordType: 'Project', recordId: event.projectId, userId: event.userId, byId: event.byId, category: 'SYSTEM', messageKey: 'notifications.projects.removedYou' })
    },
  },
])
