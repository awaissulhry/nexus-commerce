import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { newVersionRefusal, seriesRootOf } from '@nexus/factory-domain/files/versions/rules'
import {
  ACCEPTED_PROOFS_ACTION,
  acceptedProofsOf,
  MAX_PROOFS,
  PROOF_CONTENT_TYPES,
  PROOF_RECORD_TYPE,
  proofFileKindOf,
  proofSeries,
  proofsFrozenRefusal,
  proofTypeRefusal,
  tooManyRefusal,
} from '@nexus/factory-domain/sales/quote-proofs/rules'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { completeUpload, prepareFileCopy, presignedView, recordGeneratedFile, requestUpload, storeAccountOf, storeCall, viewOf } from '../../../platform/files/files'
import { cleanFileName, fileMachine, normaliseContentType, UPLOAD_URL_SECONDS, uploadProblems, type FileKind } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { insertNewVersion, versionKeyOf, type VersionPlan } from '../../../platform/files/versions/versions'
import { seriesOf } from '../../../platform/files/versions/supersede'
import { officeContextOf, officeQuote, readCurrentVersion, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { factsOf, lockVersionRow, proofFilesOf, proofsOf, type ProofRow } from './store'

/**
 * The office's side of the proofs (B-W2b-165; SAL-199; design sales.quotes Documents, "Proofs the customer accepts with
 * the quote"): read them per version with what was accepted, add one (announce → PUT → confirm), give one a new version,
 * remove one, carry an earlier version's over — all only while the quote's current version is not sent (quotes.manage over
 * the quote's company and customer; adding a file is files.upload too). Every change is ONE command of its own beside the
 * files platform's (the version's row locked first: a send never crosses it) with an audit row on the quote and
 * quote.proofs_changed. A proof is the office's file until the send shares it (freeze.ts).
 *
 *   GET    /sales/quotes/:quoteId/proofs                       quotes.view
 *   POST   /sales/quotes/:quoteId/proofs                       quotes.manage + files.upload: a new proof, its presigned PUT
 *   POST   /sales/quotes/:quoteId/proofs/:fileId/versions      quotes.manage + files.upload: a new version of that proof
 *   POST   /sales/quotes/:quoteId/proofs/:fileId/complete      quotes.manage + files.upload: the upload confirmed
 *   DELETE /sales/quotes/:quoteId/proofs/:fileId               quotes.manage: the proof and every version of it
 *   POST   /sales/quotes/:quoteId/proofs/carry                 quotes.manage + files.upload: copies of an earlier version's
 *                                                              proofs (each names its source), the same bytes not twice
 */

export interface ProofUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

const userNames = async (db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> => {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

/** Why the caller may not change the current version's proofs now (a right they lack, or a frozen version); null when they may. */
function heldFor(caller: CommandCaller, quote: QuoteRow, version: Pick<VersionRow, 'status' | 'revision'>): { readonly right: boolean; readonly message: string } | null {
  const actor = actorOf(officeContextOf(caller))
  if (!can(actor, QUOTES_MANAGE, { companyId: quote.companyId, partyId: quote.partyId })) return { right: true, message: 'Changing proofs needs quotes.manage for this customer.' }
  if (!can(actor, FILES_UPLOAD, { companyId: quote.companyId })) return { right: true, message: 'Adding a file needs files.upload for this company.' }
  const frozen = proofsFrozenRefusal(version.status, version.revision)
  return frozen ? { right: false, message: frozen } : null
}

/** GET /sales/quotes/:quoteId/proofs */
export async function listProofs(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId, QUOTES_VIEW)
  return caller.withClient(async (client) => {
    const versions = await client.quoteVersion.findMany({ where: { quoteId: quote.id }, select: { id: true, revision: true, status: true, sentAt: true }, orderBy: { revision: 'desc' } })
    const ids = versions.map((version) => version.id)
    const rows = await proofFilesOf(client, ids)
    const acceptances = await client.quoteAcceptance.findMany({ where: { versionId: { in: ids } }, select: { id: true, versionId: true, signerName: true, acceptedAt: true } })
    const evidence = acceptances.length > 0 ? await client.auditLog.findMany({ where: { recordType: PROOF_RECORD_TYPE, recordId: { in: ids }, action: ACCEPTED_PROOFS_ACTION }, select: { recordId: true, after: true } }) : []
    const people = await userNames(client, rows.map((row) => row.createdById))
    const current = versions.find((version) => version.revision === quote.currentRevision) ?? null
    const listed = versions.filter((version) => version.id === current?.id || rows.some((row) => row.recordId === version.id) || acceptances.some((row) => row.versionId === version.id))
    const held = current ? (heldFor(caller, quote, current)?.message ?? null) : 'The quote has no version.'
    const currentHas = new Set(current ? proofSeries(rows.filter((row) => row.recordId === current.id).map(factsOf)).map((entry) => entry.newest.row.sha256) : [])
    const earlier = versions.filter((version) => current !== null && version.revision < current.revision)
    const carry = earlier
      .map((version) => ({ version, count: proofSeries(rows.filter((row) => row.recordId === version.id).map(factsOf)).filter((entry) => entry.current && !currentHas.has(entry.current.row.sha256)).length }))
      .find((entry) => entry.count > 0)
    return {
      quoteId: quote.id,
      versions: listed.map((version) => {
        const acceptance = acceptances.find((row) => row.versionId === version.id) ?? null
        const trail = acceptance ? evidence.find((row) => row.recordId === version.id && (row.after as { acceptanceId?: unknown } | null)?.acceptanceId === acceptance.id) : undefined
        return {
          versionId: version.id,
          revision: version.revision,
          status: version.status,
          current: version.id === current?.id,
          sentAt: version.sentAt ? toUtcIso(version.sentAt) : null,
          frozen: proofsFrozenRefusal(version.status, version.revision),
          proofs: proofsOf(rows.filter((row) => row.recordId === version.id), people),
          accepted: acceptance ? { acceptanceId: acceptance.id, signerName: acceptance.signerName, acceptedAt: toUtcIso(acceptance.acceptedAt), proofs: acceptedProofsOf(trail?.after ?? null) } : null,
        }
      }),
      may: { change: held === null, held },
      carry: held === null && carry ? { fromVersionId: carry.version.id, revision: carry.version.revision, count: carry.count } : null,
      limits: { max: MAX_PROOFS, contentTypes: [...PROOF_CONTENT_TYPES] },
      at: toUtcIso(serverClock.now()),
    }
  })
}

/** The quote and its current version, when the caller may change its proofs now (else 403 / 409 in words). */
async function writable(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const version = await caller.withClient((client) => readCurrentVersion(client, quote))
  const held = heldFor(caller, quote, version)
  if (held !== null) throw held.right ? new ForbiddenError(held.message) : new InvalidStateError(held.message)
  return { quote, version }
}

/** In the command: the version's row locked, its state read again (a send may have frozen it meanwhile). */
async function stillOpen(tools: Pick<CommandTools, 'tx'>, versionId: string): Promise<void> {
  await lockVersionRow(tools.tx, versionId)
  const row = await tools.tx.quoteVersion.findUniqueOrThrow({ where: { id: versionId }, select: { status: true, revision: true } })
  const refusal = proofsFrozenRefusal(row.status, row.revision)
  if (refusal) throw new InvalidStateError(refusal)
}

const seriesCount = (rows: readonly ProofRow[]): number => proofSeries(rows.map(factsOf)).length

function typeProblems(body: ProofUpload): Issue[] {
  const refusal = proofTypeRefusal(body.contentType)
  return refusal ? [{ path: 'body/contentType', message: refusal }] : []
}

/** POST /sales/quotes/:quoteId/proofs: a new proof of the current version, and its presigned PUT. */
export async function announceProof(files: FilesRuntime, caller: CommandCaller, quoteId: string, body: ProofUpload, idempotencyKey?: string) {
  const { quote, version } = await writable(caller, quoteId)
  const problems = typeProblems(body)
  if (problems.length > 0) throw new ValidationError('The proof is not valid.', problems)
  const tooMany = tooManyRefusal(seriesCount(await caller.withClient((client) => proofFilesOf(client, [version.id]))))
  if (tooMany) throw new ConflictError(tooMany)
  return requestUpload(
    files,
    caller,
    { companyId: quote.companyId, recordType: PROOF_RECORD_TYPE, recordId: version.id, kind: proofFileKindOf(body.contentType), category: 'PROOF', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** The proof file of the current version (any version of its series, not deleted). */
async function proofOf(caller: CommandCaller, versionId: string, fileId: string): Promise<ProofRow> {
  const row = isUuid(fileId) ? (await caller.withClient((client) => proofFilesOf(client, [versionId]))).find((file) => file.id === fileId) : undefined
  if (!row || row.status === 'DELETED') throw new NotFoundError('Proof not found.')
  return row
}

/**
 * POST /sales/quotes/:quoteId/proofs/:fileId/versions: a new version of the proof (B-W2b-160's series: the next number, a
 * new object, the earlier version superseded once the new one is available). A PDF's next version is a PDF, a picture's a
 * picture (a version keeps its kind). The office's file until the send, as the first one.
 */
export async function announceProofVersion(files: FilesRuntime, caller: CommandCaller, quoteId: string, fileId: string, body: ProofUpload, idempotencyKey?: string) {
  const { quote, version } = await writable(caller, quoteId)
  const named = await proofOf(caller, version.id, fileId)
  const root = seriesRootOf(named)
  const series = await caller.withClient((client) => seriesOf(client, root))
  const refusal = newVersionRefusal(named, series)
  if (refusal) throw new ConflictError(refusal)
  const contentType = normaliseContentType(body.contentType)
  const originalName = cleanFileName(body.originalName)
  const problems: Issue[] = [
    ...typeProblems(body),
    ...uploadProblems({ kind: named.kind as FileKind, contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
  ]
  if (problems.length > 0) throw new ValidationError('The new version is not valid.', problems)
  const plan: VersionPlan = {
    root,
    companyId: quote.companyId,
    recordType: PROOF_RECORD_TYPE,
    recordId: version.id,
    kind: named.kind as FileKind,
    category: 'PROOF',
    originalName: originalName!,
    contentType,
    sizeBytes: body.sizeBytes,
    sha256: body.sha256,
    sharing: { visibility: ['OFFICE'], companyId: quote.companyId, floorSiteId: null, partyId: null },
    storeAccountId: await storeAccountOf(caller, quote.companyId),
  }
  const { result } = await command(caller, { name: 'quotes.requestProofVersion', idempotencyKey, input: { quoteId, fileId, ...body } }, async (tools) => {
    await stillOpen(tools, version.id)
    const storageKey = versionKeyOf(tools.context, plan, tools.now)
    const row = await insertNewVersion(tools, plan, storageKey)
    return { file: viewOf(row), storageKey }
  })
  const upload = await storeCall(() =>
    files.storage.presignUpload(caller, plan.storeAccountId, { key: result.storageKey, contentType: plan.contentType, sizeBytes: plan.sizeBytes, sha256: plan.sha256, expiresInSeconds: UPLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: result.file, upload: presignedView(upload) }
}

/** POST /sales/quotes/:quoteId/proofs/:fileId/complete: the upload confirmed (available, or held with the reason). */
export async function completeProof(files: FilesRuntime, caller: CommandCaller, quoteId: string, fileId: string, idempotencyKey?: string) {
  const { quote, version } = await writable(caller, quoteId)
  await proofOf(caller, version.id, fileId)
  const file = await completeUpload(files, caller, fileId, idempotencyKey, { viaModule: true })
  await command(caller, { name: 'quotes.addProof', idempotencyKey, input: { quoteId, fileId } }, async (tools) => {
    await stillOpen(tools, version.id)
    tools.audit({
      action: 'quotes.addProof',
      recordType: 'Quote',
      recordId: quote.id,
      companyId: quote.companyId,
      after: { versionId: version.id, revision: version.revision, fileId, name: file.originalName, sha256: file.sha256, versionNo: file.versionNo ?? 1, status: file.status },
    })
    tools.emit({ type: 'quote.proofs_changed', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, change: (file.versionNo ?? 1) > 1 ? 'replaced' : 'added', fileIds: [fileId] } })
    return { fileId }
  })
  return listProofs(caller, quoteId)
}

/** DELETE /sales/quotes/:quoteId/proofs/:fileId: the proof and every version of it (the objects removed after). */
export async function removeProof(files: FilesRuntime, caller: CommandCaller, quoteId: string, fileId: string, idempotencyKey?: string) {
  const { quote, version } = await writable(caller, quoteId)
  const named = await proofOf(caller, version.id, fileId)
  const root = seriesRootOf(named)
  const { result } = await command(caller, { name: 'quotes.removeProof', idempotencyKey, input: { quoteId, fileId } }, async (tools) => {
    const { tx, now } = tools
    await stillOpen(tools, version.id)
    const rows = (await proofFilesOf(tx, [version.id])).filter((row) => (row.seriesId ?? row.id) === root && row.status !== 'DELETED')
    if (rows.length === 0) throw new NotFoundError('Proof not found.')
    for (const row of rows) {
      assertTransition(fileMachine, row.status, 'DELETED', { legalHold: row.legalHold, retainUntil: row.retainUntil, now })
      await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'files.delete', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DELETED' }, reason: `Proof removed from quote ${quote.number} version ${version.revision}` })
    }
    const ids = rows.map((row) => row.id)
    tools.audit({ action: 'quotes.removeProof', recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, before: { versionId: version.id, revision: version.revision, name: named.originalName, fileIds: ids } })
    tools.emit({ type: 'quote.proofs_changed', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, change: 'removed', fileIds: ids } })
    return rows.map((row) => ({ storeAccountId: row.storeAccountId, key: row.storageKey, legalHold: row.legalHold, retainUntil: row.retainUntil === null ? null : toUtcIso(row.retainUntil) }))
  })
  for (const object of result) {
    try {
      await files.storage.remove(caller, object.storeAccountId, { key: object.key, legalHold: object.legalHold, retainUntil: object.retainUntil === null ? null : new Date(object.retainUntil) }, files.clock.now())
    } catch {
      // The rows are DELETED: gone for every caller. An object left behind is invisible; the gateway's ledger has the failure.
    }
  }
  return listProofs(caller, quoteId)
}

/**
 * POST /sales/quotes/:quoteId/proofs/carry: the current proofs of an earlier version (a new version of a sent quote starts
 * without them) copied onto the current one, each copy naming its source (prepareFileCopy, the same bytes); a proof whose
 * bytes the current version already has is not copied again.
 */
export async function carryProofs(files: FilesRuntime, caller: CommandCaller, quoteId: string, body: { readonly fromVersionId: string }, idempotencyKey?: string) {
  const { quote, version } = await writable(caller, quoteId)
  const { from, sources, held } = await caller.withClient(async (client) => {
    const from = await client.quoteVersion.findFirst({ where: { id: body.fromVersionId, quoteId: quote.id }, select: { id: true, revision: true } })
    if (!from || from.revision >= version.revision) throw new NotFoundError('Earlier version not found.')
    const rows = await proofFilesOf(client, [from.id, version.id])
    const held = proofSeries(rows.filter((row) => row.recordId === version.id).map(factsOf))
    const has = new Set(held.map((entry) => entry.newest.row.sha256))
    const sources = proofSeries(rows.filter((row) => row.recordId === from.id).map(factsOf)).flatMap((entry) => (entry.current && !has.has(entry.current.row.sha256) ? [entry.current.row] : []))
    return { from, sources, held: held.length }
  })
  if (sources.length === 0) throw new ConflictError(`Version ${from.revision} has no proof the current version does not already have.`)
  const tooMany = tooManyRefusal(held + sources.length - 1)
  if (tooMany) throw new ConflictError(tooMany)
  const prepared: Awaited<ReturnType<typeof prepareFileCopy>>[] = []
  for (const source of sources) {
    prepared.push(await prepareFileCopy(files, caller, source.id, { companyId: quote.companyId, recordType: PROOF_RECORD_TYPE, recordId: version.id, visibility: ['OFFICE'] }))
  }
  await command(caller, { name: 'quotes.carryProofs', idempotencyKey, input: { quoteId, ...body } }, async (tools) => {
    await stillOpen(tools, version.id)
    const made: string[] = []
    for (const copy of prepared) {
      const file = await recordGeneratedFile(tools, copy, { details: { carriedFromVersion: from.revision } })
      await tools.tx.storedFile.update({ where: { id: file.id }, data: { category: 'PROOF' }, select: { id: true } })
      made.push(file.id)
    }
    tools.audit({ action: 'quotes.carryProofs', recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, after: { versionId: version.id, revision: version.revision, fromVersionId: from.id, fromRevision: from.revision, fileIds: made, sourceFileIds: sources.map((source) => source.id) } })
    tools.emit({ type: 'quote.proofs_changed', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, change: 'carried', fileIds: made } })
    return { fileIds: made }
  })
  return listProofs(caller, quoteId)
}
