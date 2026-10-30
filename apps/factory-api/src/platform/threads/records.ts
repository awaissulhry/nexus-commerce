import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../core/command'

/**
 * Which records have a thread, and whose they are (plan A1 §2.3; COL-001). A thread takes its company, site and party
 * from its RECORD, never from the caller: nobody can file a record's conversation under another company (where its
 * staff would not see it) or share it with another party. Each record type that has a thread names a resolver here,
 * which reads the record in the caller's office scope and answers its scope, or null when there is no such record.
 *
 * A module adds its records in the same change that gives them a thread panel, one line each:
 *   Quote: async (tx, id) => scopeOf(await tx.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })),
 * W0 knows the tenancy core's own records. Tests add made-up types with `useThreadRecords`.
 */

export interface RecordScope {
  /** The record's company; null for a tenant-wide record. */
  readonly companyId: string | null
  /** The record's site, when it sits on one. */
  readonly siteId: string | null
  /** The record's customer, supplier or subcontractor: the only party its shared messages may reach. */
  readonly partyId: string | null
}

export type RecordResolver = (client: FactoryClient | CommandTx, recordId: string) => Promise<RecordScope | null>

export const THREAD_RECORDS: Readonly<Record<string, RecordResolver>> = Object.freeze({
  Company: async (client, id) => ((await client.company.findUnique({ where: { id }, select: { id: true } })) ? { companyId: id, siteId: null, partyId: null } : null),
  Site: async (client, id) => {
    const site = await client.site.findUnique({ where: { id }, select: { companyId: true } })
    return site ? { companyId: site.companyId, siteId: id, partyId: null } : null
  },
  // modules/parties (SCR-033, SCR-057 Activity and Documents; B-W1-07): the party's company (none: tenant-wide) and the
  // party itself, so its shared messages reach its own contacts only; a known contact's mail without a thread joins it
  // (platform/email-in/match.ts PARTY_RECORD).
  Party: async (client, id) => {
    const party = await client.party.findUnique({ where: { id }, select: { companyId: true } })
    return party ? { companyId: party.companyId, siteId: null, partyId: id } : null
  },
  // platform/auth (SCR-011, SCR-012, SCR-013; B-W0-27): an office person and a role are tenant-wide; a floor device and a
  // floor worker sit on their site. Admin records take internal notes only (no party).
  User: async (client, id) => ((await client.user.findUnique({ where: { id }, select: { id: true } })) ? { companyId: null, siteId: null, partyId: null } : null),
  Role: async (client, id) => ((await client.role.findUnique({ where: { id }, select: { id: true } })) ? { companyId: null, siteId: null, partyId: null } : null),
  Device: async (client, id) => {
    const device = await client.device.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return device ? { companyId: device.companyId, siteId: device.siteId, partyId: null } : null
  },
  Worker: async (client, id) => {
    const worker = await client.worker.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return worker ? { companyId: worker.companyId, siteId: worker.siteId, partyId: null } : null
  },
  // platform/admin/connections (B-W0-28, SCR-087): an outside service's account, of a company or tenant-wide.
  IntegrationAccount: async (client, id) => {
    const account = await client.integrationAccount.findUnique({ where: { id }, select: { companyId: true } })
    return account ? { companyId: account.companyId, siteId: null, partyId: null } : null
  },
  // modules/compliance/certificates (SCR-051): the holder company (none: brand-held); the party only when a brand holds
  // it (the brand is the legal maker), not a supplier holding a protector's certificate.
  Certificate: async (client, id) => {
    const certificate = await client.certificate.findUnique({ where: { id }, select: { companyId: true, holderPartyId: true, holderParty: { select: { roles: true } } } })
    if (!certificate) return null
    return { companyId: certificate.companyId, siteId: null, partyId: certificate.holderParty?.roles.includes('BRAND') ? certificate.holderPartyId : null }
  },
  // modules/product/styles (SCR-041): the style's company (none: tenant-wide); the party is the brand a private-label
  // style is made for, so its tech-pack questions can be shared with that brand only.
  Style: async (client, id) => {
    const style = await client.style.findUnique({ where: { id }, select: { companyId: true, brandPartyId: true } })
    return style ? { companyId: style.companyId, siteId: null, partyId: style.brandPartyId } : null
  },
  // modules/invoicing (SCR-081; B-W1-50 the courtesy copy of an invoice SDI could not deliver): the seller company and
  // the customer (its buyer), so the copy and its replies stay with that customer.
  Invoice: async (client, id) => {
    const invoice = await client.invoice.findUnique({ where: { id }, select: { companyId: true, buyerPartyId: true } })
    return invoice ? { companyId: invoice.companyId, siteId: null, partyId: invoice.buyerPartyId } : null
  },
  // modules/sales/quotes (SCR-034; B-W1-24 the quote mail with its PDF and the acceptance confirmation): the selling
  // company and the customer.
  Quote: async (client, id) => {
    const quote = await client.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return quote ? { companyId: quote.companyId, siteId: null, partyId: quote.partyId } : null
  },
  // modules/purchasing (SCR-059; B-W1-30 the order mail with its PDF and confirm link, the cancellation): the buying company,
  // the delivery site and the supplier, so the order's mail and the supplier's replies stay with that supplier.
  PurchaseOrder: async (client, id) => {
    const order = await client.purchaseOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return order ? { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId } : null
  },
  // modules/purchasing/subcontracting (SCR-129 Activity; B-W2a-25): the company, the work order's site and the workshop.
  SubcontractOrder: async (client, id) => {
    const order = await client.subcontractOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return order ? { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId } : null
  },
  // modules/purchasing/claims (SCR-131 the claim's Activity tab; B-W2a-44 the claim mailed to the supplier): the company,
  // the site the goods are at and the supplier, so the claim's mail and the supplier's replies stay with that supplier.
  SupplierClaim: async (client, id) => {
    const claim = await client.supplierClaim.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return claim ? { companyId: claim.companyId, siteId: claim.siteId, partyId: claim.partyId } : null
  },
  // modules/sales/orders (SCR-039 Activity; B-W1-25): the selling company and the customer.
  SalesOrder: async (client, id) => {
    const order = await client.salesOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return order ? { companyId: order.companyId, siteId: null, partyId: order.partyId } : null
  },
  // modules/production/work-orders (SCR-070 Activity; B-W1-38 part 2): the work order's company and site; no party (a work
  // order may make the lines of several customers' orders, so its thread stays internal).
  WorkOrder: async (client, id) => {
    const workOrder = await client.workOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return workOrder ? { companyId: workOrder.companyId, siteId: workOrder.siteId, partyId: null } : null
  },
  // modules/shipping (SCR-067; B-W1-49 the documents link mail): the shipment's company, site and party (its customer),
  // so its mail and the customer's replies stay with that customer.
  Shipment: async (client, id) => {
    const shipment = await client.shipment.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return shipment ? { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId } : null
  },
  // modules/compliance/register (SCR-113 Actions; B-W1-43 the corrective actions and the distributor/authority log): the
  // register's company and the party that reported the entry (none: internal).
  PpeRegisterEntry: async (client, id) => {
    const entry = await client.ppeRegisterEntry.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return entry ? { companyId: entry.companyId, siteId: null, partyId: entry.partyId } : null
  },
  // modules/quality/lab (SCR-075; B-W1-34 the lot's quality status timeline): the lot's company, site and supplier.
  Lot: async (client, id) => {
    const lot = await client.lot.findUnique({ where: { id }, select: { companyId: true, siteId: true, supplierId: true } })
    return lot ? { companyId: lot.companyId, siteId: lot.siteId, partyId: lot.supplierId } : null
  },
  // modules/inventory/receipts (SCR-063 the receipt's Activity tab; B-W1-32 part 2): the receiving company and site and the
  // supplier, so its notes and the supplier's mail about the delivery stay with that supplier.
  GoodsReceipt: async (client, id) => {
    const receipt = await client.goodsReceipt.findUnique({ where: { id }, select: { companyId: true, siteId: true, supplierId: true } })
    return receipt ? { companyId: receipt.companyId, siteId: receipt.siteId, partyId: receipt.supplierId } : null
  },
  // modules/quality/holds (SCR-078 the Hold record's Activity tab; B-W2a-26): the hold's company and site; notes only.
  QualityHold: async (client, id) => {
    const hold = await client.qualityHold.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return hold ? { companyId: hold.companyId, siteId: hold.siteId, partyId: null } : null
  },
  // B-W2a-47: an NCR's thread is internal (its supplier hears through the supplier claim, not here).
  Nonconformance: async (client, id) => {
    const ncr = await client.nonconformance.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return ncr ? { companyId: ncr.companyId, siteId: ncr.siteId, partyId: null } : null
  },
  // modules/plant (SCR-148, SCR-149, SCR-150 the records' Activity tab; B-W2a-35): the machine's company and site; notes
  // only (a machine's supplier is no party of its maintenance).
  Machine: async (client, id) => {
    const machine = await client.machine.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return machine ? { companyId: machine.companyId, siteId: machine.siteId, partyId: null } : null
  },
  MaintenanceRequest: async (client, id) => {
    const request = await client.maintenanceRequest.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return request ? { companyId: request.companyId, siteId: request.siteId, partyId: null } : null
  },
  MaintenanceJob: async (client, id) => {
    const job = await client.maintenanceJob.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return job ? { companyId: job.companyId, siteId: job.siteId, partyId: null } : null
  },
  // modules/sales/returns (SCR-112 the Return's Activity tab; B-W2a-43): the selling company, the site the goods come back
  // to and the customer, so the return's notes and the customer's mail about it stay with that customer.
  ReturnAuthorisation: async (client, id) => {
    const rma = await client.returnAuthorisation.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return rma ? { companyId: rma.companyId, siteId: rma.siteId, partyId: rma.partyId } : null
  },
})

let extra: Readonly<Record<string, RecordResolver>> = {}

/**
 * Test only: more record types, or another resolver for a known one (a made-up `Quote` with a party: these win over the
 * module's own). `undefined` removes them again.
 */
export function useThreadRecords(resolvers: Readonly<Record<string, RecordResolver>> | undefined): void {
  extra = resolvers ?? {}
}

/** The record's scope, or null when its type has no thread or the record does not exist (for this caller). */
export async function resolveRecord(client: FactoryClient | CommandTx, recordType: string, recordId: string): Promise<RecordScope | null> {
  const resolver = Object.hasOwn(extra, recordType) ? extra[recordType] : Object.hasOwn(THREAD_RECORDS, recordType) ? THREAD_RECORDS[recordType] : undefined
  return resolver ? resolver(client, recordId) : null
}
