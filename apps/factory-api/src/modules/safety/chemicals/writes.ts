import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { cabinetCodeOf, chemicalProblems, replaceRefusal, sheetProblems, statementsOf, type ChemicalInput, type ChemicalRefusal, type ChemicalUse, type QuantityUnit, type SignalWord } from '@nexus/factory-domain/safety/chemicals/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type OfficeContext, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { actorIdOf, officeOf, problemsError, refuse, todayOf } from '../../people/employees/access'
import { readChemical } from './reads'
import { CHEMICAL_SELECT, chemicalViews, mayManage, newestFirst, SHEET_SELECT, sheetViews, type ChemicalRow, type SheetRow } from './store'

/**
 * The chemical register's writes (B-W2b-143; QHS-277, QHS-278; design plant.chemicals pop-ups Add chemical, Chemical's Edit,
 * Replace SDS), office only, safety.chemicals.manage over the chemical's company and site, each one command with an
 * Idempotency-Key:
 *
 *   POST  /safety/chemicals                              add a chemical to a site's register (ACTIVE)
 *   PATCH /safety/chemicals/:id                          change it (its version read; never its company or site)
 *   POST  /safety/chemicals/:id/archive | restore        out of use with the reason (its sheets are kept) | back in use
 *   POST  /safety/chemicals/:id/data-sheets/upload       a sheet's PDF announced (+ /:fileId/complete): a DOCUMENT of the
 *                                                        chemical shared with its site's floor (the cabinet QR, offline)
 *   POST  /safety/chemicals/:id/data-sheets              the sheet recorded: the current one of its language becomes
 *                                                        SUPERSEDED (kept) and this one CURRENT, in the same command
 *
 * The files go through platform/files (types, size, the presigned PUT, the store's check, the virus scan) as the tenant's
 * system caller holding exactly files.upload and files.manage over the chemical's company and site, after the module's own
 * checks (as the plant's photos): sharing with the floor is the module's decision, so a safety officer needs no files.manage.
 * factory-db's guards hold the same rules for every login (…_protected_safety_w2b_guards); these answer first, in words.
 */

const MANAGE_WORDS = 'The chemical register of this site is kept by a role that keeps it (safety.chemicals.manage).'
const PDF = 'application/pdf'

const refuseWith = (refusal: ChemicalRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

export interface ChemicalBody {
  readonly name: string
  readonly supplierPartyId?: string | null | undefined
  readonly supplierName?: string | null | undefined
  readonly use: ChemicalUse
  readonly ghsPictograms: readonly string[]
  readonly signalWord?: SignalWord | null | undefined
  readonly hazardStatements: readonly string[]
  readonly precautionStatements: readonly string[]
  readonly storagePlace: string
  readonly cabinetCode?: string | null | undefined
  readonly maxQuantity?: string | null | undefined
  readonly maxQuantityUnit?: QuantityUnit | null | undefined
  readonly roleSheetIds: readonly string[]
  readonly ppeItemIds: readonly string[]
  readonly note?: string | null | undefined
}

/** The body as stored: statements in CLP's own writing, each once; the cabinet in capitals; blanks as null. */
function normalised(body: ChemicalBody): ChemicalInput {
  const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
  return {
    name: body.name.trim(),
    supplierPartyId: body.supplierPartyId ?? null,
    supplierName: blankToNull(body.supplierName),
    use: body.use,
    ghsPictograms: [...body.ghsPictograms],
    signalWord: body.signalWord ?? null,
    hazardStatements: statementsOf(body.hazardStatements.join(' ')),
    precautionStatements: statementsOf(body.precautionStatements.join(' ')),
    storagePlace: body.storagePlace.trim(),
    cabinetCode: cabinetCodeOf(body.cabinetCode),
    maxQuantity: blankToNull(body.maxQuantity),
    maxQuantityUnit: body.maxQuantityUnit ?? null,
    roleSheetIds: [...body.roleSheetIds],
    ppeItemIds: [...body.ppeItemIds],
    note: blankToNull(body.note),
  }
}

function checked(body: ChemicalBody): ChemicalInput {
  const input = normalised(body)
  const problems = chemicalProblems(input)
  if (problems.length > 0) throw problemsError(problems, 'The chemical is not complete: see each field.')
  return input
}

/** What the chemical names, of its own company and site (the guard's rules, answered first in words). */
async function assertNamed(tx: CommandTx, place: { readonly companyId: string; readonly siteId: string }, input: ChemicalInput, before: ChemicalRow | null): Promise<void> {
  if (input.supplierPartyId && input.supplierPartyId !== before?.supplierPartyId) {
    const party = await tx.party.findUnique({ where: { id: input.supplierPartyId }, select: { companyId: true, status: true } })
    if (!party || (party.companyId !== null && party.companyId !== place.companyId) || party.status !== 'ACTIVE') refuse('SUPPLIER_OTHER_COMPANY', "The supplier is an active party of this company or the group's.", 'supplierPartyId')
  }
  if (input.roleSheetIds.length > 0) {
    const found = await tx.roleSheet.count({ where: { id: { in: [...input.roleSheetIds] }, siteId: place.siteId } })
    if (found !== input.roleSheetIds.length) refuse('ROLE_OTHER_SITE', "The roles are role sheets of the chemical's own site.", 'roleSheetIds')
  }
  if (input.ppeItemIds.length > 0) {
    const found = await tx.ppeItem.count({ where: { id: { in: [...input.ppeItemIds] }, companyId: place.companyId } })
    if (found !== input.ppeItemIds.length) refuse('PPE_OTHER_COMPANY', "The PPE items are of the company's own PPE catalogue.", 'ppeItemIds')
  }
}

const columns = (input: ChemicalInput) => ({
  name: input.name,
  supplierPartyId: input.supplierPartyId ?? null,
  supplierName: input.supplierName ?? null,
  use: input.use,
  ghsPictograms: [...input.ghsPictograms] as ChemicalRow['ghsPictograms'],
  signalWord: input.signalWord ?? null,
  hazardStatements: [...input.hazardStatements],
  precautionStatements: [...input.precautionStatements],
  storagePlace: input.storagePlace,
  cabinetCode: input.cabinetCode ?? null,
  maxQuantity: input.maxQuantity ?? null,
  maxQuantityUnit: input.maxQuantityUnit ?? null,
  roleSheetIds: [...input.roleSheetIds],
  ppeItemIds: [...input.ppeItemIds],
  note: input.note ?? null,
})

/** What an audit row keeps of a chemical: every fact, no person. */
const audited = (input: ChemicalInput) => ({ ...columns(input), ghsPictograms: [...input.ghsPictograms] })

async function viewIn(tx: CommandTx, context: OfficeContext, id: string) {
  const row = (await tx.chemical.findUniqueOrThrow({ where: { id }, select: CHEMICAL_SELECT })) as ChemicalRow
  return (await chemicalViews(tx, context, [row]))[0]!
}

/** A chemical the caller reads and keeps (404 when it cannot read it, 403 in words when it reads but does not keep it). */
async function keptChemical(caller: CommandCaller, context: OfficeContext, chemicalId: string): Promise<ChemicalRow> {
  const row = await caller.withClient((client) => readChemical(client, context, chemicalId))
  if (!mayManage(context, row)) throw new ForbiddenError(MANAGE_WORDS)
  return row
}

export interface CreateBody extends ChemicalBody {
  readonly companyId: string
  readonly siteId: string
}

/** POST /safety/chemicals. */
export async function addChemical(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = { companyId: body.companyId, siteId: body.siteId }
  if (!mayManage(context, place)) throw new ForbiddenError(MANAGE_WORDS)
  const input = checked(body)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addChemical', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const site = await tx.site.findUnique({ where: { id: place.siteId }, select: { companyId: true, status: true } })
    if (!site || site.companyId !== place.companyId) refuse('SITE_OTHER_COMPANY', 'The site is one of the company’s sites.', 'siteId')
    await assertNamed(tx, place, input, null)
    await tx.chemical.create({ data: { id, companyId: place.companyId, siteId: place.siteId, ...columns(input), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'safety.addChemical', recordType: 'Chemical', recordId: id, companyId: place.companyId, siteId: place.siteId, after: audited(input) })
    tools.emit({ type: 'chemical.changed', subject: id, companyId: place.companyId, siteId: place.siteId, payload: { chemicalId: id, siteId: place.siteId, change: 'ADDED' } })
    return { chemical: await viewIn(tx, context, id) }
  })
  return { ...result, replayed }
}

/** PATCH /safety/chemicals/:id. */
export async function editChemical(caller: CommandCaller, chemicalId: string, body: ChemicalBody & { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await keptChemical(caller, context, chemicalId)
  const input = checked(body)
  const { result } = await command(caller, { name: 'safety.editChemical', idempotencyKey, input: body, record: { type: 'Chemical', id: before.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await tx.chemical.findUniqueOrThrow({ where: { id: before.id }, select: CHEMICAL_SELECT })) as ChemicalRow
    if (current.status !== 'ACTIVE') refuse('ARCHIVED', 'This chemical is archived: put it back in use first, then change it.')
    await assertNamed(tx, current, input, current)
    await tx.chemical.update({ where: { id: current.id }, data: { ...columns(input), updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.editChemical', recordType: 'Chemical', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: audited(normalised({ ...current, maxQuantity: current.maxQuantity?.toString() ?? null })), after: audited(input) })
    tools.emit({ type: 'chemical.changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { chemicalId: current.id, siteId: current.siteId, change: 'EDITED' } })
    return { chemical: await viewIn(tx, context, current.id) }
  })
  return result
}

/** POST /safety/chemicals/:id/archive | restore. */
export async function setChemicalStatus(caller: CommandCaller, chemicalId: string, to: 'ARCHIVED' | 'ACTIVE', body: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await keptChemical(caller, context, chemicalId)
  const name = to === 'ARCHIVED' ? 'safety.archiveChemical' : 'safety.restoreChemical'
  const { result } = await command(caller, { name, idempotencyKey, input: body, record: { type: 'Chemical', id: before.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.chemical.findUniqueOrThrow({ where: { id: before.id }, select: { status: true, companyId: true, siteId: true } })
    if (to === 'ARCHIVED' && current.status !== 'ACTIVE') refuse('ARCHIVED', 'This chemical is archived already.')
    if (to === 'ACTIVE' && current.status !== 'ARCHIVED') refuse('NOT_ARCHIVED', 'This chemical is in use already.')
    await tx.chemical.update({ where: { id: before.id }, data: { status: to, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: 'Chemical', recordId: before.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: to }, ...(body.reason ? { reason: body.reason.trim() } : {}) })
    tools.emit({ type: 'chemical.changed', subject: before.id, companyId: current.companyId, siteId: current.siteId, payload: { chemicalId: before.id, siteId: current.siteId, change: to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED' } })
    return { chemical: await viewIn(tx, context, before.id) }
  })
  return result
}

/** The tenant's system caller for one chemical's company and site only, holding exactly these permissions. */
function siteCaller(request: FastifyRequest, tenantId: string, place: { readonly companyId: string; readonly siteId: string }, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [place.companyId], sites: [place.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

export interface AnnounceBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /safety/chemicals/:id/data-sheets/upload: the sheet's PDF announced, then the presigned PUT. */
export async function announceSheet(request: FastifyRequest, chemicalId: string, body: AnnounceBody, idempotencyKey?: string) {
  const context = officeOf(request)
  const row = await keptChemical(request, context, chemicalId)
  if (row.status !== 'ACTIVE') refuse('ARCHIVED', 'This chemical is archived: put it back in use first, then add its data sheet.')
  if (body.contentType.trim().toLowerCase().split(';')[0] !== PDF) refuse('FILE_NOT_PDF', 'A safety data sheet is a PDF: the tablets at the cabinet open it as one.', 'contentType')
  return requestUpload(
    processFiles(),
    siteCaller(request, context.tenantId, row, [FILES_UPLOAD, FILES_MANAGE]),
    {
      companyId: row.companyId,
      recordType: 'Chemical',
      recordId: row.id,
      kind: 'DOCUMENT',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'FLOOR'],
      floorSiteId: row.siteId,
    },
    idempotencyKey,
  )
}

/** POST /safety/chemicals/:id/data-sheets/upload/:fileId/complete. */
export async function completeSheet(request: FastifyRequest, chemicalId: string, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  const row = await keptChemical(request, context, chemicalId)
  const uploader = siteCaller(request, context.tenantId, row, [FILES_UPLOAD, FILES_MANAGE])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'Chemical', recordId: row.id, kind: 'DOCUMENT' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

export interface SheetBody {
  readonly fileId: string
  readonly versionLabel: string
  readonly revisedOn: BusinessDate
  readonly language: string
}

/** POST /safety/chemicals/:id/data-sheets: the sheet recorded; the current one of its language superseded, kept. */
export async function addSheet(caller: CommandCaller, chemicalId: string, body: SheetBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await keptChemical(caller, context, chemicalId)
  const input = { versionLabel: body.versionLabel.trim(), revisedOn: body.revisedOn, language: body.language.trim() }
  const sheetId = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addDataSheet', idempotencyKey, input: body, record: { type: 'Chemical', id: before.id } }, async (tools: CommandTools) => {
    const { tx, now } = tools
    const problems = sheetProblems(input, todayOf(now))
    if (problems.length > 0) throw problemsError(problems, 'The data sheet is not complete: see each field.')
    const chemical = await tx.chemical.findUniqueOrThrow({ where: { id: before.id }, select: { status: true, companyId: true, siteId: true } })
    if (chemical.status !== 'ACTIVE') refuse('ARCHIVED', 'This chemical is archived: put it back in use first, then add its data sheet.')
    const file = await tx.storedFile.findUnique({ where: { id: body.fileId }, select: { recordType: true, recordId: true, status: true, contentType: true, visibility: true, floorSiteId: true } })
    if (!file || file.recordType !== 'Chemical' || file.recordId !== before.id) refuse('FILE_NOT_READY', 'Upload the sheet’s PDF to this chemical first (Replace SDS), then record it.', 'fileId')
    if (file!.contentType !== PDF) refuse('FILE_NOT_PDF', 'A safety data sheet is a PDF: the tablets at the cabinet open it as one.', 'fileId')
    if (file!.status !== 'AVAILABLE' || !file!.visibility.includes('FLOOR') || file!.floorSiteId !== chemical.siteId) refuse('FILE_NOT_READY', 'The PDF is not ready to be read at the cabinet yet (its upload is not confirmed, held by the virus scan, or not shared with the site’s tablets): upload it again with Replace SDS.', 'fileId')
    if (await tx.safetyDataSheet.findFirst({ where: { fileId: body.fileId }, select: { id: true } })) refuse('FILE_NOT_READY', 'This PDF is recorded as a data sheet already: upload the new version.', 'fileId')
    const current = (await tx.safetyDataSheet.findFirst({ where: { chemicalId: before.id, language: input.language, status: 'CURRENT' }, select: SHEET_SELECT })) as SheetRow | null
    refuseWith(replaceRefusal(current ? { versionLabel: current.versionLabel, revisedOn: current.revisedOn.toISOString().slice(0, 10) } : null, input))
    const actorId = actorIdOf(tools.context)
    if (current) {
      await tx.safetyDataSheet.update({ where: { id: current.id }, data: { status: 'SUPERSEDED', supersededAt: now, supersededById: actorId, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'safety.supersedeDataSheet', recordType: 'SafetyDataSheet', recordId: current.id, companyId: chemical.companyId, siteId: chemical.siteId, before: { status: 'CURRENT' }, after: { status: 'SUPERSEDED', by: sheetId } })
    }
    await tx.safetyDataSheet.create({ data: { id: sheetId, siteId: chemical.siteId, chemicalId: before.id, versionLabel: input.versionLabel, revisedOn: new Date(`${input.revisedOn}T00:00:00.000Z`), language: input.language, fileId: body.fileId, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
    tools.audit({ action: 'safety.addDataSheet', recordType: 'SafetyDataSheet', recordId: sheetId, companyId: chemical.companyId, siteId: chemical.siteId, after: { chemicalId: before.id, versionLabel: input.versionLabel, revisedOn: input.revisedOn, language: input.language, fileId: body.fileId, supersedes: current?.id ?? null } })
    tools.audit({ action: 'safety.addDataSheet', recordType: 'Chemical', recordId: before.id, companyId: chemical.companyId, siteId: chemical.siteId, after: { sheetId, language: input.language, versionLabel: input.versionLabel } })
    tools.emit({ type: 'sds.replaced', subject: before.id, companyId: chemical.companyId, siteId: chemical.siteId, payload: { chemicalId: before.id, siteId: chemical.siteId, sheetId, supersededId: current?.id ?? null, language: input.language } })
    const rows = (await tx.safetyDataSheet.findMany({ where: { id: { in: [sheetId, ...(current ? [current.id] : [])] } }, select: SHEET_SELECT })) as SheetRow[]
    const views = await sheetViews(tx, rows.sort(newestFirst))
    return { sheet: views.find((view) => view.id === sheetId)!, superseded: current ? (views.find((view) => view.id === current.id) ?? null) : null, chemical: await viewIn(tx, context, before.id) }
  })
  return { ...result, replayed }
}
