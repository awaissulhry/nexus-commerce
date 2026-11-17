import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { NOTE_WORDS, uniqueRecords, type NoteRecordType } from '@nexus/factory-domain/production-brand/notes'
import { ISSUE_WORDS } from '@nexus/factory-domain/production-brand/issues' // B-PR-43b
import { effectiveSupervisor, supervisorMarkOf } from '@nexus/factory-domain/production-brand/supervisor'
import { cleanBody, noteProblems, uniqueIds } from '@nexus/factory-domain/threads/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { MIS_SEND_LIMITS, partiesNamedIn } from '../../../platform/email-out/mis-send/rules'
import { mayOnThread, type WallScope } from '../../../platform/threads/records'
import { EVERY_PARTY_MARKER } from '../../quality/wall'
import { personActors } from '../supervisor/follows'
import { customerDefaultsOf, orderSupervisorsOf, workOrderSupervisorsOf, type Reader } from '../supervisor/resolver'
import { officeContextOf } from '../work-orders/access'

/**
 * B-PR-43a — what "Note to N" / "Ask the supervisor" would do, read before Send (production plan §1, §3; lead pick L23; review
 * fixes R-47, R-55, R-58; PW-13) — and the plan the write (./notes.ts) runs again inside its own read, so both say the same:
 *
 *   records      each picked record the writer SEES (threads.read over its own scope: a sales order's company and customer, a
 *                work order's through its customer — a work order of several customers or none only with every customer) with
 *                its number, its customer, whether the writer may write on it (threads.post) and its supervisor as a list says it
 *                (Me / Someone else / Not set: never a name on a list); the others only counted (`unknown`), never named
 *   people       each person mentioned, and the seen records they cannot read ("Dora Campione cannot read 2 of 12: not mentioned
 *                there; the note is still written")
 *   other names  the seen records whose text names ANOTHER customer than the record's own (email-out mis-send partiesNamedIn,
 *                legal or trade name without the legal form, customers of the record's company or of every company), with the
 *                names the writer may know (customers whose threads they read); Send is held until the text changes or the
 *                writer ticks "This text names no other customer" (R-47) — `held`
 *
 * Read only: nothing is written, nobody is told.
 *
 *   POST /production/notes/check   office, threads.post (the write's own body)
 */

export interface NoteRecordInput {
  readonly type: NoteRecordType
  readonly id: string
}

export interface NoteDraftInput {
  readonly records: readonly NoteRecordInput[]
  readonly body: string
  readonly mentions?: readonly string[] | undefined
  readonly askSupervisor?: boolean | undefined
  readonly namesNoOtherCustomer?: boolean | undefined
  /** B-PR-43b: "Needs an answer". */
  readonly needsAnswer?: boolean | undefined
}

/** A picked record the writer sees, as the check and the write read it. */
export interface SeenRecord {
  /** Where it was picked (the body's `records/<index>`). */
  readonly index: number
  readonly type: NoteRecordType
  readonly id: string
  readonly label: string
  readonly companyId: string
  readonly siteId: string | null
  /** Its customer: a sales order's, a work order's one customer (null: a work order of several customers or of none). */
  readonly partyId: string | null
  /** Threads' scope of it (a work order's customer as its WALL party). */
  readonly scope: WallScope
  readonly canPost: boolean
  /** Its production supervisor now (null: none). */
  readonly supervisorId: string | null
  /** The other customers its text names (empty: none). */
  readonly namesOther: readonly { readonly id: string; readonly name: string }[]
}

/** The plan of one draft: the records seen, how many were not, who is mentioned where. */
export interface NotePlan {
  readonly bodyText: string
  readonly mentions: readonly string[]
  readonly seen: readonly SeenRecord[]
  readonly unknown: number
  /** Each person mentioned (and, asked, each record's supervisor): the seen records where they may be mentioned. */
  readonly readers: ReadonlyMap<string, ReadonlySet<string>>
  /** The writer: who may read which customers' names. */
  readonly actor: Actor
}

export const recordKey = (record: { readonly type: string; readonly id: string }): string => `${record.type}:${record.id}`

const nameOf = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName
const fold = (name: string | null | undefined): string => (name ?? '').trim().toLowerCase()

/** The picked records as the writer sees them (one read per type, threads' read rule over each record's own scope). */
async function seenRecordsOf(db: Reader, actor: Actor, records: readonly NoteRecordInput[]): Promise<{ seen: Omit<SeenRecord, 'supervisorId' | 'namesOther'>[]; unknown: number }> {
  const idsOf = (type: NoteRecordType) => records.filter((record) => record.type === type && isUuid(record.id)).map((record) => record.id)
  const orders = new Map((idsOf('SalesOrder').length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: idsOf('SalesOrder') } }, select: { id: true, number: true, companyId: true, partyId: true } })).map((row) => [row.id, row]))
  const workOrders = new Map((idsOf('WorkOrder').length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: idsOf('WorkOrder') } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true } })).map((row) => [row.id, row]))
  const seen: Omit<SeenRecord, 'supervisorId' | 'namesOther'>[] = []
  let unknown = 0
  records.forEach((record, index) => {
    const order = record.type === 'SalesOrder' ? orders.get(record.id) : undefined
    const workOrder = record.type === 'WorkOrder' ? workOrders.get(record.id) : undefined
    const row = order
      ? { label: order.number, companyId: order.companyId, siteId: null, partyId: order.partyId, scope: { companyId: order.companyId, siteId: null, partyId: order.partyId } satisfies WallScope }
      : workOrder
        ? { label: workOrder.number, companyId: workOrder.companyId, siteId: workOrder.siteId, partyId: workOrder.partyId, scope: { companyId: workOrder.companyId, siteId: workOrder.siteId, partyId: null, wallPartyId: workOrder.partyId ?? EVERY_PARTY_MARKER } satisfies WallScope }
        : null
    // Another customer's record, or none such: counted, never named (PW-13).
    if (!row || !mayOnThread(actor, THREADS_READ, record.type, row.scope)) {
      unknown++
      return
    }
    seen.push({ index, type: record.type, id: record.id, ...row, canPost: mayOnThread(actor, THREADS_POST, record.type, row.scope) })
  })
  return { seen, unknown }
}

/** Each seen record's production supervisor now (./supervisor/resolver's rule, in two or three reads). */
async function supervisorsOf(db: Reader, seen: readonly Pick<SeenRecord, 'type' | 'id' | 'partyId'>[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const orders = seen.filter((record) => record.type === 'SalesOrder')
  const own = await orderSupervisorsOf(db, orders.map((record) => record.id))
  const defaults = await customerDefaultsOf(db, orders.flatMap((record) => (record.partyId !== null ? [record.partyId] : [])))
  for (const record of orders) out.set(recordKey(record), effectiveSupervisor(own.get(record.id) ?? null, record.partyId !== null ? (defaults.get(record.partyId)?.supervisorId ?? null) : null).userId)
  const workOrders = seen.filter((record) => record.type === 'WorkOrder')
  if (workOrders.length > 0) {
    const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrders.map((record) => record.id) } }, select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } } })
    const rows = workOrders.map((record) => ({ id: record.id, partyId: record.partyId, orderIds: [...new Set(cells.filter((cell) => cell.workOrderId === record.id && cell.salesOrderLine).map((cell) => cell.salesOrderLine!.orderId))] }))
    const found = await workOrderSupervisorsOf(db, rows)
    for (const record of workOrders) out.set(recordKey(record), found.get(record.id)?.userId ?? null)
  }
  return out
}

/**
 * R-47: the other customers a text names on each record — the record's customer and its own names left out; customers of the
 * record's company or of every company (the mis-send guard's list, MIS_SEND_LIMITS.parties at most). A record of no customer
 * (a work order of several or none: only people who reach every customer read it) is not held.
 */
async function otherCustomersOf(db: Reader, text: string, seen: readonly Pick<SeenRecord, 'type' | 'id' | 'companyId' | 'partyId'>[]): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>()
  const withCustomer = seen.filter((record) => record.partyId !== null)
  if (text.trim() === '' || withCustomer.length === 0) return out
  const companies = [...new Set(withCustomer.map((record) => record.companyId))]
  const parties = await db.party.findMany({
    where: { roles: { hasSome: ['CUSTOMER', 'BRAND'] }, status: { not: 'ARCHIVED' }, OR: [{ companyId: null }, { companyId: { in: companies } }] },
    select: { id: true, legalName: true, tradeName: true, companyId: true },
    orderBy: { id: 'asc' },
    take: MIS_SEND_LIMITS.parties,
  })
  const named = partiesNamedIn(text, parties)
  if (named.length === 0) return out
  const owners = await db.party.findMany({ where: { id: { in: [...new Set(withCustomer.map((record) => record.partyId!))] } }, select: { id: true, legalName: true, tradeName: true } })
  for (const record of withCustomer) {
    const own = owners.find((party) => party.id === record.partyId)
    const ownNames = new Set([fold(own?.legalName), fold(own?.tradeName)].filter((name) => name !== ''))
    const others = named.filter((party) => party.id !== record.partyId && (party.companyId === null || party.companyId === record.companyId) && !ownNames.has(fold(party.legalName)) && !(party.tradeName && ownNames.has(fold(party.tradeName))))
    if (others.length > 0) out.set(recordKey(record), others.map((party) => ({ id: party.id, name: nameOf(party) })))
  }
  return out
}

/**
 * The plan of a draft (the check's answer and the write's first read): its cleaned text and mentions (400 in words when the note
 * itself is not valid or a mention is no active office person), the records seen with their supervisor and the other customers
 * the text names on them, the records not seen counted, and who may be mentioned where.
 */
export async function planNotes(db: Reader, context: OfficeContext, draft: NoteDraftInput, now: Date): Promise<NotePlan> {
  const actor = actorOf(context)
  const bodyText = cleanBody(draft.body)
  const mentions = uniqueIds(draft.mentions)
  const problems: Issue[] = noteProblems({ bodyText, mentions, attachments: [] })
  if (problems.length > 0) throw new ValidationError('The note is not valid.', problems)
  const people = mentions.length === 0 ? [] : await db.user.findMany({ where: { id: { in: mentions }, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  const persons = mentions.flatMap((userId, index) => (people.some((person) => person.id === userId) ? [] : [{ path: `body/mentions/${index}`, message: NOTE_WORDS.NOT_A_PERSON.en }]))
  if (persons.length > 0) throw new ValidationError(persons[0]!.message, persons)
  const records = uniqueRecords(draft.records)
  const { seen: found, unknown } = await seenRecordsOf(db, actor, records)
  const supervisors = await supervisorsOf(db, found)
  const others = await otherCustomersOf(db, bodyText, found)
  const seen: SeenRecord[] = found.map((record) => ({ ...record, supervisorId: supervisors.get(recordKey(record)) ?? null, namesOther: others.get(recordKey(record)) ?? [] }))
  // Who may be mentioned where: threads' rule (an ACTIVE office person whose live roles read the record's thread).
  const actorOfPerson = personActors(db, context.tenantId, now)
  const readers = new Map<string, Set<string>>()
  const wanted = [...new Set([...mentions, ...(draft.askSupervisor ? seen.flatMap((record) => (record.supervisorId !== null ? [record.supervisorId] : [])) : [])])]
  for (const userId of wanted) {
    const person = await actorOfPerson(userId)
    readers.set(userId, new Set(person ? seen.filter((record) => mayOnThread(person, THREADS_READ, record.type, record.scope)).map(recordKey) : []))
  }
  return { bodyText, mentions, seen, unknown, readers, actor }
}

/** The people a record's note mentions: those typed and, asked, its supervisor — each only where they read it. */
export function mentionsOn(plan: NotePlan, record: SeenRecord, askSupervisor: boolean): { mentioned: string[]; left: string[] } {
  const wanted = uniqueIds([...plan.mentions, ...(askSupervisor && record.supervisorId !== null ? [record.supervisorId] : [])])
  const reads = (userId: string) => plan.readers.get(userId)?.has(recordKey(record)) ?? false
  return { mentioned: wanted.filter(reads), left: wanted.filter((userId) => !reads(userId)) }
}

/** The names of the other customers a writer may know (customers whose threads they read at the record's company). */
const knownNames = (actor: Actor, record: SeenRecord): string[] =>
  record.namesOther.filter((party) => mayOnThread(actor, THREADS_READ, 'SalesOrder', { companyId: record.companyId, siteId: null, partyId: party.id })).map((party) => party.name)

/** POST /production/notes/check (see the file's head). */
export async function checkNotes(caller: CommandCaller, draft: NoteDraftInput) {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const plan = await planNotes(db, context, draft, now)
    const people = plan.mentions.length === 0 ? [] : await db.user.findMany({ where: { id: { in: [...plan.mentions] } }, select: { id: true, displayName: true } })
    const customers = plan.seen.flatMap((record) => (record.partyId !== null ? [record.partyId] : []))
    const names = new Map((customers.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(customers)] } }, select: { id: true, legalName: true, tradeName: true } })).map((party) => [party.id, nameOf(party)]))
    const writable = plan.seen.filter((record) => record.canPost)
    const namesOther = writable.filter((record) => record.namesOther.length > 0)
    return {
      records: plan.seen.map((record) => ({
        type: record.type,
        id: record.id,
        label: record.label,
        customer: record.partyId !== null ? { id: record.partyId, name: names.get(record.partyId) ?? '' } : null,
        canWrite: record.canPost,
        why: record.canPost ? null : NOTE_WORDS.CANNOT_POST.en,
        supervisor: supervisorMarkOf({ userId: record.supervisorId, from: null }, context.actorId),
      })),
      unknown: plan.unknown,
      /** Different customers among the records seen (an office note never reaches any of them). */
      customers: new Set(customers).size,
      people: plan.mentions.map((userId) => ({
        userId,
        name: people.find((person) => person.id === userId)?.displayName ?? '',
        cannotRead: writable.filter((record) => !(plan.readers.get(userId)?.has(recordKey(record)) ?? false)).map((record) => ({ type: record.type, id: record.id, label: record.label })),
      })),
      noSupervisor: draft.askSupervisor || draft.needsAnswer ? writable.filter((record) => record.supervisorId === null).map((record) => ({ type: record.type, id: record.id, label: record.label })) : [],
      // ---- B-PR-43b: "Needs an answer" raises no issue on a work order of several customers or of none (its note is still written).
      noIssue: draft.needsAnswer ? writable.filter((record) => record.partyId === null).map((record) => ({ type: record.type, id: record.id, label: record.label, why: ISSUE_WORDS.NO_CUSTOMER.en })) : [],
      namesOtherCustomer: namesOther.map((record) => ({ type: record.type, id: record.id, label: record.label, names: knownNames(plan.actor, record) })),
      held: namesOther.length > 0 && draft.namesNoOtherCustomer !== true,
    }
  })
}
