import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { columnIdOf } from '@nexus/factory-domain/fields/access'
import { FIELD_LIMITS } from '@nexus/factory-domain/fields/rules'
import type { StoredValue } from '@nexus/factory-domain/fields/values'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'
import { BULK_LIMITS, type BulkRefusal, type BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../../core/command'
import { actorOf } from '../../../../core/context'
import { officeContextOf } from '../../../../modules/sales/orders/access'
import { customRecordOf, recordFactsOf } from '../../../fields/records'
import { fieldsOfModel, fieldsSeen, saidInWords, valuesOfRecords, writeValuesInCommand, type FieldRow } from '../../../fields/registry'
import { defineBulkTarget, type BulkTargetField } from '../target'

/**
 * Sales › Orders, the sheet's cells (B-TH-060; threads plan TH-4, SHEET-G09; design O-SAL-ORD-LIST.grid-F26, SHEET.brand-fields-F03
 * and -F08; wall W17): the order's office note (column `note`) and its custom values (columns `cf:<code>`: the custom fields of
 * orders THIS person sees — of every customer, or of one customer it reaches (B-TH-056) — TEXT, NUMBER, DATE, SELECT and YES_NO;
 * a money, multi-select, person, link or file field is changed in the order's own custom section). The order's lines never: they
 * change only through an amendment.
 *
 * Each row is ONE command, sales.orders.editCells (orders.manage over the order's company and customer): the order locked by the
 * version the person reviewed (the list's row version: every cell write moves it, so a second person's edit is "stale", never
 * overwritten), the note written, the custom values written through platform/fields' own write (its checks, its audit row per
 * value, custom_value.changed), and one audit row of the cells. A CLOSED or CANCELLED order keeps every cell (the database freezes
 * it). W17: a field for one customer is no field of another customer's order — held as `invalid` on such a row in the preview, and
 * refused by the fields' own write (a field the person does not see at all is no field of the list: 400, never told it exists).
 */

const LIST_KEY = 'sales.orders'
const FINAL = ['CLOSED', 'CANCELLED']
/** The office note in a cell: the bulk text limit (a longer note than this stays as it is: the cell holds at most this much). */
const NOTE_MAX = Math.min(MAX_TEXT.internalNote, BULK_LIMITS.text)
/** The custom field types a cell edits. */
const IN_CELL = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'YES_NO'] as const

const SELECT = { id: true, number: true, status: true, version: true, companyId: true, partyId: true, internalNote: true } as const satisfies Prisma.SalesOrderSelect

interface Row {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly version: number
  readonly companyId: string
  readonly partyId: string
  readonly internalNote: string | null
  /** The custom values the person sees, by column id, as a cell shows them. */
  readonly custom: Readonly<Record<string, BulkValue>>
}

/** A stored custom value as a cell holds it (YES_NO as YES / NO). */
const cellValueOf = (field: FieldRow, value: StoredValue | null): BulkValue => {
  if (value === null || value === undefined) return null
  if (field.type === 'YES_NO') return value === true ? 'YES' : 'NO'
  return typeof value === 'string' || typeof value === 'number' ? value : null
}
/** A cell's value as the field stores it. */
const storedValueOf = (field: FieldRow, value: BulkValue): unknown => (value === null ? null : field.type === 'YES_NO' ? value === 'YES' : value)

/** The custom fields of orders this person edits in a cell. */
async function cellFields(client: CommandTx | Prisma.TransactionClient, caller: CommandCaller): Promise<FieldRow[]> {
  const actor = actorOf(officeContextOf(caller))
  return fieldsSeen(actor, await fieldsOfModel(client as Prisma.TransactionClient, 'SalesOrder')).filter((field) => (IN_CELL as readonly string[]).includes(field.type) && field.audience !== 'MONEY')
}

const held = (row: Row): BulkRefusal | null => (FINAL.includes(row.status) ? { code: 'held', status: row.status } : null)

/** One custom field as a cell of the list. */
function cellOf(field: FieldRow): BulkTargetField<Row> {
  const column = columnIdOf(field)
  const base = { nullable: !field.required, read: (row: Row) => row.custom[column] ?? null }
  // W17: a field of one company or one customer is no field of another's order.
  const fieldHeld = (row: Row): BulkRefusal | null => held(row) ?? ((field.companyId !== null && field.companyId !== row.companyId) || (field.partyId !== null && field.partyId !== row.partyId) ? { code: 'invalid', field: column } : null)
  switch (field.type) {
    case 'NUMBER':
      return { ...base, kind: 'number', held: fieldHeld }
    case 'DATE':
      return { ...base, kind: 'date', held: fieldHeld }
    case 'SELECT':
      return { ...base, kind: 'choice', choices: field.options.map((option) => option.code), held: fieldHeld }
    case 'YES_NO':
      return { ...base, kind: 'choice', choices: ['YES', 'NO'], held: fieldHeld }
    default:
      return { ...base, kind: 'text', maxLength: Math.min(FIELD_LIMITS.text, BULK_LIMITS.text), held: fieldHeld }
  }
}

async function rowsOf(client: CommandTx | Prisma.TransactionClient, caller: CommandCaller, where: Prisma.SalesOrderWhereInput): Promise<Row[]> {
  const orders = await client.salesOrder.findMany({ where, select: SELECT })
  if (orders.length === 0) return []
  const fields = await cellFields(client, caller)
  const values = await valuesOfRecords(client as Prisma.TransactionClient, 'SalesOrder', orders.map((order) => order.id), fields.map((field) => field.id))
  return orders.map((order) => {
    const own = values.get(order.id)
    return { ...order, custom: Object.fromEntries(fields.flatMap((field) => (own?.has(field.id) ? [[columnIdOf(field), cellValueOf(field, own.get(field.id)!.value)] as const] : []))) }
  })
}

export const salesOrders = defineBulkTarget<Row>({
  listKey: LIST_KEY,
  permission: ORDERS_MANAGE,
  fields: {
    note: { kind: 'text', nullable: true, maxLength: NOTE_MAX, read: (row) => row.internalNote, held },
  },
  async fieldsFor(caller) {
    const fields = await caller.withClient((client) => cellFields(client as unknown as Prisma.TransactionClient, caller))
    return Object.fromEntries(fields.map((field) => [columnIdOf(field), cellOf(field)]))
  },
  async load(caller, ids) {
    const wanted = ids.filter(isUuid)
    if (wanted.length === 0) return []
    const actor = actorOf(officeContextOf(caller))
    return caller.withClient((client) => rowsOf(client as unknown as Prisma.TransactionClient, caller, { AND: [scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput, { id: { in: wanted } }] }))
  },
  idOf: (row) => row.id,
  labelOf: (row) => row.number,
  versionOf: (row) => row.version,
  statusOf: (row) => row.status,
  rowHeld: (caller, row) => (can(actorOf(officeContextOf(caller)), ORDERS_MANAGE, { companyId: row.companyId, partyId: row.partyId }) ? null : { code: 'forbidden' }),
  async write(caller, row, changes, version, idempotencyKey) {
    const context = officeContextOf(caller)
    const actor = actorOf(context)
    const { result } = await command(caller, { name: 'sales.orders.editCells', idempotencyKey, input: { orderId: row.id, version, changes } }, async (tools) =>
      saidInWords(async () => {
        const order = await tools.tx.salesOrder.findUnique({ where: { id: row.id }, select: SELECT })
        if (!order || !can(actor, ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
        if (order.version !== version) throw new StaleVersionError('SalesOrder', order.id, order.version, version)
        if (FINAL.includes(order.status)) throw new InvalidStateError(`Sales order ${order.number} is ${order.status.toLowerCase()}: it never changes.`)
        const fields = new Map((await cellFields(tools.tx, caller)).map((field) => [columnIdOf(field), field]))
        // The custom values through platform/fields' own write (W17: a field of another customer is no field of this order).
        const asked = Object.keys(changes).flatMap((column) => (fields.has(column) ? [{ column, field: fields.get(column)! }] : []))
        let written = { set: [] as string[], cleared: [] as string[] }
        if (asked.length > 0) {
          const record = customRecordOf('ORDER')!
          const facts = (await recordFactsOf(tools.tx as unknown as Prisma.TransactionClient, 'SalesOrder', [order.id])).get(order.id)!
          const current = (await valuesOfRecords(tools.tx as unknown as Prisma.TransactionClient, 'SalesOrder', [order.id], asked.map((entry) => entry.field.id))).get(order.id)
          written = await writeValuesInCommand(tools, record, facts, asked.map(({ field, column }) => ({ code: field.code, value: storedValueOf(field, changes[column] ?? null), version: current?.get(field.id)?.version ?? null })), actor, context.actorId)
        }
        const note = Object.hasOwn(changes, 'note') ? (changes.note === null ? null : String(changes.note).trim() || null) : order.internalNote
        const noteChanged = note !== order.internalNote
        const changed = noteChanged || written.set.length > 0 || written.cleared.length > 0
        if (changed) {
          // The row's version moves with every cell write, so the list's next edit of this row checks against it.
          const { count } = await tools.tx.salesOrder.updateMany({ where: { id: order.id, version }, data: { ...(noteChanged ? { internalNote: note } : {}), version: version + 1, updatedAt: tools.now } })
          if (count !== 1) throw new ConflictError(`Sales order ${order.number} changed since it was read: reload it and try again.`)
        }
        tools.audit({
          action: 'sales.orders.editCells',
          recordType: 'SalesOrder',
          recordId: order.id,
          companyId: order.companyId,
          before: { version, ...(noteChanged ? { internalNote: order.internalNote } : {}) },
          after: { version: changed ? version + 1 : version, ...(noteChanged ? { internalNote: note } : {}), set: written.set, cleared: written.cleared },
        })
        return { orderId: order.id }
      }),
    )
    const [after] = await caller.withClient((client) => rowsOf(client as unknown as Prisma.TransactionClient, caller, { id: result.orderId }))
    if (!after) throw new NotFoundError('Sales order not found.')
    return after
  },
})
