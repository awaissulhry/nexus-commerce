import { FakeSes } from '../../adapters/ses/fake'
import { sesMailAdapter } from '../../adapters/ses/ses'
import { loadFactoryEnv } from '../../env'
import type { Gateway } from '../gateway/gateway'
import { processGateway } from '../gateway/service'
import type { MailAdapter } from './port'
import { mailStorage, type MailStorage } from './store'

/**
 * The process's email runtime: the mail store behind the gateway (store.ts), the fake mailbox of FAKE SES accounts (local
 * and test only; none in staging or production), and the web origin the privacy-notice slot and sign-in links point at.
 * Made on first use from apps/factory-api/.env and the process gateway; tests set their own with
 * useEmail(createEmailRuntime({ … })), like useGateway() and useFiles().
 */

export interface EmailRuntime {
  readonly mail: MailStorage
  /** The mailbox of FAKE accounts, or null (staging and production). */
  readonly fake: FakeSes | null
  /** FACTORY_WEB_ORIGIN: the privacy notice's address (footer). */
  readonly webOrigin: string
}

export interface EmailRuntimeOptions {
  readonly gateway: Gateway
  readonly fake: FakeSes | null
  readonly webOrigin: string
  /** Default: the real SES adapter. Tests pass one on a fake transport. */
  readonly ses?: MailAdapter
}

export function createEmailRuntime(options: EmailRuntimeOptions): EmailRuntime {
  return Object.freeze({
    mail: mailStorage(options.gateway, { ses: options.ses ?? sesMailAdapter(), fake: options.fake }),
    fake: options.fake,
    webOrigin: options.webOrigin.replace(/\/+$/, ''),
  })
}

let configured: EmailRuntime | undefined
let fromEnv: EmailRuntime | undefined

export function useEmail(runtime: EmailRuntime | undefined): void {
  configured = runtime
}

export function processEmail(): EmailRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    const environmentCredentials =
      env.FACTORY_AWS_ACCESS_KEY_ID && env.FACTORY_AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.FACTORY_AWS_ACCESS_KEY_ID, secretAccessKey: env.FACTORY_AWS_SECRET_ACCESS_KEY } : undefined
    fromEnv = createEmailRuntime({
      gateway: processGateway(),
      fake: local ? new FakeSes() : null,
      webOrigin: env.FACTORY_WEB_ORIGIN,
      ses: sesMailAdapter({ environmentCredentials }),
    })
  }
  return fromEnv
}
