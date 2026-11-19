import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { MessageKey } from '@nexus/factory-domain/notifications/rules'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { followersOf } from '../../threads/followers'
import { recordLabelOf } from '../../threads/labels'
// B-W2b-371: a record type's thread gate (a rider's profile: sales.measurements.view).
import { mayOnThread } from '../../threads/records'
import { wallScopeOf } from '../../threads/records' // B-PR-08a part 2: a work order's, hold's or NCR's thread is told through its customer
import type { Draft, FanOutRule, RuleContext } from '../fan-out'
// ---- B-SA-051: a change note's face and batch.
import { changeWhatOf, orderChangeBatch } from '@nexus/factory-domain/notifications/rules'
import { EVERY_PARTY_MARKER } from '../../../modules/quality/wall'
import { wallPartyOf, type WallScope } from '../../threads/records'
// ---- end B-SA-051
// ---- B-CP-079: a customer's ask of its factory designer tells who asks and on which record, never the note's words.
import { isDesignerAskNote } from '@nexus/factory-domain/threads/designer/rules'
// ---- end B-CP-079

/**
 * Notes and mail on a record (COL-006 mentions, COL-011 followers):
 *   thread.user_mentioned   MENTION to the person mentioned, while they may still read the thread
 *   thread.message_posted   FOLLOWING to the record's followers who did not mute it, may read it, and are neither its
 *                           author nor mentioned in it (they have their mention): a note, a mail sent, a reply in
 *
 * B-SA-051 (Sales page plan R9 "ONE bell mechanism per change", P8; 13-backend B7; review C-7): a CHANGE NOTE (a SYSTEM internal
 * note whose event names `causedById`: the system line of a change of a sales order on its thread, B-SA-052, and its floor note
 * on each open work order, B-SA-053) tells the same followers — the supervisor follows by himself (B-PR-42b), a task's assignee
 * too, the customer's backup only when he follows — with the change's words: "SO-0142 changed: <what>. 2 steps still to do." on
 * the order's thread, "WO-0142: its order SO-0142 changed — <what>." on a work order's. Never the person who made the change
 * (`causedById`, the drafts' actor); every note of one change of one order is ONE bell item per reader (the change's batch,
 * orderChangeBatch — the order's status and promise moves of the same command fold into it too: view-follow/rules.ts). The wall
 * as for every note: a follower is told only while he reads the thread by his live roles (`mayOnThread` over the record's wall
 * scope: a person limited to another customer, a muted follow, an inactive person — never); followers are office people (a
 * customer's contact or a floor worker is never one). A work order's face names the order only when it is of the work order's
 * own customer (a mixed work order's readers reach every customer); else it reads as the work order's own change.
 */

const payloadOf = (type: string) => threadEvents.find((event) => event.type === type)!.payload

async function threadOf(context: RuleContext, threadId: string) {
  return context.tx.thread.findUnique({ where: { id: threadId }, select: { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true } })
}

const FOLLOWING_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({ INTERNAL_NOTE: 'notifications.following.note', INBOUND: 'notifications.following.mail_in', OUTBOUND: 'notifications.following.mail_out' })

// ---- B-SA-051 -------------------------------------------------------------------------------------------------------------------
interface PostedPayload {
  readonly threadId: string
  readonly messageId: string
  readonly recordType: string
  readonly recordId: string
  readonly direction: string
  readonly batchId?: string
  readonly causedById?: string | null
  readonly orderId?: string
  readonly stillToDo?: number
  /** B-SA-052: people another notice of the same act already told (B-PR-32's withdrawal notice): left out of this bell. */
  readonly alreadyTold?: readonly string[]
}

/** How a change note reads in its followers' bell: its words, who made it (never told), and the change's batch. */
interface ChangeFace {
  readonly messageKey: MessageKey
  readonly params: Readonly<Record<string, string | number>>
  readonly actorId: string | null
  readonly batchId: string | null
}

/** A change note's face (null: the message is no change note — a person's note, a mail, any other system note keeps its words). */
async function changeFaceOf(context: RuleContext, thread: { readonly recordType: string; readonly recordId: string }, payload: PostedPayload, message: { readonly authorKind: string; readonly bodyText: string }, scope: WallScope): Promise<ChangeFace | null> {
  const actorId = payload.causedById
  if (actorId === undefined || message.authorKind !== 'SYSTEM' || payload.direction !== 'INTERNAL_NOTE') return null
  const what = changeWhatOf(message.bodyText)
  const correlationId = context.event?.correlationId
  const batchOf = (orderId: string | null): string | null => (orderId && correlationId ? orderChangeBatch(correlationId, orderId) : (payload.batchId ?? null))
  if (thread.recordType === 'WorkOrder' && payload.orderId) {
    // The order is named (and its change's batch taken) only when it is of the work order's own customer (or the work order is of
    // several or none: its readers reach every customer), read by its own row: a note naming another customer's order by mistake
    // never shows its number nor its id; it reads as the work order's own change.
    const order = await context.tx.salesOrder.findUnique({ where: { id: payload.orderId }, select: { number: true, partyId: true } })
    const wall = wallPartyOf(scope)
    if (order && (wall === EVERY_PARTY_MARKER || order.partyId === wall)) return { actorId, batchId: batchOf(payload.orderId), messageKey: 'notifications.following.orderChange', params: { what, number: order.number } }
  }
  const base = { actorId, batchId: batchOf(thread.recordType === 'SalesOrder' ? thread.recordId : null) }
  const steps = payload.stillToDo ?? 0
  const messageKey: MessageKey = steps > 1 ? 'notifications.following.changeSteps' : steps === 1 ? 'notifications.following.changeStep' : 'notifications.following.change'
  return { ...base, messageKey, params: steps > 1 ? { what, count: steps } : { what } }
}
// ---- end B-SA-051

export const THREAD_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'threads.mentioned',
    events: ['thread.user_mentioned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('thread.user_mentioned').parse(raw) as unknown as { threadId: string; messageId: string; userId: string; authorId: string | null; batchId?: string }
      const thread = await threadOf(context, payload.threadId)
      const reader = thread ? await context.reader(payload.userId) : null
      if (!thread || !reader || !mayOnThread(reader.actor, THREADS_READ, thread.recordType, await wallScopeOf(context.tx, thread))) return []
      const label = await recordLabelOf(context.tx, thread.recordType, thread.recordId)
      if (label === null) return []
      // ---- B-CP-079 (lead pick B6): the note of a customer's ask (its own shape) reads "<customer> asks you, the factory designer, on
      // <record>" — the customer by its name (the reader reads its record), never the note's excerpt.
      const message = await context.tx.message.findUnique({ where: { id: payload.messageId }, select: { direction: true, authorKind: true, authorName: true } })
      const party = message?.authorKind === 'SYSTEM' && thread.partyId !== null ? await context.tx.party.findUnique({ where: { id: thread.partyId }, select: { legalName: true, tradeName: true } }) : null
      const customer = party ? (party.tradeName ?? party.legalName) : null
      const asked = message !== null && customer !== null && isDesignerAskNote(message, customer) ? { customer } : null
      // ---- end B-CP-079
      return [
        {
          userId: payload.userId,
          category: 'MENTION',
          record: { type: thread.recordType, id: thread.recordId, label },
          companyId: thread.companyId,
          anchor: `message:${payload.messageId}`,
          messageKey: asked ? 'notifications.designerAsked' : 'notifications.mentioned', // B-CP-079
          params: asked ? { customer: asked.customer, messageId: payload.messageId } : { actorId: payload.authorId, messageId: payload.messageId },
          actorId: payload.authorId,
          // B-TH-045: "mentioned you on 12 orders" is one bell item.
          batchId: payload.batchId ?? null,
        },
      ]
    },
  },
  {
    name: 'threads.following',
    events: ['thread.message_posted'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('thread.message_posted').parse(raw) as unknown as PostedPayload
      const thread = await threadOf(context, payload.threadId)
      if (!thread) return []
      const followers = await followersOf(context.tx, { type: thread.recordType, id: thread.recordId })
      if (followers.length === 0) return []
      const message = await context.tx.message.findUnique({ where: { id: payload.messageId }, select: { authorKind: true, authorId: true, mentionedUserIds: true, /* B-SA-051 */ bodyText: true } })
      if (!message) return []
      const authorId = message.authorKind === 'USER' ? message.authorId : null
      const label = await recordLabelOf(context.tx, thread.recordType, thread.recordId)
      if (label === null) return []
      const drafts: Draft[] = []
      const scope = await wallScopeOf(context.tx, thread) // B-PR-08a part 2
      // B-SA-051: a change note tells with the change's words, as its batch, never the person who made it.
      const change = await changeFaceOf(context, thread, payload, message, scope)
      const actorId = change ? change.actorId : authorId
      for (const userId of followers) {
        if (userId === actorId || message.mentionedUserIds.includes(userId)) continue
        if (change && payload.alreadyTold?.includes(userId)) continue // B-SA-052: one act, one bell item per person
        const reader = await context.reader(userId)
        if (!reader || !mayOnThread(reader.actor, THREADS_READ, thread.recordType, scope)) continue
        drafts.push({
          userId,
          category: 'FOLLOWING',
          record: { type: thread.recordType, id: thread.recordId, label },
          companyId: thread.companyId,
          anchor: `message:${payload.messageId}`,
          messageKey: change?.messageKey ?? FOLLOWING_KEYS[payload.direction] ?? 'notifications.following.note',
          params: { actorId, messageId: payload.messageId, direction: payload.direction, ...(change?.params ?? {}) },
          actorId,
          // B-TH-045; B-SA-051: a change note's batch is its change of the order.
          batchId: change ? change.batchId : (payload.batchId ?? null),
        })
      }
      return drafts
    },
  },
])
