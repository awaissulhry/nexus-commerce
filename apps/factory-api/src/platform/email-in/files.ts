import { randomUUID } from 'node:crypto'
import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { InboundAttachment } from '@nexus/factory-domain/email-in/rules'
import type { CommandCaller, CommandTools, CommandTx } from '../../core/command'
import type { FilesRuntime } from '../files/service'
import { storageKeyFor, type FileAudience } from '../files/rules'

/**
 * The attachments of received mail as record files (COL-025: "Attachments are stored as files on the record
 * (deduplicated)"; COL-050: who sees them). Their bytes are put in the tenant's file store by the worker or the route,
 * before any transaction (gateway op files.put), and recorded as AVAILABLE StoredFile rows inside the command that
 * decides where the mail goes, so the files, the thread message and the mail's place are one change:
 *   - a mail that joined a thread: files of the thread's RECORD, shared with the thread's party (PARTNER: the party sent
 *     them, its portal shows them with its message), never with a floor or a link;
 *   - a mail that waits (TRIAGE, HELD): files of the InboundEmail, office only, until a person assigns or releases it;
 *     then they are copied onto the record (StoredFile's record never changes: copy = read + put + a new row).
 * A file of the record with the same content (SHA-256) and name is reused, not stored twice.
 */

/** A kept attachment whose bytes are in the store. */
export type StoredPart = Extract<InboundAttachment, { kept: true }>

/** The record a mail's files go to, and with whom they are shared. */
export interface FileHome {
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string | null
  /** The thread's party: the files are shared with it (PARTNER). Null: office only. */
  readonly partyId: string | null
}

/**
 * The tenant's file store for a company's files: its R2 account that is not DISABLED, the company's own before the
 * tenant-wide one (as platform/files chooses). None, or two at one level, is a set-up problem (409).
 */
export async function storeAccountFor(client: FactoryClient | CommandTx, companyId: string | null): Promise<string> {
  const accounts = await client.integrationAccount.findMany({
    where: { provider: 'R2', status: { not: 'DISABLED' }, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { id: true, companyId: true },
    orderBy: { id: 'asc' },
  })
  const own = accounts.filter((account) => companyId !== null && account.companyId === companyId)
  const chosen = own.length > 0 ? own : accounts.filter((account) => account.companyId === null)
  if (chosen.length !== 1) throw new ConflictError(chosen.length === 0 ? 'Files are not set up: this tenant has no file store (an R2 account).' : 'This tenant has more than one file store for these files.')
  return chosen[0]!.id
}

/** Puts bytes in the store under a new random key (one files.put gateway call); answers the stored part. */
export async function putPart(
  files: FilesRuntime,
  caller: CommandCaller,
  where: { readonly tenantId: string; readonly companyId: string | null; readonly storeAccountId: string },
  part: { readonly name: string; readonly contentType: string; readonly body: Buffer; readonly sha256: string },
): Promise<StoredPart> {
  const storageKey = storageKeyFor({ tenantId: where.tenantId, companyId: where.companyId, kind: 'ATTACHMENT', now: files.clock.now(), random: randomUUID() })
  await files.storage.put(caller, where.storeAccountId, { key: storageKey, contentType: part.contentType, body: part.body, sha256: part.sha256 })
  return { kept: true, name: part.name, contentType: part.contentType, sizeBytes: part.body.length, sha256: part.sha256, storeAccountId: where.storeAccountId, storageKey, fileId: null }
}

/**
 * Records stored parts as AVAILABLE ATTACHMENT files of `home`, inside the command; answers the file id of each part, in
 * order (a file of the record with the same SHA-256, name and sharing is reused: two parts may answer one id). Each new
 * file has its audit row and file.available.
 */
export async function recordFiles(tools: Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit' | 'emit'>, home: FileHome, parts: readonly StoredPart[]): Promise<string[]> {
  const { tx, now } = tools
  const visibility: FileAudience[] = home.partyId ? ['OFFICE', 'PARTNER'] : ['OFFICE']
  const ids: string[] = []
  for (const part of parts) {
    const same = await tx.storedFile.findFirst({
      where: { recordType: home.recordType, recordId: home.recordId, sha256: part.sha256, originalName: part.name, status: 'AVAILABLE', partyId: home.partyId },
      select: { id: true },
    })
    if (same) {
      ids.push(same.id)
      continue
    }
    const id = newId()
    await tx.storedFile.create({
      data: {
        id,
        companyId: home.companyId,
        recordType: home.recordType,
        recordId: home.recordId,
        kind: 'ATTACHMENT',
        originalName: part.name,
        contentType: part.contentType,
        sizeBytes: part.sizeBytes,
        sha256: part.sha256,
        storeAccountId: part.storeAccountId,
        storageKey: part.storageKey,
        status: 'AVAILABLE',
        availableAt: now,
        visibility,
        partyId: home.partyId,
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'emailIn.storeAttachment',
      recordType: 'StoredFile',
      recordId: id,
      companyId: home.companyId,
      after: { recordType: home.recordType, recordId: home.recordId, kind: 'ATTACHMENT', originalName: part.name, contentType: part.contentType, sizeBytes: part.sizeBytes, sha256: part.sha256, status: 'AVAILABLE', visibility, partyId: home.partyId },
    })
    tools.emit({ type: 'file.available', subject: id, companyId: home.companyId, payload: { fileId: id, recordType: home.recordType, recordId: home.recordId, kind: 'ATTACHMENT' } })
    ids.push(id)
  }
  return ids
}
