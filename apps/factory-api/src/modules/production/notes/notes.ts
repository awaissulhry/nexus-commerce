import { THREADS_POST } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { heldForOtherCustomer, NOTE_WORDS, writeOrder, type NoteSkip } from '@nexus/factory-domain/production-brand/notes'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { mayOnThread, wallScopeOf } from '../../../platform/threads/records'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import { officeContextOf } from '../work-orders/access'
import { mentionsOn, planNotes, recordKey, type NoteDraftInput, type NotePlan, type SeenRecord } from './check'

/**
 * B-PR-43a — note to N records and ask the supervisor (production plan §1 "Ask the supervisor / Note to N: one office note with
 * @mentions written into each picked order's own thread (one or up to 100 orders)"; §3 "Note to N / Ask the supervisor —
 * threads.post on each record"; lead pick L23; review fixes R-47, R-48, R-58; threads agreements T5, T6; the Owner's point N4).
 *
 *   POST /production/notes {records [{type SalesOrder|WorkOrder, id}] 1-100, body, mentions ≤ 20, askSupervisor,
 *                           namesNoOtherCustomer}
 *
 * ONE command writes one internal office note on each picked record's OWN thread, the same text, through threads' seams only:
 * `ensureThread` (the thread made with the first note), `mayOnThread` (threads.post over the thread's own scope, a work order's
 * through its customer), `mentionProblems` (who may be mentioned there) and `writeMessage` (the message, its audit row,
 * thread.message_posted, the mentions with thread.user_mentioned and their MENTIONED follow) — no second thread, no second mention
 * system. Every note carries ONE `batchId` (threads T6, B-TH-045): each reader's bell folds the batch into one item ("mentioned
 * you on 12 orders"), counting only the records that reader may read.
 *
 *   the wall      each record walled on its own (./check: threads.read over its own scope); one the writer does not see is
 *                 counted (`unknown`), never named; one seen but not writable is skipped with why; none seen → 404 (PW-13)
 *   mentions      each person only on the records they read (the note is still written there; the answer names where they were
 *                 not mentioned); "Ask the supervisor" adds each record's own supervisor (./supervisor/resolver) to ITS note
 *   other names   a writable record whose text names another customer is refused (409 refusal/NAMES_OTHER_CUSTOMER, each such
 *                 record named at body/records/<index>) unless the writer ticked "This text names no other customer" (R-47);
 *                 checked again here, not trusted from the check route
 *   customers     mixed customers are allowed: these are internal notes, never a shared message (threads R-17)
 *   order         threads written in record type and id order (two batches never wait on each other); one Idempotency-Key per
 *                 batch
 *   audit         writeMessage's row per note, and one `production.notesBatch` row per customer and company (R-48: each names
 *                 only its own records; a work order of no customer under its company)
 */

/** A record written on: its note, who it mentioned, who was left out (they cannot read it). */
interface Written {
  readonly record: SeenRecord
  readonly messageId: string
  readonly mentioned: readonly string[]
  readonly left: readonly string[]
}

const ref = (record: Pick<SeenRecord, 'type' | 'id' | 'label'>) => ({ type: record.type, id: record.id, label: record.label })
const skippedOf = (record: SeenRecord, code: NoteSkip) => ({ ...ref(record), why: NOTE_WORDS[code].en })

/** One customer at one company (a record of no customer: its company only) — one audit row each (R-48). */
export function sharesOf<T extends Pick<SeenRecord, 'companyId' | 'partyId'>>(records: readonly T[]): { companyId: string; partyId: string | null; records: T[] }[] {
  const shares = new Map<string, { companyId: string; partyId: string | null; records: T[] }>()
  for (const record of records) {
    const key = `${record.companyId}|${record.partyId ?? ''}`
    const share = shares.get(key) ?? { companyId: record.companyId, partyId: record.partyId, records: [] }
    share.records.push(record)
    shares.set(key, share)
  }
  return [...shares.values()]
}

/** The refusal of a text that names another customer on some records (R-47), each record named where it was picked. */
export function namesOtherCustomerRefusal(held: readonly SeenRecord[]): DomainError {
  return new DomainError('conflict', NOTE_WORDS.NAMES_OTHER_CUSTOMER.en, [
    { path: 'refusal/NAMES_OTHER_CUSTOMER', message: NOTE_WORDS.NAMES_OTHER_CUSTOMER.en },
    ...held.map((record) => ({ path: `body/records/${record.index}`, message: `${record.label}: ${NOTE_WORDS.NAMES_OTHER_CUSTOMER_ON.en}` })),
  ])
}

/**
 * Inside the command: one note on each writable record (in write order), each through threads' seams, all with `batchId`.
 * Answers what was written and what was skipped inside (the thread is closed, or its scope no longer lets the writer post).
 */
export async function writeNotesInCommand(tools: CommandTools, context: OfficeContext, plan: NotePlan, input: { readonly askSupervisor: boolean; readonly batchId: string }): Promise<{ written: Written[]; skipped: ReturnType<typeof skippedOf>[] }> {
  const author = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
  const written: Written[] = []
  const skipped: ReturnType<typeof skippedOf>[] = []
  for (const record of writeOrder(plan.seen.filter((row) => row.canPost))) {
    const { thread } = await ensureThread(tools, { type: record.type, id: record.id }, context.actorId)
    // The thread as it is now (made here or by a racing note): its own scope decides, as threads' postNote.
    if (!mayOnThread(plan.actor, THREADS_POST, record.type, await wallScopeOf(tools.tx, thread))) {
      skipped.push(skippedOf(record, 'CANNOT_POST'))
      continue
    }
    if (thread.status !== 'OPEN') {
      skipped.push(skippedOf(record, 'THREAD_CLOSED'))
      continue
    }
    const { mentioned, left } = mentionsOn(plan, record, input.askSupervisor)
    // Threads' own check of who may be mentioned on THIS thread (the plan read the same rule just before; a role taken away
    // since leaves the person out here too).
    const problems = await mentionProblems(tools.tx, context, thread, mentioned, tools.now)
    const refused = new Set(problems.map((problem) => mentioned[Number(problem.path.split('/').pop())]).filter((userId): userId is string => userId !== undefined))
    const told = mentioned.filter((userId) => !refused.has(userId))
    const message = await writeMessage(tools, thread, {
      direction: 'INTERNAL_NOTE',
      channel: 'APP',
      author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null },
      bodyText: plan.bodyText,
      mentions: told,
      batchId: input.batchId,
    })
    written.push({ record, messageId: message.id, mentioned: told, left: [...left, ...refused] })
  }
  return { written, skipped }
}

/** The answer of a batch: one result per record the writer sees, the others counted. */
export function notesAnswer(plan: NotePlan, batchId: string, done: { readonly written: readonly Written[]; readonly skipped: readonly ReturnType<typeof skippedOf>[] }, askSupervisor: boolean) {
  const left = new Map<string, ReturnType<typeof ref>[]>()
  for (const entry of done.written) for (const userId of entry.left) left.set(userId, [...(left.get(userId) ?? []), ref(entry.record)])
  return {
    batchId,
    written: done.written.map((entry) => ({
      ...ref(entry.record),
      messageId: entry.messageId,
      mentioned: [...entry.mentioned],
      supervisorAsked: askSupervisor && entry.record.supervisorId !== null && entry.mentioned.includes(entry.record.supervisorId),
    })),
    skipped: [...plan.seen.filter((record) => !record.canPost).map((record) => skippedOf(record, 'CANNOT_POST')), ...done.skipped],
    notMentioned: [...left.entries()].map(([userId, records]) => ({ userId, records })),
    unknown: plan.unknown,
  }
}

/** POST /production/notes (see the file's head). */
export async function writeNotes(caller: CommandCaller, body: NoteDraftInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const plan = await caller.withClient((db) => planNotes(db, context, body, serverClock.now()))
  if (plan.seen.length === 0) throw new NotFoundError(NOTE_WORDS.NONE_FOUND.en)
  // Seen, but none of them writable: nothing to write (403 in words).
  if (!plan.seen.some((record) => record.canPost)) throw new ForbiddenError(NOTE_WORDS.CANNOT_POST.en)
  const held = heldForOtherCustomer(plan.seen.filter((record) => record.canPost), body.namesNoOtherCustomer === true)
  if (held.length > 0) throw namesOtherCustomerRefusal(held)
  const askSupervisor = body.askSupervisor === true
  const { result } = await command(
    caller,
    {
      name: 'production.notes',
      idempotencyKey,
      input: { records: plan.seen.map(recordKey), bodyText: plan.bodyText, mentions: plan.mentions, askSupervisor, namesNoOtherCustomer: body.namesNoOtherCustomer === true },
    },
    async (tools) => {
      const batchId = newId()
      const done = await writeNotesInCommand(tools, context, plan, { askSupervisor, batchId })
      // R-48: one audit row per customer and company of the writable records, each naming only its own.
      for (const share of sharesOf(plan.seen.filter((record) => record.canPost))) {
        const mine = done.written.filter((entry) => share.records.includes(entry.record))
        tools.audit({
          action: 'production.notesBatch',
          recordType: share.partyId !== null ? 'Party' : 'Company',
          recordId: share.partyId ?? share.companyId,
          companyId: share.companyId,
          after: {
            batchId,
            records: share.records.map((record) => ({ type: record.type, id: record.id })),
            written: mine.map((entry) => entry.messageId),
            mentioned: [...new Set(mine.flatMap((entry) => entry.mentioned))].length,
            askSupervisor,
            namesNoOtherCustomer: body.namesNoOtherCustomer === true,
          },
        })
      }
      return notesAnswer(plan, batchId, done, askSupervisor)
    },
  )
  return result
}
