import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { portalDesignerName } from '@nexus/factory-domain/auth/partners/designer'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { DESIGNER_ASK_NOTE, DESIGNER_ASK_WINDOW_MS, DESIGNER_ASKS_PER_DAY, designerAskAuthor, designerAskNote, designerAskWords, mayAskOn, type DesignerAskRefusal } from '@nexus/factory-domain/threads/designer/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../auth/roles/access'
import { systemCallerOf } from '../../files/files'
import type { PartnerCaller } from '../../search/partner/session'
import { mayOnThread, type WallScope } from '../records'
import { ensureThread, officeRecord, writeMessage, type RecordRef } from '../threads'

/**
 * B-CP-079 (customer page plan C7, D12; 12 §5; review B6, C4, F4; lead pick B6; wall W-CP-6): "Ask the factory designer" from a
 * portal thread — POST /portal/threads/<type>/<id>/messages {body, askFactoryDesigner: true} (platform/threads/partner/service.ts).
 *
 *   before the post   `planDesignerAsk`: the record is of a type the customer writes on; a factory designer is named for the
 *                     customer (B-CP-078: the designer while active, else the backup); at least one slot person reads the record's
 *                     thread by their live roles (the mention rule: threads.read over its wall scope). Else 409 in the portal's
 *                     words (refusal/DESIGNER_NO_DESIGNER, refusal/DESIGNER_NOT_HERE) and nothing is posted. Over the cap (the
 *                     customer's asks in 24 hours, counted by its own notes), the message is posted WITHOUT the ask and the
 *                     answer says so.
 *   after the post    `askDesignerAfterPost`: ONE command in the tenant's system scope — the office-only INTERNAL NOTE (author
 *                     "<customer> (portal)", SYSTEM) "<customer> … asks the factory designer: «first 80 characters»" mentioning the
 *                     slot people who read the thread (MessageMention, a MENTIONED follow, the urgent MENTION bell + mail by
 *                     preference — the bell names who asks and the record, never the excerpt: notifications/rules/threads.ts),
 *                     and `thread.factory_designer_asked` (ids only). A repeated Idempotency-Key writes no second note.
 * The partner role reads no internal note: the customer never sees the note, nor whether anyone read it. The DB guards stay as they
 * are: the mention rides on an internal note, as the threads guard demands.
 */

type Reader = FactoryClient | CommandTx

interface SlotPerson {
  readonly id: string
  readonly name: string
  readonly active: boolean
}

/** The customer's slot (the designer, then the backup) and the one name its people read. */
async function slotOf(db: Reader, partyId: string): Promise<{ people: SlotPerson[]; name: string | null }> {
  const row = await db.portalSettings.findUnique({ where: { id: partyId }, select: { factoryDesignerId: true, factoryDesignerBackupId: true } })
  const ids = [row?.factoryDesignerId ?? null, row?.factoryDesignerBackupId ?? null]
  const users = await db.user.findMany({ where: { id: { in: ids.filter((id): id is string => id !== null) } }, select: { id: true, displayName: true, audience: true, status: true } })
  const person = (id: string | null): SlotPerson | null => {
    const user = id === null ? undefined : users.find((entry) => entry.id === id)
    return user ? { id: user.id, name: user.displayName, active: user.audience === 'OFFICE' && user.status === 'ACTIVE' } : null
  }
  const [designer, backup] = [person(ids[0]!), person(ids[1]!)]
  return { people: [designer, backup].filter((entry): entry is SlotPerson => entry !== null), name: portalDesignerName({ designer, backup }) }
}

/** The slot people who read the record's thread now: ACTIVE, their live office roles reading it over its wall scope (the mention rule). */
async function readersOf(db: Reader, tenantId: string, people: readonly SlotPerson[], recordType: string, scope: WallScope, now: Date): Promise<string[]> {
  const out: string[] = []
  for (const person of people) {
    if (!person.active) continue
    const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, person.id, now), true) }
    if (mayOnThread(actor, THREADS_READ, recordType, scope)) out.push(person.id)
  }
  return out
}

const customerNameOf = async (db: Reader, partyId: string): Promise<string> => {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { legalName: true, tradeName: true } })
  return party ? (party.tradeName ?? party.legalName) : ''
}

export interface DesignerAskPlan {
  /** The name the customer reads ("We asked Giulia Verdi."). */
  readonly name: string
  /** The customer's name as the note and the bell say it. */
  readonly customer: string
  /** Over the cap: the message goes without the ask. */
  readonly capped: boolean
}

/** Checked BEFORE the post (see the file's head): the plan, or a 409 in the person's words (nothing is posted). */
export async function planDesignerAsk(request: FastifyRequest, caller: PartnerCaller, ref: RecordRef): Promise<DesignerAskPlan> {
  const locale = caller.session.person.locale
  const refuse = (word: DesignerAskRefusal): DomainError => {
    const words = designerAskWords(word, locale)
    return new DomainError('conflict', words, [{ path: `refusal/DESIGNER_${word}`, message: words }])
  }
  if (!mayAskOn(ref.type)) throw refuse('NOT_HERE')
  const partyId = caller.context.partyId
  return systemCallerOf(request)(caller.context.tenantId).withClient(async (db) => {
    const slot = await slotOf(db, partyId)
    if (slot.name === null) throw refuse('NO_DESIGNER')
    const now = serverClock.now()
    const { scope } = await officeRecord(db, ref)
    if ((await readersOf(db, caller.context.tenantId, slot.people, ref.type, scope, now)).length === 0) throw refuse('NOT_HERE')
    const customer = await customerNameOf(db, partyId)
    // The customer's asks in the last 24 hours: its own notes (their author is the customer's portal), on any of its threads.
    const asks = await db.message.count({
      where: { direction: DESIGNER_ASK_NOTE.direction, authorKind: DESIGNER_ASK_NOTE.authorKind, authorName: designerAskAuthor(customer), thread: { partyId }, at: { gte: new Date(now.getTime() - DESIGNER_ASK_WINDOW_MS) } },
    })
    return { name: slot.name, customer, capped: asks >= DESIGNER_ASKS_PER_DAY }
  })
}

export interface DesignerAskAnswer {
  readonly asked: boolean
  /** The name asked (null: not asked). */
  readonly name: string | null
  /** "We asked Giulia Verdi." / why not this time, in the person's language. */
  readonly words: string
}

/** The answer of a post over the cap: sent, without the ask. */
export const cappedAnswer = (caller: PartnerCaller): DesignerAskAnswer => ({ asked: false, name: null, words: designerAskWords('CAPPED', caller.session.person.locale) })

/** Right after the post (see the file's head): the note that mentions the slot people, and its event, in ONE system command. */
export async function askDesignerAfterPost(request: FastifyRequest, caller: PartnerCaller, ref: RecordRef, posted: { readonly message: { readonly id: string } }, body: string, plan: DesignerAskPlan, idempotencyKey?: string): Promise<DesignerAskAnswer> {
  const tenantId = caller.context.tenantId
  const partyId = caller.context.partyId
  const { result } = await command(
    systemCallerOf(request)(tenantId),
    { name: 'threads.askFactoryDesigner', idempotencyKey: idempotencyKey ? `${idempotencyKey}:designer` : undefined, input: { recordType: ref.type, recordId: ref.id, messageId: posted.message.id } },
    async (tools) => {
      const { thread } = await ensureThread(tools, ref, null)
      // The people again, inside the command (a role may have moved since the check).
      const readers = await readersOf(tools.tx, tenantId, (await slotOf(tools.tx, partyId)).people, ref.type, (await officeRecord(tools.tx, ref)).scope, tools.now)
      if (readers.length === 0) {
        tools.audit({ recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, after: { factoryDesignerAsked: false, messageId: posted.message.id } })
        return null
      }
      const note = await writeMessage(tools, thread, {
        direction: DESIGNER_ASK_NOTE.direction,
        channel: DESIGNER_ASK_NOTE.channel,
        author: { kind: DESIGNER_ASK_NOTE.authorKind, id: null, name: designerAskAuthor(plan.customer) },
        bodyText: cleanBody(designerAskNote(plan.customer, body)),
        mentions: readers,
      })
      tools.emit({ type: 'thread.factory_designer_asked', subject: thread.recordId, companyId: thread.companyId, payload: { threadId: thread.id, messageId: posted.message.id, noteId: note.id, recordType: thread.recordType, recordId: thread.recordId } })
      return note.id
    },
  )
  const locale = caller.session.person.locale
  return result === null ? { asked: false, name: null, words: designerAskWords('NOT_HERE', locale) } : { asked: true, name: plan.name, words: designerAskWords('ASKED', locale, plan.name) }
}
