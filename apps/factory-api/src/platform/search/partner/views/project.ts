import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_PROJECTS_VIEW } from '@nexus/factory-domain/projects/permissions'
import { definePartnerView, holdsTyped, idsOf, type PartnerReader, type PartnerRecord } from '../view'

/**
 * A project of the partner's organisation (B-TH-069; threads plan TH-5, PROJ-G07, PROJ.portal-F01…F04, F08; walls W09, W38; the
 * office index's ../../indexers/project.ts): opened on its thread (platform/threads/partner), found in the portal search's
 * Projects group, listed on the Samples & tech packs page (modules/sales/portal-samples) and in Home's conversations.
 *
 * MEMBERS ONLY (Owner question 2: brand people are added one by one): a project opens to the portal person the office ADDED to
 * it — a RecordFollower row of that person (the partner role reads its own party's member rows only) — who holds
 * portal.projects.view; another person of the same company finds nothing (not found, never "you were not added"); a person of
 * another company reads no row at all (the party wall: Project.partyId, the database's). A supplier's project shows in the
 * supplier portal the same way and never names a customer (one outside company per project).
 *
 * Read in the PARTNER scope: its name, status, target date and season — never the lead, the goal, the outcome or its words, who
 * made or closed it (hidden columns, never selected). No money anywhere. TH-5 follow-up (B-TH-303's rule, B-TH-253): `ourRef` is
 * null and the number is none of the words a partner may type — the office's PRJ series counts every customer's projects, so the
 * portal names and finds a project by its name (and season), never by that number.
 */
export default definePartnerView({
  recordType: 'Project',
  group: 'projects',
  kinds: ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR'],
  async read(client, ids, reader?: PartnerReader): Promise<PartnerRecord[]> {
    if (ids.length === 0 || !reader) return []
    const memberOf = await client.recordFollower.findMany({ where: { recordType: 'Project', recordId: { in: [...ids] }, userId: reader.userId }, select: { recordId: true } })
    if (memberOf.length === 0) return []
    const rows = await client.project.findMany({
      where: { id: { in: memberOf.map((row) => row.recordId) } },
      select: { id: true, companyId: true, partyId: true, name: true, status: true, targetDate: true, seasonCode: true },
    })
    return rows
      .filter((row) => row.partyId !== null && can(reader.actor, PORTAL_PROJECTS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
      .map((row) => ({ id: row.id, companyId: row.companyId, theirRef: null, ourRef: null, subtitle: row.name, status: row.status, date: row.targetDate, words: [row.name, row.seasonCode] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.project.findMany({ where: { name: holdsTyped(typed) }, select: { id: true }, orderBy: { createdAt: 'desc' }, take }))
  },
})
