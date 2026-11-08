import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { FactoryClient } from '@nexus/factory-db'
import type { PortalSignInHead } from '@nexus/factory-domain/branding/contracts'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import { SYSTEM_ACTOR_ID } from '../../core/context'
import { portalCompany } from '../auth/portal/store'
import { systemContext } from '../outbox/system'
import { asContext, publicBrandingOf } from './branding'

/**
 * B-W2b-164 (design portal.signin › brand head, help foot): what the portal's sign-in page shows before anything is typed,
 * for anyone. The page knows its portal by its address — the tenant's slug and the company's code, as the partner
 * invitation mail names them (`/p/signin?tenant=<slug>&company=<code>`; with one active company the code may be left out,
 * as POST /portal/signin/start allows) — or, on the mailed link's landing, by the company's id the link's token names.
 *
 * The answer: the tenant's slug and the company's code (what the e-mail step sends), the company's public branding
 * (publicBrandingOf), the company's default conversation address (whom a partner asks — the address the refusal words of
 * a sign-in name too) and its legal block in each language as its documents print it (c.c. art. 2250). Public facts only:
 * no person, no party, nothing about who has access. Read in the platform scope (the Tenant row) and the tenant's system
 * scope (row-level security stays forced); one 404 for every miss (unknown or inactive tenant or company).
 */

export interface PortalHeadQuery {
  readonly tenant?: string | undefined
  readonly company?: string | undefined
  readonly companyId?: string | undefined
}

type Reader = Pick<FactoryClient, 'company' | 'companyBranding' | 'storedFile' | 'emailIdentity'>

/** The registered office as the Company row keeps it (platform/documents reads it the same way). */
const officeAddress = z.object({ line1: z.string(), line2: z.string().nullish(), postalCode: z.string(), city: z.string(), province: z.string().nullish(), country: z.string() })

const LEGAL_COLUMNS = {
  legalName: true,
  tradeName: true,
  address: true,
  vatNumber: true,
  fiscalCode: true,
  reaOffice: true,
  reaNumber: true,
  shareCapital: true,
  soleShareholder: true,
  inLiquidation: true,
  currency: true,
  pec: true,
} as const

const missing = () => new NotFoundError('No portal is known at this address.')

/** The head of one company of a tenant, read in that tenant's system scope; null when the company is not active. */
async function headOf(client: Reader, tenantSlug: string, companyId: string): Promise<PortalSignInHead | null> {
  const branding = await publicBrandingOf(client, companyId)
  if (!branding) return null
  const [company, identity] = await Promise.all([
    client.company.findUniqueOrThrow({ where: { id: companyId }, select: { code: true, ...LEGAL_COLUMNS } }),
    client.emailIdentity.findFirst({
      where: { companyId, kind: 'CONVERSATION', status: 'ACTIVE', isDefault: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { fromAddress: true },
    }),
  ])
  const address = officeAddress.safeParse(company.address)
  const legal: CompanyLegal = {
    legalName: company.legalName,
    tradeName: company.tradeName,
    address: address.success ? address.data : null,
    vatNumber: company.vatNumber,
    fiscalCode: company.fiscalCode,
    reaOffice: company.reaOffice,
    reaNumber: company.reaNumber,
    shareCapital: company.shareCapital === null ? null : company.shareCapital.toFixed(2),
    soleShareholder: company.soleShareholder,
    inLiquidation: company.inLiquidation,
    currency: company.currency,
    pec: company.pec,
  }
  const block = (language: 'it' | 'en') => ({ name: legalName(legal, language), lines: legalLines(legal, language) })
  return {
    tenant: tenantSlug,
    company: { id: companyId, code: company.code, name: branding.companyName },
    branding,
    contact: { email: identity?.fromAddress ?? null },
    legal: { it: block('it'), en: block('en') },
  }
}

/** GET /branding/portal-sign-in?tenant=&company= | ?companyId= (anyone). */
export async function portalSignInHead(request: FastifyRequest, query: PortalHeadQuery): Promise<{ head: PortalSignInHead }> {
  const slug = query.tenant?.trim().toLowerCase()
  if (!slug && !query.companyId) {
    throw new ValidationError('Name the portal: tenant (and company), or companyId.', [{ path: 'querystring/tenant', message: 'Give the tenant, or the company id.' }])
  }
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId: String(request.id) })
  const inTenant = <T>(tenantId: string, work: (client: FactoryClient) => Promise<T>) => asContext(request, systemContext(tenantId, String(request.id))).withClient(work)

  if (slug) {
    const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, status: true } }))
    if (tenant?.status !== 'ACTIVE') throw missing()
    const head = await inTenant(tenant.id, async (client) => {
      const company = await portalCompany(client, query.company)
      if (!company || (query.companyId && company.id !== query.companyId)) return null
      return headOf(client, tenant.slug, company.id)
    })
    if (!head) throw missing()
    return { head }
  }

  // By the company's id: the tenant is found as the public branding finds it (each ACTIVE tenant read in its own system scope).
  const companyId = query.companyId!
  if (!isUuid(companyId)) throw missing()
  const tenants = await platform.withClient((client) => client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true, slug: true }, orderBy: { id: 'asc' } }))
  for (const tenant of tenants) {
    const head = await inTenant(tenant.id, async (client) => ((await client.company.findFirst({ where: { id: companyId, status: 'ACTIVE' }, select: { id: true } })) ? headOf(client, tenant.slug, companyId) : null))
    if (head) return { head }
  }
  throw missing()
}
