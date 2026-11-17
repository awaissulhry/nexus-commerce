import { DomainError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { processFiles } from '../../../platform/files/service'
import { useFileOn } from '../../../platform/files/use-on'
import type { FileAudience } from '../../../platform/files/rules'
import type { InquiryData } from './store'

/**
 * B-TH-025 / B-TH-026 (threads plan N8, "Use on…"): a request's files carried to what was made from it — the order, a style
 * draft. Each is copied by platform/files' Use on (B-TH-024: the bytes copied and checked, the copy naming its source, the
 * brand wall: a customer's file goes only to a record of the same customer), AFTER the command that made the record: the
 * record stands even when a file cannot be copied (its bytes missing, the person not allowed), and the answer says which and
 * why. A copy is shared as the original was (the office; the customer's portal when the original was shared with it); never the
 * floor or a link from here. A file already carried to that record (a retried call) is not copied again.
 */

export interface CarriedFiles {
  readonly carried: { sourceFileId: string; fileId: string; name: string }[]
  readonly notCarried: { sourceFileId: string; name: string; reason: string }[]
}

const SHARED: readonly FileAudience[] = ['OFFICE', 'PARTNER']

/** The request's own files and its mail's kept attachments, AVAILABLE (or only those picked, in their order). */
export async function requestFiles(caller: CommandCaller, row: Pick<InquiryData, 'id' | 'sourceEmailId'>, picked?: readonly string[]): Promise<{ id: string; originalName: string; visibility: string[] }[]> {
  const files = await caller.withClient((client) =>
    client.storedFile.findMany({
      where: { status: 'AVAILABLE', OR: [{ recordType: 'Inquiry', recordId: row.id }, ...(row.sourceEmailId ? [{ recordType: 'InboundEmail', recordId: row.sourceEmailId }] : [])] },
      select: { id: true, originalName: true, visibility: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  if (picked === undefined) return files
  return picked.flatMap((fileId) => files.filter((file) => file.id === fileId))
}

/** Copies each file onto the target record (see the module's head); one file's failure never stops the others. */
export async function carryFiles(caller: CommandCaller, files: readonly { id: string; originalName: string; visibility: string[] }[], target: { readonly recordType: string; readonly recordId: string }, idempotencyKey: string | undefined): Promise<CarriedFiles> {
  const result: CarriedFiles = { carried: [], notCarried: [] }
  if (files.length === 0) return result
  const already = new Map(
    (await caller.withClient((client) => client.storedFile.findMany({ where: { recordType: target.recordType, recordId: target.recordId, sourceFileId: { in: files.map((file) => file.id) } }, select: { id: true, sourceFileId: true } }))).map((row) => [row.sourceFileId, row.id]),
  )
  for (const file of files) {
    const copied = already.get(file.id)
    if (copied) {
      result.carried.push({ sourceFileId: file.id, fileId: copied, name: file.originalName })
      continue
    }
    try {
      const visibility = SHARED.filter((audience) => file.visibility.includes(audience))
      const { file: copy } = await useFileOn(processFiles(), caller, file.id, { recordType: target.recordType, recordId: target.recordId, visibility }, idempotencyKey ? `${idempotencyKey}:carry:${file.id}` : undefined)
      result.carried.push({ sourceFileId: file.id, fileId: copy.id, name: file.originalName })
    } catch (error) {
      // A refusal in words (not allowed, the brand wall, the bytes missing) or the store unavailable: said, the others carried on.
      if (!(error instanceof DomainError) && !(error instanceof ApiError)) throw error
      result.notCarried.push({ sourceFileId: file.id, name: file.originalName, reason: error.message })
    }
  }
  return result
}
