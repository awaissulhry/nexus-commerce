import type { Prisma } from '@nexus/factory-db'
import { COMPANIES_MANAGE, COMPANIES_VIEW, SITES_MANAGE, SITES_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PostalAddress } from '@nexus/factory-domain/documents/model'
import { sellerOf } from '@nexus/factory-domain/invoicing/document'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import type {
  CompanyView,
  CreateCompanyBody,
  CreateLineBody,
  CreateSiteBody,
  CreateStationBody,
  CreateWorkCentreBody,
  EditCompanyBody,
  EditLineBody,
  EditSiteBody,
  EditStationBody,
  EditWorkCentreBody,
  LineView,
  SiteView,
  StationView,
  WorkCentreView,
} from './contract'

/**
 * The tenancy core in the Office (SCR-008, SCR-009; PLT-003, PLT-004, MES-292): read and change companies, sites and a
 * site's lines, work centres and stations. Each row is checked with can() against its company and site; lists are
 * filtered with scopeWhere(). Writes go through command() with the version the caller read and one audit row from →
 * to. A company's code and a site's, line's, work centre's and station's code never change (numbers, labels and the
 * Office address use them); a row is archived, never deleted, and only while nothing active uses it.
 */

type Client = Prisma.TransactionClient

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller) => actorOf(contextOf(caller))
const createdBy = (context: RequestContext) => (context.audience === 'office' ? context.actorId : null)

function mayDo(caller: CommandCaller, permission: string, scope: { companyId: string; siteId?: string }): void {
  if (!can(actor(caller), permission as never, scope)) throw new ForbiddenError()
}

/** Refused because something active still uses the row: the issues name each kind and its count. */
function inUse(what: string, uses: Readonly<Record<string, number>>): never {
  const issues: Issue[] = Object.entries(uses)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ path: `uses/${kind}`, message: String(count) }))
  throw new DomainError('conflict', `${what} is still in use: archive or move what uses it first.`, issues)
}

const COMPANY = {
  id: true,
  code: true,
  legalName: true,
  tradeName: true,
  vatNumber: true,
  fiscalCode: true,
  regimeFiscale: true,
  reaOffice: true,
  reaNumber: true,
  shareCapital: true,
  soleShareholder: true,
  inLiquidation: true,
  address: true,
  pec: true,
  sdiReceiverCode: true,
  country: true,
  currency: true,
  timezone: true,
  locale: true,
  fiscalYearStartMonth: true,
  documentFooter: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CompanySelect
type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof COMPANY }>

const SITE = { id: true, companyId: true, code: true, name: true, kind: true, address: true, timezone: true, status: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.SiteSelect
type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE }>
const LINE = { id: true, companyId: true, siteId: true, code: true, name: true, status: true, version: true } as const satisfies Prisma.LineSelect
const CENTRE = { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, status: true, version: true } as const satisfies Prisma.WorkCentreSelect
const STATION = { id: true, companyId: true, siteId: true, lineId: true, workCentreId: true, code: true, name: true, status: true, version: true } as const satisfies Prisma.StationSelect
type LineRow = Prisma.LineGetPayload<{ select: typeof LINE }>
type CentreRow = Prisma.WorkCentreGetPayload<{ select: typeof CENTRE }>
type StationRow = Prisma.StationGetPayload<{ select: typeof STATION }>

const addressOf = (value: Prisma.JsonValue | null): PostalAddress | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const optional = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : null)
  return { line1: text('line1'), line2: optional('line2'), postalCode: text('postalCode'), city: text('city'), province: optional('province'), country: text('country') || 'IT' }
}

/** What stops the company from issuing invoices: FatturaPA's seller data (sellerOf) and an address to receive at. */
export function invoicingReadiness(row: CompanyRow): CompanyView['invoicing'] {
  const shareCapital = row.shareCapital === null ? null : row.shareCapital.toFixed(2)
  const { issues } = sellerOf({ ...row, shareCapital, address: addressOf(row.address) })
  const all = [...issues]
  if (!row.pec?.trim() && !row.sdiReceiverCode?.trim()) all.push({ path: 'company/pec', message: 'The company needs a PEC address or an SDI code to receive e-invoices.' })
  return { ready: all.length === 0, issues: all.map((issue) => ({ path: issue.path, message: issue.message })) }
}

export function companyView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    tradeName: row.tradeName,
    vatNumber: row.vatNumber,
    fiscalCode: row.fiscalCode,
    regimeFiscale: row.regimeFiscale,
    reaOffice: row.reaOffice,
    reaNumber: row.reaNumber,
    shareCapital: row.shareCapital === null ? null : row.shareCapital.toFixed(2),
    soleShareholder: row.soleShareholder,
    inLiquidation: row.inLiquidation,
    address: addressOf(row.address),
    pec: row.pec,
    sdiReceiverCode: row.sdiReceiverCode,
    country: row.country,
    currency: row.currency,
    timezone: row.timezone,
    locale: row.locale,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    documentFooter: row.documentFooter,
    status: row.status,
    invoicing: invoicingReadiness(row),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

type SiteCounts = SiteView['counts']
const NO_COUNTS: SiteCounts = { lines: 0, stations: 0, workCentres: 0, devices: 0, printers: 0 }

/** The active rows on each site (archived lines, centres and stations, revoked devices and archived printers left out). */
async function siteCounts(client: Client, siteIds: readonly string[]): Promise<Map<string, SiteCounts>> {
  const out = new Map<string, SiteCounts>(siteIds.map((id) => [id, { ...NO_COUNTS }]))
  if (siteIds.length === 0) return out
  const where = { siteId: { in: [...siteIds] } }
  const [lines, stations, centres, devices, printers] = await Promise.all([
    client.line.groupBy({ by: ['siteId'], where: { ...where, status: 'ACTIVE' }, _count: { _all: true } }),
    client.station.groupBy({ by: ['siteId'], where: { ...where, status: 'ACTIVE' }, _count: { _all: true } }),
    client.workCentre.groupBy({ by: ['siteId'], where: { ...where, status: 'ACTIVE' }, _count: { _all: true } }),
    client.device.groupBy({ by: ['siteId'], where: { ...where, status: { not: 'REVOKED' } }, _count: { _all: true } }),
    client.printer.groupBy({ by: ['siteId'], where: { ...where, status: { not: 'ARCHIVED' } }, _count: { _all: true } }),
  ])
  const add = (rows: ReadonlyArray<{ siteId: string; _count: { _all: number } }>, key: keyof SiteCounts) => {
    for (const row of rows) {
      const counts = out.get(row.siteId)
      if (counts) counts[key] = row._count._all
    }
  }
  add(lines, 'lines')
  add(stations, 'stations')
  add(centres, 'workCentres')
  add(devices, 'devices')
  add(printers, 'printers')
  return out
}

function siteView(row: SiteRow, counts: SiteCounts = NO_COUNTS): SiteView {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    address: addressOf(row.address),
    timezone: row.timezone,
    status: row.status,
    counts,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const lineView = (row: LineRow): LineView => ({ id: row.id, siteId: row.siteId, code: row.code, name: row.name, status: row.status, version: row.version })
const centreView = (row: CentreRow): WorkCentreView => ({ id: row.id, siteId: row.siteId, code: row.code, name: row.name, kind: row.kind, status: row.status, version: row.version })
const stationView = (row: StationRow, devices = 0): StationView => ({
  id: row.id,
  siteId: row.siteId,
  lineId: row.lineId,
  workCentreId: row.workCentreId,
  code: row.code,
  name: row.name,
  status: row.status,
  devices,
  version: row.version,
})

/** The sites of these companies the caller may see (sites.view), with their counts. */
async function sitesOf(caller: CommandCaller, client: Client, companyIds: readonly string[], includeArchived: boolean): Promise<SiteView[]> {
  if (companyIds.length === 0 || !holds(actor(caller), SITES_VIEW)) return []
  const rows = await client.site.findMany({
    where: {
      AND: [
        scopeWhere(actor(caller), SITES_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput,
        { companyId: { in: [...companyIds] } },
        includeArchived ? {} : { status: 'ACTIVE' },
      ],
    },
    select: SITE,
    orderBy: [{ code: 'asc' }],
    take: 500,
  })
  const counts = await siteCounts(
    client,
    rows.map((row) => row.id),
  )
  return rows.map((row) => siteView(row, counts.get(row.id)))
}

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function listCompanies(caller: CommandCaller, query: { includeArchived?: boolean | undefined }): Promise<Array<CompanyView & { sites: SiteView[] }>> {
  const includeArchived = query.includeArchived ?? false
  return caller.withClient(async (client) => {
    const rows = await client.company.findMany({
      where: { AND: [scopeWhere(actor(caller), COMPANIES_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, includeArchived ? {} : { status: 'ACTIVE' }] },
      select: COMPANY,
      orderBy: [{ code: 'asc' }],
      take: 200,
    })
    const sites = await sitesOf(
      caller,
      client,
      rows.map((row) => row.id),
      includeArchived,
    )
    return rows.map((row) => ({ ...companyView(row), sites: sites.filter((site) => site.companyId === row.id) }))
  })
}

async function readCompany(client: Client, companyId: string): Promise<CompanyRow> {
  const row = isUuid(companyId) ? await client.company.findUnique({ where: { id: companyId }, select: COMPANY }) : null
  if (!row) throw new NotFoundError('Company not found.')
  return row
}

export async function getCompany(caller: CommandCaller, companyId: string): Promise<{ company: CompanyView; sites: SiteView[] }> {
  return caller.withClient(async (client) => {
    const row = await readCompany(client, companyId)
    if (!can(actor(caller), COMPANIES_VIEW, { companyId: row.id })) throw new NotFoundError('Company not found.')
    return { company: companyView(row), sites: await sitesOf(caller, client, [row.id], true) }
  })
}

async function readSite(caller: CommandCaller, client: Client, siteId: string, permission: string = SITES_VIEW): Promise<SiteRow> {
  const row = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: SITE }) : null
  if (!row || !can(actor(caller), SITES_VIEW, { companyId: row.companyId, siteId: row.id })) throw new NotFoundError('Site not found.')
  if (permission !== SITES_VIEW) mayDo(caller, permission, { companyId: row.companyId, siteId: row.id })
  return row
}

export async function getSite(caller: CommandCaller, siteId: string) {
  return caller.withClient(async (client) => {
    const site = await readSite(caller, client, siteId)
    const [company, lines, workCentres, stations, devices] = await Promise.all([
      client.company.findUnique({ where: { id: site.companyId }, select: { id: true, code: true, legalName: true } }),
      client.line.findMany({ where: { siteId: site.id }, select: LINE, orderBy: [{ code: 'asc' }] }),
      client.workCentre.findMany({ where: { siteId: site.id }, select: CENTRE, orderBy: [{ code: 'asc' }] }),
      client.station.findMany({ where: { siteId: site.id }, select: STATION, orderBy: [{ code: 'asc' }] }),
      client.device.groupBy({ by: ['stationId'], where: { siteId: site.id, status: { not: 'REVOKED' }, stationId: { not: null } }, _count: { _all: true } }),
    ])
    if (!company) throw new NotFoundError('Site not found.')
    const perStation = new Map(devices.map((row) => [row.stationId, row._count._all]))
    const counts = await siteCounts(client, [site.id])
    return {
      site: siteView(site, counts.get(site.id)),
      company,
      lines: lines.map(lineView),
      workCentres: workCentres.map(centreView),
      stations: stations.map((row) => stationView(row, perStation.get(row.id) ?? 0)),
    }
  })
}

// ---- companies --------------------------------------------------------------------------------------------------------

const auditedCompany = (row: CompanyRow) => {
  const { id: _id, version: _version, createdAt: _created, updatedAt: _updated, ...fields } = row
  return { ...fields, shareCapital: row.shareCapital === null ? null : row.shareCapital.toFixed(2) }
}

/** org.createCompany: a new legal entity of the tenant (only with companies.manage over every company). */
export async function createCompany(caller: CommandCaller, input: CreateCompanyBody, idempotencyKey?: string): Promise<CompanyView> {
  if (!grantsFor(actor(caller), COMPANIES_MANAGE).some((grant) => grant.companies === 'all')) throw new ForbiddenError()
  const taken = await caller.withClient((client) => client.company.findFirst({ where: { code: input.code }, select: { id: true } }))
  if (taken) throw new ConflictError(`The tenant already has a company ${input.code}.`)
  const { result } = await command(caller, { name: 'org.createCompany', idempotencyKey, input }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.company.create({
      data: { id, code: input.code, legalName: input.legalName, vatNumber: input.vatNumber ?? null, country: input.country ?? 'IT', createdAt: now, updatedAt: now, createdById: createdBy(context) },
      select: COMPANY,
    })
    audit({ recordType: 'Company', recordId: id, companyId: id, after: auditedCompany(row) })
    return companyView(row)
  })
  return result
}

/** org.editCompany: legal, e-invoicing and default data, or the status (archived only while it has no active site). */
export async function editCompany(caller: CommandCaller, companyId: string, input: EditCompanyBody, idempotencyKey?: string): Promise<CompanyView> {
  const before = await caller.withClient((client) => readCompany(client, companyId))
  if (!can(actor(caller), COMPANIES_VIEW, { companyId: before.id })) throw new NotFoundError('Company not found.')
  mayDo(caller, COMPANIES_MANAGE, { companyId: before.id })
  const { version: _version, reason, ...fields } = input
  const { address, ...plain } = fields
  const changes: Prisma.CompanyUpdateInput = {}
  for (const [key, value] of Object.entries(plain)) if (value !== undefined) (changes as Record<string, unknown>)[key] = value
  if (address) changes.address = address
  if (fields.status === 'ARCHIVED' && before.status !== 'ARCHIVED') {
    const sites = await caller.withClient((client) => client.site.count({ where: { companyId: before.id, status: 'ACTIVE' } }))
    if (sites > 0) inUse('The company', { sites })
  }
  const { result } = await command(
    caller,
    { name: 'org.editCompany', idempotencyKey, input: { companyId, ...input }, record: { type: 'Company', id: before.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      await tx.company.update({ where: { id: before.id }, data: changes, select: { id: true } })
      // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
      if (address === null) await tx.$executeRaw`UPDATE "Company" SET "address" = NULL WHERE "id" = ${before.id}::uuid`
      const row = await tx.company.findUniqueOrThrow({ where: { id: before.id }, select: COMPANY })
      audit({ recordType: 'Company', recordId: row.id, companyId: row.id, before: auditedCompany(before), after: auditedCompany(row), ...(reason ? { reason } : {}) })
      return companyView(row)
    },
  )
  return result
}

// ---- sites ------------------------------------------------------------------------------------------------------------

const auditedSite = (row: SiteRow) => ({ companyId: row.companyId, code: row.code, name: row.name, kind: row.kind, address: row.address, timezone: row.timezone, status: row.status })

/** org.createSite: a plant, warehouse or office of a company the caller manages sites of. */
export async function createSite(caller: CommandCaller, input: CreateSiteBody, idempotencyKey?: string): Promise<SiteView> {
  const company = await caller.withClient((client) => client.company.findUnique({ where: { id: input.companyId }, select: { id: true, status: true, timezone: true } }))
  if (!company || !can(actor(caller), COMPANIES_VIEW, { companyId: company.id })) throw new NotFoundError('Company not found.')
  mayDo(caller, SITES_MANAGE, { companyId: company.id })
  if (company.status !== 'ACTIVE') throw new DomainError('invalid_state', 'The company is archived.', [{ path: 'body/companyId', message: 'archived' }])
  const taken = await caller.withClient((client) => client.site.findFirst({ where: { code: input.code }, select: { id: true } }))
  if (taken) throw new ConflictError(`The tenant already has a site ${input.code}.`)
  const { result } = await command(caller, { name: 'org.createSite', idempotencyKey, input }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.site.create({
      data: {
        id,
        companyId: company.id,
        code: input.code,
        name: input.name,
        kind: input.kind,
        timezone: input.timezone ?? company.timezone,
        ...(input.address ? { address: input.address } : {}),
        createdAt: now,
        updatedAt: now,
        createdById: createdBy(context),
      },
      select: SITE,
    })
    audit({ recordType: 'Site', recordId: id, companyId: row.companyId, siteId: id, after: auditedSite(row) })
    return siteView(row)
  })
  return result
}

/** org.editSite: name, kind, time zone, address, or archived (only while no active line, station, device or printer is on it). */
export async function editSite(caller: CommandCaller, siteId: string, input: EditSiteBody, idempotencyKey?: string): Promise<SiteView> {
  const before = await caller.withClient((client) => readSite(caller, client, siteId, SITES_MANAGE))
  if (input.status === 'ARCHIVED' && before.status !== 'ARCHIVED') {
    const counts = (await caller.withClient((client) => siteCounts(client, [before.id]))).get(before.id) ?? NO_COUNTS
    if (counts.lines + counts.stations + counts.devices + counts.printers > 0) inUse('The site', { lines: counts.lines, stations: counts.stations, devices: counts.devices, printers: counts.printers })
  }
  const { result } = await command(
    caller,
    { name: 'org.editSite', idempotencyKey, input: { siteId, ...input }, record: { type: 'Site', id: before.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      await tx.site.update({
        where: { id: before.id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.address ? { address: input.address } : {}),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        select: { id: true },
      })
      // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
      if (input.address === null) await tx.$executeRaw`UPDATE "Site" SET "address" = NULL WHERE "id" = ${before.id}::uuid`
      const row = await tx.site.findUniqueOrThrow({ where: { id: before.id }, select: SITE })
      audit({ recordType: 'Site', recordId: row.id, companyId: row.companyId, siteId: row.id, before: auditedSite(before), after: auditedSite(row), ...(input.reason ? { reason: input.reason } : {}) })
      const counts = await siteCounts(tx, [row.id])
      return siteView(row, counts.get(row.id))
    },
  )
  return result
}

// ---- lines, work centres, stations ------------------------------------------------------------------------------------

async function codeFree(tx: CommandTx | Client, model: 'line' | 'workCentre' | 'station', siteId: string, code: string): Promise<void> {
  const where = { siteId, code }
  const taken =
    model === 'line'
      ? await tx.line.findFirst({ where, select: { id: true } })
      : model === 'workCentre'
        ? await tx.workCentre.findFirst({ where, select: { id: true } })
        : await tx.station.findFirst({ where, select: { id: true } })
  if (taken) throw new ConflictError(`The site already has ${model === 'line' ? 'a line' : model === 'workCentre' ? 'a work centre' : 'a station'} ${code}.`)
}

function activeSite(site: SiteRow): void {
  if (site.status !== 'ACTIVE') throw new DomainError('invalid_state', 'The site is archived.', [{ path: 'params/siteId', message: 'archived' }])
}

/** org.createLine. */
export async function createLine(caller: CommandCaller, siteId: string, input: CreateLineBody, idempotencyKey?: string): Promise<LineView> {
  const site = await caller.withClient((client) => readSite(caller, client, siteId, SITES_MANAGE))
  activeSite(site)
  await caller.withClient((client) => codeFree(client, 'line', site.id, input.code))
  const { result } = await command(caller, { name: 'org.createLine', idempotencyKey, input: { siteId, ...input } }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.line.create({ data: { id, companyId: site.companyId, siteId: site.id, code: input.code, name: input.name, createdAt: now, updatedAt: now, createdById: createdBy(context) }, select: LINE })
    audit({ recordType: 'Line', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { code: row.code, name: row.name, status: row.status } })
    return lineView(row)
  })
  return result
}

async function readPart<Row extends { companyId: string; siteId: string }>(caller: CommandCaller, read: (client: Client) => Promise<Row | null>, what: string): Promise<Row> {
  const row = await caller.withClient(read)
  if (!row || !can(actor(caller), SITES_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError(`${what} not found.`)
  mayDo(caller, SITES_MANAGE, { companyId: row.companyId, siteId: row.siteId })
  return row
}

/** org.editLine: its name, or archived (only while no active station is on it). */
export async function editLine(caller: CommandCaller, lineId: string, input: EditLineBody, idempotencyKey?: string): Promise<LineView> {
  const before = await readPart(caller, (client) => (isUuid(lineId) ? client.line.findUnique({ where: { id: lineId }, select: LINE }) : Promise.resolve(null)), 'Line')
  if (input.status === 'ARCHIVED' && before.status !== 'ARCHIVED') {
    const stations = await caller.withClient((client) => client.station.count({ where: { lineId: before.id, status: 'ACTIVE' } }))
    if (stations > 0) inUse('The line', { stations })
  }
  const { result } = await command(
    caller,
    { name: 'org.editLine', idempotencyKey, input: { lineId, ...input }, record: { type: 'Line', id: before.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.line.update({ where: { id: before.id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.status === undefined ? {} : { status: input.status }) }, select: LINE })
      audit({ recordType: 'Line', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { name: before.name, status: before.status }, after: { name: row.name, status: row.status }, ...(input.reason ? { reason: input.reason } : {}) })
      return lineView(row)
    },
  )
  return result
}

/** org.createWorkCentre. */
export async function createWorkCentre(caller: CommandCaller, siteId: string, input: CreateWorkCentreBody, idempotencyKey?: string): Promise<WorkCentreView> {
  const site = await caller.withClient((client) => readSite(caller, client, siteId, SITES_MANAGE))
  activeSite(site)
  await caller.withClient((client) => codeFree(client, 'workCentre', site.id, input.code))
  const { result } = await command(caller, { name: 'org.createWorkCentre', idempotencyKey, input: { siteId, ...input } }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.workCentre.create({
      data: { id, companyId: site.companyId, siteId: site.id, code: input.code, name: input.name, kind: input.kind, createdAt: now, updatedAt: now, createdById: createdBy(context) },
      select: CENTRE,
    })
    audit({ recordType: 'WorkCentre', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { code: row.code, name: row.name, kind: row.kind, status: row.status } })
    return centreView(row)
  })
  return result
}

/** org.editWorkCentre: its name, or archived (only while no active station belongs to it). */
export async function editWorkCentre(caller: CommandCaller, workCentreId: string, input: EditWorkCentreBody, idempotencyKey?: string): Promise<WorkCentreView> {
  const before = await readPart(caller, (client) => (isUuid(workCentreId) ? client.workCentre.findUnique({ where: { id: workCentreId }, select: CENTRE }) : Promise.resolve(null)), 'Work centre')
  if (input.status === 'ARCHIVED' && before.status !== 'ARCHIVED') {
    const stations = await caller.withClient((client) => client.station.count({ where: { workCentreId: before.id, status: 'ACTIVE' } }))
    if (stations > 0) inUse('The work centre', { stations })
  }
  const { result } = await command(
    caller,
    { name: 'org.editWorkCentre', idempotencyKey, input: { workCentreId, ...input }, record: { type: 'WorkCentre', id: before.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.workCentre.update({ where: { id: before.id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.status === undefined ? {} : { status: input.status }) }, select: CENTRE })
      audit({ recordType: 'WorkCentre', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { name: before.name, status: before.status }, after: { name: row.name, status: row.status }, ...(input.reason ? { reason: input.reason } : {}) })
      return centreView(row)
    },
  )
  return result
}

/** The line and work centre a station names: on the station's site and active. */
async function stationTargets(client: Client, siteId: string, target: { lineId?: string | null | undefined; workCentreId?: string | undefined }): Promise<void> {
  const issues: Issue[] = []
  if (target.lineId) {
    const line = await client.line.findUnique({ where: { id: target.lineId }, select: { siteId: true, status: true } })
    if (!line || line.siteId !== siteId || line.status !== 'ACTIVE') issues.push({ path: 'body/lineId', message: 'Expected an active line of this site.' })
  }
  if (target.workCentreId) {
    const centre = await client.workCentre.findUnique({ where: { id: target.workCentreId }, select: { siteId: true, status: true } })
    if (!centre || centre.siteId !== siteId || centre.status !== 'ACTIVE') issues.push({ path: 'body/workCentreId', message: 'Expected an active work centre of this site.' })
  }
  if (issues.length > 0) throw new DomainError('validation_failed', 'The station is not valid.', issues)
}

/** org.createStation: on a line of the site, or standing alone; it belongs to one work centre of the site. */
export async function createStation(caller: CommandCaller, siteId: string, input: CreateStationBody, idempotencyKey?: string): Promise<StationView> {
  const site = await caller.withClient((client) => readSite(caller, client, siteId, SITES_MANAGE))
  activeSite(site)
  await caller.withClient(async (client) => {
    await stationTargets(client, site.id, input)
    await codeFree(client, 'station', site.id, input.code)
  })
  const { result } = await command(caller, { name: 'org.createStation', idempotencyKey, input: { siteId, ...input } }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.station.create({
      data: { id, companyId: site.companyId, siteId: site.id, lineId: input.lineId ?? null, workCentreId: input.workCentreId, code: input.code, name: input.name, createdAt: now, updatedAt: now, createdById: createdBy(context) },
      select: STATION,
    })
    audit({ recordType: 'Station', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { code: row.code, name: row.name, lineId: row.lineId, workCentreId: row.workCentreId, status: row.status } })
    return stationView(row)
  })
  return result
}

/** org.editStation: its name, line (or none), work centre, or archived (only while no device is enrolled at it). */
export async function editStation(caller: CommandCaller, stationId: string, input: EditStationBody, idempotencyKey?: string): Promise<StationView> {
  const before = await readPart(caller, (client) => (isUuid(stationId) ? client.station.findUnique({ where: { id: stationId }, select: STATION }) : Promise.resolve(null)), 'Station')
  await caller.withClient((client) => stationTargets(client, before.siteId, input))
  const devices = await caller.withClient((client) => client.device.count({ where: { stationId: before.id, status: { not: 'REVOKED' } } }))
  if (input.status === 'ARCHIVED' && before.status !== 'ARCHIVED' && devices > 0) inUse('The station', { devices })
  const { result } = await command(
    caller,
    { name: 'org.editStation', idempotencyKey, input: { stationId, ...input }, record: { type: 'Station', id: before.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.station.update({
        where: { id: before.id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.lineId === undefined ? {} : { lineId: input.lineId }),
          ...(input.workCentreId === undefined ? {} : { workCentreId: input.workCentreId }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        select: STATION,
      })
      const fields = (station: StationRow) => ({ name: station.name, lineId: station.lineId, workCentreId: station.workCentreId, status: station.status })
      audit({ recordType: 'Station', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: fields(before), after: fields(row), ...(input.reason ? { reason: input.reason } : {}) })
      return stationView(row, devices)
    },
  )
  return result
}
