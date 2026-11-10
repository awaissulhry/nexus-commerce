import { boughtInCheck, type BoughtInCheck, type PartCoverage } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { dayOf, todayOf } from '../certificates/certificates'
import { officeOf } from '../register-of-rules/common'
import { SUMMARY_SELECT, summaryOf, visibleCertificates } from './bodies'

/**
 * The incoming check of a bought-in part (B-W2b-255; QHS-106: protector (EN 1621) certificates per supplier part, checked
 * at incoming): `GET /compliance/bought-in?itemId&supplierPartyId&on` — is a lot of this part from this supplier covered
 * on that day, by which certificate, and if not, why. The incoming inspection reads the same rule for the lot's covering
 * certificate (quality/incoming/certificates.ts, B-W2b-255's seam: a coverage naming another supplier never covers the
 * lot). Reading is compliance.certificates.view; only certificates the caller may see answer.
 */

export interface BoughtInQuery {
  readonly itemId: string
  readonly supplierPartyId?: string | undefined
  readonly on?: BusinessDate | undefined
}

const partyName = (party: { legalName: string; tradeName: string | null }): string => party.tradeName?.trim() || party.legalName

function words(check: BoughtInCheck, item: string, supplier: string | null, on: BusinessDate): string {
  const certificate = check.coverage?.certificate
  switch (check.state) {
    case 'COVERED':
      return `Covered: certificate ${certificate!.number} (${certificate!.standard}) names ${supplier ?? 'this supplier'}'s part ${check.coverage!.supplierArticleCode ?? item}, valid on ${on}.`
    case 'COVERED_ANY_SUPPLIER':
      return `Covered: certificate ${certificate!.number} (${certificate!.standard}) covers part ${item} without naming a supplier; name the supplier on its coverage to check it at incoming.`
    case 'NOT_VALID':
      return `Not covered on ${on}: certificate ${certificate!.number} names the part but does not hold (${(check.why ?? 'NOT_VALID').toLowerCase().replace(/_/g, ' ')}).`
    case 'OTHER_SUPPLIER':
      return `Not covered: the certificates of part ${item} name other suppliers' parts, not ${supplier ?? 'this supplier'}'s.`
    case 'NO_CERTIFICATE':
      return `Not covered: no certificate covers part ${item}.`
  }
}

/** GET /compliance/bought-in */
export async function checkBoughtIn(caller: CommandCaller, query: BoughtInQuery) {
  const context = officeOf(caller)
  const on = query.on ?? todayOf()
  return caller.withClient(async (db) => {
    const item = await db.item.findUnique({ where: { id: query.itemId }, select: { id: true, code: true, name: true } })
    if (!item) throw new NotFoundError('Part not found.')
    const rows = await db.certificateCoverage.findMany({
      where: { itemId: item.id, status: 'ACTIVE', certificate: visibleCertificates(context) },
      select: { id: true, status: true, supplierPartyId: true, supplierArticleCode: true, certificate: { select: SUMMARY_SELECT } },
      orderBy: { id: 'asc' },
    })
    const coverages: PartCoverage[] = rows.map((row) => ({
      coverageId: row.id,
      status: row.status,
      supplierPartyId: row.supplierPartyId,
      supplierArticleCode: row.supplierArticleCode,
      certificate: { id: row.certificate.id, number: row.certificate.number, standard: row.certificate.standard, ppeClass: row.certificate.ppeClass, status: row.certificate.status, validFrom: dayOf(row.certificate.validFrom), validTo: dayOf(row.certificate.validTo) },
    }))
    const check = boughtInCheck(coverages, query.supplierPartyId ?? null, on)
    const partyIds = [...new Set([...(query.supplierPartyId ? [query.supplierPartyId] : []), ...check.otherSuppliers])]
    const parties = new Map((partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, legalName: true, tradeName: true } }) : []).map((party) => [party.id, partyName(party)]))
    const answer = check.coverage ? rows.find((row) => row.id === check.coverage!.coverageId)! : null
    return {
      item,
      on,
      state: check.state,
      certificate: answer ? summaryOf(answer.certificate) : null,
      coverageId: answer?.id ?? null,
      supplierArticleCode: answer?.supplierArticleCode ?? null,
      why: check.why,
      otherSuppliers: check.otherSuppliers.map((id) => ({ id, name: parties.get(id) ?? '—' })),
      message: words(check, item.code, query.supplierPartyId ? (parties.get(query.supplierPartyId) ?? null) : null, on),
    }
  })
}
