import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue } from '@nexus/factory-domain/imports/importer'
import { workshopLocationProblems } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { CommandTx } from '../../../core/command'
// Types only: the registry lists the locations adapter, which uses this file.
import type { CheckRow, ImportScope } from '../registry'

/**
 * The Workshop column of the locations import (B-W2b-25; the B-W2a-25 gap; SCM-141): the parts of modules/inventory/
 * locations importer.ts's adapter that read and check a workshop's stock location. factory-domain inventory/locations
 * importer `planLocationRow` holds the plain rules (only kind SUBCONTRACTOR names one, it never changes); this
 *
 *   loads    the workshop's party code of each location (`workshopCodesOf`),
 *   checks   the workshop a row names (`checkWorkshops`), as the locations page's create does (modules/inventory/locations
 *            locations.ts checkWorkshop): a SUBCONTRACTOR party, not archived, of the site's company or every company
 *            (purchasing/subcontracting `workshopLocationProblems`), and one ACTIVE location per workshop and site (none
 *            already, and not twice in the sheet),
 *   finds    the workshop again inside the batch's command for the write (`workshopForWrite`), with the same rules.
 *
 * The …_supply_w2a_guards trigger stays the last word (kind ⇔ workshop, the workshop never changes).
 */

const PARTY = { id: true, code: true, roles: true, status: true, companyId: true } as const

const text = (value: CellValue | null | undefined): string | null => (value === undefined || value === null ? null : String(value))

/** The party codes of the locations' workshops, by party id. */
export async function workshopCodesOf(client: CommandTx, partyIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(partyIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  return new Map((await client.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
}

/** The workshop each row names, against the parties and the site's workshop locations (one list of issues per row). */
export async function checkWorkshops(client: CommandTx, rows: readonly CheckRow[], scope: ImportScope): Promise<RowIssue[][]> {
  // Only the rows of a workshop location: a workshop on another kind, or a kind without its workshop, is the plan's to refuse
  // (a row this check refuses is an error with these issues only).
  const named = rows.filter((row) => text(row.values.workshop) !== null && row.values.kind === 'SUBCONTRACTOR')
  if (named.length === 0) return rows.map(() => [])
  const sites = new Map(
    (await client.site.findMany({ where: { code: { in: [...new Set(named.map((row) => String(row.key.site)))] }, ...(scope.companyId ? { companyId: scope.companyId } : {}) }, select: { id: true, code: true, companyId: true } })).map(
      (site) => [site.code, site],
    ),
  )
  const parties = new Map((await client.party.findMany({ where: { code: { in: [...new Set(named.map((row) => String(row.values.workshop)))] } }, select: PARTY })).map((party) => [party.code, party]))
  const held = await client.location.findMany({
    where: { kind: 'SUBCONTRACTOR', status: 'ACTIVE', siteId: { in: [...sites.values()].map((site) => site.id) }, partyId: { in: [...parties.values()].map((party) => party.id) } },
    select: { code: true, siteId: true, partyId: true },
  })
  const inSheet = new Set<string>()
  return rows.map((row) => {
    const code = text(row.values.workshop)
    if (code === null || row.values.kind !== 'SUBCONTRACTOR') return []
    const site = sites.get(String(row.key.site))
    // A site the job's company does not have: the write says so (its batch stops), as before W2b.
    if (!site) return []
    const party = parties.get(code) ?? null
    const problems = workshopLocationProblems('SUBCONTRACTOR', party?.id ?? code, party, site.companyId)
    if (!party) return [{ column: 'workshop', message: `No party ${code}: name a subcontractor by its party code.` }]
    if (problems.length > 0) return problems.map((problem) => ({ column: 'workshop', message: problem.message }))
    const pair = `${site.id}|${party.id}`
    const other = held.find((location) => location.siteId === site.id && location.partyId === party.id && location.code !== String(row.key.code))
    if (other) return [{ column: 'workshop', message: `${party.code} has its stock location ${other.code} on site ${site.code} already: one per workshop and site.` }]
    if (inSheet.has(pair)) return [{ column: 'workshop', message: `${party.code} is named twice for site ${site.code} in this sheet: one stock location per workshop and site.` }]
    inSheet.add(pair)
    return []
  })
}

/** Inside the batch's command: the workshop a new SUBCONTRACTOR location names, checked again; a throw stops the batch. */
export async function workshopForWrite(tx: CommandTx, code: string, site: { readonly id: string; readonly code: string; readonly companyId: string }, locationCode: string): Promise<string> {
  const party = await tx.party.findFirst({ where: { code }, select: PARTY })
  const problems = workshopLocationProblems('SUBCONTRACTOR', party?.id ?? code, party, site.companyId)
  if (!party || problems.length > 0) throw new Error(`Location ${locationCode}: ${!party ? `no party ${code}` : problems[0]!.message} Run the dry run again.`)
  const other = await tx.location.findFirst({ where: { siteId: site.id, kind: 'SUBCONTRACTOR', partyId: party.id, status: 'ACTIVE' }, select: { code: true } })
  if (other) throw new Error(`Location ${locationCode}: ${party.code} has its stock location ${other.code} on site ${site.code} already (one per workshop and site).`)
  return party.id
}
