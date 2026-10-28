import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localFileStore, type LocalFileStore } from '../../adapters/local-files/local'
import { r2FileStore } from '../../adapters/r2/r2'
import { serverClock, type Clock } from '../../core/time'
import { loadFactoryEnv } from '../../env'
import type { Gateway } from '../gateway/gateway'
import { processGateway } from '../gateway/service'
import type { FileStoreAdapter } from './port'
import { fileStorage, type FileStorage } from './store'

/**
 * The process's files runtime: the store behind the gateway and, with FACTORY_ENV local or test, the local store whose
 * `/local-files` routes serve its presigned requests. Made on first use from apps/factory-api/.env
 * (FACTORY_LOCAL_FILES_DIR, default a folder under the system's temporary directory named after the queue prefix) and
 * the process gateway; tests set their own with useFiles(createFilesRuntime({ … })), like useGateway().
 */

export interface FilesRuntime {
  readonly storage: FileStorage
  /** The local store, or null (staging and production: every FAKE account is refused there anyway). */
  readonly local: LocalFileStore | null
  /** Presigned requests' expiry and the local tokens' check. */
  readonly clock: Clock
}

export interface FilesRuntimeOptions {
  readonly gateway: Gateway
  readonly local: LocalFileStore | null
  /** Default: the real R2 adapter. Tests pass one with a fake S3 request handler. */
  readonly r2?: FileStoreAdapter
  readonly clock?: Clock
}

export function createFilesRuntime(options: FilesRuntimeOptions): FilesRuntime {
  return Object.freeze({
    storage: fileStorage(options.gateway, { r2: options.r2 ?? r2FileStore(), local: options.local }),
    local: options.local,
    clock: options.clock ?? serverClock,
  })
}

let configured: FilesRuntime | undefined
let fromEnv: FilesRuntime | undefined

export function useFiles(runtime: FilesRuntime | undefined): void {
  configured = runtime
}

export function processFiles(): FilesRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local =
      env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
        ? localFileStore({ root: env.FACTORY_LOCAL_FILES_DIR ?? join(tmpdir(), 'nexus-factory-files', env.FACTORY_QUEUE_PREFIX), environment: env.FACTORY_ENV })
        : null
    fromEnv = createFilesRuntime({ gateway: processGateway(), local })
  }
  return fromEnv
}
