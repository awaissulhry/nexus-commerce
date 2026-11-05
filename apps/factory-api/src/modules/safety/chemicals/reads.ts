import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { SAFETY_CHEMICALS_MANAGE } from '@nexus/factory-domain/safety/chemicals/permissions'
import { cabinetCodeOf, CHEMICAL_LIMITS, REGISTER_LAW, SDS_LAW, type ChemicalUse } from '@nexus/factory-domain/safety/chemicals/rules'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type OfficeContext, type SystemContext } from '../../../core/context'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { officeOf, todayOf } from '../../people/employees/access'
import { CHEMICAL_SELECT, chemicalScope, chemicalViews, mayManage, newestFirst, quantityText, SHEET_SELECT, sheetViews, type ChemicalRow, type SheetRow } from './store'

/**
 * The chemical register's reads (B-W2b-143; QHS-277, QHS-278; design plant.chemicals), office only, safety.view, each
 * chemical checked against its company and site:
 *
 *   GET /safety/chemicals                         the register (site from the top bar or every site the caller reaches;
 *                                                 `status`, `tile`, `use`, `cabinet`, `q`), the companies and sites
 *   GET /safety/chemicals/counts                  the tiles: active products, without SDS, SDS to request, cabinets
 *   GET /safety/chemicals/:id                     one chemical with every sheet, current and superseded
 *   GET /safety/chemicals/data-sheets             the SDS library: the current sheet per product and language with the
 *                                                 versions it replaced, and the active products with none
 *   GET /safety/chemicals/cabinets                the cabinets (the Print cabinet QR dialog)
 *   GET /safety/chemicals/cabinets/:siteId/:code  one cabinet's products for the wall sheet (new tab, print)
 *   GET /safety/chemicals/choices?siteId          the dialog's role sheets of the site, PPE items of the company, supplier
 *                                                 parties, and the cabinets and places already named (manage)
 *   GET /safety/chemicals/:id/data-sheets/:sheetId/download   a sheet's PDF (the SDS window, the viewer)
 */

const LAW = { register: REGISTER_LAW, sds: SDS_LAW }

type ScopeQuery = { readonly companyId?: string | undefined; readonly siteId?: string | undefined }

const asked = (query: ScopeQuery): Prisma.ChemicalWhereInput => ({ ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.siteId ? { siteId: query.siteId } : {}) })

const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

/** The companies (with their language) and sites the caller reads the register of (ACTIVE), narrowed as asked. */
async function placesOf(client: FactoryClient, context: OfficeContext, query: ScopeQuery) {
  const actor = actorOf(context)
  const companies = await client.company.findMany({
    where: { AND: [scopeWhere(actor, SAFETY_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, { status: 'ACTIVE' }, context.companyId ? { id: context.companyId } : {}, query.companyId ? { id: query.companyId } : {}] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, legalName: true, locale: true },
  })
  const sites = await client.site.findMany({
    where: { AND: [scopeWhere(actor, SAFETY_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, { status: 'ACTIVE', companyId: { in: companies.map((company) => company.id) } }, query.siteId ? { id: query.siteId } : {}] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, companyId: true, code: true, name: true },
  })
  return companies.map((company) => ({ id: company.id, code: company.code, name: company.legalName, language: company.locale, sites: sites.filter((site) => site.companyId === company.id).map((site) => ({ id: site.id, code: site.code, name: site.name })) }))
}

const byName = (a: { name: string; site: { code: string }; id: string }, b: { name: string; site: { code: string }; id: string }): number =>
  a.site.code.localeCompare(b.site.code) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) || a.id.localeCompare(b.id)

/** Every chemical of the scope the caller reads, as the screens show them (the tiles count from the same rows). */
async function registerOf(client: FactoryClient, context: OfficeContext, where: Prisma.ChemicalWhereInput) {
  const rows = (await client.chemical.findMany({ where: { AND: [chemicalScope(context, SAFETY_VIEW), where] }, take: CHEMICAL_LIMITS.list + 1, select: CHEMICAL_SELECT })) as ChemicalRow[]
  const complete = rows.length <= CHEMICAL_LIMITS.list
  return { views: (await chemicalViews(client, context, rows.slice(0, CHEMICAL_LIMITS.list))).sort(byName), complete }
}

export interface ListQuery extends ScopeQuery {
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined
  readonly tile?: 'withoutSds' | 'toRequest' | undefined
  readonly use?: ChemicalUse | undefined
  readonly cabinet?: string | undefined
  readonly q?: string | undefined
  readonly limit?: number | undefined
}

/** The register's rows, filtered as the list's address asks (the export reads the same). */
export async function listChemicals(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const status = query.status ?? 'ACTIVE'
    const words = (query.q ?? '').trim()
    const where: Prisma.ChemicalWhereInput = {
      AND: [
        asked(query),
        status === 'all' ? {} : { status },
        query.use ? { use: query.use } : {},
        query.cabinet ? { cabinetCode: cabinetCodeOf(query.cabinet) } : {},
        words ? { OR: [{ name: { contains: words, mode: 'insensitive' } }, { supplierName: { contains: words, mode: 'insensitive' } }, { storagePlace: { contains: words, mode: 'insensitive' } }, { cabinetCode: { contains: words, mode: 'insensitive' } }, { hazardStatements: { has: words.toUpperCase() } }] } : {},
      ],
    }
    const { views, complete } = await registerOf(client, context, where)
    const tiled = query.tile === 'withoutSds' ? views.filter((view) => view.status === 'ACTIVE' && view.sheetState === 'MISSING') : query.tile === 'toRequest' ? views.filter((view) => view.status === 'ACTIVE' && view.sheetState === 'OTHER_LANGUAGE') : views
    const limit = query.limit ?? CHEMICAL_LIMITS.list
    return {
      chemicals: tiled.slice(0, limit),
      complete: complete && tiled.length <= limit,
      companies: await placesOf(client, context, query),
      canManage: holdsHere(context, SAFETY_CHEMICALS_MANAGE),
      law: LAW,
      today: todayOf(now),
    }
  })
}

/** GET /safety/chemicals/counts. */
export async function chemicalCounts(caller: CommandCaller, query: ScopeQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const { views } = await registerOf(client, context, { AND: [asked(query), { status: 'ACTIVE' }] })
    return {
      active: views.length,
      withoutSds: views.filter((view) => view.sheetState === 'MISSING').length,
      toRequest: views.filter((view) => view.sheetState === 'OTHER_LANGUAGE').length,
      cabinets: new Set(views.filter((view) => view.cabinetCode !== null).map((view) => `${view.siteId}|${view.cabinetCode}`)).size,
    }
  })
}

/** One chemical the caller reads, or a 404. */
export async function readChemical(client: FactoryClient, context: OfficeContext, chemicalId: string): Promise<ChemicalRow> {
  const row = isUuid(chemicalId) ? ((await client.chemical.findUnique({ where: { id: chemicalId }, select: CHEMICAL_SELECT })) as ChemicalRow | null) : null
  if (!row || (context.companyId && context.companyId !== row.companyId) || !can(actorOf(context), SAFETY_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Chemical not found.')
  return row
}

/** GET /safety/chemicals/:id. */
export async function chemicalRecord(caller: CommandCaller, chemicalId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readChemical(client, context, chemicalId)
    const [chemical] = await chemicalViews(client, context, [row])
    const sheets = (await client.safetyDataSheet.findMany({ where: { chemicalId: row.id }, select: SHEET_SELECT })) as SheetRow[]
    return { chemical: chemical!, sheets: await sheetViews(client, [...sheets].sort((a, b) => (a.status === b.status ? newestFirst(a, b) : a.status === 'CURRENT' ? -1 : 1))), today: todayOf(now) }
  })
}

/** GET /safety/chemicals/data-sheets: the library. */
export async function sheetLibrary(caller: CommandCaller, query: ScopeQuery & { readonly q?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const words = (query.q ?? '').trim()
    const { views } = await registerOf(client, context, { AND: [asked(query), { status: 'ACTIVE' }, words ? { name: { contains: words, mode: 'insensitive' } } : {}] })
    const all = (await client.safetyDataSheet.findMany({ where: { chemicalId: { in: views.map((view) => view.id) } }, select: SHEET_SELECT })) as SheetRow[]
    const superseded = [...all].filter((sheet) => sheet.status === 'SUPERSEDED').sort(newestFirst)
    const sheets = views.flatMap((view) =>
      view.current.map((sheet) => ({
        id: sheet.id,
        chemicalId: view.id,
        chemical: view.name,
        site: view.site,
        siteId: view.siteId,
        versionLabel: sheet.versionLabel,
        revisedOn: sheet.revisedOn,
        language: sheet.language,
        fileId: sheet.fileId,
        fileName: sheet.fileName,
        addedAt: sheet.addedAt,
        superseded: superseded
          .filter((old) => old.chemicalId === view.id && old.language === sheet.language)
          .map((old) => ({ id: old.id, versionLabel: old.versionLabel, revisedOn: old.revisedOn.toISOString().slice(0, 10), supersededAt: old.supersededAt?.toISOString() ?? null })),
        canManage: view.canManage,
      })),
    )
    const missing = views.filter((view) => view.current.length === 0).map((view) => ({ chemicalId: view.id, chemical: view.name, site: view.site, canManage: view.canManage }))
    return { sheets, missing }
  })
}

/** GET /safety/chemicals/cabinets. */
export async function listCabinets(caller: CommandCaller, query: ScopeQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const { views } = await registerOf(client, context, { AND: [asked(query), { status: 'ACTIVE' }, { cabinetCode: { not: null } }] })
    const cabinets = new Map<string, { siteId: string; site: { code: string; name: string }; code: string; places: string[]; products: number; withoutSheet: number }>()
    for (const view of views) {
      const key = `${view.siteId}|${view.cabinetCode}`
      const cabinet = cabinets.get(key) ?? { siteId: view.siteId, site: view.site, code: view.cabinetCode!, places: [], products: 0, withoutSheet: 0 }
      if (!cabinet.places.includes(view.storagePlace)) cabinet.places.push(view.storagePlace)
      cabinet.products += 1
      if (view.current.length === 0) cabinet.withoutSheet += 1
      cabinets.set(key, cabinet)
    }
    return { cabinets: [...cabinets.values()].sort((a, b) => a.site.code.localeCompare(b.site.code) || a.code.localeCompare(b.code)) }
  })
}

/** GET /safety/chemicals/cabinets/:siteId/:code: the wall sheet. */
export async function cabinetSheet(caller: CommandCaller, siteId: string, code: string, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const cabinet = cabinetCodeOf(code) ?? ''
    const site = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: { id: true, code: true, name: true, companyId: true, company: { select: { code: true, legalName: true } } } }) : null
    if (!site || (context.companyId && context.companyId !== site.companyId) || !can(actorOf(context), SAFETY_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Cabinet not found.')
    const { views } = await registerOf(client, context, { siteId: site.id, status: 'ACTIVE', cabinetCode: cabinet })
    if (views.length === 0) throw new NotFoundError('Cabinet not found.')
    return {
      siteId: site.id,
      site: { code: site.code, name: site.name },
      company: { code: site.company.code, name: site.company.legalName },
      code: cabinet,
      places: [...new Set(views.map((view) => view.storagePlace))],
      chemicals: views.map((view) => ({
        id: view.id,
        name: view.name,
        supplier: view.supplier.name,
        use: view.use,
        ghsPictograms: view.ghsPictograms,
        signalWord: view.signalWord,
        hazardStatements: view.hazardStatements,
        precautionStatements: view.precautionStatements,
        storagePlace: view.storagePlace,
        maxQuantity: view.maxQuantity,
        maxQuantityUnit: view.maxQuantityUnit,
        ppe: view.ppe.map((item) => item.name),
        current: view.current.map((sheet) => ({ id: sheet.id, versionLabel: sheet.versionLabel, revisedOn: sheet.revisedOn, language: sheet.language })),
      })),
      law: LAW,
      today: todayOf(now),
    }
  })
}

/** GET /safety/chemicals/choices?siteId: what the Add chemical and Edit dialogs offer at a site. */
export async function chemicalChoices(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } })
    if (!site || (context.companyId && context.companyId !== site.companyId) || !can(actorOf(context), SAFETY_CHEMICALS_MANAGE, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const [roles, ppe, suppliers, named] = await Promise.all([
      client.roleSheet.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, code: true, name: true } }),
      client.ppeItem.findMany({ where: { companyId: site.companyId, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, code: true, name: true } }),
      client.party.findMany({ where: { status: 'ACTIVE', roles: { has: 'SUPPLIER' }, OR: [{ companyId: null }, { companyId: site.companyId }] }, orderBy: [{ legalName: 'asc' }, { id: 'asc' }], take: 300, select: { id: true, code: true, legalName: true, tradeName: true } }),
      client.chemical.findMany({ where: { siteId: site.id }, select: { cabinetCode: true, storagePlace: true }, take: CHEMICAL_LIMITS.list }),
    ])
    return {
      roles,
      ppe,
      suppliers: suppliers.map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })),
      cabinets: [...new Set(named.map((row) => row.cabinetCode).filter((code): code is string => code !== null))].sort(),
      places: [...new Set(named.map((row) => row.storagePlace))].sort((a, b) => a.localeCompare(b, 'it')),
    }
  })
}

/** The tenant's system caller holding only files.read over one site (the store call reads the file as the module decides). */
export function readerAt(request: FastifyRequest, tenantId: string, place: { readonly companyId: string; readonly siteId: string }): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_READ], companies: [place.companyId], sites: [place.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** GET /safety/chemicals/:id/data-sheets/:sheetId/download: safety.view reads a sheet, current or superseded. */
export async function downloadSheet(request: FastifyRequest, chemicalId: string, sheetId: string) {
  const context = officeOf(request)
  const { row, sheet } = await request.withClient(async (client) => {
    const row = await readChemical(client, context, chemicalId)
    const sheet = isUuid(sheetId) ? await client.safetyDataSheet.findFirst({ where: { id: sheetId, chemicalId: row.id }, select: { fileId: true, file: { select: { originalName: true } } } }) : null
    if (!sheet) throw new NotFoundError('Data sheet not found.')
    return { row, sheet }
  })
  const reader = readerAt(request, context.tenantId, row)
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, sheet.fileId), fileName: sheet.file.originalName }
}

export { quantityText, mayManage }
