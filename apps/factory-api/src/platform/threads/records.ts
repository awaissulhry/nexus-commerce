import type { FactoryClient } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors' // B-PR-08a
import { can, type Actor, type Permission, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../core/command'
// ---- B-PR-08a part 2: the customers a hold or an NCR names, and the one marker of several (the quality wall, B-PR-06).
import { isUuid } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_MARKER, holdCustomersOf, NCR_FACTS, ncrCustomersOf, NO_CUSTOMER, partyOfCustomers } from '../../modules/quality/wall'
// ---- end B-PR-08a

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
  // ---- B-PR-08a part 2: a NOT_SHAREABLE record's customer (a work order's, a hold's, an NCR's; the every-party marker for several or
  // none): who in the OFFICE reaches its thread (mayOnThread), never a party anything is shared with (partyId stays null).
  readonly wallPartyId?: string | null
  // ---- end B-PR-08a
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
  // modules/receivables (B-W2a-55): a payment reminder's e-mail goes out on its own thread, the company owed and the
  // customer (email out's EmailOutbound of recordType "PaymentReminder").
  PaymentReminder: async (client, id) => {
    const reminder = await client.paymentReminder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return reminder ? { companyId: reminder.companyId, siteId: null, partyId: reminder.partyId } : null
  },
  Quote: async (client, id) => {
    const quote = await client.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return quote ? { companyId: quote.companyId, siteId: null, partyId: quote.partyId } : null
  },
  // modules/sales/pricelists (SCR-106 the price list's Activity tab; B-W2a-49): the list's company (none: every company's
  // list); notes only (a list prices many customers, so its thread stays internal).
  PriceList: async (client, id) => {
    const list = await client.priceList.findUnique({ where: { id }, select: { companyId: true } })
    return list ? { companyId: list.companyId, siteId: null, partyId: null } : null
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
  // modules/payables (SCR-153 the supplier invoice's Activity; B-W2a-62 the differences sent to the buyer): the company it
  // is addressed to and the supplier or subcontractor that sent it.
  SupplierInvoice: async (client, id) => {
    const invoice = await client.supplierInvoice.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return invoice ? { companyId: invoice.companyId, siteId: null, partyId: invoice.partyId } : null
  },
  // modules/sales/orders (SCR-039 Activity; B-W1-25): the selling company and the customer.
  SalesOrder: async (client, id) => {
    const order = await client.salesOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return order ? { companyId: order.companyId, siteId: null, partyId: order.partyId } : null
  },
  // modules/sales/change-requests (B-W2b-183): a customer's change or cancel request of an order, the order's company and
  // customer (the office's notes on it; the answer itself reaches the customer through the portal and its mail).
  OrderChangeRequest: async (client, id) => {
    const request = await client.orderChangeRequest.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return request ? { companyId: request.companyId, siteId: null, partyId: request.partyId } : null
  },
  // modules/production/work-orders (SCR-070 Activity; B-W1-38 part 2): the work order's company and site; no party (a work
  // order may make the lines of several customers' orders, so its thread stays internal).
  // ---- B-PR-08a part 2: its customer (WorkOrder.partyId, B-PR-01) is its WALL party; a work order of none (mixed before the rule,
  // our own range) reaches only who reaches every customer (B-PR-03 reachesWorkOrder).
  WorkOrder: async (client, id) => {
    const workOrder = await client.workOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return workOrder ? { companyId: workOrder.companyId, siteId: workOrder.siteId, partyId: null, wallPartyId: workOrder.partyId ?? EVERY_PARTY_MARKER } : null
  },
  // ---- end B-PR-08a
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
  // modules/compliance/recall (B-W2b-260; RG1:02): a notice to a distributor, its mail and the distributor's reply: the
  // notice's company and its recipient (the party), so the reply comes back to this notice and is recorded as its answer.
  DistributorNotice: async (client, id) => {
    const notice = await client.distributorNotice.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return notice ? { companyId: notice.companyId, siteId: null, partyId: notice.partyId } : null
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
  // ---- B-PR-08a part 2: the WALL party of a hold is the customer of what it holds, of an NCR the customer of everything it names
  // (modules/quality/wall.ts): one → it; several, or customer work of none → every customer only; a lot, a hide → none.
  QualityHold: async (client, id) => {
    const hold = await client.qualityHold.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, subjectType: true, subjectIds: true } })
    if (!hold) return null
    return { companyId: hold.companyId, siteId: hold.siteId, partyId: null, wallPartyId: partyOfCustomers((await holdCustomersOf(client, [hold])).get(hold.id) ?? NO_CUSTOMER) }
  },
  // B-W2a-47: an NCR's thread is internal (its supplier hears through the supplier claim, not here).
  Nonconformance: async (client, id) => {
    const ncr = await client.nonconformance.findUnique({ where: { id }, select: NCR_FACTS })
    if (!ncr) return null
    return { companyId: ncr.companyId, siteId: ncr.siteId, partyId: null, wallPartyId: partyOfCustomers((await ncrCustomersOf(client, [ncr])).get(ncr.id) ?? NO_CUSTOMER) }
  },
  // ---- end B-PR-08a
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
  // modules/sales/repairs (SCR-112 the Repair order's Activity tab; B-W2a-57): the company, the repairing site and the
  // customer, so the repair's notes and the customer's mail about it stay with that customer.
  RepairOrder: async (client, id) => {
    const repair = await client.repairOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return repair ? { companyId: repair.companyId, siteId: repair.siteId, partyId: repair.partyId } : null
  },
  // modules/quality/complaints (SCR-113 the Complaint's Activity tab; B-W2a-65): the company the complaint is made to and the
  // customer, so its notes and the mail with the customer about it stay with that customer; no site (none is named).
  Complaint: async (client, id) => {
    const complaint = await client.complaint.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return complaint ? { companyId: complaint.companyId, siteId: null, partyId: complaint.partyId } : null
  },
  // B-W2b-15 (modules/inventory/counts, follow-up Z2:05): a stock count's thread, of its company and site; internal notes
  // only (no party).
  StockCount: async (client, id) => {
    const count = await client.stockCount.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return count ? { companyId: count.companyId, siteId: count.siteId, partyId: null } : null
  },
  // B-W2b-23 (search finds a DDT; it has no page of its own and opens its record panels): a DDT's thread, of its company,
  // site and recipient, as its shipment's.
  Ddt: async (client, id) => {
    const ddt = await client.ddt.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return ddt ? { companyId: ddt.companyId, siteId: ddt.siteId, partyId: ddt.partyId } : null
  },
  // modules/people (B-W2b-26; PLT-020: a team as a group, with its own notes): the team's company and site; internal notes
  // only (no party). NOT the employee record yet: a thread is read with threads.read over its company and site, so every
  // role that reads threads there would read notes about a person; it waits for a per-record read permission here.
  Team: async (client, id) => {
    const team = await client.team.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return team ? { companyId: team.companyId, siteId: team.siteId, partyId: null } : null
  },
  // B-W2b-108 (modules/quality/capa; the CAPA's Activity tab, its reminder and escalation tasks): the company it belongs
  // to, no site (one CAPA takes NCRs of several sites), and the customer an 8D is written for; internal CAPAs no party.
  Capa: async (client, id) => {
    const capa = await client.capa.findUnique({ where: { id }, select: { companyId: true, customerId: true } })
    return capa ? { companyId: capa.companyId, siteId: null, partyId: capa.customerId } : null
  },
  // B-W2b-184 (platform/approvals-out): an approval request's own conversation (an outside signer's answer, the questions
  // about a request whose record has no thread of its partner): its company and the partner asked.
  ApprovalRequest: async (client, id) => {
    const request = await client.approvalRequest.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return request ? { companyId: request.companyId, siteId: null, partyId: request.partyId } : null
  },
  // B-W2b-226 (modules/product/changes; design products.changes Activity): a change request's company and site (a floor one's,
  // or its work order's) and the customer or supplier who asked; a change order's company, internal notes only (no party).
  ChangeRequest: async (client, id) => {
    const request = await client.changeRequest.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true } })
    return request ? { companyId: request.companyId, siteId: request.siteId, partyId: request.partyId } : null
  },
  ChangeOrder: async (client, id) => {
    const order = await client.changeOrder.findUnique({ where: { id }, select: { companyId: true } })
    return order ? { companyId: order.companyId, siteId: null, partyId: null } : null
  },
  // B-W2b-246 (modules/sales/samples; design products.samples Activity): a sample round's company, no site, and the brand or
  // customer it is for (its shared messages reach that party only); an internal round takes internal notes only.
  SampleRound: async (client, id) => {
    const round = await client.sampleRound.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return round ? { companyId: round.companyId, siteId: null, partyId: round.partyId } : null
  },
  // B-W2b-282 (platform/approvals; design home.approvals review "Conversation"): a request for a yes, between its approver and
  // the person who asked, internal notes only (no party), in the request's company and site.
  ApprovalTask: async (client, id) => {
    const task = await client.approvalTask.findUnique({ where: { id }, select: { companyId: true, siteId: true } })
    return task ? { companyId: task.companyId, siteId: task.siteId, partyId: null } : null
  },
  // B-W2b-295 (modules/sales/inquiries; design sales.inquiries Activity): an inquiry's company, no site, and the customer it is
  // from (its mail and the replies reach that customer only); a prospect's inquiry takes internal notes until it is matched.
  Inquiry: async (client, id) => {
    const inquiry = await client.inquiry.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return inquiry ? { companyId: inquiry.companyId, siteId: null, partyId: inquiry.partyId } : null
  },
  // B-W2b-345 (modules/sales/service; design "Service case" Activity, SAL-436 the status mails): a service case's company, no
  // site, and the customer it names (its status mails and the replies reach that customer only); a rider's case without a
  // customer takes internal notes only.
  ServiceCase: async (client, id) => {
    const serviceCase = await client.serviceCase.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return serviceCase ? { companyId: serviceCase.companyId, siteId: null, partyId: serviceCase.partyId } : null
  },
  // B-W2b-351 (modules/sales/safety-reports; SAL-414): a product-safety report's company, no site, and the customer it names (a
  // report from the public DoC page names none: internal notes only). Never anything of an injury (ProductSafetyInjury has no thread).
  ProductSafetyReport: async (client, id) => {
    const report = await client.productSafetyReport.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return report ? { companyId: report.companyId, siteId: null, partyId: report.partyId } : null
  },
  // B-W2b-371 (XF2:02; design rider.activity): ONE thread per rider and garment type, on the chain's first revision (a later
  // revision has none: the conversation does not split per revision); no company (a profile has none) and the customer. Body data:
  // THREAD_GATES below asks sales.measurements.view beside threads.read / threads.post.
  MeasurementProfile: async (client, id) => {
    const profile = await client.measurementProfile.findUnique({ where: { id }, select: { partyId: true, supersedesId: true } })
    return profile && profile.supersedesId === null ? { companyId: null, siteId: null, partyId: profile.partyId } : null
  },
  // ---- B-TH-040 (threads plan TH-3, G16, L2-G04; modules/sales/portal-ordering): a catalogue order, once sent, has its thread —
  // the selling company and the customer, so the office and the customer discuss it there (the customer through its partner view,
  // search/partner/views/portal-order-request.ts). A DRAFT is the customer's alone: no record here, so no thread, for anyone.
  PortalOrderRequest: async (client, id) => {
    const request = await client.portalOrderRequest.findUnique({ where: { id }, select: { companyId: true, partyId: true, status: true } })
    return request && request.status !== 'DRAFT' ? { companyId: request.companyId, siteId: null, partyId: request.partyId } : null
  },
  // ---- end B-TH-040
  // ---- B-TH-066 (threads plan TH-5, PROJ-G02; modules/product/projects): a project's company and its ONE outside company (none:
  // an office-only project, internal notes only), so its shared messages reach that company only (the database's
  // Thread_project_party holds the same).
  Project: async (client, id) => {
    const project = await client.project.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    return project ? { companyId: project.companyId, siteId: null, partyId: project.partyId } : null
  },
  // ---- end B-TH-066
})

/**
 * B-W2b-371: record types whose thread asks one more permission over its scope beside threads.read, threads.post and
 * threads.manage (Team's note above: a thread is read with threads.read over its company and site). A rider's measurement profile
 * is body data: a role that reads threads but not measurements (finance, the warehouse, read only …) neither reads, writes,
 * follows, is mentioned in nor is notified of its thread.
 */
export const THREAD_GATES: Readonly<Record<string, Permission>> = Object.freeze({
  MeasurementProfile: 'sales.measurements.view',
  // ---- B-TH-005 (threads plan TH-0, thread-G02; GDPR art. 4 inside the office): notes about a PERSON — a colleague, a role's
  // holders, a floor device and who uses it, a worker, a team, an outside service's account — are read, written, followed,
  // mentioned on and notified only to whoever may view that record itself, beside threads.read: a role that reads threads (the
  // sales office, the warehouse …) no longer reads what HR or the administrator wrote about a person.
  User: 'users.view',
  Role: 'roles.view',
  Device: 'devices.view',
  Worker: 'workers.view',
  Team: 'people.view',
  IntegrationAccount: 'integrations.view',
  // ---- end B-TH-005
})

/** The permission on the record's thread AND the record type's gate (when it has one), over the thread's scope. */
export function mayOnThread(actor: Actor, permission: Permission, recordType: string | null | undefined, /* B-PR-08a */ scope: WallScope): boolean {
  // ---- B-PR-08a part 2: a work order's, hold's or NCR's thread is reached through its WALL party (the resolver's, officeRecord's,
  // wallScopeOf's); a scope that does not carry it (a party-less thread row read as it is) reaches it only with every customer.
  const at: ScopedRecord = recordType && !mayShare(recordType) ? { ...scope, partyId: scope.wallPartyId !== undefined ? scope.wallPartyId : EVERY_PARTY_MARKER } : scope
  // ---- end B-PR-08a
  if (!can(actor, permission, at)) return false
  const gate = recordType && Object.hasOwn(THREAD_GATES, recordType) ? THREAD_GATES[recordType] : undefined
  return gate === undefined || can(actor, gate, at)
}

// ---- B-PR-08a (production plan R-02, §2 "work order, hold and NCR threads stay internal"; threads lead T2, 2026-11-17): a work
// order, a quality hold and a nonconformance are NEVER shared with a customer or supplier. Their resolvers may name a party (the
// brand a work order is made for: B-PR-08a part 2): that is a WALL party — who in the office may read the thread — never the
// thread's share party. threads.ts never sets it as the thread's party (ensureThread), refuses a shared message on them
// (writeMessage: 409 refusal/NOT_SHAREABLE in words) and gives a portal or a link reader nothing (readThread: empty).
export const NOT_SHAREABLE: ReadonlySet<string> = new Set(['WorkOrder', 'QualityHold', 'Nonconformance'])

/** Whether a record type's thread may take a party and carry shared messages (every type but NOT_SHAREABLE's). */
export const mayShare = (recordType: string): boolean => !NOT_SHAREABLE.has(recordType)

/** Why a shared message on such a record is refused, for the office (it names no customer). */
export const NOT_SHAREABLE_REFUSAL = Object.freeze({
  it: 'La conversazione di un ordine di lavoro, di un blocco qualità o di una non conformità resta interna alla fabbrica: non si condivide mai con un cliente o un fornitore. Scrivi una nota interna.',
  en: 'The thread of a work order, a quality hold or a nonconformance stays inside the factory: it is never shared with a customer or supplier. Write an internal note instead.',
})

/** The 409 of a shared message on such a record: the words at `refusal/NOT_SHAREABLE`. */
export const notShareableRefusal = (): DomainError =>
  new DomainError('conflict', NOT_SHAREABLE_REFUSAL.en, [{ path: 'refusal/NOT_SHAREABLE', message: NOT_SHAREABLE_REFUSAL.en }])

// B-PR-08a part 2 (production plan §2 "office people limited to some brands get the same wall … in threads"; threads lead T2): an
// office person limited to some customers reads, writes on, is mentioned on and is told of a work order's, hold's or NCR's thread
// only when they reach its customer (every customer: several, or customer work of none). The customer is a WALL party, carried
// beside the scope (`wallPartyId`) — never in `partyId`, the party a record's messages, files, links and portal tasks are SHARED
// with: so every other reader of resolveRecord (files, shares, portal tasks, email in and out, notifications) still finds no party
// on these three types, as before, and can share nothing by mistake. The thread row stays party-less.

/** A scope as the office's thread checks read it: the record's (or its thread's), and a NOT_SHAREABLE record's wall party. */
export type WallScope = ScopedRecord & { readonly wallPartyId?: string | null }

/** Where a thread sits, as its row (or a message's thread) holds it. */
export interface ThreadPlace {
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
}

/** The customer a scope's record belongs to for the wall: its wall party when it has one, else its party. */
export const wallPartyOf = (scope: WallScope | null | undefined): string | null => (scope ? (scope.wallPartyId !== undefined ? scope.wallPartyId : (scope.partyId ?? null)) : null)

/** The wall party of each work order, hold and NCR asked, by `type:id` (one read per type); other types and unknown ids are left out. */
export async function wallPartiesOf(client: FactoryClient | CommandTx, refs: readonly { readonly type: string; readonly id: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const idsOf = (type: string) => [...new Set(refs.filter((ref) => ref.type === type && isUuid(ref.id)).map((ref) => ref.id))]
  const workOrders = idsOf('WorkOrder')
  if (workOrders.length > 0) {
    for (const row of await client.workOrder.findMany({ where: { id: { in: workOrders } }, select: { id: true, partyId: true } })) out.set(`WorkOrder:${row.id}`, row.partyId ?? EVERY_PARTY_MARKER)
  }
  const holds = idsOf('QualityHold')
  if (holds.length > 0) {
    const rows = await client.qualityHold.findMany({ where: { id: { in: holds } }, select: { id: true, subjectType: true, subjectIds: true } })
    const customers = await holdCustomersOf(client, rows)
    for (const row of rows) out.set(`QualityHold:${row.id}`, partyOfCustomers(customers.get(row.id) ?? NO_CUSTOMER))
  }
  const ncrs = idsOf('Nonconformance')
  if (ncrs.length > 0) {
    const rows = await client.nonconformance.findMany({ where: { id: { in: ncrs } }, select: NCR_FACTS })
    const customers = await ncrCustomersOf(client, rows)
    for (const row of rows) out.set(`Nonconformance:${row.id}`, partyOfCustomers(customers.get(row.id) ?? NO_CUSTOMER))
  }
  return out
}

/**
 * The office's scope of each thread: its own, and for a NOT_SHAREABLE record its wall party (a record gone: every customer only).
 * Reads only for these three types, so a partner or link caller (which never reaches them) reads nothing more.
 */
export async function wallScopesOf(client: FactoryClient | CommandTx, threads: readonly ThreadPlace[]): Promise<(thread: ThreadPlace) => WallScope> {
  const walls = await wallPartiesOf(client, threads.filter((thread) => !mayShare(thread.recordType)).map((thread) => ({ type: thread.recordType, id: thread.recordId })))
  return (thread) => {
    const own: WallScope = { companyId: thread.companyId, siteId: thread.siteId, partyId: thread.partyId }
    if (mayShare(thread.recordType)) return own
    const wall = walls.get(`${thread.recordType}:${thread.recordId}`)
    return { ...own, partyId: null, wallPartyId: wall === undefined ? EVERY_PARTY_MARKER : wall }
  }
}

/** One thread's office scope (wallScopesOf). */
export async function wallScopeOf(client: FactoryClient | CommandTx, thread: ThreadPlace): Promise<WallScope> {
  return (await wallScopesOf(client, [thread]))(thread)
}
// ---- end B-PR-08a

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
