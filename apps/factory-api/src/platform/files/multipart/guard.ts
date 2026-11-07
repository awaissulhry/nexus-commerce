import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'

/**
 * COL-052 (B-W2b-160): a file announced for an upload in parts is completed only through its session
 * (POST /files/uploads/:sessionId/complete): the store must join the parts first, and the joined object's checksum is the
 * store's checksum of the parts, so the plain confirm (files.ts completeUpload, the store's HEAD) would hold a good file as
 * a checksum mismatch. Called by completeUpload before its HEAD, as the office or the tenant's system caller.
 */
export async function refuseLargeUploadConfirm(caller: CommandCaller, fileId: string): Promise<void> {
  const session = await caller.withClient((client) => client.fileUploadSession.findFirst({ where: { fileId }, select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }))
  if (session) throw new ConflictError(`This file is uploaded in parts: complete it with POST /files/uploads/${session.id}/complete.`)
}
