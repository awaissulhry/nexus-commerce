import type { Permission } from '../core/permissions'

/**
 * B-TH-047 (threads plan TH-3, N10, N25, X-G06; design O-SAL-INQ-LIST.list-F11/F14, X-PUR-ORD-LIST.grid-F01; wall W27, W30): ONE
 * view gate per thread record type — the permission its own record page is read with — and which side of the factory a record's
 * conversation waits on. Pure.
 *
 * A thread is read with threads.read over its record's scope (apps/factory-api platform/threads records.ts `mayOnThread`, with
 * B-TH-005's gates for people records and B-PR-08a's wall party). A list of conversations ACROSS records ("Customer replies" in
 * Incoming, "Supplier replies" on Purchasing › Orders) also asks each row's own view permission over that scope: a reader lists
 * only the conversations of records it may open (the production manager reads threads but no quotes: a quote's conversation is
 * never on its list). A record type without a gate here is listed to nobody (fail closed).
 *
 *   CUSTOMER side   the customer's records that are not Incoming's own rows: orders, quotes, invoices and reminders, shipments
 *                   and DDTs, returns, repairs, complaints, sample rounds, service cases, safety reports, the brand's private
 *                   styles and certificates, its 8Ds and its riders' measurement profiles
 *   SUPPLIER side   purchase and subcontract orders, supplier claims and invoices, goods receipts, lots
 *   either side     a party's own thread, a product change request, an approval request, a PPE register entry, a notice to a
 *                   distributor: by the party's roles (a customer or brand: CUSTOMER; a supplier or subcontractor: SUPPLIER)
 *
 * Incoming's own kinds (a request, a catalogue order, a change request) wait as Incoming's rows (factory-domain sales/incoming), so
 * they are never in "Customer replies" too.
 */

export const THREAD_VIEW_GATES: Readonly<Record<string, Permission>> = Object.freeze({
  Company: 'companies.view',
  Site: 'sites.view',
  Party: 'parties.view',
  User: 'users.view',
  Role: 'roles.view',
  Device: 'devices.view',
  Worker: 'workers.view',
  IntegrationAccount: 'integrations.view',
  Certificate: 'compliance.certificates.view',
  Style: 'product.styles.view',
  PaymentReminder: 'receivables.view',
  Invoice: 'invoices.view',
  Quote: 'quotes.view',
  PriceList: 'pricelists.view',
  PurchaseOrder: 'purchasing.view',
  SubcontractOrder: 'purchasing.view',
  SupplierClaim: 'purchasing.view',
  SupplierInvoice: 'payables.view',
  SalesOrder: 'orders.view',
  OrderChangeRequest: 'orders.view',
  WorkOrder: 'workorders.view',
  Shipment: 'shipping.view',
  PpeRegisterEntry: 'compliance.register.view',
  DistributorNotice: 'compliance.register.view',
  Lot: 'quality.lots.view',
  GoodsReceipt: 'inventory.stock.view',
  QualityHold: 'quality.holds.view',
  Nonconformance: 'quality.ncr.view',
  Machine: 'plant.view',
  MaintenanceRequest: 'plant.view',
  MaintenanceJob: 'plant.view',
  ReturnAuthorisation: 'sales.returns.view',
  RepairOrder: 'sales.repairs.view',
  Complaint: 'quality.complaints.view',
  StockCount: 'inventory.counts.view',
  Ddt: 'shipping.view',
  Team: 'people.view',
  Capa: 'quality.capa.view',
  ApprovalRequest: 'partners.approvals.view',
  ChangeRequest: 'product.changes.view',
  ChangeOrder: 'product.changes.view',
  SampleRound: 'sales.samples.view',
  ApprovalTask: 'approvals.view',
  Inquiry: 'sales.inquiries.view',
  ServiceCase: 'sales.service.view',
  ProductSafetyReport: 'sales.safety.view',
  MeasurementProfile: 'sales.measurements.view',
  PortalOrderRequest: 'orders.view',
  // B-TH-066: a project is read as its thread (threads.read over its company and outside company): no record view of its own.
  Project: 'threads.read',
  // B-TH-075's technical file (a thread record since #1571) had no gate: its page reads with the certificate register's view
  // (modules/compliance/techfiles manifest), so its conversation is listed with it (closes "every thread type has a view gate").
  TechnicalFile: 'compliance.certificates.view',
} satisfies Record<string, Permission>)

/** A record type's own view permission, or null: none known (never listed). */
export const viewGateOf = (recordType: string): Permission | null => (Object.hasOwn(THREAD_VIEW_GATES, recordType) ? THREAD_VIEW_GATES[recordType]! : null)

export const WAITING_SIDES = ['CUSTOMER', 'SUPPLIER'] as const
export type WaitingSide = (typeof WAITING_SIDES)[number]

/** The customer's records whose conversations "Customer replies" lists (never Incoming's own kinds). */
export const CUSTOMER_SIDE_TYPES = Object.freeze([
  'SalesOrder',
  'Quote',
  'Invoice',
  'PaymentReminder',
  'Shipment',
  'Ddt',
  'ReturnAuthorisation',
  'RepairOrder',
  'Complaint',
  'SampleRound',
  'ServiceCase',
  'ProductSafetyReport',
  'Style',
  'Certificate',
  'Capa',
  'MeasurementProfile',
] as const)

/** The supplier's records whose conversations "Supplier replies" lists. */
export const SUPPLIER_SIDE_TYPES = Object.freeze(['PurchaseOrder', 'SubcontractOrder', 'SupplierClaim', 'SupplierInvoice', 'GoodsReceipt', 'Lot'] as const)

/** Records of either side: the side is the party's (its roles). */
// B-TH-066: a project with an outside company waits on that company's side (an office-only project has no shared message: never listed).
export const EITHER_SIDE_TYPES = Object.freeze(['Party', 'ChangeRequest', 'ApprovalRequest', 'PpeRegisterEntry', 'DistributorNotice', 'Project'] as const)

/** Incoming's own rows (a request, a catalogue order, a change request): they wait there, never in "Customer replies". */
export const INCOMING_OWN_TYPES = Object.freeze(['Inquiry', 'PortalOrderRequest', 'OrderChangeRequest'] as const)

/** The record types a side's list reads (its own and the either-side ones). */
export function typesOfSide(side: WaitingSide): readonly string[] {
  return [...(side === 'CUSTOMER' ? CUSTOMER_SIDE_TYPES : SUPPLIER_SIDE_TYPES), ...EITHER_SIDE_TYPES]
}

/** Whether a party with these roles is on the side (a customer or brand; a supplier or subcontractor). Both: on both. */
export function partyOnSide(roles: readonly string[], side: WaitingSide): boolean {
  return side === 'CUSTOMER' ? roles.includes('CUSTOMER') || roles.includes('BRAND') : roles.includes('SUPPLIER') || roles.includes('SUBCONTRACTOR')
}

/** Whether a record type's conversation is on the side: by its type, or (either side) by its party's roles. */
export function onSide(recordType: string, side: WaitingSide, partyRoles: readonly string[]): boolean {
  if ((EITHER_SIDE_TYPES as readonly string[]).includes(recordType)) return partyOnSide(partyRoles, side)
  return (side === 'CUSTOMER' ? (CUSTOMER_SIDE_TYPES as readonly string[]) : (SUPPLIER_SIDE_TYPES as readonly string[])).includes(recordType)
}
