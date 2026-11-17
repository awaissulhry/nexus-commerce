import { FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { mayOnThread, resolveRecord } from '../threads/records'
import { wallPartyOf } from '../threads/records' // B-PR-08a part 2
import type { FileView } from './contract'
import { contextOf, mayWrite, prepareFileCopy, readVisible, recordGeneratedFile, withRecordParty } from './files'
import { ownerOf, readsThroughModule } from './owned'
import { normaliseVisibility, type FileAudience, type FileKind } from './rules'
import type { FilesRuntime } from './service'
// B-TH-231: the records a file may be carried to, found as global search finds them.
import { MESSAGE_TYPE, searchRecords } from '../search/search'

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
  // B-PR-08a part 2: a work order's, hold's or NCR's customer is its wall party (records.ts; several or none: the every-party marker).
  const sourceParty = wallPartyOf(from) ?? source.partyId ?? null
  const targetParty = wallPartyOf(target)
  if (sourceParty !== null && targetParty !== null && sourceParty !== targetParty) {
    const words = USE_ON_WORDS.otherParty(source.originalName)
    throw new DomainError('conflict', words, [{ path: 'refusal/OTHER_PARTY', message: words }])
  }
  const sharing = await withRecordParty(caller, body, { visibility: normaliseVisibility(body.visibility ?? ['OFFICE']), companyId: target.companyId ?? null, floorSiteId: null, partyId: null })
  mayWrite(caller, FILES_UPLOAD, sharing)
  // B-TH-231: shared beyond the office it is files.manage, as at upload and afterwards (COL-050).
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
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

// ---- B-TH-231 (threads plan TH-2, T9-F05; walls W25 / W26): "Use on another record…" offers only what the API takes ------------
/** A record a file may be carried to, as the picker lists it. `partyId`: the target record's customer or supplier (null: none). */
export interface UseOnTarget {
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  readonly title: string
  readonly subtitle: string | null
  readonly area: string
  readonly partyId: string | null
}

/** At most this many targets in one answer. */
export const USE_ON_TARGETS = 20

/**
 * GET /files/:fileId/use-on/targets?q=&type= — the records this file may be carried to, found by number or name as global search
 * finds them (the reader's own entries), then each read again with its thread resolver: a record the person may write files on
 * (files.read over it and its gate, files.upload), not this file's own record, not one whose files its module keeps, and — the
 * brand wall — of the SAME customer as the file's record, or of none (a file of no customer may go to any of them). So the picker
 * never offers another customer's record; the carry (POST …/use-on) checks it all again.
 */
export async function useOnTargets(caller: CommandCaller, fileId: string, query: { readonly q: string; readonly type?: string | undefined }): Promise<{ tooShort: boolean; targets: UseOnTarget[] }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const source = await readVisible(caller, fileId)
  const kind: FileKind = source.kind === 'FISCAL_ARCHIVE' ? 'DOCUMENT' : (source.kind as FileKind)
  if (query.type === MESSAGE_TYPE) return { tooShort: false, targets: [] }
  const found = await searchRecords(caller, { q: query.q, type: query.type, limit: 50, offset: 0 })
  if (found.tooShort) return { tooShort: true, targets: [] }
  return caller.withClient(async (client) => {
    const from = await resolveRecord(client, source.recordType, source.recordId)
    const sourceParty = from?.partyId ?? source.partyId ?? null
    const targets: UseOnTarget[] = []
    for (const result of found.results) {
      if (targets.length >= USE_ON_TARGETS) break
      if (result.recordType === MESSAGE_TYPE || (result.recordType === source.recordType && result.recordId === source.recordId)) continue
      if (readsThroughModule(result.recordType) || ownerOf(result.recordType, kind)) continue
      const target = await resolveRecord(client, result.recordType, result.recordId)
      if (!target || !mayOnThread(actor, FILES_READ, result.recordType, target) || !can(actor, FILES_UPLOAD, target)) continue
      if (sourceParty !== null && target.partyId !== null && target.partyId !== sourceParty) continue
      targets.push({ recordType: result.recordType, recordId: result.recordId, number: result.number, title: result.title, subtitle: result.subtitle, area: result.area, partyId: target.partyId })
    }
    return { tooShort: false, targets }
  })
}
// ---- end B-TH-231
