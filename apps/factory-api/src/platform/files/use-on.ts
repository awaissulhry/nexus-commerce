import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { mayOnThread, resolveRecord } from '../threads/records'
import type { FileView } from './contract'
import { contextOf, mayWrite, prepareFileCopy, readVisible, recordGeneratedFile, withRecordParty } from './files'
import { ownerOf, readsThroughModule } from './owned'
import { normaliseVisibility, type FileAudience, type FileKind } from './rules'
import type { FilesRuntime } from './service'

/**
 * B-TH-024 (threads plan TH-2, N8; sections T9, the record threads' "Use on…"; wall test T25 extended): carry a file to another
 * record — a customer's photo from its request onto the order made from it, a tech pack from a style onto a quote.
 *
 *   POST /files/:fileId/use-on {recordType, recordId, visibility?}   files.read over the file and its record (B-TH-029),
 *                                                                    files.upload over the target record
 *
 * The bytes are copied (prepareFileCopy: read from the store, checked against their SHA-256, put under a new key) and the copy
 * recorded in ONE command (recordGeneratedFile): its kind (a fiscal archive file becomes a DOCUMENT: the archive stays where it
 * is) and its category kept, the copy NAMING ITS SOURCE (sourceFileId: which file and so which version it was); a record's
 * file list shows where each copy came from (listFiles' `origin`). Sharing on the target: the office by default; shared
 * outside, only with the TARGET record's own customer or supplier (withRecordParty, B-TH-003).
 *
 * The brand wall (Owner rule 2026-11-16: "one brand must not be able to see anything related to any other brand"): a file of a
 * customer's record goes only to a record of the same customer or of none (an internal record); onto another customer's
 * record it is refused in words (409 `refusal/OTHER_PARTY`; the office's words name the file, never shown to a customer). A
 * file of no customer (our own) may go anywhere the person may write. A record type whose files its module keeps (owned.ts)
 * takes none this way.
 */

export interface UseOnBody {
  readonly recordType: string
  readonly recordId: string
  readonly visibility?: readonly FileAudience[] | undefined
}

export const USE_ON_WORDS = Object.freeze({
  otherParty: (name: string) => `${name} belongs to another customer's record: a file is carried only to a record of the same customer, or to one of no customer.`,
  sameRecord: 'The file is on this record already.',
  ownedTarget: "This record's files are kept by its own screen: add the file there.",
})

export async function useFileOn(runtime: FilesRuntime, caller: CommandCaller, fileId: string, body: UseOnBody, idempotencyKey?: string): Promise<{ file: FileView }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  // The source as the person may read it (its company, its record's own scope: B-TH-029).
  const source = await readVisible(caller, fileId)
  if (source.status !== 'AVAILABLE') throw new InvalidStateError(`This file is ${source.status}; only an available file is carried to another record.`)
  const kind: FileKind = source.kind === 'FISCAL_ARCHIVE' ? 'DOCUMENT' : (source.kind as FileKind)
  if (readsThroughModule(body.recordType) || ownerOf(body.recordType, kind)) throw new ValidationError(USE_ON_WORDS.ownedTarget, [{ path: 'body/recordType', message: USE_ON_WORDS.ownedTarget }])
  if (body.recordType === source.recordType && body.recordId === source.recordId) throw new ValidationError(USE_ON_WORDS.sameRecord, [{ path: 'body/recordId', message: USE_ON_WORDS.sameRecord }])
  const { target, from, category } = await caller.withClient(async (client) => ({
    target: isUuid(body.recordId) ? await resolveRecord(client, body.recordType, body.recordId) : null,
    from: await resolveRecord(client, source.recordType, source.recordId),
    category: (await client.storedFile.findUnique({ where: { id: source.id }, select: { category: true } }))?.category ?? null,
  }))
  if (!target || !mayOnThread(actor, FILES_READ, body.recordType, target)) throw new NotFoundError('Record not found.')
  if (!can(actor, FILES_UPLOAD, target)) throw new ForbiddenError('Adding files to this record needs the right to upload files over it.')
  // The brand wall: the source's customer (its record's; else the party the file is shared with) is the target's, or either has none.
  const sourceParty = from?.partyId ?? source.partyId ?? null
  if (sourceParty !== null && target.partyId !== null && sourceParty !== target.partyId) {
    const words = USE_ON_WORDS.otherParty(source.originalName)
    throw new DomainError('conflict', words, [{ path: 'refusal/OTHER_PARTY', message: words }])
  }
  const sharing = await withRecordParty(caller, body, { visibility: normaliseVisibility(body.visibility ?? ['OFFICE']), companyId: target.companyId ?? null, floorSiteId: null, partyId: null })
  mayWrite(caller, FILES_UPLOAD, sharing)
  const prepared = await prepareFileCopy(runtime, caller, source.id, { companyId: sharing.companyId, recordType: body.recordType, recordId: body.recordId, kind, visibility: sharing.visibility, floorSiteId: null, partyId: sharing.partyId })
  const { result } = await command(caller, { name: 'files.useOn', idempotencyKey, input: { fileId, ...body } }, async (tools) => {
    const file = await recordGeneratedFile(tools, prepared, {
      category,
      details: { useOn: true, sourceFileId: source.id, sourceRecordType: source.recordType, sourceRecordId: source.recordId, sourceVersionNo: source.versionNo ?? 1 },
    })
    return { file }
  })
  return result
}
