import { ApiError } from '../../../core/errors'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { GatewayCallFailed, GatewayRefusal } from '../../gateway/gateway'
import { contextOf } from '../../threads/threads'
import { putPart, type StoredPart } from '../files'
import type { EmailInRuntime } from '../service'
import { attachmentsOf, keptOf, type MailRow } from '../sort'

/**
 * The files of a waiting mail, copied for a record before the command that joins it (B-W2b-394: the capture address's match
 * in the worker, a service case opened from a mail by a person). A file's record never changes, so each AVAILABLE file of the
 * mail is read and put again under a new key of the record's company (one files.read and one files.put gateway call each),
 * in the mail's order; the join records them as files of the record shared with its party. The mail keeps its own copies.
 * Works for the worker (the tenant's system) and for an office person alike.
 */
export async function copyMailFiles(runtime: EmailInRuntime, caller: CommandCaller, mail: Pick<MailRow, 'id' | 'attachments'>, companyId: string | null): Promise<StoredPart[]> {
  const context = contextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'system') throw new ApiError('internal_error', 'Mail files are copied by the office or the system only.')
  const kept = keptOf(attachmentsOf(mail)).filter((part) => part.fileId !== null)
  if (kept.length === 0) return []
  const rows = await caller.withClient((client) =>
    client.storedFile.findMany({
      where: { id: { in: kept.map((part) => part.fileId!) }, recordType: 'InboundEmail', recordId: mail.id, status: 'AVAILABLE' },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true },
    }),
  )
  const files = runtime.files()
  const copies: StoredPart[] = []
  try {
    for (const part of kept) {
      const row = rows.find((file) => file.id === part.fileId)
      if (!row) continue
      const body = await files.storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes)
      if (!body) throw new ConflictError(`The attachment ${row.originalName} of this mail is missing from the file store.`)
      copies.push(await putPart(files, caller, { tenantId: context.tenantId, companyId, storeAccountId: row.storeAccountId }, { name: row.originalName, contentType: row.contentType, body, sha256: row.sha256 }))
    }
  } catch (error) {
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) throw new ApiError('not_ready', 'The file store is not available right now; nothing was changed. Try again shortly.')
    throw error
  }
  return copies
}
