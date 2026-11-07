import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { CommandCaller } from '../../../core/command'
import { gatewayAccount, ProviderError, type Gateway } from '../../gateway/gateway'
import type { PresignedRequest } from '../port'
import type { FileStoreAdapters } from '../store'
import { isMultipartAdapter, type MultipartStoreAdapter, type ObjectDigest, type PartTarget, type StoredPart } from './port'

/**
 * The multipart store behind the gateway (COL-052; B-W2b-160): each operation is ONE gateway call for the file's R2
 * account, as for every store call (../store.ts): re-read and checked (mode, kill switch, circuit, rate limit) and
 * recorded as one IntegrationCall row with the key and counts, never a URL or a part's bytes.
 *
 *   files.multipart_start   files.multipart_presign   files.multipart_parts   files.multipart_complete
 *   files.multipart_abort   files.digest
 *
 * Starting and completing are tried once (not idempotent at the store: the service handles a repeat); the others retry.
 */

/** A digest reads the whole object: up to ten minutes for the largest file. */
const DIGEST_TIMEOUT_MS = 600_000

export interface MultipartStorage {
  start(caller: CommandCaller, accountId: string, target: { readonly key: string; readonly contentType: string }): Promise<string>
  presignParts(caller: CommandCaller, accountId: string, targets: readonly PartTarget[]): Promise<PresignedRequest[]>
  listParts(caller: CommandCaller, accountId: string, key: string, uploadId: string): Promise<StoredPart[] | null>
  complete(caller: CommandCaller, accountId: string, key: string, uploadId: string, parts: readonly StoredPart[]): Promise<void>
  abort(caller: CommandCaller, accountId: string, key: string, uploadId: string): Promise<void>
  digest(caller: CommandCaller, accountId: string, key: string): Promise<ObjectDigest | null>
}

export function multipartStorage(gateway: Gateway, adapters: FileStoreAdapters): MultipartStorage {
  function adapterFor(account: AdapterAccount): MultipartStoreAdapter {
    if (account.provider !== 'R2') throw new ProviderError('This account is not a file store (provider R2).', { retryable: false })
    const adapter = account.mode === 'FAKE' ? adapters.local : adapters.r2
    if (!adapter) throw new ProviderError('A FAKE file store needs the local folder, which this environment does not have.', { retryable: false })
    if (!isMultipartAdapter(adapter)) throw new ProviderError('This file store does not take uploads in parts.', { retryable: false })
    return adapter
  }

  return Object.freeze({
    start: (caller, accountId, target) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.multipart_start', idempotent: false, request: { key: target.key, contentType: target.contentType } }, (call) =>
        adapterFor(call.account).startMultipart(call, target),
      ),
    presignParts: (caller, accountId, targets) =>
      gateway.call(
        gatewayAccount(caller, accountId),
        { name: 'files.multipart_presign', idempotent: true, request: { key: targets[0]?.key ?? null, parts: targets.map((target) => target.partNumber) } },
        async (call) => {
          const adapter = adapterFor(call.account)
          const signed: PresignedRequest[] = []
          for (const target of targets) signed.push(await adapter.presignPart(call, target))
          return signed
        },
      ),
    listParts: (caller, accountId, key, uploadId) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.multipart_parts', idempotent: true, request: { key } }, (call) => adapterFor(call.account).listParts(call, key, uploadId)),
    complete: (caller, accountId, key, uploadId, parts) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.multipart_complete', idempotent: false, request: { key, parts: parts.length } }, (call) =>
        adapterFor(call.account).completeMultipart(call, key, uploadId, parts),
      ),
    abort: (caller, accountId, key, uploadId) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.multipart_abort', idempotent: true, request: { key } }, (call) => adapterFor(call.account).abortMultipart(call, key, uploadId)),
    digest: (caller, accountId, key) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'files.digest', idempotent: true, timeoutMs: DIGEST_TIMEOUT_MS, request: { key } }, (call) => adapterFor(call.account).digest(call, key)),
  } satisfies MultipartStorage)
}
