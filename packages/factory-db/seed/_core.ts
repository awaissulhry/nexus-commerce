import { SiteKind, TenantStatus, WorkCentreKind } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The tenancy core's synthetic seed: one made-up tenant with two companies, one plant per company, and on each plant
 * four work centres, a line and five stations (two on the line, three standing alone). Every name is invented
 * ("Seed …"); no fiscal identifier is filled in. Company A has a bank account for its deposits: the IBAN is the
 * documented Italian example of the SWIFT IBAN registry (no real account), no BIC; company B has none. The tenant is
 * written in the platform scope, everything else in the tenant's office scope, as the app does.
 */

export interface CoreSeed {
  readonly tenantId: string
  readonly actorId: string
  readonly companies: readonly { readonly id: string; readonly code: string }[]
  readonly sites: readonly { readonly id: string; readonly companyId: string; readonly code: string }[]
}

/** The IBAN registry's documented example for Italy (ISO 13616): a valid check digit, no real account. */
export const EXAMPLE_IBAN_IT = 'IT60X0542811101000000123456'

const COMPANIES = [
  { key: 'A', site: 'A1', bank: { bankAccountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_IT, bic: null, bankName: 'Seed example bank' } },
  { key: 'B', site: 'B1', bank: { bankAccountHolder: null, iban: null, bic: null, bankName: null } },
] as const

const WORK_CENTRES = [
  { code: 'CUT', name: 'Cutting', kind: WorkCentreKind.CUTTING },
  { code: 'SEW', name: 'Sewing', kind: WorkCentreKind.SEWING },
  { code: 'QC', name: 'Final inspection', kind: WorkCentreKind.INSPECTION },
  { code: 'PACK', name: 'Packing', kind: WorkCentreKind.PACKING },
] as const

// The sewing stations sit on the line; the cutting table and the benches stand alone on the site.
const STATIONS = [
  { code: 'CUT-01', name: 'Cutting table 1', workCentre: 'CUT', onLine: false },
  { code: 'SEW-01', name: 'Sewing station 1', workCentre: 'SEW', onLine: true },
  { code: 'SEW-02', name: 'Sewing station 2', workCentre: 'SEW', onLine: true },
  { code: 'QC-01', name: 'Inspection bench 1', workCentre: 'QC', onLine: false },
  { code: 'PACK-01', name: 'Packing bench 1', workCentre: 'PACK', onLine: false },
] as const

export async function seed({ db, namespace }: SeedContext): Promise<CoreSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  const tenant = { slug: namespace, name: `Seed group (${namespace})`, status: TenantStatus.ACTIVE, defaultLocale: 'it' }
  await db.withScope({ audience: 'platform' }, (client) =>
    client.tenant.upsert({ where: { id: tenantId }, create: { id: tenantId, ...tenant }, update: tenant }),
  )

  const companies = COMPANIES.map((company) => ({ id: id(`company:${company.key}`), code: `SC${company.key}`, ...company }))
  const sites = companies.map((company) => ({ id: id(`site:${company.site}`), companyId: company.id, code: company.site }))

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const company of companies) {
        const data = {
          code: company.code,
          legalName: `Seed Company ${company.key}`,
          tradeName: `Seed ${company.key}`,
          address: { line1: `Via Esempio ${company.key === 'A' ? 1 : 2}`, postalCode: '00000', city: 'Seedville', country: 'IT' },
          documentFooter: `Seed Company ${company.key} - synthetic data`,
          ...company.bank,
        }
        await tx.company.upsert({ where: { id: company.id }, create: { id: company.id, ...data }, update: data })
      }
      for (const site of sites) {
        // Its delivery address: purchase orders print it (and refuse a send without it).
        const address = { line1: `Via Esempio ${site.code === 'A1' ? 11 : 12}`, postalCode: '00000', city: 'Seedville', country: 'IT' }
        const data = { companyId: site.companyId, code: site.code, name: `Seed plant ${site.code}`, kind: SiteKind.PLANT, address }
        await tx.site.upsert({ where: { id: site.id }, create: { id: site.id, ...data }, update: data })

        const at = { companyId: site.companyId, siteId: site.id }
        const workCentre = (code: string): string => id(`site:${site.code}:work-centre:${code}`)
        for (const centre of WORK_CENTRES) {
          const centreData = { ...at, code: centre.code, name: centre.name, kind: centre.kind }
          await tx.workCentre.upsert({ where: { id: workCentre(centre.code) }, create: { id: workCentre(centre.code), ...centreData }, update: centreData })
        }
        const lineId = id(`site:${site.code}:line:L1`)
        const lineData = { ...at, code: 'L1', name: `Line 1 (${site.code})` }
        await tx.line.upsert({ where: { id: lineId }, create: { id: lineId, ...lineData }, update: lineData })
        for (const station of STATIONS) {
          const stationId = id(`site:${site.code}:station:${station.code}`)
          const stationData = { ...at, lineId: station.onLine ? lineId : null, workCentreId: workCentre(station.workCentre), code: station.code, name: station.name }
          await tx.station.upsert({ where: { id: stationId }, create: { id: stationId, ...stationData }, update: stationData })
        }
      }
    }),
  )

  return {
    tenantId,
    actorId,
    companies: companies.map(({ id: companyId, code }) => ({ id: companyId, code })),
    sites,
  }
}
