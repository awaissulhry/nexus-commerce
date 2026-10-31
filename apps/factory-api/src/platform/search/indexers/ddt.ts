import type { CommandTx } from '../../../core/command'
import { bySubjectIn, defineIndexer, idWhere, partyName, type RecordsOf } from '../indexer'

/**
 * Transport documents, DDT (modules/shipping/ddt; shipping.view): by number, the recipient's name and code, and the record
 * it went with — a shipment, or a source's (a subcontract order's kit, a return or claim to a supplier, a repair, a
 * customer return) number. Scope as the DDT list: company, site and recipient. ISSUED, or CANCELLED once cancelled. A DDT
 * has no page of its own (design 00 §2.3): it opens its record panels (thread, files, history); the record it went with
 * is under its name. NEVER its freight or a line's value. Issued and cancelled (a shipment's or a source's)
 * re-read it — those events' subject is the shipment or the source, the DDT is in the payload; a recipient renamed
 * re-indexes its DDTs.
 */
const ddtOf: RecordsOf = (event) => {
  const id = (event.payload as { ddtId?: unknown } | null)?.ddtId
  return typeof id === 'string' ? [id] : []
}

type SourceType = 'SubcontractOrder' | 'SupplierClaim' | 'RepairOrder' | 'ReturnAuthorisation'

/** The numbers of the sources the DDTs went with, by id (one query per kind of source on the page). */
async function sourceNumbers(tx: CommandTx, sources: readonly { readonly sourceType: string | null; readonly sourceId: string | null }[]): Promise<Map<string, string>> {
  const ids = (type: SourceType) => [...new Set(sources.filter((source) => source.sourceType === type && source.sourceId).map((source) => source.sourceId!))]
  const numbers = new Map<string, string>()
  const add = (rows: readonly { id: string; number: string }[]) => rows.forEach((row) => numbers.set(row.id, row.number))
  // One query after another: `tx` is one transaction's connection.
  if (ids('SubcontractOrder').length > 0) add(await tx.subcontractOrder.findMany({ where: { id: { in: ids('SubcontractOrder') } }, select: { id: true, number: true } }))
  if (ids('SupplierClaim').length > 0) add(await tx.supplierClaim.findMany({ where: { id: { in: ids('SupplierClaim') } }, select: { id: true, number: true } }))
  if (ids('RepairOrder').length > 0) add(await tx.repairOrder.findMany({ where: { id: { in: ids('RepairOrder') } }, select: { id: true, number: true } }))
  if (ids('ReturnAuthorisation').length > 0) add(await tx.returnAuthorisation.findMany({ where: { id: { in: ids('ReturnAuthorisation') } }, select: { id: true, number: true } }))
  return numbers
}

export default defineIndexer({
  recordType: 'Ddt',
  area: 'warehouse',
  viewPermission: 'shipping.view',
  on: {
    'ddt.issued': ddtOf,
    'ddt.cancelled': ddtOf,
    'ddt.source_issued': ddtOf,
    'ddt.source_cancelled': ddtOf,
    'party.updated': bySubjectIn((tx, partyId, take) => tx.ddt.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.ddt.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        partyId: true,
        number: true,
        sourceType: true,
        sourceId: true,
        shipment: { select: { number: true } },
        cancellations: { select: { id: true }, take: 1 },
      },
    })
    const parties = new Map(
      (await tx.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((party) => [party.id, party]),
    )
    const sources = await sourceNumbers(tx, rows)
    return rows.map((row) => {
      const party = parties.get(row.partyId) ?? null
      const wentWith = row.shipment?.number ?? (row.sourceId ? (sources.get(row.sourceId) ?? null) : null)
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: row.partyId,
        number: row.number,
        title: partyName(party) ?? row.number,
        subtitle: wentWith,
        status: row.cancellations.length > 0 ? 'CANCELLED' : 'ISSUED',
        words: [party?.code, party?.legalName],
      }
    })
  },
})
