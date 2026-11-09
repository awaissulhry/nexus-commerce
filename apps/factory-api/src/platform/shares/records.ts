import type { FactoryClient } from '@nexus/factory-db'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { QUALITY_COMPLAINTS_MANAGE, QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { SALES_RETURNS_MANAGE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { SHARE_FIELDS, type ShareFieldKind } from '@nexus/factory-domain/shares/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandTx } from '../../core/command'

/**
 * The records a partner can be invited to, and what each shares (B-W2b-200; plan "each record type registers the fields it
 * shares; never cost, margin or pay"). One entry per record type a RECORD_INVITE link opens (factory-domain links/purposes,
 * shares/rules SHARE_FIELDS: the keys and their kinds): the record's own view and write permissions (seeing the shares of a
 * record takes its view, inviting its write, beside partners.shares.*), its reference as a partner reads it, and the shared
 * fields. Each `read` selects exactly the columns of its fields: never an amount, a cost, an internal note or an office
 * person. The record's company, site and party come from its thread resolver (platform/threads/records.ts): the partner
 * invited is the party the record's thread reaches.
 *
 * `read` runs in the office caller's scope for the office (a record the person's tenant does not hold is not found), and in
 * the tenant's system scope for an invited partner's page — after the share was checked live, never before.
 */

type Client = FactoryClient | CommandTx

/** One shared field: its key (factory-domain SHARE_FIELDS), its kind and its value (null when empty). */
export interface ShareField {
  readonly key: string
  readonly kind: ShareFieldKind
  readonly value: string | number | null
}

export interface ShareRecord {
  /** The record's own number or code as both sides read it (SO-2026-0042, AX-100). */
  readonly reference: string
  /** The partner's own reference for it (their PO, their claim), when the record keeps one. */
  readonly theirRef: string | null
  readonly fields: readonly ShareField[]
}

export interface ShareRecordAdapter {
  readonly recordType: string
  /** Seeing who is invited takes the record's view permission; inviting, changing and revoking its write permission. */
  readonly view: Permission
  readonly manage: Permission
  read(client: Client, recordId: string): Promise<ShareRecord | null>
}

const day = (value: Date | null): string | null => (value ? toUtcIso(value).slice(0, 10) : null)
const instant = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The fields of a record type in their registered order, from one row's values by key. */
function fieldsOf(recordType: string, values: Readonly<Record<string, string | number | null>>): ShareField[] {
  return (SHARE_FIELDS[recordType] ?? []).map(([key, kind]) => ({ key, kind, value: values[key] ?? null }))
}

function adapter(recordType: string, view: Permission, manage: Permission, read: (client: Client, id: string) => Promise<{ reference: string; theirRef: string | null; values: Record<string, string | number | null> } | null>): ShareRecordAdapter {
  return Object.freeze<ShareRecordAdapter>({
    recordType,
    view,
    manage,
    async read(client, recordId) {
      const row = await read(client, recordId)
      return row ? { reference: row.reference, theirRef: row.theirRef, fields: fieldsOf(recordType, row.values) } : null
    },
  })
}

export const SHARE_RECORDS: Readonly<Record<string, ShareRecordAdapter>> = Object.freeze({
  Style: adapter('Style', PRODUCT_STYLES_VIEW, PRODUCT_STYLES_MANAGE, async (client, id) => {
    const row = await client.style.findUnique({ where: { id }, select: { code: true, name: true, season: true, productType: true, status: true } })
    return row ? { reference: row.code, theirRef: null, values: { code: row.code, name: row.name, season: row.season, productType: row.productType, status: row.status } } : null
  }),
  Quote: adapter('Quote', QUOTES_VIEW, QUOTES_MANAGE, async (client, id) => {
    const row = await client.quote.findUnique({ where: { id }, select: { number: true, customerRef: true, status: true, currentRevision: true } })
    return row ? { reference: row.number, theirRef: row.customerRef, values: { number: row.number, theirRef: row.customerRef, status: row.status, revision: row.currentRevision } } : null
  }),
  SalesOrder: adapter('SalesOrder', ORDERS_VIEW, ORDERS_MANAGE, async (client, id) => {
    const row = await client.salesOrder.findUnique({ where: { id }, select: { number: true, customerRef: true, status: true, orderDate: true, requestedDate: true, promiseDate: true } })
    return row
      ? { reference: row.number, theirRef: row.customerRef, values: { number: row.number, theirRef: row.customerRef, status: row.status, orderDate: day(row.orderDate), requestedDate: day(row.requestedDate), promiseDate: day(row.promiseDate) } }
      : null
  }),
  PurchaseOrder: adapter('PurchaseOrder', PURCHASING_VIEW, PURCHASING_MANAGE, async (client, id) => {
    const row = await client.purchaseOrder.findUnique({ where: { id }, select: { number: true, supplierRef: true, status: true, revision: true, orderDate: true, requestedDate: true } })
    return row
      ? { reference: row.number, theirRef: row.supplierRef, values: { number: row.number, theirRef: row.supplierRef, status: row.status, revision: row.revision, orderDate: day(row.orderDate), requestedDate: day(row.requestedDate) } }
      : null
  }),
  SubcontractOrder: adapter('SubcontractOrder', PURCHASING_VIEW, PURCHASING_SUBCONTRACT_MANAGE, async (client, id) => {
    const row = await client.subcontractOrder.findUnique({ where: { id }, select: { number: true, status: true, orderDate: true, expectedBackDate: true } })
    return row ? { reference: row.number, theirRef: null, values: { number: row.number, status: row.status, orderDate: day(row.orderDate), expectedBackDate: day(row.expectedBackDate) } } : null
  }),
  Shipment: adapter('Shipment', SHIPPING_VIEW, SHIPPING_MANAGE, async (client, id) => {
    const row = await client.shipment.findUnique({ where: { id }, select: { number: true, status: true, carrierName: true, shippedAt: true, expectedDeliveryAt: true, deliveredAt: true } })
    return row
      ? { reference: row.number, theirRef: null, values: { number: row.number, status: row.status, carrier: row.carrierName, shippedAt: instant(row.shippedAt), expectedDeliveryAt: instant(row.expectedDeliveryAt), deliveredAt: instant(row.deliveredAt) } }
      : null
  }),
  Complaint: adapter('Complaint', QUALITY_COMPLAINTS_VIEW, QUALITY_COMPLAINTS_MANAGE, async (client, id) => {
    const row = await client.complaint.findUnique({ where: { id }, select: { number: true, customerRef: true, status: true, category: true, receivedAt: true, answerDueOn: true } })
    return row
      ? { reference: row.number, theirRef: row.customerRef, values: { number: row.number, theirRef: row.customerRef, status: row.status, category: row.category, receivedAt: instant(row.receivedAt), answerDueOn: day(row.answerDueOn) } }
      : null
  }),
  ReturnAuthorisation: adapter('ReturnAuthorisation', SALES_RETURNS_VIEW, SALES_RETURNS_MANAGE, async (client, id) => {
    const row = await client.returnAuthorisation.findUnique({ where: { id }, select: { number: true, customerRef: true, status: true, requestedAt: true, goodsDueBy: true } })
    return row ? { reference: row.number, theirRef: row.customerRef, values: { number: row.number, theirRef: row.customerRef, status: row.status, requestedAt: instant(row.requestedAt), goodsDueBy: day(row.goodsDueBy) } } : null
  }),
  SupplierClaim: adapter('SupplierClaim', PURCHASING_VIEW, PURCHASING_CLAIMS_MANAGE, async (client, id) => {
    const row = await client.supplierClaim.findUnique({ where: { id }, select: { number: true, kind: true, status: true, remedy: true, sentAt: true } })
    return row ? { reference: row.number, theirRef: null, values: { number: row.number, kind: row.kind, status: row.status, remedy: row.remedy, sentAt: instant(row.sentAt) } } : null
  }),
})

/** The adapter of a record type, or undefined when no partner can be invited to it. */
export const shareRecordOf = (recordType: string): ShareRecordAdapter | undefined => SHARE_RECORDS[recordType]
