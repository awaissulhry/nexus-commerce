import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { callFileKindOf, SIGNAL_REFUSALS, SUGGESTION_LIMITS, suggestionProblem, type SuggestionKind } from '@nexus/factory-domain/production/baskets/signals'
import { command, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { anonymousCaller, anonymousKey } from '../../safety/incidents/access'
import { floorOf, refuse } from '../calls/access'
import { siteUploader } from '../calls/floor'
import { namedWorker } from '../calls/station'
import { siteOf } from '../calls/store'
import { systemView } from '../scans/access'
import type { SuggestionBody } from './contract'

/**
 * Tell the office (owb- order workflow, S5 fl3 step 4; design floorMe "Tell the office: with or without my name"; Statuto dei
 * Lavoratori art. 4: no read mark, no figure, no name the worker did not give):
 *
 *   POST /floor/suggestions/files (+ /:fileId/complete)   a voice note (audio/…, ≤ 2 min), online only: an AUDIO file of the
 *                                                         suggestion to be (recordType FloorSuggestion, the suggestion's id
 *                                                         made here), shared OFFICE + FLOOR at the site (the …_floor_baskets_2
 *                                                         guard: a voice note the floor can open), uploaded as the tenant's
 *                                                         system (no worker, no device on the file), its receipt key hashed
 *   POST /floor/suggestions                               the suggestion (FloorSuggestion, append-only): an idea, something
 *                                                         wrong or a thanks: words, the voice note, or the kind alone
 *
 * Without the name (`withName` false) nothing of the worker is kept: no worker, employee or device id on the row (a PHONE is one
 * person's own: its id would name them; the guard refuses a device or an employee without the worker), written as the system actor in the
 * floor scope (safety/incidents/access.ts `anonymousCaller`: the audit row, the receipt and the event name no worker and no
 * tablet), the receipt's key hashed (`anonymousKey`), no tablet clock, and never through the offline queue (its ledger keeps the
 * worker and the tablet: ./../baskets/queued.ts refuses it). With the name the worker is named only where the site names workers
 * (and they acknowledged the notice); else it goes without, and the answer says so (`withName` false).
 * The office's list of suggestions is a later step (the table is read by the office role only).
 */

/** The site's company: the files' and the row's. */
async function siteCompany(caller: CommandCaller, context: FloorContext): Promise<string> {
  const site = await caller.withClient((db) => siteOf(db, context.siteId))
  if (!site) throw new NotFoundError('Site not found.')
  return site.companyId
}

export interface VoiceBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly durationSeconds: number
}

/** POST /floor/suggestions/files: a voice note for a suggestion, then the presigned PUT. */
export async function announceSuggestionVoice(request: FastifyRequest, body: VoiceBody, idempotencyKey?: string) {
  const context = floorOf(request)
  if (callFileKindOf(body.contentType) !== 'AUDIO') throw new ValidationError('Tell the office takes a voice note.', [{ path: 'body/contentType', message: 'Send a sound (audio/…).' }])
  if (body.durationSeconds > SUGGESTION_LIMITS.voiceSeconds) throw new ValidationError(`A voice note runs at most ${SUGGESTION_LIMITS.voiceSeconds} seconds.`, [{ path: 'body/durationSeconds', message: `At most ${SUGGESTION_LIMITS.voiceSeconds} seconds.` }])
  const companyId = await siteCompany(request, context)
  return requestUpload(
    processFiles(),
    siteUploader(request, context.tenantId, { companyId, siteId: context.siteId }, [FILES_UPLOAD, FILES_MANAGE]),
    { companyId, recordType: 'FloorSuggestion', recordId: newId(), kind: 'AUDIO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'FLOOR'], floorSiteId: context.siteId },
    idempotencyKey ? anonymousKey(context, idempotencyKey) : undefined,
  )
}

/** POST /floor/suggestions/files/:fileId/complete. */
export async function completeSuggestionVoice(request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const context = floorOf(request)
  const companyId = await siteCompany(request, context)
  const uploader = siteUploader(request, context.tenantId, { companyId, siteId: context.siteId }, [FILES_UPLOAD, FILES_MANAGE])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'FloorSuggestion', kind: 'AUDIO', companyId, floorSiteId: context.siteId }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey ? anonymousKey(context, idempotencyKey) : undefined) }
}

/** POST /floor/suggestions (online), or a named one from the offline queue (`queued`). */
export async function tellOffice(caller: CommandCaller, body: SuggestionBody, key?: string, options: { readonly queued?: boolean } = {}): Promise<{ readonly suggestion: { readonly id: string; readonly kind: SuggestionKind; readonly withName: boolean }; readonly replayed: boolean }> {
  const context = floorOf(caller)
  const words = body.words?.trim() || null
  const voiceFileId = body.voiceFileId ?? null
  const problem = suggestionProblem({ words })
  if (problem) refuse({ ...SIGNAL_REFUSALS.SUGGESTION_WORDS, message: problem })
  if (!body.withName && options.queued) refuse({ code: 'ANON_ONLINE', message: 'A message without your name goes only when the network is there.', fix: 'Send it again when the network is back.' })
  const companyId = await siteCompany(caller, context)
  // The voice note: a confirmed AUDIO file of a suggestion of this company, shared with this site's floor; its record id is the
  // suggestion's id.
  const voice = voiceFileId
    ? await systemView(caller).withClient((db) => db.storedFile.findFirst({ where: { id: voiceFileId, recordType: 'FloorSuggestion', kind: 'AUDIO', companyId, floorSiteId: context.siteId, status: 'AVAILABLE' }, select: { recordId: true } }))
    : null
  if (voiceFileId && !voice) refuse(SIGNAL_REFUSALS.NO_VOICE)
  const id = voice?.recordId ?? newId()
  const named = body.withName ? await caller.withClient((db) => namedWorker(db, context.siteId, context.actorId)) : null
  const writer = body.withName ? caller : anonymousCaller(caller, context, newId())
  const idempotencyKey = body.withName ? (key ?? `${context.deviceId}.${body.clientEventId}`) : anonymousKey(context, key ?? body.clientEventId)
  const deviceTime = body.withName && body.occurredAt ? parseInstant(body.occurredAt) : null
  const { result, replayed } = await command(writer, { name: 'production.tellOffice', idempotencyKey, input: { kind: body.kind, words, voiceFileId, withName: body.withName }, ...(deviceTime ? { deviceTime } : {}) }, async (tools) => {
    const { tx, now } = tools
    // The floor role inserts and reads none back (createMany: no RETURNING).
    await tx.floorSuggestion.createMany({
      // The worker, their employee and the device only with the name (and only where the site names workers).
      data: [{ id, companyId, siteId: context.siteId, kind: body.kind, words, voiceFileId, workerId: named?.workerId ?? null, employeeId: named?.employeeId ?? null, deviceId: named ? context.deviceId : null, clientEventId: body.clientEventId, createdAt: now }],
    })
    tools.audit({ action: 'production.tellOffice', recordType: 'FloorSuggestion', recordId: id, companyId, siteId: context.siteId, after: { kind: body.kind, words: words !== null, voice: voiceFileId !== null, withName: named !== null, ...(named ? { workerId: named.workerId } : {}) } })
    return { suggestion: { id, kind: body.kind, withName: named !== null } }
  })
  return { ...result, replayed }
}
