import { z } from 'zod'
import { defineContract, id, instant, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
// B-SA-053: an order change's note for the floor and its kind, read now (STOP while held, else CHECK), never stored.
import { FLOOR_NOTE_KINDS, floorNoteKindOf } from '@nexus/factory-domain/sales/orders/change-notes'
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
 *   a message        an internal note written in the app on the work order's thread and marked for the floor (B-W2b-F5): the
 *                    office's, ticked "For the floor" by its writer, or another station's comment (B-W2b-47 writes those
 *                    there, marked). An office note with no tick stays in the office. Never a mail
 *   open             the thread is open, the note is at most 14 days old, and it is not the reader's own; whether it was
 *                    read stays on the tablet (nothing here records who read what: Statuto dei Lavoratori art. 4)
 *
 * The floor role reads neither threads nor messages, so the list is read through the tenant's system view after the floor's
 * checks (floor.work at the device's site, work orders of that site only), as the material flag is. What goes back is the
 * work order, where the note comes from, its words and its time: never a name, never a file, and no more than a tablet can
 * show. Words that may be cut say so. There is no money field, and nothing reads the words of a note: that is why a person
 * chooses, note by note, and the composer's tick says no prices (the Owner's rule; record-panels).
 *
 * B-SA-053 (sales page plan P8', R2; 14-change-flow §5.3): `kind` ORDER_CHANGE is an order change's "For your work" note — the
 * system's own floor note (author SYSTEM with no name: a station's comment always carries its station's code, B-W2b-47) written
 * by modules/sales/orders/change-notes.ts; only the NEWEST of each work order is listed (a later step of the same change replaces
 * it on the tablet). `check` is read now, never stored: STOP while the work order is on hold (the hold already refuses its scans),
 * else CHECK (the tablet opens it before the next Start). Whether a tablet showed it, or "Got it" was tapped, stays on the tablet:
 * nothing here records who or which station saw it (R2). A plain note is kind NOTE, check null.
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
  // B-SA-053: a plain note, or an order change's (the newest of its work order), and how it opens (null: a plain note).
  kind: z.enum(['NOTE', 'ORDER_CHANGE']),
  check: z.enum(FLOOR_NOTE_KINDS).nullable(),
})

/** B-SA-053: an order change's floor note (the system's own: no station code). */
const isOrderChange = (row: { readonly authorKind: string; readonly authorName: string | null }): boolean => row.authorKind === 'SYSTEM' && row.authorName === null

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
        forFloor: true,
        at: { gte: new Date(now.getTime() - FLOOR_MESSAGES.days * DAY_MS) },
        bodyText: { not: '' },
        // Not the reader's own comment, nor their station's at a site that names no worker (B-W2b-47: the station's code).
        NOT: [{ authorKind: 'WORKER', authorId: context.actorId }, ...(station ? [{ authorKind: 'SYSTEM' as const, authorName: station }] : [])],
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: FLOOR_MESSAGES.rows,
      select: { id: true, threadId: true, authorKind: true, /* B-SA-053 */ authorName: true, bodyText: true, at: true },
    })
    // B-SA-053: the work orders' state now (STOP / CHECK), and only the newest order-change note of each (rows are newest first).
    const statuses = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(threads.map((thread) => thread.recordId))] } }, select: { id: true, status: true } })).map((row) => [row.id, row.status as string]))
    const changed = new Set<string>()
    const messages = rows.flatMap((row) => {
      const workOrderId = orderOf.get(row.threadId)!
      const orderChange = isOrderChange(row)
      if (orderChange && changed.has(workOrderId)) return []
      if (orderChange) changed.add(workOrderId)
      const from = row.authorKind === 'USER' || orderChange ? ('OFFICE' as const) : ('FLOOR' as const)
      return [{ id: row.id, workOrder: { id: workOrderId, number: numbers.get(workOrderId)! }, from, text: row.bodyText.slice(0, FLOOR_MESSAGES.text), cut: row.bodyText.length > FLOOR_MESSAGES.text, at: toUtcIso(row.at), kind: orderChange ? ('ORDER_CHANGE' as const) : ('NOTE' as const), check: orderChange ? floorNoteKindOf(statuses.get(workOrderId) ?? '') : null }]
    })
    return { ...answer, messages }
  })
}
