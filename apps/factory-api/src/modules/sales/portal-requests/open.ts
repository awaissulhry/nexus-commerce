import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import type { CommandTx } from '../../../core/command'
import { PORTAL_REQUESTS_CLOSED, type Words } from '@nexus/factory-domain/sales/portal-requests/rules'
import { portalReader } from '../portal-orders/access'

/**
 * Whether a company takes requests now (B-TH-012; threads plan L2-G03): a request is numbered from the company's INQUIRY series
 * (INQ-…), so the portal's New order and the inquiry addresses are open only while the company has an ACTIVE one. Without it the
 * portal says so before the customer types ("Orders by portal are not open yet for <company> — please write to your contact",
 * P-CUS-NEW.head-F02) and the alert REQUEST_NUMBERING_MISSING tells the admins (platform/alerts). The answer names only the
 * session's own company.
 */

/** Whether the company has an active INQUIRY series (read in the office scope). */
export async function takesRequests(client: FactoryClient, companyId: string): Promise<boolean> {
  return (await client.numberSeries.count({ where: { companyId, kind: 'INQUIRY', status: 'ACTIVE' } })) > 0
}

/** GET /portal/inquiries/open */
export async function requestsOpen(app: FastifyInstance, request: FastifyRequest): Promise<{ open: boolean; reason: Words | null }> {
  const reader = portalReader(app, request)
  const company = reader.session.company
  const open = await reader.inTenant((client) => takesRequests(client, company.id))
  return { open, reason: open ? null : PORTAL_REQUESTS_CLOSED(company.name) }
}

// ---- the alert REQUEST_NUMBERING_MISSING (B-TH-012; factory-domain alerts/kinds; platform/alerts/evaluators FINDERS) -------

/**
 * In the tenant's system scope: the companies (the rule's, else every one) that receive requests — a customer's portal is on
 * (PortalSettings.portalOn of a party of the company or tenant-wide) or the company has inquiry addresses in force (its sales
 * settings, else the tenant's) — and have no ACTIVE INQUIRY series, so a request would wait silently. One alert per company
 * (record Company); it clears when a series is made active. `only`: the companies of a recheck. The facts say which doors are
 * open; they name no customer.
 */
export async function numberingMissingFindings(tx: FactoryClient | CommandTx, rule: RulePlace, _now: Date, only?: readonly string[]): Promise<Finding[]> {
  const companies = await tx.company.findMany({ where: { ...(rule.companyId ? { id: rule.companyId } : {}), ...(only ? { id: { in: [...only] } } : {}) }, select: { id: true, code: true, legalName: true, tradeName: true }, orderBy: { code: 'asc' }, take: 200 })
  if (companies.length === 0) return []
  const [series, portals, settings] = await Promise.all([
    tx.numberSeries.findMany({ where: { companyId: { in: companies.map((company) => company.id) }, kind: 'INQUIRY', status: 'ACTIVE' }, select: { companyId: true } }),
    tx.portalSettings.findMany({ where: { portalOn: true }, select: { party: { select: { companyId: true } } }, take: 5000 }),
    tx.salesSettings.findMany({ where: { OR: [{ companyId: null }, { companyId: { in: companies.map((company) => company.id) } }] }, select: { companyId: true, inquiryAddresses: true } }),
  ])
  const numbered = new Set(series.map((row) => row.companyId))
  const tenantAddresses = settings.find((row) => row.companyId === null)?.inquiryAddresses ?? []
  const findings: Finding[] = []
  for (const company of companies) {
    if (numbered.has(company.id)) continue
    const portalOn = portals.some((row) => row.party.companyId === null || row.party.companyId === company.id)
    const own = settings.find((row) => row.companyId === company.id)
    const addresses = (own ? own.inquiryAddresses : tenantAddresses).length > 0
    if (!portalOn && !addresses) continue
    findings.push({
      recordType: 'Company',
      recordId: company.id,
      label: company.tradeName ?? company.legalName,
      scope: { companyId: company.id, siteId: null, partyId: null },
      facts: { portalOn, inquiryAddresses: addresses },
    })
  }
  return findings
}
