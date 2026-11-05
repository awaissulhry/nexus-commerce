import { KIND_WORDS, type IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'
import { defineIndexer, idWhere } from '../indexer'

/**
 * Incidents, near misses and hazards (modules/safety/incidents, B-W2b-125; safety.incidents.view; opens in Plant › Health &
 * safety › Incidents, B-W2b-149): by number, with the kind's words in Italian and English (either language finds it), the site,
 * the area, the station and the machine as codes. Scope as the incidents list: company and site.
 *
 * ANONYMISED (GDPR art. 9; B-W2b-91's rule "no export, no search index" for the protected tables): never a person (no reporter,
 * worker, device or anyone involved), never an injury or an INAIL filing (IncidentPerson and InailFiling are not read), and none
 * of the free words (what happened, the place, the immediate action: they could name someone). The title is the number. Reported,
 * corrected, closed, reopened and cancelled re-read it.
 */
export default defineIndexer({
  recordType: 'Incident',
  area: 'plant',
  viewPermission: 'safety.incidents.view',
  on: {
    'incident.reported': 'subject',
    'incident.changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.incident.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        number: true,
        kind: true,
        status: true,
        site: { select: { code: true } },
        area: { select: { code: true, name: true } },
        station: { select: { code: true } },
        machine: { select: { assetNumber: true } },
      },
    })
    return rows.map((row) => {
      const kind = KIND_WORDS[row.kind as IncidentKind]
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: null,
        number: row.number,
        title: row.number,
        // Where, as codes only: the site, then the machine, the station or the area.
        subtitle: [row.site.code, row.machine?.assetNumber ?? row.station?.code ?? row.area?.code].filter(Boolean).join(' · ') || null,
        status: row.status,
        words: [kind?.en, kind?.it, row.area?.code, row.area?.name, row.station?.code, row.machine?.assetNumber],
      }
    })
  },
})
