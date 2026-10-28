import { FakeMailBucket } from '../../adapters/ses-inbound/fake'
import { inboundS3Store } from '../../adapters/ses-inbound/s3'
import { loadFactoryEnv } from '../../env'
import { processFiles, type FilesRuntime } from '../files/service'
import type { Gateway } from '../gateway/gateway'
import { processGateway } from '../gateway/service'
import type { RawMailAdapter } from './port'
import { rawMailStorage, type RawMailStorage } from './store'

/**
 * The process's email-in runtime: the raw-mail store behind the gateway (store.ts), the fake receiving bucket of FAKE SES
 * accounts (local and test only; none in staging or production), and the files runtime the attachments go to
 * (platform/files: gateway ops files.put and files.read). Made on first use from apps/factory-api/.env and the process
 * gateway; tests set their own with useEmailIn(createEmailInRuntime({ … })), like useEmail() and useFiles().
 */

export interface EmailInRuntime {
  readonly raw: RawMailStorage
  /** The receiving bucket of FAKE accounts, or null (staging and production). */
  readonly fake: FakeMailBucket | null
  /** The files runtime attachments are stored with (default: the process's, processFiles()). */
  files(): FilesRuntime
}

export interface EmailInRuntimeOptions {
  readonly gateway: Gateway
  readonly fake: FakeMailBucket | null
  /** Default: the real S3 adapter. Tests pass one on a fake transport. */
  readonly s3?: RawMailAdapter
  /** Default: the process's files runtime (processFiles), made when first needed. */
  readonly files?: FilesRuntime
}

export function createEmailInRuntime(options: EmailInRuntimeOptions): EmailInRuntime {
  return Object.freeze({
    raw: rawMailStorage(options.gateway, { s3: options.s3 ?? inboundS3Store(), fake: options.fake }),
    fake: options.fake,
    files: () => options.files ?? processFiles(),
  })
}

let configured: EmailInRuntime | undefined
let fromEnv: EmailInRuntime | undefined

export function useEmailIn(runtime: EmailInRuntime | undefined): void {
  configured = runtime
}

export function processEmailIn(): EmailInRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    const environmentCredentials =
      env.FACTORY_AWS_ACCESS_KEY_ID && env.FACTORY_AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.FACTORY_AWS_ACCESS_KEY_ID, secretAccessKey: env.FACTORY_AWS_SECRET_ACCESS_KEY } : undefined
    fromEnv = createEmailInRuntime({ gateway: processGateway(), fake: local ? new FakeMailBucket() : null, s3: inboundS3Store({ environmentCredentials }) })
  }
  return fromEnv
}
