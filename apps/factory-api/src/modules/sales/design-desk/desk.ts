import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { hasSmallPreview } from '../../../platform/files/thumbs/small'
import { openDesignerAsks } from '../../production/calls/asks'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { officeContextOf, seenOrdersWhere, seenRequestsWhere } from '../orders/access'
import { ORDER_RECORD, ownOrdersOf, REQUEST_RECORD } from '../orders/on-the-order'
import type { DesignDeskView } from './contract'

/**
 * owb-of2 step 4 (order workflow, plan.md § 5f "Design desk", R20; LF shared-asks: S5 00:36 openDesignerAsks, S3 07:43 placedOf):
 * GET /design-desk — the Factory designer's first page, four lists, each ONLY of the orders the caller may see (orders.view over the
 * order, or orders.view.own while on it: ../orders/on-the-order.ts — the ONE rule; ids in SQL). Needs orders.view or orders.view.own,
 * and files.read (the pictures and the files are the desk's work). No price, ever.
 *
 *   asked      the open orders (CONFIRMED · IN_PRODUCTION · READY · PARTLY_SHIPPED · PENDING_APPROVAL) and the Draft/Sent orders the
 *              designer works on: for a person with orders.view.own, its OWN follow rows — HELP_ASKED (asked in the thread: a mention,
 *              the "Ask the Factory designer" door), GIVEN (put on it by someone: "Give to the designer", the order's People, Confirm
 *              gives the office people), ON_IT (it follows by its own choice, or made or was assigned something) — and the customers it
 *              is the Factory designer (or backup) of: their confirmed open orders, CONFIRMED. For a reader with orders.view (Sales, the
 *              Owner): the same follow rows of each customer's Factory designer or backup, over every order it sees. Newest first, 200.
 *   approvals  the OPEN design approvals (PROOF on an order line, ARTWORK on the order) of the orders the caller sees, oldest first
 *   codes      "n of m placed" — null until S3's placement read (owb-ss2b `placedOf`) is on main: the web says one quiet line
 *   floor      the floor's open asks to the designer (ASK_LOGO · ASK_PATCH · ASK_UNCLEAR), read ONLY through S5's openDesignerAsks over
 *              the orders the caller sees, oldest first
 */

type Reader = FactoryClient

const DESK_ORDER_STATUSES: readonly SalesOrderStatus[] = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']
const SEEN_MAX = 2000
const ASKED_MAX = 200
const WHY_RANK = { HELP_ASKED: 0, GIVEN: 1, ON_IT: 2, CONFIRMED: 3 } as const
type Why = keyof typeof WHY_RANK

/** A follow row's reason as the desk says why. */
const whyOf = (reason: string): Why => (reason === 'MENTIONED' ? 'HELP_ASKED' : reason === 'ADDED' ? 'GIVEN' : 'ON_IT')

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** GET /design-desk (see the file's head). */
export async function designDesk(caller: CommandCaller): Promise<DesignDeskView> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if ((!holds(actor, ORDERS_VIEW) && !holds(actor, ORDERS_VIEW_OWN)) || !holds(actor, FILES_READ)) throw new ForbiddenError()
  return caller.withClient(async (client) => {
    const own = await ownOrdersOf(client, context)
    const orders = await client.salesOrder.findMany({
      where: { AND: [seenOrdersWhere(context, own), { status: { in: [...DESK_ORDER_STATUSES] } }] },
      select: { id: true, number: true, companyId: true, partyId: true, status: true, createdAt: true, pictureFileId: true, party: { select: { code: true, legalName: true } }, portalOrderRequests: { select: { subject: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SEEN_MAX,
    })
    const requests = await client.portalOrderRequest.findMany({
      where: { AND: [seenRequestsWhere(context, own), { status: { in: ['DRAFT', 'SENT'] } }] },
      select: { id: true, number: true, partyId: true, createdAt: true, subject: true, pictureFileId: true, party: { select: { code: true, legalName: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SEEN_MAX,
    })
    const orderIds = orders.map((order) => order.id)
    const lines = orderIds.length > 0 ? await client.salesOrderLine.findMany({ where: { orderId: { in: orderIds }, kind: { not: 'FEE' } }, select: { id: true, orderId: true, styleId: true }, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] }) : []

    // ---- (a) asked ----
    const designersOf = new Map<string, string[]>()
    const slots = await client.portalSettings.findMany({ where: { OR: [{ factoryDesignerId: { not: null } }, { factoryDesignerBackupId: { not: null } }] }, select: { partyId: true, factoryDesignerId: true, factoryDesignerBackupId: true } })
    for (const slot of slots) designersOf.set(slot.partyId, [slot.factoryDesignerId, slot.factoryDesignerBackupId].filter((value): value is string => value !== null))
    const watchers = own !== null ? [context.actorId] : unique([...designersOf.values()].flat())
    const follows = watchers.length > 0
      ? await client.recordFollower.findMany({
          where: { userId: { in: watchers }, OR: [{ recordType: ORDER_RECORD, recordId: { in: orderIds } }, { recordType: REQUEST_RECORD, recordId: { in: requests.map((request) => request.id) } }] },
          select: { recordType: true, recordId: true, userId: true, reason: true, createdAt: true },
        })
      : []
    const partyOfRecord = new Map<string, string>([...orders.map((order) => [order.id, order.partyId] as const), ...requests.map((request) => [request.id, request.partyId] as const)])
    const asked = new Map<string, { kind: 'ORDER' | 'REQUEST'; why: Why; since: Date }>()
    const keep = (recordId: string, kind: 'ORDER' | 'REQUEST', why: Why, since: Date) => {
      const before = asked.get(recordId)
      if (!before || WHY_RANK[why] < WHY_RANK[before.why]) asked.set(recordId, { kind, why, since })
    }
    for (const follow of follows) {
      // For Sales: a follow counts only when it is the record's own customer's designer (or backup).
      if (own === null && !(designersOf.get(partyOfRecord.get(follow.recordId) ?? '') ?? []).includes(follow.userId)) continue
      keep(follow.recordId, follow.recordType === ORDER_RECORD ? 'ORDER' : 'REQUEST', whyOf(follow.reason), follow.createdAt)
    }
    if (own !== null) {
      // The customers the designer is the Factory designer (or backup) of: their confirmed open orders.
      const mine = new Set([...designersOf.entries()].filter(([, people]) => people.includes(context.actorId)).map(([partyId]) => partyId))
      for (const order of orders) if (mine.has(order.partyId) && order.status !== 'PENDING_APPROVAL') keep(order.id, 'ORDER', 'CONFIRMED', order.createdAt)
    }
    const askedRows = [...asked.entries()].sort(([, a], [, b]) => b.since.getTime() - a.since.getTime()).slice(0, ASKED_MAX)
    const firstStyle = new Map<string, string>()
    for (const line of lines) if (!firstStyle.has(line.orderId)) firstStyle.set(line.orderId, line.styleId)
    const askedRequestIds = askedRows.filter(([, row]) => row.kind === 'REQUEST').map(([id]) => id)
    if (askedRequestIds.length > 0) {
      for (const line of await client.portalOrderRequestLine.findMany({ where: { requestId: { in: askedRequestIds }, removedAt: null, styleId: { not: null } }, select: { requestId: true, styleId: true }, orderBy: [{ requestId: 'asc' }, { seq: 'asc' }] })) {
        if (line.styleId && !firstStyle.has(line.requestId)) firstStyle.set(line.requestId, line.styleId)
      }
    }
    const records = askedRows.map(([id, row]) => {
      const order = row.kind === 'ORDER' ? orders.find((entry) => entry.id === id) : undefined
      const request = row.kind === 'REQUEST' ? requests.find((entry) => entry.id === id) : undefined
      return { id, row, order, request, pictureFileId: order?.pictureFileId ?? request?.pictureFileId ?? null }
    })
    const pictures = await picturesOf(client, actor, records.map((record) => ({ id: record.id, pictureFileId: record.pictureFileId, styleId: firstStyle.get(record.id) ?? null })))

    // ---- (b) the open design approvals of the orders it sees ----
    const lineIds = lines.map((line) => line.id)
    const orderOfLine = new Map(lines.map((line) => [line.id, line.orderId]))
    const approvals = orderIds.length > 0
      ? await client.approvalRequest.findMany({
          where: { status: 'OPEN', kind: { in: ['PROOF', 'ARTWORK'] }, OR: [{ recordType: 'SalesOrder', recordId: { in: orderIds } }, ...(lineIds.length > 0 ? [{ recordType: 'SalesOrderLine', recordId: { in: lineIds } }] : [])] },
          select: { id: true, recordType: true, recordId: true, kind: true, status: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: ASKED_MAX,
        })
      : []
    const orderOf = new Map(orders.map((order) => [order.id, order]))

    // ---- (d) the floor's asks to the designer, through S5's read, per company of the orders it sees ----
    const floor: DesignDeskView['floor'] = []
    for (const companyId of unique(orders.map((order) => order.companyId))) {
      const ids = orders.filter((order) => order.companyId === companyId).map((order) => order.id)
      for (const ask of await openDesignerAsks(client, { companyId, orderIds: ids })) {
        floor.push({ callId: ask.callId, orderNumber: ask.salesOrderId ? (orderOf.get(ask.salesOrderId)?.number ?? null) : null, what: ask.typeCode, since: ask.since, state: ask.state })
      }
    }
    floor.sort((a, b) => a.since.localeCompare(b.since))

    return {
      asked: records.flatMap((record) => {
        const party = record.order?.party ?? record.request?.party
        if (!party) return []
        return [{
          kind: record.row.kind,
          id: record.id,
          number: record.order?.number ?? record.request?.number ?? null,
          subject: record.order ? (record.order.portalOrderRequests[0]?.subject ?? null) : (record.request?.subject ?? null),
          party: { code: party.code, name: party.legalName },
          why: record.row.why,
          since: toUtcIso(record.row.since),
          picture: pictures.get(record.id) ?? null,
        }]
      }),
      approvals: approvals.flatMap((approval) => {
        const orderId = approval.recordType === 'SalesOrder' ? approval.recordId : orderOfLine.get(approval.recordId)
        const order = orderId ? orderOf.get(orderId) : undefined
        if (!order) return []
        return [{ approvalId: approval.id, orderId: order.id, number: order.number, subject: order.portalOrderRequests[0]?.subject ?? null, kind: approval.kind as 'PROOF' | 'ARTWORK', sentAt: toUtcIso(approval.createdAt), state: approval.status }]
      }),
      // S3's placedOf (owb-ss2b) is not on main yet: null, the web says one quiet line.
      codes: null,
      floor,
    }
  })
}

/** Each record's picture: its own (a file the reader may open), else its first line's design picture. */
async function picturesOf(client: Reader, actor: Actor, records: readonly { readonly id: string; readonly pictureFileId: string | null; readonly styleId: string | null }[]): Promise<Map<string, DesignDeskView['asked'][number]['picture']>> {
  const out = new Map<string, DesignDeskView['asked'][number]['picture']>()
  if (records.length === 0) return out
  const chosenIds = unique(records.flatMap((record) => (record.pictureFileId ? [record.pictureFileId] : [])))
  const chosen = chosenIds.length > 0
    ? await client.storedFile.findMany({ where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput, { id: { in: chosenIds }, status: 'AVAILABLE' }] }, select: { id: true, contentType: true, thumbnailKey: true } })
    : []
  const chosenOf = new Map(chosen.map((file) => [file.id, file]))
  const thumbnails = await mainPictureThumbnails(client, actor, unique(records.flatMap((record) => (record.styleId ? [record.styleId] : []))))
  const thumbIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
  const thumbFiles = new Map(thumbIds.length > 0 ? (await client.storedFile.findMany({ where: { id: { in: thumbIds } }, select: { id: true, contentType: true, thumbnailKey: true } })).map((file) => [file.id, file]) : [])
  for (const record of records) {
    const thumbnail = record.styleId ? thumbnails.get(record.styleId) : undefined
    const file = (record.pictureFileId ? chosenOf.get(record.pictureFileId) : undefined) ?? (thumbnail ? thumbFiles.get(thumbnail.fileId) : undefined)
    if (file) out.set(record.id, { fileId: file.id, contentType: file.contentType, small: hasSmallPreview(file) })
  }
  return out
}
