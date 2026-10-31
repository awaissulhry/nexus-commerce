import type { LocationKind } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { markValues } from '@nexus/factory-domain/imports/importer'
import { locationsImporter } from '@nexus/factory-domain/inventory/locations/importer'
import { wouldCycle } from '@nexus/factory-domain/inventory/locations/rules'
import { INVENTORY_LOCATIONS_MANAGE, INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { CommandTx } from '../../../core/command'
// W2b (B-W2b-25): the Workshop column (load, check, write).
import { checkWorkshops, workshopCodesOf, workshopForWrite } from '../../../platform/imports/importers/locations-workshop'
import type { ImportAdapter, ImportScope } from '../../../platform/imports/registry'

/**
 * The locations import's adapter (factory-domain inventory/locations/importer.ts; platform/imports): finds a row's
 * location by its site's code and its own code, in the job's company, and writes one planned row: a new location
 * (inside its parent, which an earlier row or the database already holds), or a new name, kind or parent for an
 * existing one. Running and applying it needs inventory.locations.manage, seeing its plans inventory.locations.view.
 * A row naming a site of another company, a missing or archived parent, or a parent that would put a location inside
 * itself stops its batch with that reason (fix the sheet, apply again). W2b (B-W2b-25): a workshop's stock location
 * (SUBCONTRACTOR) names its workshop in the Workshop column (platform/imports/importers/locations-workshop.ts).
 *
 * The registry lists this adapter, so it imports only the registry's types (no load-order cycle) and freezes itself as
 * defineImportAdapter would.
 */

const text = (value: CellValue | undefined): string | undefined => (value === undefined ? undefined : String(value))

async function siteByCode(tx: CommandTx, code: string, scope: ImportScope) {
  const site = await tx.site.findFirst({ where: { code, ...(scope.companyId ? { companyId: scope.companyId } : {}) }, select: { id: true, companyId: true, code: true } })
  if (!site) throw new Error(`Site ${code} is not a site of the import's company.`)
  return site
}

async function parentOf(tx: CommandTx, siteId: string, code: string, locationId: string | null): Promise<string> {
  const siteLocations = await tx.location.findMany({ where: { siteId }, select: { id: true, parentId: true, code: true, status: true } })
  const parent = siteLocations.find((location) => location.code === code)
  if (!parent) throw new Error(`Parent ${code} is not a location of the site yet; list it before the locations inside it.`)
  if (parent.status !== 'ACTIVE') throw new Error(`Parent ${code} is archived; nothing goes inside it.`)
  if (locationId && wouldCycle(locationId, parent.id, siteLocations)) throw new Error(`Location ${code} cannot be its own parent's parent.`)
  return parent.id
}

export const locationsImportAdapter: ImportAdapter = Object.freeze({
  importer: locationsImporter,
  permission: INVENTORY_LOCATIONS_MANAGE,
  viewPermission: INVENTORY_LOCATIONS_VIEW,
  check: (client, rows, scope) => checkWorkshops(client, rows, scope),
  async load(client, keys, scope) {
    const siteCodes = [...new Set(keys.map((key) => String(key.site)))]
    const sites = await client.site.findMany({ where: { code: { in: siteCodes }, ...(scope.companyId ? { companyId: scope.companyId } : {}) }, select: { id: true, code: true } })
    const codeOfSite = new Map(sites.map((site) => [site.id, site.code]))
    const rows = await client.location.findMany({
      where: { siteId: { in: sites.map((site) => site.id) }, code: { in: [...new Set(keys.map((key) => String(key.code)))] } },
      select: { id: true, siteId: true, code: true, name: true, kind: true, partyId: true, parent: { select: { code: true } } },
    })
    const workshops = await workshopCodesOf(client, rows.map((row) => row.partyId))
    return rows.map((row) => ({
      id: row.id,
      values: { site: codeOfSite.get(row.siteId)!, code: row.code, name: row.name, kind: row.kind, parent: row.parent?.code ?? null, workshop: row.partyId === null ? null : (workshops.get(row.partyId) ?? null) },
    }))
  },
  async write(tools, row, scope) {
    const { tx, audit, now, context } = tools
    const values = row.values
    // B-W2a-25, W2b B-W2b-25: a location never turns into a workshop's stock location or stops being one (the plan refuses
    // it in the dry run; this holds for a row that changed since), and only that kind names its workshop.
    if (row.action !== 'CREATE' && values.kind !== undefined && (values.kind === 'SUBCONTRACTOR') !== (row.before?.kind === 'SUBCONTRACTOR')) {
      throw new Error(`Location ${String(row.key.code)}: a workshop location stays one (its workshop never changes); make a new location instead.`)
    }
    if (row.action !== 'CREATE' && values.workshop !== undefined) {
      throw new Error(`Location ${String(row.key.code)}: its workshop never changes; make a new location for another workshop.`)
    }
    if (row.action === 'CREATE') {
      const site = await siteByCode(tx, String(row.key.site), scope)
      const id = newId()
      const workshopCode = text(values.workshop)
      if ((values.kind === 'SUBCONTRACTOR') !== (workshopCode !== undefined)) {
        throw new Error(`Location ${String(row.key.code)}: ${values.kind === 'SUBCONTRACTOR' ? 'a Subcontractor location names its workshop' : 'only a Subcontractor location names a workshop'}.`)
      }
      const partyId = workshopCode === undefined ? null : await workshopForWrite(tx, workshopCode, site, String(row.key.code))
      const parentCode = text(values.parent)
      await tx.location.create({
        data: {
          id,
          companyId: site.companyId,
          siteId: site.id,
          parentId: parentCode ? await parentOf(tx, site.id, parentCode, null) : null,
          code: String(row.key.code),
          name: String(values.name),
          kind: String(values.kind) as LocationKind,
          partyId,
          createdAt: now,
          updatedAt: now,
          createdById: context.audience === 'office' ? context.actorId : null,
        },
        select: { id: true },
      })
      audit({ action: 'inventory.importLocation', recordType: 'Location', recordId: id, companyId: site.companyId, siteId: site.id, after: markValues(locationsImporter, values) })
      return { recordId: id }
    }
    const current = await tx.location.findUniqueOrThrow({ where: { id: row.recordId! }, select: { id: true, companyId: true, siteId: true } })
    const parentCode = text(values.parent)
    await tx.location.update({
      where: { id: current.id },
      data: {
        ...(values.name !== undefined ? { name: String(values.name) } : {}),
        ...(values.kind !== undefined ? { kind: String(values.kind) as LocationKind } : {}),
        ...(parentCode !== undefined ? { parentId: await parentOf(tx, current.siteId, parentCode, current.id) } : {}),
        version: { increment: 1 },
      },
      select: { id: true },
    })
    audit({
      action: 'inventory.importLocation',
      recordType: 'Location',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: markValues(locationsImporter, row.before),
      after: markValues(locationsImporter, values),
    })
    return { recordId: current.id }
  },
} satisfies ImportAdapter)
