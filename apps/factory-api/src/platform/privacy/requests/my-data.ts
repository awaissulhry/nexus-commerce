import type { FastifyRequest } from 'fastify'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { dueAtOf, OPEN_REQUEST_STATUSES, REQUEST_HELD_WORDS } from '@nexus/factory-domain/privacy/retention/requests'
import { command, type CommandCaller } from '../../../core/command'
import { downloadFile, systemCallerOf } from '../../files/files'
import { processFiles } from '../../files/service'
import { officeOf } from '../access'
import { COLLECT_ACTIONS, packageHeld, REQUEST_SELECT, requestViewOf } from './read'
import { emitChange } from './requests'

/**
 * Download my data (B-W2b-405; PLT-202; GDPR arts. 15, 20; design shell.profile "Download my data"): any signed-in office person
 * asks for their own package. Their session proves who they are (art. 12(6)), so the request is received, its identity checked
 * by the person and its package asked for in ONE command; the worker collects it (package.ts). The person downloads it from My
 * profile; the first download hands it over: the request is DONE, decided by them. The privacy desk sees these requests too.
 *
 *   GET  /privacy/my-data                        my requests (newest first) with their package and its collection
 *   POST /privacy/my-data                        ask for my package (one open at a time); the company is the screen's
 *   GET  /privacy/my-data/:requestId/package     my package (a 60-second link); the first download closes the request
 */

const MINE = (userId: string) => ({ personKind: 'USER' as const, personRecordType: 'User', personRecordId: userId })

/** GET /privacy/my-data */
export async function myData(caller: CommandCaller, now: Date) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.dataRequest.findMany({ where: { ...MINE(context.actorId), kind: 'ACCESS' }, select: REQUEST_SELECT, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 20 })
    const requests = []
    for (const row of rows) {
      const view = await requestViewOf(client, row, now)
      requests.push({ id: view.id, company: view.company, kind: view.kind, status: view.status, receivedAt: view.receivedAt, dueAt: view.dueAt, package: view.package, collect: view.collect })
    }
    const open = rows.some((row) => (OPEN_REQUEST_STATUSES as readonly string[]).includes(row.status))
    return { requests, mayAsk: !open && context.companyId !== undefined && context.companyId !== null, companyId: context.companyId ?? null }
  })
}

/** POST /privacy/my-data */
export async function askMyData(caller: CommandCaller, now: Date, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = context.companyId ?? null
  if (!companyId) throw new InvalidStateError('Pick the company you work in first (the company switch at the top): the request is kept by that company.')
  const { result } = await command(caller, { name: 'privacy.myDataAsk', idempotencyKey, input: { companyId } }, async (tools) => {
    const { tx } = tools
    const open = await tx.dataRequest.findFirst({ where: { ...MINE(context.actorId), kind: 'ACCESS', status: { in: [...OPEN_REQUEST_STATUSES] } }, select: { id: true } })
    if (open) throw new ConflictError('Your data is being collected already: download it from My profile when it is ready.')
    const id = newId()
    const row = { id, companyId, ...MINE(context.actorId), kind: 'ACCESS' as const, receivedAt: tools.now, dueAt: dueAtOf(tools.now), status: 'RECEIVED' as const, createdById: context.actorId }
    await tx.dataRequest.create({ data: row, select: { id: true } })
    // The session proved who asks (art. 12(6)): checked by the person, the work starts at once.
    await tx.dataRequest.update({ where: { id }, data: { identityCheckedAt: tools.now, identityCheckedById: context.actorId, status: 'IN_PROGRESS', updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'DataRequest', recordId: id, companyId, after: { personKind: 'USER', personRecordType: 'User', personRecordId: context.actorId, kind: 'ACCESS', receivedAt: toUtcIso(tools.now), identityChecked: 'SESSION', status: 'IN_PROGRESS' } })
    tools.audit({ action: COLLECT_ACTIONS.asked, recordType: 'DataRequest', recordId: id, companyId, after: { askedAt: toUtcIso(tools.now) } })
    emitChange(tools, row, 'IN_PROGRESS', 'IDENTITY_CHECKED')
    tools.emit({ type: 'privacy.request_collect_asked', subject: id, companyId, payload: { requestId: id, companyId } })
    return id
  })
  return { requestId: result, ...(await myData(caller, now)) }
}

/** GET /privacy/my-data/:requestId/package */
export async function myPackage(request: FastifyRequest, requestId: string) {
  const context = officeOf(request)
  const row = isUuid(requestId) ? await request.withClient((client) => client.dataRequest.findFirst({ where: { id: requestId, ...MINE(context.actorId) }, select: REQUEST_SELECT })) : null
  if (!row) throw new NotFoundError('Request not found.')
  if (!row.packageFileId || row.packageFile?.status !== 'AVAILABLE') throw new InvalidStateError(REQUEST_HELD_WORDS[packageHeld(row.packageFile)])
  const download = await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, row.packageFileId, { viaModule: true })
  if (row.status === 'IN_PROGRESS') {
    // Handed over: the first download closes the request, decided by the person.
    await command(request, { name: 'privacy.myDataReceived', input: { requestId }, record: { type: 'DataRequest', id: requestId } }, async (tools) => {
      await tools.tx.dataRequest.update({ where: { id: requestId }, data: { status: 'DONE', decidedAt: tools.now, decidedById: context.actorId, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'DataRequest', recordId: requestId, companyId: row.companyId, before: { status: 'IN_PROGRESS' }, after: { status: 'DONE', handedOver: 'DOWNLOADED' } })
      emitChange(tools, row, 'DONE', 'DONE')
      return null
    })
  }
  return { download }
}
