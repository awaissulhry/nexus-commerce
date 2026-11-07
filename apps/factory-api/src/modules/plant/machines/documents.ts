import type { FastifyRequest } from 'fastify'
import { FILES_DELETE, FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { categoryOf, ceOnFile, groupOf, kindFits, MACHINE_RECORD, type DocumentGroup } from '@nexus/factory-domain/plant/machines/documents'
import { documentKind } from '@nexus/factory-domain/plant/machines/status'
import { PLANT_MACHINES_MANAGE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { completeUpload, deleteFile, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { assertMay, assertMayWrite, may, officeOf } from '../access'
import { readMachine, type MachineRow } from '../store'
import { refuse, siteCaller } from './depth-access'

/**
 * A machine's documents (B-W2b-136; QHS-165; D.Lgs. 81/2008 art. 71 c.4; design plant.machines › Machine › "Documents &
 * CE"): the CE declaration, the manuals, the photos and the rest, as files of the Machine (factory-domain
 * plant/machines/documents.ts). Office only:
 *
 *   GET  /plant/machines/:machineId/documents                         the files grouped, "CE on file" (plant.view)
 *   POST /plant/machines/:machineId/documents (+ /:fileId/complete)   one announced with its group, then confirmed
 *        (plant.machines.manage); shared with the machine's site's tablets when asked (art. 71: at hand)
 *   GET  /plant/machines/:machineId/documents/:fileId/download        a presigned look (plant.view)
 *   POST /plant/machines/:machineId/documents/:fileId/remove          a wrong or superseded file removed, with the reason
 *        (plant.machines.manage; refused while the file is retained or on legal hold)
 *
 * The files go through platform/files (types, size, presign, the store's check, the scan) as the tenant's system caller
 * holding exactly the files permission over the machine's company and site, after the module's own check: a person keeps a
 * machine's documents with plant.machines.manage, no files right. The generic file routes cannot set the category, so
 * only these routes file a CE declaration or a manual.
 */

const SHOWN = ['AVAILABLE', 'QUARANTINED'] as const
const DOC_SELECT = { id: true, kind: true, category: true, originalName: true, contentType: true, sizeBytes: true, status: true, scanStatus: true, visibility: true, createdAt: true, availableAt: true, version: true } as const

interface DocRow {
  readonly id: string
  readonly kind: string
  readonly category: string | null
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly status: string
  readonly scanStatus: string
  readonly visibility: readonly string[]
  readonly createdAt: Date
  readonly availableAt: Date | null
  readonly version: number
}

const documentView = (row: DocRow, group: DocumentGroup = groupOf(row)) => ({
  id: row.id,
  group,
  kind: row.kind,
  originalName: row.originalName,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  status: row.status as (typeof SHOWN)[number] | 'PENDING_UPLOAD' | 'DELETED',
  scanStatus: row.scanStatus as 'NOT_SCANNED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED',
  onTablets: row.visibility.includes('FLOOR'),
  createdAt: toUtcIso(row.createdAt),
  availableAt: row.availableAt ? toUtcIso(row.availableAt) : null,
  version: row.version,
})

async function knownMachine(request: FastifyRequest, machineId: string, write: boolean): Promise<{ machine: MachineRow; tenantId: string }> {
  const context = officeOf(request)
  const machine = isUuid(machineId) ? await request.withClient((client) => readMachine(client, context, machineId)) : null
  if (!machine) throw new NotFoundError('Machine not found.')
  assertMay(context, PLANT_VIEW, machine, 'Machine')
  if (write) assertMayWrite(context, PLANT_MACHINES_MANAGE, machine, 'The documents of the machines of this site are kept by a role that keeps the machines (plant.machines.manage).')
  return { machine, tenantId: context.tenantId }
}

async function machineFile(request: FastifyRequest, tenantId: string, machine: MachineRow, fileId: string, permissions: Parameters<typeof siteCaller>[3]) {
  const caller = siteCaller(request, tenantId, machine, permissions)
  const row = isUuid(fileId) ? ((await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: MACHINE_RECORD, recordId: machine.id, status: { not: 'DELETED' } }, select: DOC_SELECT }))) as DocRow | null) : null
  if (!row) throw new NotFoundError('File not found.')
  return { caller, row }
}

/** GET /plant/machines/:machineId/documents. */
export async function listDocuments(request: FastifyRequest, machineId: string) {
  const { machine } = await knownMachine(request, machineId, false)
  const context = officeOf(request)
  const rows = (await request.withClient((client) =>
    client.storedFile.findMany({ where: { recordType: MACHINE_RECORD, recordId: machine.id, status: { in: [...SHOWN] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: DOC_SELECT }),
  )) as DocRow[]
  return { documents: rows.map((row) => documentView(row)), ceOnFile: ceOnFile(rows), canManage: may(context, PLANT_MACHINES_MANAGE, machine) }
}

export interface AnnounceBody {
  readonly group: DocumentGroup
  readonly kind: 'DOCUMENT' | 'CERTIFICATE' | 'PHOTO'
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly onTablets?: boolean | undefined
}

/** POST /plant/machines/:machineId/documents: announced with its group, then the presigned PUT. */
export async function announceDocument(request: FastifyRequest, machineId: string, body: AnnounceBody, idempotencyKey?: string) {
  const { machine, tenantId } = await knownMachine(request, machineId, true)
  if (!kindFits(body.group, body.kind)) refuse(documentKind())
  const onTablets = body.onTablets ?? (body.group === 'MACHINE_CE' || body.group === 'MANUAL')
  const answer = await requestUpload(
    processFiles(),
    siteCaller(request, tenantId, machine, [FILES_UPLOAD, FILES_MANAGE]),
    {
      companyId: machine.companyId,
      recordType: MACHINE_RECORD,
      recordId: machine.id,
      kind: body.kind,
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: onTablets ? ['OFFICE', 'FLOOR'] : ['OFFICE'],
      floorSiteId: onTablets ? machine.siteId : null,
      category: categoryOf(body.group),
    },
    idempotencyKey,
  )
  const file = answer.file
  return {
    document: documentView({ ...file, category: categoryOf(body.group), createdAt: new Date(file.createdAt), availableAt: file.availableAt ? new Date(file.availableAt) : null, visibility: file.visibility }, body.group),
    upload: answer.upload,
  }
}

/** POST /plant/machines/:machineId/documents/:fileId/complete. */
export async function completeDocument(request: FastifyRequest, machineId: string, fileId: string, idempotencyKey?: string) {
  const { machine, tenantId } = await knownMachine(request, machineId, true)
  const { caller, row } = await machineFile(request, tenantId, machine, fileId, [FILES_UPLOAD, FILES_MANAGE])
  await completeUpload(processFiles(), caller, row.id, idempotencyKey)
  const after = (await caller.withClient((client) => client.storedFile.findUnique({ where: { id: row.id }, select: DOC_SELECT }))) as DocRow
  return { document: documentView(after) }
}

/** GET /plant/machines/:machineId/documents/:fileId/download. */
export async function downloadDocument(request: FastifyRequest, machineId: string, fileId: string) {
  const { machine, tenantId } = await knownMachine(request, machineId, false)
  const { caller, row } = await machineFile(request, tenantId, machine, fileId, [FILES_READ])
  if (row.status !== 'AVAILABLE') throw new NotFoundError('File not found.')
  return { download: await downloadFile(processFiles(), { caller, system: systemCallerOf(request) }, row.id), fileName: row.originalName, contentType: row.contentType }
}

/** POST /plant/machines/:machineId/documents/:fileId/remove. */
export async function removeDocument(request: FastifyRequest, machineId: string, fileId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { machine, tenantId } = await knownMachine(request, machineId, true)
  const { caller, row } = await machineFile(request, tenantId, machine, fileId, [FILES_DELETE])
  await deleteFile(processFiles(), caller, row.id, { version: body.version, reason: body.reason.trim() }, idempotencyKey)
  return { removed: row.id }
}
