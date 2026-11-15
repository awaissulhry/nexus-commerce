import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { reachWhere } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { companyTestModes } from '../../modules/invoicing/test-mode/settings'
import { siteTestModes } from '../../modules/shipping/test-mode/test-mode'

/**
 * The office shell's notices (B-W2b-F49; design shell.frame sec:system-banners; LOG-035; Owner rule W2b-6 "a test mode shows a
 * banner on every page while it is on", for everyone, so nobody buys a real label or sends a real e-invoice by mistake).
 *
 *   read   any signed-in office person, no permission: which of the ACTIVE sites and companies the person works in (any of
 *          their grants reaches it: reachWhere) have the carrier (B-W2b-390, per site) or e-invoicing (B-W2b-401, per
 *          company) in test mode — narrowed to one company when the shell names it. Names and on/off only: the reads are
 *          the settings pages' own (shipping siteTestModes, invoicing companyTestModes), so the shell and the pages agree;
 *          the settings themselves stay behind shipping.view and invoices.view.
 */
export async function shellNotices(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const company = query.companyId ? { companyId: query.companyId } : {}
  const sites = { AND: [reachWhere(actor, { company: 'companyId', site: 'id' }), company] } as Prisma.SiteWhereInput
  const companies = { AND: [reachWhere(actor, { company: 'id' }), { status: 'ACTIVE' }, query.companyId ? { id: query.companyId } : {}] } as Prisma.CompanyWhereInput
  return caller.withClient(async (client) => {
    const carrier = await siteTestModes(client, sites)
    const eInvoicing = await companyTestModes(client, companies)
    return {
      testModes: {
        // By name, as the banner lists them (the page's order is by company id).
        carrierSites: carrier
          .filter((row) => row.testMode)
          .map(({ site }) => ({ siteId: site.id, name: site.name }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.siteId.localeCompare(b.siteId)),
        eInvoicingCompanies: eInvoicing.filter((row) => row.testMode).map(({ company }) => ({ companyId: company.id, name: company.legalName })),
      },
    }
  })
}
