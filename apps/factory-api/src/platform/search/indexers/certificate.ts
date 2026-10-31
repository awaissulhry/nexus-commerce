import { bySubjectIn, defineIndexer, idWhere, partyName, type RecordsOf } from '../indexer'

/**
 * PPE certificates (modules/compliance/certificates; compliance.certificates.view; opens in Compliance › Certificates): by
 * the certificate's number, the model it names, the standard and class, the notified body's name and number, the holder's
 * name and code. Scope as the certificates list: company and holder, both nullable (a brand's certificate, null company,
 * reaches every company). Made, edited and moved by a person (`compliance.certificate_changed`, B-W2b-23), expired by the
 * daily run, linked to its successor (both re-read); a holder renamed re-indexes its certificates.
 */
const successorOf: RecordsOf = (event) => {
  const payload = event.payload as { successorId?: unknown } | null
  return [event.subject, ...(typeof payload?.successorId === 'string' ? [payload.successorId] : [])]
}

export default defineIndexer({
  recordType: 'Certificate',
  area: 'compliance',
  viewPermission: 'compliance.certificates.view',
  on: {
    'compliance.certificate_changed': 'subject',
    'compliance.certificate_expired': 'subject',
    'compliance.certificate_renewed': successorOf,
    'party.updated': bySubjectIn((tx, partyId, take) => tx.certificate.findMany({ where: { holderPartyId: partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.certificate.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        holderPartyId: true,
        number: true,
        standard: true,
        ppeClass: true,
        modelReference: true,
        notifiedBodyName: true,
        notifiedBodyNumber: true,
        status: true,
        holderParty: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.holderPartyId,
      number: row.number,
      title: row.modelReference ?? row.standard,
      // The model when it names one (the standard and the notified body under it), else the standard (the body under it).
      subtitle: row.modelReference ? `${row.standard} · ${row.notifiedBodyName}` : row.notifiedBodyName,
      status: row.status,
      words: [row.ppeClass, row.notifiedBodyNumber, partyName(row.holderParty), row.holderParty?.code, row.holderParty?.legalName],
    }))
  },
})
