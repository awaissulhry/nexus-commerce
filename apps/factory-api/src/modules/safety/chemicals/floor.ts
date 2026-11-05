import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, type FloorContext } from '../../../core/context'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { readerAt } from './reads'
import { newestFirst, quantityText, type SheetRow } from './store'

/**
 * The cabinet QR on the floor (B-W2b-143; QHS-278 "SDS library; an SDS binder meets worker access today (REACH art. 35)";
 * design plant.chemicals "SDS at the cabinet by QR, readable offline on floor devices"), floor only, floor.work (every floor
 * role) at the device's own site; row-level security keeps a tablet to its site's Chemical and SafetyDataSheet rows
 * (select only):
 *
 *   GET /safety/floor/chemicals                    what the tablet keeps: every ACTIVE chemical of its site with its cabinet,
 *                                                  hazards, place, PPE words and its CURRENT sheets (file id, size, SHA-256)
 *   GET /safety/floor/data-sheets/:sheetId/download  a current sheet's PDF (a 60-second presigned GET; the tablet keeps the
 *                                                  bytes and checks them against the SHA-256)
 *
 * The tablet (apps/factory-web floor/tasks/sds) asks for the list while online, keeps it with every current PDF in its own
 * storage, and opens a cabinet from what it keeps when the network is gone. Never a person, never money.
 */

function floorOf(request: FastifyRequest): FloorContext {
  const context = request.factoryContext
  if (!context || context.audience !== 'floor') throw new NotFoundError('Not found.')
  return context
}

/** GET /safety/floor/chemicals. */
export async function floorPack(request: FastifyRequest, now: Date = new Date()) {
  const context = floorOf(request)
  return request.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: context.siteId }, select: { id: true, code: true, name: true, companyId: true, company: { select: { locale: true } } } })
    if (!site) throw new NotFoundError('Not found.')
    const chemicals = await client.chemical.findMany({
      where: { siteId: site.id, status: 'ACTIVE' },
      orderBy: [{ cabinetCode: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, name: true, supplierPartyId: true, supplierName: true, use: true, ghsPictograms: true, signalWord: true, hazardStatements: true, precautionStatements: true, storagePlace: true, cabinetCode: true, maxQuantity: true, maxQuantityUnit: true, ppeItemIds: true },
    })
    const ids = chemicals.map((row) => row.id)
    const sheets = (ids.length === 0 ? [] : await client.safetyDataSheet.findMany({ where: { chemicalId: { in: ids }, status: 'CURRENT' }, select: { id: true, siteId: true, chemicalId: true, versionLabel: true, revisedOn: true, language: true, fileId: true, status: true, supersededAt: true, supersededById: true, createdAt: true, createdById: true } })) as SheetRow[]
    // The floor reads no Party: the supplier's own words only (a party's name stays the office's).
    const files = new Map((sheets.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: sheets.map((sheet) => sheet.fileId) }, status: 'AVAILABLE' }, select: { id: true, sizeBytes: true, sha256: true } })).map((file) => [file.id, file]))
    const ppe = new Map((await client.ppeItem.findMany({ where: { id: { in: [...new Set(chemicals.flatMap((row) => row.ppeItemIds))] } }, select: { id: true, name: true } })).map((item) => [item.id, item.name]))
    return {
      siteId: site.id,
      site: { code: site.code, name: site.name },
      language: site.company.locale,
      at: toUtcIso(now),
      chemicals: chemicals.map((row) => ({
        id: row.id,
        name: row.name,
        supplier: row.supplierName,
        use: row.use,
        ghsPictograms: [...row.ghsPictograms],
        signalWord: row.signalWord,
        hazardStatements: [...row.hazardStatements],
        precautionStatements: [...row.precautionStatements],
        storagePlace: row.storagePlace,
        cabinetCode: row.cabinetCode,
        maxQuantity: quantityText(row.maxQuantity),
        maxQuantityUnit: row.maxQuantityUnit,
        ppe: row.ppeItemIds.map((id) => ppe.get(id)).filter((name): name is string => name !== undefined),
        current: sheets
          .filter((sheet) => sheet.chemicalId === row.id && files.has(sheet.fileId))
          .sort(newestFirst)
          .map((sheet) => ({ id: sheet.id, versionLabel: sheet.versionLabel, revisedOn: sheet.revisedOn.toISOString().slice(0, 10), language: sheet.language, fileId: sheet.fileId, sizeBytes: files.get(sheet.fileId)!.sizeBytes, sha256: files.get(sheet.fileId)!.sha256 })),
      })),
    }
  })
}

/** GET /safety/floor/data-sheets/:sheetId/download: a CURRENT sheet of the device's site. */
export async function floorSheetDownload(request: FastifyRequest, sheetId: string) {
  const context = floorOf(request)
  const sheet = isUuid(sheetId)
    ? await request.withClient((client) =>
        client.safetyDataSheet.findFirst({
          where: { id: sheetId, siteId: context.siteId, status: 'CURRENT', chemical: { status: 'ACTIVE' } },
          select: { fileId: true, chemical: { select: { companyId: true } }, file: { select: { sha256: true, sizeBytes: true, floorSiteId: true } } },
        }),
      )
    : null
  if (!sheet || sheet.file.floorSiteId !== context.siteId || !can(actorOf(context), 'floor.work', { companyId: sheet.chemical.companyId, siteId: context.siteId })) throw new NotFoundError('Data sheet not found.')
  const reader = readerAt(request, context.tenantId, { companyId: sheet.chemical.companyId, siteId: context.siteId })
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, sheet.fileId), sha256: sheet.file.sha256, sizeBytes: sheet.file.sizeBytes }
}
