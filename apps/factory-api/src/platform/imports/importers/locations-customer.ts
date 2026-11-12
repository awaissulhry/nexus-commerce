import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue } from '@nexus/factory-domain/imports/importer'
import { customerPlaceProblems } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import type { CommandTx } from '../../../core/command'
// Types only: the registry lists the locations adapter, which uses this file.
import type { CheckRow, ImportScope } from '../registry'

/**
 * The customer of a CUSTOMER location in the locations import (B-W2b-289; SCM-177; the lead's B-W2b-277 follow-up): the
 * Workshop column of a Customer row names the customer or brand by its party code, checked as the locations page's create
 * checks it (modules/inventory/locations locations.ts checkWorkshop → factory-domain inventory/locations-depth
 * `customerPlaceProblems`): a party with the CUSTOMER or BRAND role, not archived, of the site's company or every company.
 * The sibling of locations-workshop.ts (the workshop of a SUBCONTRACTOR row); factory-domain inventory/locations importer
 * `planLocationRow` holds the plain rules (a new Customer row names one, it never changes, it sits at the top). The
 * …_warehouse_depth_w2b_guards trigger stays the last word (kind ⇔ party, the party's roles, the party never changes).
 */

const PARTY = { id: true, code: true, roles: true, status: true, companyId: true } as const

const text = (value: CellValue | null | undefined): string | null => (value === undefined || value === null ? null : String(value))

/** The customer each Customer row names, against the parties (one list of issues per row). */
export async function checkCustomers(client: CommandTx, rows: readonly CheckRow[], scope: ImportScope): Promise<RowIssue[][]> {
  const named = rows.filter((row) => text(row.values.workshop) !== null && row.values.kind === 'CUSTOMER')
  if (named.length === 0) return rows.map(() => [])
  const sites = new Map(
    (await client.site.findMany({ where: { code: { in: [...new Set(named.map((row) => String(row.key.site)))] }, ...(scope.companyId ? { companyId: scope.companyId } : {}) }, select: { id: true, code: true, companyId: true } })).map((site) => [site.code, site]),
  )
  const parties = new Map((await client.party.findMany({ where: { code: { in: [...new Set(named.map((row) => String(row.values.workshop)))] } }, select: PARTY })).map((party) => [party.code, party]))
  return rows.map((row) => {
    const code = text(row.values.workshop)
    if (code === null || row.values.kind !== 'CUSTOMER') return []
    const site = sites.get(String(row.key.site))
    // A site the job's company does not have: the write says so (its batch stops), as for every row.
    if (!site) return []
    const party = parties.get(code) ?? null
    if (!party) return [{ column: 'workshop', message: `No party ${code}: name a customer or brand by its party code.` }]
    return customerPlaceProblems(party.id, party, site.companyId).map((problem) => ({ column: 'workshop', message: problem.message }))
  })
}

/** Inside the batch's command: the customer a new CUSTOMER location names, checked again; a throw stops the batch. */
export async function customerForWrite(tx: CommandTx, code: string, site: { readonly companyId: string }, locationCode: string): Promise<string> {
  const party = await tx.party.findFirst({ where: { code }, select: PARTY })
  const problems = customerPlaceProblems(party?.id ?? code, party, site.companyId)
  if (!party || problems.length > 0) throw new Error(`Location ${locationCode}: ${!party ? `no party ${code}` : problems[0]!.message} Run the dry run again.`)
  return party.id
}
