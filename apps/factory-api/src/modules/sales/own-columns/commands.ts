import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { isCustomer } from '@nexus/factory-domain/parties/rules'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import {
  choicesRowOf,
  holdsValue,
  isUseOn,
  newColumnProblem,
  ownValueFields,
  OWN_COLUMN_WORDS,
  useProblem,
  USE_OFF_FROM,
  type ColumnRefusal,
  type NewColumn,
  type OwnColumnKind,
  type UseRefusal,
} from '@nexus/factory-domain/sales/own-columns/rules'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { officeContextOf } from '../orders/access'
import { partnerOrder, portalReader } from '../portal-orders/access'
import { onDraft, ownDraft, requestView } from '../portal-ordering/requests'
import { officeDraftWriter, portalWriter, type DraftWriter } from '../portal-ordering/writer'
import { NO_OWN_COLUMNS, ownColumnsOf, type RecordOwnColumns } from './read'
import { columnView, COLUMN_SELECT, fieldsOf, lockParty, readPartyColumns, readRecordUses, recordLineIds, valueView, VALUE_SELECT, type OwnColumnView, type OwnValueView } from './store'

/**
 * The customer's own columns — commands and reads (owb- order workflow, S1 po1.4; design order-workflow § 5zi C, R62 a; PL-schema § 5A
 * row 5, guard G8; the rules: factory-domain sales/own-columns/rules). Two doors, the same rules:
 *
 *   portal  the customer's portal people who keep drafts (portal.orderDrafts.edit: the Buyer, the Designer, the Admin), inside their
 *           party (row-level security; the partner role writes the three tables of its own party). An ORDER's columns and values
 *           also need portal.salesOrders.view (who reads the orders: never the Designer). A preview writes nothing.
 *   office  orders.manage (orders.view to read) over the company and THAT customer (can() first: out of reach is 404, as a wrong id)
 *
 *   GET  /portal/own-columns                                   → { columns }                 office: GET /sales/own-columns?partyId=
 *   POST /portal/own-columns            { name, kind, choices? } → OwnColumn (201)          office: POST /sales/own-columns { partyId, … }
 *   POST /portal/own-columns/:columnId/close  { version }      → OwnColumn                   office: POST /sales/own-columns/:columnId/close
 *   PUT  /portal/order-requests/:requestId/own-columns { version, columnIds, dropValues? } → the draft record (a DRAFT's: its version moves)
 *                                                                                           office: PUT /sales/order-requests/:requestId/own-columns
 *   PUT  /portal/sales-orders/:orderId/own-columns { columnIds, dropValues? } → { ownColumns } office: PUT /sales/orders/:orderId/own-columns
 *   PUT  /portal/own-values { line: { kind, id }, columnId, value, version? } → OwnValue      office: PUT /sales/own-values
 *
 * Refusals: 400 a name of 1 to 40, a value of the column's kind (words) · 404 another customer's column, record or line · 409 words:
 * a duplicate name, a fixed column's name, a choice column with fewer than 2 choices, more than 8 columns on one order, a closed
 * column, a column with values switched off without `dropValues`, a value on a column that is not on the order, a stale version.
 * Every write is audited with from → to (a value: on the record's own history, action ownColumns.setValue). Writes of one customer
 * run one at a time (a lock per customer: one value per column and line, one use per column and record are the API's).
 */

type Locale = 'it' | 'en'

/** Who writes and for which customer. */
interface ColumnsDoor {
  readonly door: 'portal' | 'office'
  readonly app: FastifyInstance
  readonly request: FastifyRequest
  readonly partyId: string
  /** The audit row's company (the portal's; the office: the record's, else the customer's own or none). */
  readonly companyId: string | null
  readonly userId: string
  readonly locale: Locale
  scoped<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
}

function portalDoor(app: FastifyInstance, request: FastifyRequest, write: boolean): ColumnsDoor & { readonly actor: ReturnType<typeof portalReader>['actor'] } {
  const reader = portalReader(app, request)
  if (write && reader.session.preview) throw new ForbiddenError('A preview of the portal changes nothing.')
  return { door: 'portal', app, request, partyId: reader.session.partyId, companyId: reader.session.company.id, userId: reader.session.userId, locale: partnerLocaleOf(reader.session.person.locale), actor: reader.actor, scoped: (work) => request.withClient(work) }
}

/** The office over ONE customer (and a record's company): orders.view to see it (else 404), `permission` to act (else 403). */
function officeDoor(app: FastifyInstance, request: FastifyRequest, scope: { readonly partyId: string; readonly companyId: string | null }, permission: Permission, what = 'Customer'): ColumnsDoor {
  const context = officeContextOf(request)
  const actor = actorOf(context)
  const record = { partyId: scope.partyId, ...(scope.companyId ? { companyId: scope.companyId } : {}) }
  if (!can(actor, ORDERS_VIEW, record)) throw new NotFoundError(`${what} not found.`)
  if (!can(actor, permission, record)) throw new ForbiddenError()
  return { door: 'office', app, request, partyId: scope.partyId, companyId: scope.companyId, userId: context.actorId, locale: 'en', scoped: (work) => request.withClient(work) }
}

/** The office's customer: one of the tenant's customers (else 404), with its own company (null: every company). */
async function officeCustomerDoor(app: FastifyInstance, request: FastifyRequest, partyId: string, permission: Permission): Promise<ColumnsDoor> {
  officeContextOf(request)
  const party = isUuid(partyId) ? await request.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, roles: true } })) : null
  if (!party || !isCustomer(party.roles)) throw new NotFoundError('Customer not found.')
  return officeDoor(app, request, { partyId: party.id, companyId: party.companyId }, permission)
}

/** A DraftWriter's own door (the draft's customer and company, the writer's person and words). */
const writerDoor = (writer: DraftWriter): ColumnsDoor => ({ door: writer.door, app: writer.app, request: writer.request, partyId: writer.partyId, companyId: writer.companyId, userId: writer.userId, locale: writer.locale, scoped: writer.scoped })

const columnRefused = (refusal: ColumnRefusal, locale: Locale): DomainError => (refusal.key === 'NAME' ? new ValidationError(refusal.words[locale], [{ path: 'body/name', message: refusal.words[locale] }]) : new DomainError('conflict', refusal.words[locale], [{ path: `refusal/${refusal.key}`, message: refusal.words[locale] }]))
function useRefused(refusal: UseRefusal, locale: Locale): DomainError {
  if (refusal.key === 'UNKNOWN') return new NotFoundError('Column not found.')
  return new DomainError('conflict', refusal.words[locale], [{ path: `refusal/${refusal.key}`, message: refusal.words[locale] }, ...(refusal.key === 'HAS_VALUES' ? [{ path: `body/columnIds/${refusal.columnId}`, message: refusal.words[locale] }] : [])])
}
const said = (words: { readonly en: string; readonly it: string }, locale: Locale): string => words[locale]

// ---- the customer's columns ---------------------------------------------------------------------------------------------------------

async function listColumns(door: ColumnsDoor): Promise<{ columns: OwnColumnView[] }> {
  return { columns: (await door.scoped((client) => readPartyColumns(client, door.partyId))).map(columnView) }
}

async function createColumn(door: ColumnsDoor, body: NewColumn, idempotencyKey?: string): Promise<OwnColumnView> {
  const open = async (db: FactoryClient | CommandTx) => (await readPartyColumns(db, door.partyId)).filter((column) => column.closedAt === null).map((column) => column.name)
  const first = newColumnProblem(body, await door.scoped((client) => open(client)))
  if (first) throw columnRefused(first, door.locale)
  const id = newId()
  await commandOn(door.app, door.request, { name: 'ownColumns.create', idempotencyKey, input: { partyId: door.partyId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, door.partyId)
    const again = newColumnProblem(body, await open(tx))
    if (again) throw columnRefused(again, door.locale)
    const top = await tx.partyLineColumn.aggregate({ where: { partyId: door.partyId }, _max: { seq: true } })
    const choices = choicesRowOf(body)
    await tx.partyLineColumn.create({ data: { id, partyId: door.partyId, name: body.name.trim(), kind: body.kind, choices, seq: (top._max.seq ?? 0) + 1, createdById: door.userId, createdAt: now, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'ownColumns.create', recordType: 'PartyLineColumn', recordId: id, companyId: door.companyId, after: { partyId: door.partyId, name: body.name.trim(), kind: body.kind, choices } })
    return null
  })
  return columnView(await door.scoped((client) => client.partyLineColumn.findUniqueOrThrow({ where: { id }, select: COLUMN_SELECT })))
}

/** A column is never deleted: closed, kept with its values (no new use, no new value). Closed already: as it is. */
async function closeColumn(door: ColumnsDoor, columnId: string, version: number, idempotencyKey?: string): Promise<OwnColumnView> {
  const column = isUuid(columnId) ? await door.scoped((client) => client.partyLineColumn.findFirst({ where: { id: columnId, partyId: door.partyId }, select: COLUMN_SELECT })) : null
  if (!column) throw new NotFoundError('Column not found.')
  if (column.closedAt !== null) return columnView(column)
  await commandOn(door.app, door.request, { name: 'ownColumns.close', idempotencyKey, input: { columnId, version }, record: { type: 'PartyLineColumn', id: column.id, expectedVersion: version } }, async (tools) => {
    await tools.tx.partyLineColumn.update({ where: { id: column.id }, data: { closedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'ownColumns.close', recordType: 'PartyLineColumn', recordId: column.id, companyId: door.companyId, before: { closed: false }, after: { closed: true } })
    return null
  })
  return columnView(await door.scoped((client) => client.partyLineColumn.findUniqueOrThrow({ where: { id: column.id }, select: COLUMN_SELECT })))
}

// ---- the columns on a record --------------------------------------------------------------------------------------------------------

/** The value rows of these lines (of a request or of an order). */
const linesWhere = (record: { readonly requestId?: string; readonly orderId?: string }, lineIds: readonly string[]): Prisma.OrderLineOwnValueWhereInput => (record.requestId ? { portalOrderRequestLineId: { in: [...lineIds] } } : { salesOrderLineId: { in: [...lineIds] } })

export interface UseBody {
  readonly columnIds: readonly string[]
  readonly dropValues?: boolean | undefined
}

/**
 * Inside a command: the record uses exactly these columns, in this order (at most 8). A column switched on again takes its old row
 * back; one switched off keeps its row at a place from USE_OFF_FROM on (no delete grant: see the rules), its values cleared only with
 * `dropValues` (refused in words otherwise). The audit row is on the record's own history (ownColumns.use: before → after).
 */
async function useColumnsInCommand(tools: CommandTools, door: ColumnsDoor, record: { readonly requestId?: string; readonly orderId?: string; readonly companyId: string }, body: UseBody): Promise<void> {
  const { tx, now } = tools
  await lockParty(tx, door.partyId)
  const columns = await readPartyColumns(tx, door.partyId)
  const byId = new Map(columns.map((column) => [column.id, { name: column.name, closed: column.closedAt !== null }]))
  const uses = await readRecordUses(tx, record)
  const onNow = uses.filter((use) => isUseOn(use.seq)).map((use) => use.columnId)
  const lineIds = await recordLineIds(tx, record)
  const held = lineIds.length === 0 || onNow.length === 0 ? [] : await tx.orderLineOwnValue.findMany({ where: { AND: [linesWhere(record, lineIds), { columnId: { in: onNow } }] }, select: VALUE_SELECT })
  const withValues = new Set(held.filter((value) => holdsValue(fieldsOf(value))).map((value) => value.columnId))
  const dropValues = body.dropValues ?? false
  const refusal = useProblem({ asked: body.columnIds, columns: byId, onNow, withValues, dropValues })
  if (refusal) throw useRefused(refusal, door.locale)
  for (const [index, columnId] of body.columnIds.entries()) {
    const use = uses.find((entry) => entry.columnId === columnId)
    if (use) {
      if (use.seq !== index + 1) await tx.orderLineColumnUse.update({ where: { id: use.id }, data: { seq: index + 1, version: { increment: 1 } }, select: { id: true } })
    } else {
      await tx.orderLineColumnUse.create({ data: { id: newId(), companyId: record.companyId, partyId: door.partyId, salesOrderId: record.orderId ?? null, portalOrderRequestId: record.requestId ?? null, columnId, seq: index + 1, createdById: door.userId, createdAt: now, updatedAt: now }, select: { id: true } })
    }
  }
  const off = uses.filter((use) => isUseOn(use.seq) && !body.columnIds.includes(use.columnId))
  for (const [index, use] of off.entries()) await tx.orderLineColumnUse.update({ where: { id: use.id }, data: { seq: USE_OFF_FROM + index, version: { increment: 1 } }, select: { id: true } })
  const dropped = off.map((use) => use.columnId).filter((columnId) => withValues.has(columnId))
  if (dropped.length > 0) await tx.orderLineOwnValue.updateMany({ where: { AND: [linesWhere(record, lineIds), { columnId: { in: dropped } }] }, data: { valueText: null, valueNumber: null, valueDate: null, valueBool: null, version: { increment: 1 } } })
  tools.audit({ action: 'ownColumns.use', recordType: record.requestId ? 'PortalOrderRequest' : 'SalesOrder', recordId: record.requestId ?? record.orderId!, companyId: record.companyId, before: { columnIds: onNow }, after: { columnIds: [...body.columnIds], added: body.columnIds.filter((columnId) => !onNow.includes(columnId)), droppedValuesOf: dropped } })
}

/** A DRAFT's columns (the draft's version moves, as every draft write; a sent draft's are frozen: ownDraft's words). */
async function useOnRequest(writer: DraftWriter, requestId: string, body: UseBody & { readonly version: number }, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const door = writerDoor(writer)
  await onDraft(writer, 'ownColumns.use', row, body.version, { requestId, ...body }, idempotencyKey, (tools) => useColumnsInCommand(tools, door, { requestId: row.id, companyId: row.companyId }, body))
  return requestView(writer, await ownDraft(writer, requestId))
}

/** An order's columns (no version: the order is the factory's; its columns are the customer's, they apply at once). */
async function useOnOrder(door: ColumnsDoor, order: { readonly id: string; readonly companyId: string; readonly status: string }, body: UseBody, idempotencyKey?: string): Promise<{ ownColumns: RecordOwnColumns }> {
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') throw new InvalidStateError(said(OWN_COLUMN_WORDS.ORDER_CLOSED, door.locale))
  await commandOn(door.app, door.request, { name: 'ownColumns.use', idempotencyKey, input: { orderId: order.id, ...body } }, (tools) => useColumnsInCommand(tools, door, { orderId: order.id, companyId: order.companyId }, body))
  return { ownColumns: (await door.scoped((client) => ownColumnsOf(client, { orderIds: [order.id] }))).get(order.id) ?? NO_OWN_COLUMNS }
}

// ---- a value ------------------------------------------------------------------------------------------------------------------------

export interface ValueBody {
  readonly line: { readonly kind: 'REQUEST_LINE' | 'ORDER_LINE'; readonly id: string }
  readonly columnId: string
  readonly value: string | number | boolean | null
  readonly version?: number | undefined
}

/** The line a value is on, its record, the record's customer and company, and whether a value may change there now. */
interface ValuePlace {
  readonly record: { readonly requestId?: string; readonly orderId?: string; readonly companyId: string }
  readonly partyId: string
  readonly lineId: string
  /** A DRAFT request (its screens are told of the change). */
  readonly draft: boolean
  readonly closedWords: { readonly en: string; readonly it: string } | null
}

/** The line, read in the reader's scope (a portal session: its party's only — another's is not found). */
async function valuePlace(db: FactoryClient, line: ValueBody['line']): Promise<ValuePlace> {
  if (!isUuid(line.id)) throw new NotFoundError('Line not found.')
  if (line.kind === 'REQUEST_LINE') {
    const found = await db.portalOrderRequestLine.findFirst({ where: { id: line.id, removedAt: null }, select: { id: true, partyId: true, requestId: true } })
    const request = found ? await db.portalOrderRequest.findUnique({ where: { id: found.requestId }, select: { id: true, companyId: true, partyId: true, status: true } }) : null
    if (!found || !request) throw new NotFoundError('Line not found.')
    const open = request.status === 'DRAFT' || request.status === 'SENT'
    return { record: { requestId: request.id, companyId: request.companyId }, partyId: request.partyId, lineId: found.id, draft: request.status === 'DRAFT', closedWords: open ? null : OWN_COLUMN_WORDS.REQUEST_DECIDED }
  }
  const found = await db.salesOrderLine.findFirst({ where: { id: line.id }, select: { id: true, orderId: true } })
  const order = found ? await db.salesOrder.findUnique({ where: { id: found.orderId }, select: { id: true, companyId: true, partyId: true, status: true } }) : null
  if (!found || !order) throw new NotFoundError('Line not found.')
  return { record: { orderId: order.id, companyId: order.companyId }, partyId: order.partyId, lineId: found.id, draft: false, closedWords: order.status === 'CLOSED' || order.status === 'CANCELLED' ? OWN_COLUMN_WORDS.ORDER_CLOSED : null }
}

/**
 * One value on one line, at once (also after Confirm: it moves no price and no promise). The column is the customer's, open and ON
 * the line's record; the value of its kind; a stale `version` is a 409. The history keeps from → to (the record's audit row).
 */
async function setValue(door: ColumnsDoor, place: ValuePlace, body: ValueBody, idempotencyKey?: string): Promise<OwnValueView> {
  if (place.closedWords) throw new InvalidStateError(said(place.closedWords, door.locale))
  const column = isUuid(body.columnId) ? await door.scoped((client) => client.partyLineColumn.findFirst({ where: { id: body.columnId, partyId: door.partyId }, select: COLUMN_SELECT })) : null
  if (!column) throw new NotFoundError('Column not found.')
  if (column.closedAt !== null) throw new DomainError('conflict', said(OWN_COLUMN_WORDS.CLOSED, door.locale), [{ path: 'refusal/CLOSED', message: said(OWN_COLUMN_WORDS.CLOSED, door.locale) }])
  const kind = column.kind as OwnColumnKind
  const parsed = ownValueFields(kind, column.choices, body.value)
  if (!parsed.ok) throw new ValidationError(said(parsed.words, door.locale), [{ path: 'body/value', message: said(parsed.words, door.locale) }])
  const valueWhere = { columnId: column.id, ...(place.record.requestId ? { portalOrderRequestLineId: place.lineId } : { salesOrderLineId: place.lineId }) }
  const { result } = await commandOn(door.app, door.request, { name: 'ownColumns.setValue', idempotencyKey, input: { ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, door.partyId)
    const on = (await readRecordUses(tx, place.record)).some((use) => use.columnId === column.id && isUseOn(use.seq))
    if (!on) throw new DomainError('conflict', said(OWN_COLUMN_WORDS.NOT_USED, door.locale), [{ path: 'refusal/NOT_USED', message: said(OWN_COLUMN_WORDS.NOT_USED, door.locale) }])
    const current = await tx.orderLineOwnValue.findFirst({ where: valueWhere, select: VALUE_SELECT })
    if (current && body.version !== undefined && body.version !== current.version) throw new StaleVersionError('OrderLineOwnValue', current.id, current.version, body.version)
    const fields = { valueText: parsed.fields.valueText, valueNumber: parsed.fields.valueNumber, valueDate: parsed.fields.valueDate === null ? null : new Date(`${parsed.fields.valueDate}T00:00:00.000Z`), valueBool: parsed.fields.valueBool }
    const saved = current
      ? await tx.orderLineOwnValue.update({ where: { id: current.id }, data: { ...fields, version: { increment: 1 } }, select: VALUE_SELECT })
      : await tx.orderLineOwnValue.create({ data: { id: newId(), partyId: door.partyId, ...valueWhere, ...fields, createdById: door.userId, createdAt: now, updatedAt: now }, select: VALUE_SELECT })
    const before = current ? valueView(kind, current).value : null
    const after = valueView(kind, saved).value
    tools.audit({ action: 'ownColumns.setValue', recordType: place.record.requestId ? 'PortalOrderRequest' : 'SalesOrder', recordId: place.record.requestId ?? place.record.orderId!, companyId: place.record.companyId, before: { lineId: place.lineId, columnId: column.id, name: column.name, value: before }, after: { lineId: place.lineId, columnId: column.id, name: column.name, value: after } })
    if (place.draft && place.record.requestId) tools.emit({ type: 'portal_order_request.draft_changed', subject: place.record.requestId, companyId: place.record.companyId, payload: { requestId: place.record.requestId, partyId: place.partyId } })
    return valueView(kind, saved)
  })
  return result
}

/** A stale value said in words (the record guard's message names only the version). */
async function valueInWords<T>(locale: Locale, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof StaleVersionError)) throw error
    const words = locale === 'it' ? 'Questo valore è cambiato da quando l’avete letto: rileggetelo.' : 'This value changed since you read it: read it again.'
    throw new DomainError('conflict', words, [{ path: 'body/version', message: `The current version is ${error.currentVersion}.` }])
  }
}

// ---- the routes' handlers -----------------------------------------------------------------------------------------------------------

/** An order the portal person may change the columns of: one of its party's (else 404) and one it reads (salesOrders.view, else 403). */
function assertPortalOrderReader(door: ReturnType<typeof portalDoor>): void {
  if (!can(door.actor, PORTAL_SALES_ORDERS_VIEW, { companyId: door.companyId ?? undefined, partyId: door.partyId })) throw new ForbiddenError('Orders are not part of your access: a Buyer or the Admin changes an order’s columns.')
}

export const portalListColumns = (app: FastifyInstance, request: FastifyRequest) => listColumns(portalDoor(app, request, false))
export const portalCreateColumn = (app: FastifyInstance, request: FastifyRequest, body: NewColumn, idempotencyKey?: string) => createColumn(portalDoor(app, request, true), body, idempotencyKey)
export const portalCloseColumn = (app: FastifyInstance, request: FastifyRequest, columnId: string, version: number, idempotencyKey?: string) => closeColumn(portalDoor(app, request, true), columnId, version, idempotencyKey)

export async function portalUseOnRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, body: UseBody & { readonly version: number }, idempotencyKey?: string) {
  const writer = portalWriter(app, request)
  if (writer.preview) throw new ForbiddenError('A preview of the portal changes nothing.')
  return useOnRequest(writer, requestId, body, idempotencyKey)
}

export async function portalUseOnOrder(app: FastifyInstance, request: FastifyRequest, orderId: string, body: UseBody, idempotencyKey?: string) {
  const door = portalDoor(app, request, true)
  assertPortalOrderReader(door)
  const order = await partnerOrder(request, portalReader(app, request), orderId) // the party's own order in the portal's company, else 404
  return useOnOrder(door, order, body, idempotencyKey)
}

export async function portalSetValue(app: FastifyInstance, request: FastifyRequest, body: ValueBody, idempotencyKey?: string): Promise<OwnValueView> {
  const door = portalDoor(app, request, true)
  if (body.line.kind === 'ORDER_LINE') assertPortalOrderReader(door)
  const place = await door.scoped((client) => valuePlace(client, body.line))
  if (place.partyId !== door.partyId || place.record.companyId !== door.companyId) throw new NotFoundError('Line not found.')
  return valueInWords(door.locale, () => setValue(door, place, body, idempotencyKey))
}

export const officeListColumns = async (app: FastifyInstance, request: FastifyRequest, partyId: string) => listColumns(await officeCustomerDoor(app, request, partyId, ORDERS_VIEW))
export const officeCreateColumn = async (app: FastifyInstance, request: FastifyRequest, body: NewColumn & { readonly partyId: string }, idempotencyKey?: string) => {
  const { partyId, ...column } = body
  return createColumn(await officeCustomerDoor(app, request, partyId, ORDERS_MANAGE), column, idempotencyKey)
}

export async function officeCloseColumn(app: FastifyInstance, request: FastifyRequest, columnId: string, version: number, idempotencyKey?: string) {
  officeContextOf(request)
  const column = isUuid(columnId) ? await request.withClient((client) => client.partyLineColumn.findUnique({ where: { id: columnId }, select: { partyId: true } })) : null
  if (!column) throw new NotFoundError('Column not found.')
  return closeColumn(await officeCustomerDoor(app, request, column.partyId, ORDERS_MANAGE), columnId, version, idempotencyKey)
}

export async function officeUseOnRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, body: UseBody & { readonly version: number }, idempotencyKey?: string) {
  const { writer } = await officeDraftWriter(app, request, requestId, ORDERS_MANAGE)
  return useOnRequest(writer, requestId, body, idempotencyKey)
}

export async function officeUseOnOrder(app: FastifyInstance, request: FastifyRequest, orderId: string, body: UseBody, idempotencyKey?: string) {
  officeContextOf(request)
  const order = isUuid(orderId) ? await request.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true, status: true } })) : null
  if (!order) throw new NotFoundError('Sales order not found.')
  return useOnOrder(officeDoor(app, request, { partyId: order.partyId, companyId: order.companyId }, ORDERS_MANAGE, 'Sales order'), order, body, idempotencyKey)
}

export async function officeSetValue(app: FastifyInstance, request: FastifyRequest, body: ValueBody, idempotencyKey?: string): Promise<OwnValueView> {
  officeContextOf(request)
  const place = await request.withClient((client) => valuePlace(client, body.line))
  const door = officeDoor(app, request, { partyId: place.partyId, companyId: place.record.companyId }, ORDERS_MANAGE, 'Line')
  return valueInWords(door.locale, () => setValue(door, place, body, idempotencyKey))
}
