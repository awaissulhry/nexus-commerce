import { readFactoryVariables } from '../../../env'
import { vapidProblem, type PushRequest, type VapidKeys } from './web-push'

/**
 * The process's push runtime (B-W2b-385; PLT-140): the server's VAPID keys (the environment's secrets, never a table) and the
 * transport that hands a request to the push service.
 *
 * Every outside call of the factory goes through the gateway (platform/gateway: account, rate limit, circuit, one
 * IntegrationCall row), and the gateway needs an IntegrationAccount of the provider — there is no Web Push provider yet
 * (IntegrationProvider has no WEB_PUSH: a schema need named in this step's notes). So push runs on the FAKE push service only:
 * locally and in tests a mailbox in memory that records each request exactly as the push service would get it (encrypted,
 * signed) and answers 201, or what a test tells it; in staging and production there is no transport and push says it is not
 * connected yet (`available` false with why: nothing pretends to reach a phone). The real transport is an adapter
 * (src/adapters/web-push) behind the gateway once the provider exists; the requests are already made for it (web-push.ts).
 */

export interface PushTransport {
  /** Hands one request to the push service; the HTTP status it answered. */
  send(request: PushRequest): Promise<number>
}

/** The FAKE push service (local and test only): every request kept in memory; answers 201 unless told otherwise per endpoint. */
export class FakePushService implements PushTransport {
  readonly sent: PushRequest[] = []
  private readonly answers = new Map<string, number>()

  /** The status this endpoint answers from now on (404 or 410: the subscription is gone; 500: a failure). */
  answer(endpoint: string, status: number): void {
    this.answers.set(endpoint, status)
  }

  async send(request: PushRequest): Promise<number> {
    const status = this.answers.get(request.endpoint) ?? 201
    if (status >= 200 && status < 300) this.sent.push(request)
    return status
  }
}

export interface PushRuntime {
  /** The VAPID keys, or null with why push is not available (the screen holds "Turn on push" with it). */
  readonly vapid: VapidKeys | null
  readonly transport: PushTransport | null
  /** Why push cannot be used here, in words; null: it can. */
  readonly unavailable: string | null
}

export function createPushRuntime(options: { readonly vapid: VapidKeys | null; readonly transport: PushTransport | null }): PushRuntime {
  const keyProblem = options.vapid ? vapidProblem(options.vapid) : 'Push needs the server’s VAPID keys (FACTORY_VAPID_PUBLIC_KEY, FACTORY_VAPID_PRIVATE_KEY, FACTORY_VAPID_SUBJECT).'
  const unavailable = keyProblem ?? (options.transport ? null : 'Push to phones is not connected yet: the push service account comes with a later step.')
  return Object.freeze({ vapid: keyProblem ? null : options.vapid, transport: options.transport, unavailable })
}

let configured: PushRuntime | undefined
let fromEnv: PushRuntime | undefined

/** Tests: the runtime to use (undefined: the environment's again). */
export function usePush(runtime: PushRuntime | undefined): void {
  configured = runtime
}

/**
 * The environment's runtime. Only its own variables are read (env.ts readFactoryVariables: apps/factory-api/.env and the
 * process, FACTORY_ only): the API, the worker and the scheduler validated the whole configuration at boot already, and a test
 * process that runs a fan-out without the rest of it (no Redis URL) gets push "not available" instead of a crash. The VAPID
 * keys are checked by createPushRuntime (a pair whose halves belong together, and a subject).
 */
export function processPush(): PushRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = readFactoryVariables()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    const vapid = env.FACTORY_VAPID_PUBLIC_KEY && env.FACTORY_VAPID_PRIVATE_KEY && env.FACTORY_VAPID_SUBJECT ? { publicKey: env.FACTORY_VAPID_PUBLIC_KEY, privateKey: env.FACTORY_VAPID_PRIVATE_KEY, subject: env.FACTORY_VAPID_SUBJECT } : null
    fromEnv = createPushRuntime({ vapid, transport: local ? new FakePushService() : null })
  }
  return fromEnv
}
