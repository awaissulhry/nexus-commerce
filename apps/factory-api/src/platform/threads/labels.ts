import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../core/command'

/**
 * A record's label as a chip shows it (`ORD-2026-0042`, `JK-210`, a company's code), for the records that have a thread
 * (records.ts THREAD_RECORDS): a task keeps its record's label when it is made, a notification its record's when it is
 * made (B-W2a-20). Read in the caller's scope; null when the record is not there for it. A floor worker's record is
 * labelled without the worker's name (names only inside the record itself; Owner answer W1), a person by their name.
 * A module that adds a record type to THREAD_RECORDS adds its label here, one line.
 */

type Client = FactoryClient | CommandTx
type Labeller = (client: Client, id: string) => Promise<string | null>

const LABELS: Readonly<Record<string, Labeller>> = Object.freeze({
  Company: async (client, id) => (await client.company.findUnique({ where: { id }, select: { code: true } }))?.code ?? null,
  Site: async (client, id) => (await client.site.findUnique({ where: { id }, select: { code: true } }))?.code ?? null,
  Party: async (client, id) => {
    const party = await client.party.findUnique({ where: { id }, select: { code: true, legalName: true } })
    return party ? `${party.code} ${party.legalName}` : null
  },
  User: async (client, id) => (await client.user.findUnique({ where: { id }, select: { displayName: true } }))?.displayName ?? null,
  Role: async (client, id) => (await client.role.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
  Device: async (client, id) => (await client.device.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
  Worker: async (client, id) => ((await client.worker.findUnique({ where: { id }, select: { id: true } })) ? `Worker ${id.slice(-6)}` : null),
  IntegrationAccount: async (client, id) => (await client.integrationAccount.findUnique({ where: { id }, select: { label: true } }))?.label ?? null,
  Certificate: async (client, id) => (await client.certificate.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  Style: async (client, id) => (await client.style.findUnique({ where: { id }, select: { code: true } }))?.code ?? null,
  Invoice: async (client, id) => {
    const invoice = await client.invoice.findUnique({ where: { id }, select: { number: true } })
    return invoice ? (invoice.number ?? 'Draft invoice') : null
  },
  Quote: async (client, id) => (await client.quote.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  PurchaseOrder: async (client, id) => (await client.purchaseOrder.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  SalesOrder: async (client, id) => (await client.salesOrder.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  WorkOrder: async (client, id) => (await client.workOrder.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  Shipment: async (client, id) => (await client.shipment.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  PpeRegisterEntry: async (client, id) => ((await client.ppeRegisterEntry.findUnique({ where: { id }, select: { id: true } })) ? `PPE register entry ${id.slice(-6)}` : null),
  Lot: async (client, id) => (await client.lot.findUnique({ where: { id }, select: { code: true } }))?.code ?? null,
  GoodsReceipt: async (client, id) => (await client.goodsReceipt.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  // B-W2a-44 (modules/purchasing/claims): a claim by its number.
  SupplierClaim: async (client, id) => (await client.supplierClaim.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
  // B-W2a-35 (modules/plant): a machine by its asset number, a request by its machine's, a job by its number.
  Machine: async (client, id) => (await client.machine.findUnique({ where: { id }, select: { assetNumber: true } }))?.assetNumber ?? null,
  MaintenanceRequest: async (client, id) => {
    const request = await client.maintenanceRequest.findUnique({ where: { id }, select: { machine: { select: { assetNumber: true } } } })
    return request ? `${request.machine.assetNumber} request` : null
  },
  MaintenanceJob: async (client, id) => (await client.maintenanceJob.findUnique({ where: { id }, select: { number: true } }))?.number ?? null,
})

/** The record's label, or null when it is not there for this caller. A type without its own labeller: its type and id end. */
export async function recordLabelOf(client: Client, recordType: string, recordId: string): Promise<string | null> {
  const labeller = Object.hasOwn(LABELS, recordType) ? LABELS[recordType] : undefined
  if (!labeller) return `${recordType} ${recordId.slice(-6)}`
  return labeller(client, recordId)
}
