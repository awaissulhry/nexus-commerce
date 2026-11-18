import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Issue } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../core/command'
import { EVERY_PARTY_MARKER } from '../../modules/quality/wall'
import { mayOnThread, resolveRecord, type WallScope } from './records'

/**
 * B-SA-061 (sales page plan S5; lead picks P26, P9, R10 item 6; 10-order-page §6.4 "Discuss"): what a message is about — ONE part
 * of the sales order whose thread it is in, so the order page can jump back to it ("Show line 2 on the page"). Kept in the
 * message's append-only pair `Message.aboutKind` + `aboutId` (schema wave "sales page 1/1", B-SA-005), written with the message,
 * never changed. The note route (POST …/notes) and the portal reply route (POST …/replies) take it as `about: { kind, id }`; the
 * office's read gives it back.
 *
 *   kinds        a line, shipment, invoice, deposit request, gate, change request or work order of THIS order (a work order: one
 *                that makes a line of it) — the database's own list (…_order_apply_guards factory_message_about_ok);
 *   only here    on a sales order's thread only;
 *   belongs      the part is of the thread's own order. Anything else — another order's line, another customer's record, an id
 *                that is not there — is refused in the SAME words ("Not a part of this record."), so the refusal never says
 *                whether another customer's record exists; nothing is stored;
 *   the wall     a work order is named only by a writer who reaches it (its customer; a mixed work order made before the
 *                one-customer rule: every customer), and a reader who does not reach it reads the message without it;
 *   office only  a message to the customer (a portal reply) is never about a work order: refused in words ("The reference stays
 *                in office notes"), as the database refuses it.
 * The database checks the same on every insert (Message_about_check): these checks say it in words first.
 */

export const ABOUT_KINDS = ['SalesOrderLine', 'Shipment', 'Invoice', 'DepositRequest', 'OrderGate', 'OrderChangeRequest', 'WorkOrder'] as const
export type AboutKind = (typeof ABOUT_KINDS)[number]

/** What a message is about, as the routes take it and the office reads it. */
export interface About {
  readonly kind: AboutKind
  readonly id: string
}

/** The only record type whose thread's messages may be about one of its parts. */
export const ABOUT_THREAD_TYPE = 'SalesOrder'

/** The kinds that stay in the office: a message shared with the customer is never about one (the database's rule too). */
export const OFFICE_ONLY_ABOUT_KINDS: ReadonlySet<AboutKind> = new Set<AboutKind>(['WorkOrder'])

/** The refusals' words, for the office (it, en): none of them says whether another customer's record exists. */
export const ABOUT_WORDS = Object.freeze({
  NOT_PART: { it: 'Non fa parte di questo record.', en: 'Not a part of this record.' },
  OFFICE_ONLY: {
    it: 'Il riferimento resta nelle note interne: un messaggio al cliente non riguarda mai un ordine di lavoro.',
    en: 'The reference stays in office notes: a message to the customer is never about a work order.',
  },
})

const notPart = (): Issue[] => [{ path: 'body/about', message: ABOUT_WORDS.NOT_PART.en }]

/**
 * What is wrong with an `about` before anything is read (empty: nothing, or none sent): only on a sales order's thread, and a
 * message to the customer (`PARTNER`) never about an office-only kind.
 */
export function aboutShapeProblems(recordType: string, about: About | null | undefined, audience: 'OFFICE' | 'PARTNER'): Issue[] {
  if (!about) return []
  if (recordType !== ABOUT_THREAD_TYPE) return notPart()
  if (audience === 'PARTNER' && OFFICE_ONLY_ABOUT_KINDS.has(about.kind)) return [{ path: 'body/about/kind', message: ABOUT_WORDS.OFFICE_ONLY.en }]
  return []
}

/** Whether the part is one of this order's (the database's factory_message_about_ok, read in the writer's own transaction). */
async function partOfOrder(tx: CommandTx, orderId: string, about: About): Promise<boolean> {
  const { id } = about
  switch (about.kind) {
    case 'SalesOrderLine':
      return (await tx.salesOrderLine.count({ where: { id, orderId } })) > 0
    case 'Shipment':
      return (await tx.shipment.count({ where: { id, salesOrderId: orderId } })) > 0
    case 'Invoice':
      return (await tx.invoice.count({ where: { id, salesOrderId: orderId } })) > 0
    case 'DepositRequest':
      return (await tx.depositRequest.count({ where: { id, orderId } })) > 0
    case 'OrderGate':
      return (await tx.orderGate.count({ where: { id, salesOrderId: orderId } })) > 0
    case 'OrderChangeRequest':
      return (await tx.orderChangeRequest.count({ where: { id, orderId } })) > 0
    case 'WorkOrder':
      // A work order of the order: one that makes a line of it (a cell of one of its lines).
      return (await tx.workOrderSize.count({ where: { workOrderId: id, salesOrderLine: { is: { orderId } } } })) > 0
    default:
      return false
  }
}

/**
 * What is wrong with what a new message on this thread says it is about (empty: nothing, or none sent): the shape (above), then a
 * part of the thread's own order, and a work order only when the writer reaches it. One sentence for every "not a part".
 */
export async function aboutProblems(
  tx: CommandTx,
  actor: Actor,
  thread: { readonly recordType: string; readonly recordId: string },
  about: About | null | undefined,
  audience: 'OFFICE' | 'PARTNER',
): Promise<Issue[]> {
  if (!about) return []
  const shape = aboutShapeProblems(thread.recordType, about, audience)
  if (shape.length > 0) return shape
  if (!(await partOfOrder(tx, thread.recordId, about))) return notPart()
  if (about.kind === 'WorkOrder') {
    const scope = await resolveRecord(tx, 'WorkOrder', about.id)
    if (!scope || !mayOnThread(actor, THREADS_READ, 'WorkOrder', scope)) return notPart()
  }
  return []
}

/** A message row's about, as the database holds it. */
export interface AboutRow {
  readonly id: string
  readonly aboutKind?: string | null
  readonly aboutId?: string | null
}

/** The about of a row, or null (none, or a kind this code does not know). */
export function aboutOf(row: AboutRow): About | null {
  if (!row.aboutKind || !row.aboutId) return null
  return (ABOUT_KINDS as readonly string[]).includes(row.aboutKind) ? { kind: row.aboutKind as AboutKind, id: row.aboutId } : null
}

/** No message's about is held back. */
export const NONE_HELD: ReadonlySet<string> = new Set()

/**
 * The messages of a page whose about this office reader may not read (the wall): a work order the reader does not reach — its
 * customer's, or every customer's for a mixed one. One read, and only for a page with a work order named; every other kind is a
 * part of the order the reader already reads.
 */
export async function aboutsHeldBack(client: FactoryClient | CommandTx, actor: Actor, rows: readonly AboutRow[]): Promise<ReadonlySet<string>> {
  const named = rows.flatMap((row) => {
    const about = aboutOf(row)
    return about?.kind === 'WorkOrder' ? [{ messageId: row.id, workOrderId: about.id }] : []
  })
  if (named.length === 0) return NONE_HELD
  const workOrders = await client.workOrder.findMany({ where: { id: { in: [...new Set(named.map((one) => one.workOrderId))] } }, select: { id: true, companyId: true, siteId: true, partyId: true } })
  const scopes = new Map<string, WallScope>(workOrders.map((row) => [row.id, { companyId: row.companyId, siteId: row.siteId, partyId: null, wallPartyId: row.partyId ?? EVERY_PARTY_MARKER }]))
  const held = new Set<string>()
  for (const one of named) {
    const scope = scopes.get(one.workOrderId)
    if (!scope || !mayOnThread(actor, THREADS_READ, 'WorkOrder', scope)) held.add(one.messageId)
  }
  return held
}
