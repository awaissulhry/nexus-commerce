import { z } from 'zod'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { defineContract, id, instant, output } from '@nexus/factory-domain/core/contracts'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { paramsFor, peopleOf, sentenceOf } from '@nexus/factory-domain/notifications/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { NOTIFICATION_COLUMNS, type NotificationRow } from '../../../platform/notifications/store'
import { officeOf } from '../../../platform/tasks/tasks'

/**
 * GET /home/following (B-W2b-388; COL-035; design home.today `following` "Changed since you looked — records I follow that
 * changed, in one line each", PLT-151): the news of what I follow that I have not marked seen — my FOLLOWING notifications
 * still open (not done, not snoozed now; B-W2b-385's fan-out writes them for a followed record's status move or answer, and for
 * a followed saved view whose rows changed), ONE line per record or view: its newest news, how many came, their ids (Mark seen =
 * POST /notifications/done with them), who and when. The words are the notification's own (message key and params cut to the
 * grains I hold NOW, PLT-152; English in `sentence`). A saved view is a record of type `SavedView` (Unfollow: DELETE
 * /notifications/following/views/:id); any other record is unfollowed on its followers (PUT /threads/…/followers/me). Read only.
 */

/** GET /home/following's answer: one line per followed record or view with news I have not marked seen. */
export const followingContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      items: z.array(
        output({
          key: z.string(),
          record: output({ type: z.string(), id: id(), label: z.string() }),
          companyId: id().nullable(),
          anchor: z.string().nullable(),
          view: z.boolean(),
          /** A followed view's list (its page opens it with `?savedView=`); null for a record, or a view deleted meanwhile. */
          listKey: z.string().nullable(),
          messageKey: z.string(),
          params: grainedJson(),
          sentence: z.string(),
          actor: output({ id: id(), name: z.string() }).nullable(),
          people: z.record(z.string(), z.string()),
          at: instant(),
          count: z.number().int(),
          ids: z.array(id()),
        }),
      ),
      complete: z.boolean(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

/** The most records one answer lists, and the most news rows read for them. */
export const FOLLOWING_LIMITS = Object.freeze({ records: 50, rows: 500 })

export async function following(caller: CommandCaller) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const rows = await caller.withClient((db) =>
    db.notification.findMany({
      where: { userId: context.actorId, category: 'FOLLOWING', doneAt: null, OR: [{ snoozedAt: null }, { snoozedUntil: { lte: now } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FOLLOWING_LIMITS.rows + 1,
      select: NOTIFICATION_COLUMNS,
    }),
  )
  const groups = new Map<string, NotificationRow[]>()
  let left = rows.length > FOLLOWING_LIMITS.rows
  for (const row of rows.slice(0, FOLLOWING_LIMITS.rows)) {
    const key = `${row.recordType}:${row.recordId}`
    const group = groups.get(key)
    if (group) group.push(row)
    else if (groups.size < FOLLOWING_LIMITS.records) groups.set(key, [row])
    else left = true
  }
  const newest = [...groups.values()].map((group) => group[0]!)
  const ids = [...new Set(newest.flatMap((row) => peopleOf(row)))]
  const names = ids.length === 0 ? new Map<string, string>() : await caller.withClient(async (db) => new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName])))
  const held = heldGrains(actorOf(context))
  const viewIds = newest.filter((row) => row.recordType === 'SavedView').map((row) => row.recordId)
  const lists = viewIds.length === 0 ? new Map<string, string>() : await caller.withClient(async (db) => new Map((await db.savedView.findMany({ where: { id: { in: viewIds } }, select: { id: true, listKey: true } })).map((view) => [view.id, view.listKey])))
  return {
    asOf: toUtcIso(now),
    items: [...groups.values()].map((group) => {
      const row = group[0]!
      const params = paramsFor(row.params, held)
      return {
        key: `${row.recordType}:${row.recordId}`,
        record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
        companyId: row.companyId,
        anchor: row.anchor,
        /** A followed saved view (Unfollow stops following the view), else a followed record. */
        view: row.recordType === 'SavedView',
        listKey: row.recordType === 'SavedView' ? (lists.get(row.recordId) ?? null) : null,
        messageKey: row.messageKey,
        params,
        sentence: sentenceOf({ ...row, params }, names, 'en'),
        actor: row.actorId ? { id: row.actorId, name: names.get(row.actorId) ?? '' } : null,
        people: Object.fromEntries(peopleOf(row).map((id) => [id, names.get(id) ?? ''])),
        at: toUtcIso(row.createdAt),
        count: group.length,
        ids: group.map((entry) => entry.id),
      }
    }),
    /** False: more news waits than one answer lists (the oldest records are left out). */
    complete: !left,
    live: { events: ['notification.created'] },
  }
}
