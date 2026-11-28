import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PORTAL_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { orderLifeOf, type LifeNote, type OrderLife } from '@nexus/factory-domain/sales/order-life'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { choicesOf } from '@nexus/factory-domain/sales/portal-ordering/choices'
import { lineModelOf, materialOf, sizesText, type LineModel } from '@nexus/factory-domain/sales/portal-ordering/line-moves'
import { PORTAL_ORDER_DRAFTS_EDIT, PORTAL_ORDER_REQUESTS_MANAGE } from '@nexus/factory-domain/sales/portal-ordering/permissions'
import { DESIGN_APPROVAL_KINDS, DRAFT_ROW_WORDS, isLate, waitsOf, type SheetRowKind, type SheetWait } from '@nexus/factory-domain/sales/portal-orders/sheet-rows'
import type { CustomerOrderStatus } from '@nexus/factory-domain/sales/portal-orders/status'
import { unreadCounts, UNREAD_MAX } from '../../../platform/threads/reads'
import { columnsUsedBy, NO_OWN_COLUMNS, ownColumnsOf, type RecordOwnColumns } from '../own-columns/read'
import type { OwnColumnView, OwnValueView } from '../own-columns/store'
import { piecesOfLine } from '../portal-ordering/people'
import { listRequests } from '../portal-ordering/requests'
import { readLines as readDraftLines, readPeople as readDraftPeople } from '../portal-ordering/store'
import { portalWriter } from '../portal-ordering/writer'
import type { PortalReader } from './access'
import type { PortalOrderList } from './orders'
import { readLines as readOrderLines, readShipments } from './store'
import { atWarehouseOf } from '../../shipping/warehouse-leg/portal' // owb- po2.6 (S3's ss1, imported)

/**
 * The portal orders sheet's rows as ONE order (owb- order workflow, S1 po1.1; design § 5b, § 5zi C, § 5zj A; the S1 build's FIXED
 * Shape "SHEET"). On top of GET /portal/sales-orders/sheet's rows (./sheet.ts):
 *
 *   drafts       the party's DRAFT requests become rows (kind DRAFT, status null) — read by the partner read of portal-ordering
 *                (listRequests: the party's own rows by row-level security), never a tenant read by party; only for a reader who
 *                keeps drafts (portal.orderDrafts.edit), on the first page of the OPEN and ALL chips, at the top, filtered by the
 *                search (their subject, title or PO). A Sent order (REQUEST) was a row already: it gets its page now.
 *   every row    `page` (the order page it opens: order or request), `life` + `lifeNote` (the base's nine words, orderLifeOf), `lines`
 *                (the C rows: model, material, sizes, pieces, own values; a draft line taken out counts nowhere; a fee line is no
 *                model), `ownColumnIds` (the columns ON it, in order), `waits` (unread messages, a design waiting for the customer's
 *                yes, its open asks, a draft's Still open items, late), `may` (edit, send, delete, take back, picture)
 *   the answer   `ownColumns`: the columns any row on the page uses, each once
 *
 * Walls: the partner's own rows first (row-level security), then the tenant's names of ONLY the styles of its own label or of our
 * own collection (brand wall); no price in any of these facts (the money wall: the sheet has no price column for anybody); no office
 * series (a row's `number` stays null, as ./orders.ts says); no worker, no office person.
 */

type ListItem = PortalOrderList['answer']['items'][number]

/** A sheet row before its facts: a list row, or a Draft (kind DRAFT, no customer status). */
export type SheetItem = Omit<ListItem, 'kind' | 'status'> & { readonly kind: SheetRowKind; readonly status: CustomerOrderStatus | null }

export interface SheetLine {
  readonly id: string
  readonly seq: number
  readonly model: LineModel
  readonly material: string | null
  readonly sizes: string | null
  readonly pieces: number
  readonly ownValues: Record<string, OwnValueView>
}

export interface SheetFacts {
  readonly page: { readonly kind: 'order' | 'request'; readonly id: string }
  readonly life: OrderLife
  readonly lifeNote: LifeNote | null
  readonly lines: SheetLine[]
  readonly ownColumnIds: string[]
  readonly waits: { kind: SheetWait; count: number | null }[]
  readonly may: { readonly edit: boolean; readonly send: boolean; readonly delete: boolean; readonly takeBack: boolean; readonly picture: boolean }
}

/** What the draft rows say beside their row (from the portal-ordering read). */
interface DraftFacts {
  readonly openCount: number
  readonly startedByReader: boolean
}

/** A shipment at the factory's warehouse that waits for the customer's label: arrived there, not sent on, no label yet. */
const waitsForLabel = (leg: { readonly since: string | null; readonly sentOn: boolean; readonly labelSent: boolean } | undefined): boolean => leg !== undefined && leg.since !== null && !leg.sentOn && !leg.labelSent

/** The search of a draft row: its subject, title or PO (a number alone: a PO holding it; a draft has no number of its own). */
function draftFound(q: string | undefined, words: readonly (string | null)[]): boolean {
  const text = q?.trim() ?? ''
  if (text === '') return true
  if (/^#\d{1,9}$/.test(text)) return false
  return words.some((value) => value !== null && value.toLowerCase().includes(text.toLowerCase()))
}

/** The party's drafts as sheet rows (see the file's head), each with what its row needs to say beside it. */
export async function draftRows(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, q: string | undefined): Promise<{ readonly rows: SheetItem[]; readonly facts: Map<string, DraftFacts> }> {
  const scope = { companyId: reader.session.company.id, partyId: reader.session.partyId }
  if (!can(reader.actor, PORTAL_ORDER_DRAFTS_EDIT, scope)) return { rows: [], facts: new Map() }
  const { requests } = await listRequests(portalWriter(app, request), { status: 'DRAFT' })
  const found = requests.filter((row) => row.status === 'DRAFT' && draftFound(q, [row.subject, row.draft?.title ?? null, row.customerRef]))
  const rows: SheetItem[] = found.map((row) => ({
    kind: 'DRAFT',
    id: row.id,
    customerRef: row.customerRef,
    subject: row.subject ?? row.draft?.title ?? null,
    // Never an office series (a draft taken back keeps its request number: not the customer's to read).
    number: null,
    yourNumber: null,
    orderedOn: null,
    status: null,
    words: { ...DRAFT_ROW_WORDS },
    promiseDate: null,
    originalPromiseDate: null,
    promiseMoved: false,
    movedLately: false,
    requestedDate: row.requestedDate,
    pieces: { ordered: row.pieces, shipped: 0, open: row.pieces },
    netAmount: asMoney('price', null as number | null),
    currency: row.currency,
    nextShipment: null,
    progressPercent: null,
    needsYou: false,
  }))
  return { rows, facts: new Map(found.map((row) => [row.id, { openCount: row.draft?.openCount ?? 0, startedByReader: row.draft?.startedBy.who === 'YOU' }])) }
}

/** The facts of every row of the page and the columns they use (see the file's head). */
export async function sheetFacts(request: FastifyRequest, reader: PortalReader, items: readonly SheetItem[], drafts: ReadonlyMap<string, DraftFacts>, today: BusinessDate): Promise<{ readonly facts: Map<string, SheetFacts>; readonly ownColumns: OwnColumnView[] }> {
  const partyId = reader.session.partyId
  const scope = { companyId: reader.session.company.id, partyId }
  const orderIds = items.filter((item) => item.kind === 'ORDER').map((item) => item.id)
  const requestIds = items.filter((item) => item.kind !== 'ORDER').map((item) => item.id)
  const sentIds = items.filter((item) => item.kind === 'REQUEST').map((item) => item.id)
  const seesDesigns = can(reader.actor, PORTAL_APPROVALS_VIEW, scope)
  // The partner's own rows (row-level security: the party's only).
  const own = await request.withClient(async (client) => ({
    orders: orderIds.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true } }) : [],
    orderLines: await readOrderLines(client, orderIds),
    requestLines: await readDraftLines(client, requestIds),
    people: await readDraftPeople(client, requestIds),
    columns: await ownColumnsOf(client, { requestIds, orderIds }),
    designs: seesDesigns && orderIds.length > 0 ? await client.approvalRequest.findMany({ where: { recordType: 'SalesOrder', recordId: { in: orderIds }, status: 'OPEN', kind: { in: [...DESIGN_APPROVAL_KINDS] } }, select: { recordId: true } }) : [],
    asks: orderIds.length > 0 ? await client.orderChangeRequest.findMany({ where: { orderId: { in: orderIds }, status: { in: ['OPEN', 'COUNTERED'] } }, select: { orderId: true } }) : [],
    // owb- po2.6: the page's orders' shipments (a shared one is on every order it carries), for "Send the shipping label".
    shipments: await readShipments(client, orderIds),
  }))
  const styleIds = [...new Set([...own.orderLines.map((line) => line.styleId), ...own.requestLines.flatMap((line) => (line.styleId ? [line.styleId] : []))])]
  const colourwayIds = [...new Set([...own.orderLines.map((line) => line.colourwayId), ...own.requestLines.flatMap((line) => (line.colourwayId ? [line.colourwayId] : []))])]
  // The tenant's names of the customer's own label and our own collection only (the brand wall), and whether the factory works on
  // a Sent order's design (a yes/no: never a style id reaches the portal).
  const tenant = await reader.inTenant(async (client) => {
    const styles = styleIds.length > 0 ? await client.style.findMany({ where: { id: { in: styleIds }, OR: [{ brandPartyId: null }, { brandPartyId: partyId }] }, select: { id: true, code: true, name: true, brandPartyId: true } }) : []
    const allowed = styles.map((style) => style.id)
    const colourways = colourwayIds.length > 0 && allowed.length > 0 ? await client.colourway.findMany({ where: { id: { in: colourwayIds }, styleId: { in: allowed } }, select: { id: true, name: true } }) : []
    const started = sentIds.length > 0 ? await client.portalOrderRequest.findMany({ where: { id: { in: sentIds }, partyId }, select: { id: true, styleIds: true } }) : []
    // owb- po2.6 (S3's seam): which of those shipments wait at the factory's warehouse for the customer's label (arrived, not sent on).
    const legs = await atWarehouseOf(client, { partyId, shipmentIds: own.shipments.map((row) => row.id) })
    return { styles: new Map(styles.map((style) => [style.id, style])), colourways: new Map(colourways.map((colourway) => [colourway.id, colourway.name])), started: new Set(started.filter((row) => row.styleIds.length > 0).map((row) => row.id)), legs }
  })
  const unread = new Map(
    (
      await unreadCounts(
        request,
        items.slice(0, UNREAD_MAX).map((item) => ({ type: item.kind === 'ORDER' ? 'SalesOrder' : 'PortalOrderRequest', id: item.id })),
      )
    ).counts.map((count) => [count.recordId, count.newCount]),
  )
  const statusOf = new Map(own.orders.map((order) => [order.id, order.status as SalesOrderStatus]))
  const count = (ids: readonly string[]) => ids.reduce((map, id) => map.set(id, (map.get(id) ?? 0) + 1), new Map<string, number>())
  const designs = count(own.designs.map((row) => row.recordId))
  const asks = count(own.asks.map((row) => row.orderId))
  const styleWords = (styleId: string | null) => {
    const style = styleId ? tenant.styles.get(styleId) : undefined
    return style ? `${style.code} ${style.name}`.trim() : null
  }
  const valuesOf = (columns: RecordOwnColumns, lineId: string): Record<string, OwnValueView> => ({ ...(columns.values[lineId] ?? {}) })
  const keepsDrafts = can(reader.actor, PORTAL_ORDER_DRAFTS_EDIT, scope) && !reader.session.preview
  const orders = can(reader.actor, PORTAL_ORDER_REQUESTS_MANAGE, scope) && !reader.session.preview
  const facts = new Map<string, SheetFacts>()
  for (const item of items) {
    const columns = own.columns.get(item.id) ?? NO_OWN_COLUMNS
    let lines: SheetLine[]
    let answer: { life: OrderLife; note: LifeNote | null }
    let may: SheetFacts['may']
    if (item.kind === 'ORDER') {
      lines = own.orderLines
        .filter((line) => line.orderId === item.id && line.kind !== 'FEE')
        .map((line) => ({
          id: line.id,
          seq: line.seq,
          model: lineModelOf({ styleId: tenant.styles.has(line.styleId) ? line.styleId : null, styleBrandPartyId: tenant.styles.get(line.styleId)?.brandPartyId ?? null, styleWords: styleWords(line.styleId), description: line.description, garmentType: null }, partyId),
          material: materialOf({ choices: null, colourwayName: tenant.colourways.get(line.colourwayId) ?? null }),
          sizes: sizesText(line.sizes) ?? line.baseSize,
          pieces: line.quantity,
          ownValues: valuesOf(columns, line.id),
        }))
      const raw = statusOf.get(item.id) ?? 'CONFIRMED'
      answer = orderLifeOf({ order: { status: raw, pieces: { shipped: item.pieces.shipped, total: item.pieces.ordered }, shipments: item.status === 'DELIVERED' ? { left: 1, delivered: 1 } : { left: 0, delivered: 0 } } })
      may = { edit: false, send: false, delete: false, takeBack: false, picture: keepsDrafts && raw !== 'CLOSED' && raw !== 'CANCELLED' }
    } else {
      lines = own.requestLines
        .filter((line) => line.requestId === item.id)
        .map((line) => ({
          id: line.id,
          seq: line.seq,
          model: lineModelOf({ styleId: line.styleId && tenant.styles.has(line.styleId) ? line.styleId : null, styleBrandPartyId: line.styleId ? (tenant.styles.get(line.styleId)?.brandPartyId ?? null) : null, styleWords: styleWords(line.styleId), description: line.description, garmentType: line.garmentType }, partyId),
          material: materialOf({ choices: choicesOf(line.choices), colourwayName: line.colourwayId ? (tenant.colourways.get(line.colourwayId) ?? null) : null }),
          sizes: line.byPerson ? null : sizesText(line.sizes),
          pieces: piecesOfLine(line, own.people),
          ownValues: valuesOf(columns, line.id),
        }))
      const draft = item.kind === 'DRAFT' ? drafts.get(item.id) : undefined
      answer = orderLifeOf({ request: { status: item.kind === 'DRAFT' ? 'DRAFT' : 'SENT' } })
      may =
        item.kind === 'DRAFT'
          ? { edit: keepsDrafts, send: orders, delete: !reader.session.preview && (orders || (keepsDrafts && (draft?.startedByReader ?? false))), takeBack: false, picture: keepsDrafts }
          : { edit: false, send: false, delete: false, takeBack: orders && !tenant.started.has(item.id), picture: keepsDrafts }
    }
    const draft = drafts.get(item.id)
    facts.set(item.id, {
      page: { kind: item.kind === 'ORDER' ? 'order' : 'request', id: item.id },
      life: answer.life,
      lifeNote: answer.note,
      lines,
      ownColumnIds: columns.used.map((column) => column.id),
      waits: waitsOf({
        NEW_MESSAGES: unread.get(item.id) ?? 0,
        DESIGN_APPROVAL: designs.get(item.id) ?? 0,
        ASKED: asks.get(item.id) ?? 0,
        // owb- po2.6: its shipments at the factory's warehouse that wait for the customer's label.
        SEND_LABEL: item.kind === 'ORDER' ? own.shipments.filter((row) => row.salesOrderIds.includes(item.id) && waitsForLabel(tenant.legs.get(row.id))).length : 0,
        OPEN_DETAILS: draft?.openCount ?? 0,
        LATE: isLate(item.status, item.promiseDate, today),
      }),
      may,
    })
  }
  return { facts, ownColumns: columnsUsedBy(own.columns.values()) }
}
