import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { CommandCaller } from '../../core/command'
import { gatewayAccount, ProviderError, type Gateway } from '../gateway/gateway'
import type { DownloadTarget, FileStoreAdapter, PresignedRequest, PutTarget, StoredObject, UploadTarget } from './port'
import { deleteBlockers } from './rules'

/**
 * The file store behind the gateway (plan A1 §4; Commerce hard rule 4 for the factory): each store operation is ONE
 * gateway call for the file's R2 account — re-read and checked (mode, PAUSED kill switch, circuit, rate limit), recorded
 * as one IntegrationCall row — and inside it the adapter of the account's mode: FAKE → the local folder (local and test
 * only), LIVE and SANDBOX → R2. The caller is an office session or a tenant's system context (the gateway refuses
 * floor and partner callers; their downloads presign as the system after the audience check, files.ts).
 *
 *   files.presign_upload     files.presign_download     files.head     files.put     files.delete     files.read
 *
 * The ledger keeps the storage key, type and size of a call, never a file name (personal data) or a presigned URL.
 */

export interface FileStoreAdapters {
  readonly r2: FileStoreAdapter
  /** The local store (FACTORY_ENV local or test), else null: a FAKE account then has no store. */
  readonly local: FileStoreAdapter | null
}

/** The delete was refused before anything was sent: the file is still retained. */
export class RetainedFileError extends Error {
  override name = 'RetainedFileError'
}

export interface FileStorage {
  presignUpload(caller: CommandCaller, accountId: string, target: UploadTarget): Promise<PresignedRequest>
  presignDownload(caller: CommandCaller, accountId: string, target: DownloadTarget): Promise<PresignedRequest>
  head(caller: CommandCaller, accountId: string, key: string): Promise<StoredObject | null>
  /** Writes bytes the API made (a generated document) under a new key. */
  put(caller: CommandCaller, accountId: string, target: PutTarget): Promise<void>
  /** Removes the object of a file, refused (RetainedFileError) while the file is on legal hold or retained. */
  remove(caller: CommandCaller, accountId: string, file: { readonly key: string; readonly legalHold: boolean; readonly retainUntil: Date | null }, now: Date): Promise<void>
  /** The object's bytes (null: no object), at most maxBytes (else TooLargeObjectError): server-side work on a file. */
  read(caller: CommandCaller, accountId: string, key: string, maxBytes: number): Promise<Buffer | null>
}

export function fileStorage(gateway: Gateway, adapters: FileStoreAdapters): FileStorage {
  function adapterFor(account: AdapterAccount): FileStoreAdapter {
    if (account.provider !== 'R2') throw new ProviderError('This account is not a file store (provider R2).', { retryable: false })
    if (account.mode !== 'FAKE') return adapters.r2
    if (!adapters.local) throw new ProviderError('A FAKE file store needs the local folder, which this environment does not have.', { retryable: false })
    return adapters.local
  }

  return Object.freeze({
    presignUpload: (caller, accountId, target) =>
      gateway.call(
        gatewayAccount(caller, accountId),
        { name: 'files.presign_upload', idempotent: true, request: { key: target.key, contentType: target.contentType, sizeBytes: target.sizeBytes } },
        (call) => adapterFor(call.account).presignUpload(call, target),
      ),
    presignDownload: (caller, accountId, target) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.presign_download', idempotent: true, request: { key: target.key } }, (call) =>
        adapterFor(call.account).presignDownload(call, target),
      ),
    head: (caller, accountId, key) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.head', idempotent: true, request: { key } }, (call) => adapterFor(call.account).head(call, key)),
    put: (caller, accountId, target) =>
      gateway.call(
        gatewayAccount(caller, accountId),
        { name: 'files.put', idempotent: true, request: { key: target.key, contentType: target.contentType, sizeBytes: target.body.byteLength } },
        (call) => adapterFor(call.account).put(call, target),
      ),
    async remove(caller, accountId, file, now) {
      const blockers = deleteBlockers(file, now)
      if (blockers.length > 0) throw new RetainedFileError(`The object is retained; deleting it needs ${blockers.join(' and ')}.`)
      await gateway.call(gatewayAccount(caller, accountId), { name: 'files.delete', idempotent: true, request: { key: file.key } }, (call) => adapterFor(call.account).remove(call, file.key))
    },
    read: (caller, accountId, key, maxBytes) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.read', idempotent: true, request: { key, maxBytes } }, (call) => adapterFor(call.account).read(call, key, maxBytes)),
  } satisfies FileStorage)
}
