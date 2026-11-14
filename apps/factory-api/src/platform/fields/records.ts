import type { Prisma } from '@nexus/factory-db'
import type { Permission, ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'

/**
 * The records that take custom fields (B-W2b-421; PLT-111): ONE line each. Every list frame, record form, filter, export
 * and import reads a record type's fields through platform/fields/registry.ts by this registry — a record type gains
 * custom fields here and nowhere else.
 *
 *   key          the record type in the API's addresses (`/fields/values/ORDER/:id`) and in Admin › Fields & lists
 *   model        the Prisma model (CustomField.recordType keeps it). Customers and suppliers are both a Party: a field
 *                on one is on the other (the schema has no party role on a field; see the step's notes)
 *   view, edit   the record's OWN permissions: reading its custom values needs `view` over the record (its company,
 *                site and party), writing them `edit` — never a permission of the fields area
 *   listKey      the list frame (and its export source) that shows the custom columns
 *   importer     the import of its custom values (platform/imports registry)
 *   keyColumn    the record's own code or number: the import's Record column and a link field's import value
 *   portal       whether a partner reads it in the portal (the fields shown in it, on the party's own record)
 */

export const CUSTOM_RECORD_KEYS = ['CUSTOMER', 'SUPPLIER', 'QUOTE', 'ORDER', 'STYLE', 'MATERIAL', 'PURCHASE_ORDER', 'LOT', 'WORK_ORDER'] as const
export type CustomRecordKey = (typeof CUSTOM_RECORD_KEYS)[number]

export const CUSTOM_MODELS = ['Party', 'Quote', 'SalesOrder', 'Style', 'Item', 'PurchaseOrder', 'Lot', 'WorkOrder'] as const
export type CustomModel = (typeof CUSTOM_MODELS)[number]

export interface CustomRecord {
  readonly key: CustomRecordKey
  readonly model: CustomModel
  readonly labelIt: string
  readonly labelEn: string
  readonly view: Permission
  readonly edit: Permission
  readonly listKey: string
  readonly importer: string
  readonly keyColumn: 'code' | 'number'
  readonly portal: boolean
}

export const CUSTOM_RECORDS: readonly CustomRecord[] = Object.freeze([
  { key: 'CUSTOMER', model: 'Party', labelIt: 'Cliente', labelEn: 'Customer', view: 'parties.view', edit: 'parties.manage', listKey: 'sales.customers', importer: 'fields.customers', keyColumn: 'code', portal: true },
  { key: 'QUOTE', model: 'Quote', labelIt: 'Preventivo', labelEn: 'Quote', view: 'quotes.view', edit: 'quotes.manage', listKey: 'sales.quotes', importer: 'fields.quotes', keyColumn: 'number', portal: true },
  { key: 'ORDER', model: 'SalesOrder', labelIt: 'Ordine', labelEn: 'Order', view: ORDERS_VIEW, edit: ORDERS_MANAGE, listKey: 'sales.orders', importer: 'fields.orders', keyColumn: 'number', portal: true },
  { key: 'STYLE', model: 'Style', labelIt: 'Modello', labelEn: 'Style', view: 'product.styles.view', edit: 'product.styles.manage', listKey: 'products.styles', importer: 'fields.styles', keyColumn: 'code', portal: false },
  { key: 'MATERIAL', model: 'Item', labelIt: 'Materiale', labelEn: 'Material', view: 'product.materials.view', edit: 'product.materials.manage', listKey: 'products.materials', importer: 'fields.materials', keyColumn: 'code', portal: false },
  { key: 'SUPPLIER', model: 'Party', labelIt: 'Fornitore', labelEn: 'Supplier', view: 'parties.view', edit: 'parties.manage', listKey: 'purchasing.suppliers', importer: 'fields.suppliers', keyColumn: 'code', portal: true },
  { key: 'PURCHASE_ORDER', model: 'PurchaseOrder', labelIt: 'Ordine di acquisto', labelEn: 'Purchase order', view: 'purchasing.view', edit: 'purchasing.manage', listKey: 'purchasing.orders', importer: 'fields.purchaseOrders', keyColumn: 'number', portal: true },
  { key: 'LOT', model: 'Lot', labelIt: 'Lotto', labelEn: 'Lot', view: 'inventory.stock.view', edit: 'inventory.lots.manage', listKey: 'warehouse.lots', importer: 'fields.lots', keyColumn: 'code', portal: false },
  { key: 'WORK_ORDER', model: 'WorkOrder', labelIt: 'Ordine di lavoro', labelEn: 'Work order', view: 'workorders.view', edit: 'workorders.manage', listKey: 'production.work-orders', importer: 'fields.workOrders', keyColumn: 'number', portal: false },
] satisfies readonly CustomRecord[])

const BY_KEY = new Map<string, CustomRecord>(CUSTOM_RECORDS.map((record) => [record.key, record]))

export const customRecordOf = (key: string): CustomRecord | undefined => BY_KEY.get(key)
/** The record types of a model (Party: customer and supplier). */
export const recordsOfModel = (model: string): readonly CustomRecord[] => CUSTOM_RECORDS.filter((record) => record.model === model)
export const isCustomModel = (model: string): model is CustomModel => (CUSTOM_MODELS as readonly string[]).includes(model)

// ---- reading the records themselves -----------------------------------------------------------------------------------

type Client = Prisma.TransactionClient

/** A record as the registry needs it: its scope (for can()), its code or number, and the words a link shows. */
export interface RecordFacts extends ScopedRecord {
  readonly id: string
  readonly companyId: string | null
  readonly key: string
  readonly label: string
}

interface ModelReader {
  findMany(args: { where: Record<string, unknown>; select: Record<string, true>; take?: number }): Promise<Record<string, unknown>[]>
}

/** What each model's row gives: scope columns, its code or number, a label (`JKT-01 · Giacca`). */
const MODEL_SHAPES: Readonly<Record<CustomModel, { readonly select: Record<string, true>; readonly facts: (row: Record<string, unknown>) => RecordFacts }>> = {
  Party: { select: { id: true, companyId: true, code: true, legalName: true }, facts: (row) => ({ id: row.id as string, companyId: (row.companyId as string | null) ?? null, partyId: row.id as string, key: row.code as string, label: `${String(row.code)} · ${String(row.legalName)}` }) },
  Quote: { select: { id: true, companyId: true, partyId: true, number: true }, facts: (row) => ({ id: row.id as string, companyId: row.companyId as string, partyId: row.partyId as string, key: row.number as string, label: row.number as string }) },
  SalesOrder: { select: { id: true, companyId: true, partyId: true, number: true }, facts: (row) => ({ id: row.id as string, companyId: row.companyId as string, partyId: row.partyId as string, key: row.number as string, label: row.number as string }) },
  Style: { select: { id: true, companyId: true, code: true, name: true }, facts: (row) => ({ id: row.id as string, companyId: (row.companyId as string | null) ?? null, key: row.code as string, label: `${String(row.code)} · ${String(row.name)}` }) },
  Item: { select: { id: true, companyId: true, code: true, name: true }, facts: (row) => ({ id: row.id as string, companyId: (row.companyId as string | null) ?? null, key: row.code as string, label: `${String(row.code)} · ${String(row.name)}` }) },
  PurchaseOrder: { select: { id: true, companyId: true, siteId: true, partyId: true, number: true }, facts: (row) => ({ id: row.id as string, companyId: row.companyId as string, siteId: row.siteId as string, partyId: row.partyId as string, key: row.number as string, label: row.number as string }) },
  Lot: { select: { id: true, companyId: true, siteId: true, code: true }, facts: (row) => ({ id: row.id as string, companyId: row.companyId as string, siteId: row.siteId as string, key: row.code as string, label: row.code as string }) },
  WorkOrder: { select: { id: true, companyId: true, siteId: true, number: true }, facts: (row) => ({ id: row.id as string, companyId: row.companyId as string, siteId: row.siteId as string, key: row.number as string, label: row.number as string }) },
}

const readerOf = (client: Client, model: CustomModel): ModelReader => (client as unknown as Record<string, ModelReader>)[model.charAt(0).toLowerCase() + model.slice(1)]!

/** The records of a model by id (the ones the client may see; RLS keeps the tenant). */
export async function recordFactsOf(client: Client, model: CustomModel, ids: readonly string[]): Promise<Map<string, RecordFacts>> {
  if (ids.length === 0) return new Map()
  const shape = MODEL_SHAPES[model]
  const rows = await readerOf(client, model).findMany({ where: { id: { in: [...new Set(ids)] } }, select: shape.select })
  return new Map(rows.map((row) => [row.id as string, shape.facts(row)]))
}

/**
 * The records of a record type by their code or number, in a company (null: tenant-wide master data is found in any
 * company's scope; a company's records only in theirs). Two records with one code in the scope: none is taken.
 */
export async function recordsByKey(client: Client, record: Pick<CustomRecord, 'model' | 'keyColumn'>, keys: readonly string[], companyId: string | null): Promise<Map<string, RecordFacts>> {
  if (keys.length === 0) return new Map()
  const shape = MODEL_SHAPES[record.model]
  const scope = companyId === null ? {} : { OR: [{ companyId }, ...(record.model === 'Party' || record.model === 'Style' || record.model === 'Item' ? [{ companyId: null }] : [])] }
  const rows = await readerOf(client, record.model).findMany({ where: { [record.keyColumn]: { in: [...new Set(keys)] }, ...scope }, select: shape.select })
  const found = new Map<string, RecordFacts[]>()
  for (const row of rows) {
    const facts = shape.facts(row)
    found.set(facts.key, [...(found.get(facts.key) ?? []), facts])
  }
  return new Map([...found].filter(([, list]) => list.length === 1).map(([key, list]) => [key, list[0]!]))
}
