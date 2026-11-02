import { z } from 'zod'
import { defineContract, id, instant, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { systemView } from '../scans/access'
import { floorOf } from './access'
import { stationDispatch } from './dispatch'
import { cardsOfPerson } from './mine'
import { siteRowOf, type Reader } from './store'
import { dispatchWorld } from './world'

/**
 * Open messages on my work orders (B-W2b-71; COL-036 "My next task on the floor"; design floor.mywork "For your work", "Open
 * messages on my work orders"): GET /production/dispatch/mine/messages, floor.work.
 *
 *   my work orders   what the tablet's station queue holds and what the day's assignments name the signed-in person for,
 *                    the two lists of My work, at the tablet's own site
 *   a message        an internal note written in the app on the work order's thread: the office's, or another station's
 *                    from the floor's comment (B-W2b-47 writes those on the same thread). Never a mail
 *   open             the thread is open, the note is at most 14 days old, and it is not the reader's own; whether it was
 *                    read stays on the tablet (nothing here records who read what: Statuto dei Lavoratori art. 4)
 *
 * The floor role reads neither threads nor messages, so the list is read through the tenant's system view after the floor's
 * checks (floor.work at the device's site, work orders of that site only), as the material flag is. What goes back is the
 * work order, where the note comes from, its words and its time: never a name, never a file, and no more than a tablet can
 * show. Words that may be cut say so. There is no money field; what a person typed in a note is theirs, which is why the
 * office's composer says a work order's notes reach the tablets (record-panels, B-W2b-71).
 */

export const FLOOR_MESSAGES = Object.freeze({
  /** A note older than this is no longer open on a tablet. */
  days: 14,
  /** The newest notes a tablet lists. */
  rows: 30,
  /** The longest text a tablet shows; the rest stays in the office. */
  text: 1000,
})

const DAY_MS = 24 * 60 * 60 * 1000

const messageView = output({
  id: id(),
  workOrder: output({ id: id(), number: z.string() }),
  /** Where it comes from: the office, or the floor (another station). Never who. */
  from: z.enum(['OFFICE', 'FLOOR']),
  text: z.string(),
  /** The text was cut: the rest is in the office. */
  cut: z.boolean(),
  at: instant(),
})

export const myMessagesContract = defineContract({
  response: { 200: output({ asOf: instant(), messages: z.array(messageView) }) },
})

/** GET /production/dispatch/mine/messages. */
export async function myWorkMessages(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const queue = await stationDispatch(caller, { material: false })
  const person = await caller.withClient(async (db: Reader) => {
    const site = await siteRowOf(db, context.siteId)
    if (!site) throw new NotFoundError('Site not found.')
    const world = await dispatchWorld(db, site, businessDate(now, site.timezone), now)
    return world.subject === 'WORKER' ? cardsOfPerson(world, context.actorId).cards.map((card) => ({ id: card.workOrder.id, number: card.workOrder.number })) : []
  })
  const numbers = new Map([...queue.entries.map((entry) => [entry.workOrder.id, entry.workOrder.number] as const), ...person.map((order) => [order.id, order.number] as const)])
  const answer = { asOf: toUtcIso(now), messages: [] as z.infer<typeof messageView>[] }
  if (numbers.size === 0) return answer
  const station = queue.target?.code ?? null
  return systemView(caller).withClient(async (db: Reader) => {
    const threads = await db.thread.findMany({ where: { recordType: 'WorkOrder', recordId: { in: [...numbers.keys()] }, siteId: context.siteId, status: 'OPEN' }, select: { id: true, recordId: true } })
    if (threads.length === 0) return answer
    const orderOf = new Map(threads.map((thread) => [thread.id, thread.recordId]))
    const rows = await db.message.findMany({
      where: {
        threadId: { in: threads.map((thread) => thread.id) },
        direction: 'INTERNAL_NOTE',
        channel: 'APP',
        at: { gte: new Date(now.getTime() - FLOOR_MESSAGES.days * DAY_MS) },
        bodyText: { not: '' },
        // Not the reader's own comment, nor their station's at a site that names no worker (B-W2b-47: the station's code).
        NOT: [{ authorKind: 'WORKER', authorId: context.actorId }, ...(station ? [{ authorKind: 'SYSTEM' as const, authorName: station }] : [])],
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: FLOOR_MESSAGES.rows,
      select: { id: true, threadId: true, authorKind: true, bodyText: true, at: true },
    })
    const messages = rows.map((row) => {
      const workOrderId = orderOf.get(row.threadId)!
      return { id: row.id, workOrder: { id: workOrderId, number: numbers.get(workOrderId)! }, from: row.authorKind === 'USER' ? ('OFFICE' as const) : ('FLOOR' as const), text: row.bodyText.slice(0, FLOOR_MESSAGES.text), cut: row.bodyText.length > FLOOR_MESSAGES.text, at: toUtcIso(row.at) }
    })
    return { ...answer, messages }
  })
}
