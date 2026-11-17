import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { mayOnThread } from './records'
import { contextOf, officeRecord, type RecordRef } from './threads'

/**
 * B-TH-093 (threads plan TH-9, N18; T1-F13 "Done"; wall W08 / W34): Done — a work state apart from Close. The conversation stays
 * open (the customer or supplier can still write: nothing changes for them, and they are never told: the columns are hidden from the
 * partner role); for the office it leaves the "waiting" views for everyone (the head's waiting, Customer replies, Supplier replies).
 * A new message shared with the party (theirs or ours) reopens it on its own (threads.ts writeMessage, the portal post's bookkeeping).
 *
 *   PUT /threads/<type>/<id>/done {done}   mark done, or open again (threads.post over the record: whoever may write on it); office only.
 *                                          A conversation with no message yet has nothing to mark; a closed one is not marked
 *                                          done (Close already ends it): both refused in words. Marking twice changes nothing.
 */

export const DONE_WORDS = Object.freeze({
  NO_THREAD: { it: 'Questa conversazione non ha ancora messaggi: non c’è nulla da segnare come fatto.', en: 'This conversation has no message yet: there is nothing to mark done.' },
  CLOSED: { it: 'Questa conversazione è chiusa: riaprila per segnarla come fatta.', en: 'This conversation is closed: reopen it to mark it done.' },
})

const refusal = (code: keyof typeof DONE_WORDS): DomainError => new DomainError('conflict', DONE_WORDS[code].en, [{ path: `refusal/${code}`, message: DONE_WORDS[code].en }])

export interface DoneView {
  readonly at: string
  readonly by: { readonly id: string; readonly name: string | null }
}

/** The thread's work state as the office reads it (null: open work). */
export async function doneOf(client: FactoryClient | CommandTx, thread: { readonly doneAt: Date | null; readonly doneById: string | null }): Promise<DoneView | null> {
  if (!thread.doneAt || !thread.doneById) return null
  const user = await client.user.findUnique({ where: { id: thread.doneById }, select: { displayName: true } })
  return { at: toUtcIso(thread.doneAt), by: { id: thread.doneById, name: user?.displayName ?? null } }
}

/** PUT /threads/<type>/<id>/done: mark the conversation done, or open again. */
export async function setThreadDone(caller: CommandCaller, record: RecordRef, body: { readonly done: boolean }, idempotencyKey?: string): Promise<{ done: DoneView | null }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { thread, scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError('Marking a conversation done needs the right to write on it.')
  if (!thread) throw refusal('NO_THREAD')
  const { result } = await command(caller, { name: body.done ? 'threads.markDone' : 'threads.reopenWork', idempotencyKey, input: { recordType: record.type, recordId: record.id, done: body.done } }, async (tools) => {
    const row = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: { id: true, status: true, doneAt: true, doneById: true, version: true, companyId: true, siteId: true } })
    if (body.done && row.status !== 'OPEN') throw refusal('CLOSED')
    const already = body.done ? row.doneAt !== null : row.doneAt === null
    if (!already) {
      await tools.tx.thread.update({
        where: { id: row.id },
        data: body.done ? { doneAt: tools.now, doneById: context.actorId, version: row.version + 1, updatedAt: tools.now } : { doneAt: null, doneById: null, version: row.version + 1, updatedAt: tools.now },
        select: { id: true },
      })
    }
    tools.audit({ action: body.done ? 'threads.markDone' : 'threads.reopenWork', recordType: 'Thread', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { done: row.doneAt !== null }, after: { done: body.done } })
    const after = await tools.tx.thread.findUniqueOrThrow({ where: { id: row.id }, select: { doneAt: true, doneById: true } })
    return { done: await doneOf(tools.tx, after) }
  })
  return result
}

/**
 * The bookkeeping of a new message shared with the party: a conversation marked done is open work again (its writer's command, or
 * the portal post's system scope right after it). Returns whether it was done.
 */
export async function reopenOnSharedMessage(client: FactoryClient | CommandTx, threadId: string): Promise<boolean> {
  const { count } = await client.thread.updateMany({ where: { id: threadId, doneAt: { not: null } }, data: { doneAt: null, doneById: null } })
  return count > 0
}
