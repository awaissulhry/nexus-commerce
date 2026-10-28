import type { Redis } from 'ioredis'
import type { IntegrationCallStatus, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Clock } from '@nexus/factory-domain/ports/clock'
import type { AdapterAccount, OperationDescriptor } from '@nexus/factory-domain/ports/provider'
import type { CommandCaller } from '../../core/command'
import type { Log } from '../../core/queue'
import { serverClock } from '../../core/time'
import type { FactoryEnv } from '../../env'
import type { SecretsService } from '../secrets/envelope'
import { readSecret, SECRET_PURPOSES } from '../secrets/store'
import { GatewayLimits, type AccountLimits } from './limits'
import { ledgerSummary, scrubText, secretStrings } from './redact'

/**
 * The ONE way factory code calls an outside service (plan A1 §4 "integrationCall()"; feature PLT-195; Commerce hard
 * rule 4, for the factory). `scripts/factory/check-integration-calls.mjs` holds HTTP clients and provider SDKs to this
 * folder and src/adapters/. Every call runs the same steps, in this order:
 *
 *   1. caller    an office session or the system context (worker, scheduler, the inbound route); floor and partner
 *                sessions never call a provider (their work runs as a job)
 *   2. account   read again now, in the caller's scope (RLS: only its tenant's accounts), so a kill switch acts at once
 *   3. mode      a FAKE account is refused with FACTORY_ENV=production (and the API does not start with one: boot.ts)
 *   4. status    only ACTIVE is called; PAUSED (the kill switch) and DISABLED are refused
 *   5. circuit   after `circuitFailureThreshold` failed calls in a row the account is not called for the cool-down;
 *                then one trial call decides (limits.ts)
 *   6. rate      one token from the account's bucket; out of tokens the call waits up to `maxRateWaitMs`, then is
 *                refused as rate_limited (a job retries later)
 *   7. call      `fn` with an AbortSignal and the account's timeout per attempt. A timeout, a network error, a 429 or
 *                a 5xx is retried with a growing wait ONLY for an idempotent operation; anything else is final
 *   8. ledger    exactly ONE IntegrationCall row per call, whatever happened: account, operation, request id,
 *                idempotency key, start, end, latency, attempts, status, HTTP status, summaries with secrets and
 *                personal data removed (redact.ts). A ledger write that fails is logged and never fails the call
 *   9. health    the account's lastOkAt (at most a minute stale) and lastError, for the Connections page
 *
 * A refusal (steps 1–6: nothing was sent) throws GatewayRefusal after its ledger row; a failed call throws
 * GatewayCallFailed after its row. Redis down: refused (gateway_unavailable), never called without its limits.
 * Never call the gateway inside a command's transaction: the call may take seconds, and its ledger row commits on its
 * own.
 *
 *   const account = gatewayAccount(caller, accountId)
 *   const sent = await processGateway().call(account, { name: 'mail.send', idempotent: true, idempotencyKey }, async (call) => {
 *     const { apiKey } = await call.credentials<{ apiKey: string }>()
 *     const answer = await client.send(…, { signal: call.signal })
 *     call.answer({ httpStatus: 200, response: { messageId: answer.id } })
 *     return answer.id
 *   })
 */

/** The account a call is made for, and the caller whose scope reads it and writes the ledger row. */
export interface GatewayAccount {
  readonly caller: CommandCaller
  readonly id: string
}

/** The account `accountId`, for `caller` (an office request, or a job's system caller). */
export function gatewayAccount(caller: CommandCaller, accountId: string): GatewayAccount {
  return { caller, id: accountId }
}

export interface GatewayOperation extends OperationDescriptor {
  /** The provider idempotency key the call sends (recorded on the ledger row). */
  readonly idempotencyKey?: string | null
  /** Attempts for an idempotent operation (default 3); a non-idempotent one is tried once. */
  readonly maxAttempts?: number
  /** How long the call may wait for a rate-limit token (default: the gateway's, 2 s). */
  readonly maxRateWaitMs?: number
  /** What was asked, for the ledger (redacted; never the credentials). */
  readonly request?: unknown
}

/** What `fn` gets for one attempt. */
export interface GatewayCall {
  readonly account: AdapterAccount
  /** 1 for the first attempt. */
  readonly attempt: number
  /** Aborted at the attempt's timeout: pass it to the HTTP client. */
  readonly signal: AbortSignal
  readonly idempotencyKey: string | null
  /** The account's credentials (its sealed JSON), opened once per call; null when the account has none. */
  credentials<T = Record<string, unknown>>(): Promise<T | null>
  /** The provider's HTTP status and answer of this attempt, for the ledger (redacted before it is stored). */
  answer(details: { readonly httpStatus?: number; readonly response?: unknown }): void
}

/** Why a call was refused before anything was sent. */
export type RefusalReason =
  | 'fake_in_production'
  | 'account_paused'
  | 'account_disabled'
  | 'circuit_open'
  | 'rate_limited'
  | 'gateway_unavailable'

/** Nothing was sent. `retryAfterMs`: when a retry may pass (rate limit, open circuit). */
export class GatewayRefusal extends Error {
  override name = 'GatewayRefusal'
  constructor(
    readonly reason: RefusalReason,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

/** A provider's error answer, thrown by `fn`. Retryable by default for a 429, a 5xx or no status at all. */
export class ProviderError extends Error {
  override name = 'ProviderError'
  readonly httpStatus: number | null
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly response: unknown
  constructor(message: string, options: { httpStatus?: number; retryable?: boolean; retryAfterMs?: number; response?: unknown } = {}) {
    super(message)
    this.httpStatus = options.httpStatus ?? null
    this.retryable = options.retryable ?? (this.httpStatus === null || this.httpStatus === 429 || this.httpStatus >= 500)
    this.retryAfterMs = options.retryAfterMs ?? null
    this.response = options.response
  }
}

export type FailureKind = 'timeout' | 'provider_error' | 'network_error'

/** The call reached (or tried to reach) the provider and failed. The message holds no secret value. */
export class GatewayCallFailed extends Error {
  override name = 'GatewayCallFailed'
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null,
    readonly attempts: number,
  ) {
    super(message)
  }
}

export interface GatewaySettings {
  readonly environment: FactoryEnv['FACTORY_ENV']
  readonly clock: Clock
  /** Waits (tests pass one that does not). */
  readonly sleep: (ms: number) => Promise<void>
  /** The first retry wait, doubled after each attempt, at most retryMaxMs. */
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly maxRateWaitMs: number
  /** The longest wait for one Redis step. */
  readonly redisTimeoutMs: number
  /** lastOkAt is written at most this often per account. */
  readonly healthEveryMs: number
  readonly log?: Log
}

export const GATEWAY_SETTINGS: Omit<GatewaySettings, 'environment'> = Object.freeze({
  clock: serverClock,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  retryBaseMs: 250,
  retryMaxMs: 5_000,
  maxRateWaitMs: 2_000,
  redisTimeoutMs: 2_000,
  healthEveryMs: 60_000,
})

export interface GatewayOptions extends Partial<Omit<GatewaySettings, 'environment'>> {
  readonly environment: FactoryEnv['FACTORY_ENV']
  /** Redis for the rate limits and the circuit breaker. */
  readonly redis: Redis
  /** FACTORY_QUEUE_PREFIX: every key sits under it. */
  readonly prefix: string
  /** Opens the accounts' credentials. */
  readonly secrets: SecretsService
}

export interface Gateway {
  call<T>(account: GatewayAccount, operation: GatewayOperation, fn: (call: GatewayCall) => Promise<T>): Promise<T>
}

const OPERATION = /^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)+$/

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  companyId: true,
  provider: true,
  mode: true,
  status: true,
  settings: true,
  credentialsSecretId: true,
  rateLimitPerMinute: true,
  rateLimitBurst: true,
  callTimeoutMs: true,
  circuitFailureThreshold: true,
  circuitCooldownSeconds: true,
  lastOkAt: true,
  lastErrorAt: true,
} as const

class AttemptTimeout extends Error {
  override name = 'AttemptTimeout'
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

interface Outcome {
  status: IntegrationCallStatus
  reason: string | null
  httpStatus: number | null
  response: unknown
  error: string | null
  attempts: number
}

export function createGateway(options: GatewayOptions): Gateway {
  const settings: GatewaySettings = { ...GATEWAY_SETTINGS, ...options }
  const limits = new GatewayLimits(options.redis, options.prefix)
  const redisStep = <T>(work: Promise<T>): Promise<T> =>
    withTimeout(work, settings.redisTimeoutMs, () => new Error(`Redis did not answer within ${settings.redisTimeoutMs} ms`))

  async function call<T>(account: GatewayAccount, operation: GatewayOperation, fn: (call: GatewayCall) => Promise<T>): Promise<T> {
    if (typeof operation?.name !== 'string' || !OPERATION.test(operation.name)) {
      throw new Error(`Gateway operation ${JSON.stringify(operation?.name)} is not <area>.<action>.`)
    }
    const context = account.caller.factoryContext
    if (!context || (context.audience !== 'office' && context.audience !== 'system')) {
      throw new ForbiddenError('Outside services are called by office sessions and the system only.')
    }
    if (!isUuid(account.id)) throw new NotFoundError('Integration account not found.')
    const startedAt = settings.clock.now()
    const row = await account.caller.withClient((client) => client.integrationAccount.findUnique({ where: { id: account.id }, select: ACCOUNT_SELECT }))
    if (!row) throw new NotFoundError('Integration account not found.')
    const limitsOf: AccountLimits = row
    const idempotencyKey = operation.idempotencyKey ?? null
    let secretValues: string[] = []

    async function ledger(outcome: Outcome): Promise<void> {
      const finishedAt = settings.clock.now()
      const data: Prisma.IntegrationCallUncheckedCreateInput = {
        id: newId(),
        companyId: row!.companyId,
        accountId: row!.id,
        provider: row!.provider,
        mode: row!.mode,
        operation: operation.name,
        requestId: context!.requestId,
        idempotencyKey,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        attempts: outcome.attempts,
        status: outcome.status,
        reason: outcome.reason,
        httpStatus: outcome.httpStatus,
        requestSummary: ledgerSummary(operation.request, secretValues),
        responseSummary: ledgerSummary(outcome.response, secretValues),
        error: outcome.error === null ? null : scrubText(outcome.error, secretValues).slice(0, 1_000),
      }
      try {
        await account.caller.withClient((client) => client.integrationCall.create({ data, select: { id: true } }))
      } catch (error) {
        settings.log?.error({ err: error, accountId: row!.id, operation: operation.name }, 'gateway ledger row not written')
      }
    }

    /** Records the account's health for the Connections page; best effort, never fails the call. */
    async function health(data: { lastOkAt?: Date; lastErrorAt?: Date; lastError?: string }): Promise<void> {
      try {
        await account.caller.withClient((client) => client.integrationAccount.updateMany({ where: { id: row!.id }, data }))
      } catch (error) {
        settings.log?.warn({ err: error, accountId: row!.id }, 'gateway account health not recorded')
      }
    }

    async function refuse(reason: RefusalReason, message: string, retryAfterMs: number | null = null): Promise<never> {
      await ledger({ status: 'REFUSED', reason, httpStatus: null, response: undefined, error: null, attempts: 0 })
      throw new GatewayRefusal(reason, message, retryAfterMs)
    }

    if (row.mode === 'FAKE' && settings.environment === 'production') {
      await refuse('fake_in_production', 'This account is in FAKE mode, which production never calls.')
    }
    if (row.status === 'PAUSED') await refuse('account_paused', 'This account is paused: no call is sent until it is switched on again.')
    if (row.status === 'DISABLED') await refuse('account_disabled', 'This account is disabled.')

    let probe = false
    try {
      const circuit = await redisStep(limits.check(limitsOf, settings.clock.now().getTime()))
      if (!circuit.allowed) {
        await refuse('circuit_open', 'This account failed several calls in a row; it is rested before the next try.', circuit.retryAfterMs)
      }
      probe = circuit.probe
      const maxWait = operation.maxRateWaitMs ?? settings.maxRateWaitMs
      let take = await redisStep(limits.take(limitsOf, settings.clock.now().getTime()))
      if (!take.allowed && take.waitMs <= maxWait) {
        await settings.sleep(take.waitMs)
        take = await redisStep(limits.take(limitsOf, settings.clock.now().getTime()))
      }
      if (!take.allowed) await refuse('rate_limited', "This account's rate limit is reached; try again later.", take.waitMs)
    } catch (error) {
      if (error instanceof GatewayRefusal) throw error
      settings.log?.error({ err: error, accountId: row.id }, 'gateway limits unavailable')
      await refuse('gateway_unavailable', 'The gateway cannot check its limits right now (Redis); nothing was sent.')
    }

    let opened: Record<string, unknown> | null | undefined
    const credentials = async <C>(): Promise<C | null> => {
      if (opened === undefined) {
        if (!row.credentialsSecretId) opened = null
        else {
          const text = await account.caller.withClient((client) =>
            readSecret(client, options.secrets, { id: row.credentialsSecretId!, tenantId: row.tenantId, purpose: SECRET_PURPOSES.credentials }),
          )
          opened = JSON.parse(text) as Record<string, unknown>
          secretValues = secretStrings(opened)
        }
      }
      return opened as C | null
    }

    const adapterAccount: AdapterAccount = Object.freeze({
      id: row.id,
      tenantId: row.tenantId,
      companyId: row.companyId,
      provider: row.provider,
      mode: row.mode,
      settings: row.settings,
    })
    const maxAttempts = operation.idempotent ? Math.min(10, Math.max(1, operation.maxAttempts ?? 3)) : 1
    const timeoutMs = operation.timeoutMs ?? row.callTimeoutMs
    let answered: { httpStatus?: number; response?: unknown } = {}
    let last: { kind: FailureKind; retryable: boolean; httpStatus: number | null; message: string; response: unknown; retryAfterMs: number | null } | null = null
    let attempt = 0
    let result: T | undefined
    let succeeded = false

    while (attempt < maxAttempts) {
      attempt++
      answered = {}
      const controller = new AbortController()
      try {
        result = await withTimeout(
          fn({
            account: adapterAccount,
            attempt,
            signal: controller.signal,
            idempotencyKey,
            credentials,
            answer: (details) => {
              answered = { ...details }
            },
          }),
          timeoutMs,
          () => {
            controller.abort()
            return new AttemptTimeout(`no answer within ${timeoutMs} ms`)
          },
        )
        succeeded = true
        break
      } catch (error) {
        if (error instanceof AttemptTimeout) {
          last = { kind: 'timeout', retryable: true, httpStatus: null, message: error.message, response: undefined, retryAfterMs: null }
        } else if (error instanceof ProviderError) {
          last = {
            kind: 'provider_error',
            retryable: error.retryable,
            httpStatus: error.httpStatus ?? answered.httpStatus ?? null,
            message: error.message,
            response: error.response ?? answered.response,
            retryAfterMs: error.retryAfterMs,
          }
        } else {
          last = { kind: 'network_error', retryable: true, httpStatus: null, message: `${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? String(error)}`, response: undefined, retryAfterMs: null }
        }
        if (!last.retryable || attempt >= maxAttempts) break
        const backoff = Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** (attempt - 1))
        await settings.sleep(Math.min(settings.retryMaxMs, Math.max(backoff, last.retryAfterMs ?? 0)))
      }
    }

    const nowMs = settings.clock.now().getTime()
    // The circuit counts the provider's health: a 4xx is an answer (the provider is up), a 5xx, 429, timeout or
    // network error is not.
    const healthy = succeeded || (last?.kind === 'provider_error' && last.httpStatus !== null && last.httpStatus !== 429 && last.httpStatus < 500)
    try {
      if (healthy) await redisStep(limits.succeeded(limitsOf))
      else await redisStep(limits.failed(limitsOf, nowMs, probe))
    } catch (error) {
      settings.log?.warn({ err: error, accountId: row.id }, 'gateway circuit not updated')
    }

    if (succeeded) {
      await ledger({ status: 'SUCCEEDED', reason: null, httpStatus: answered.httpStatus ?? null, response: answered.response, error: null, attempts: attempt })
      const stale = !row.lastOkAt || nowMs - row.lastOkAt.getTime() >= settings.healthEveryMs || (row.lastErrorAt !== null && row.lastErrorAt > row.lastOkAt)
      if (stale) await health({ lastOkAt: new Date(nowMs) })
      return result as T
    }
    const failure = last!
    const message = scrubText(failure.message, secretValues).slice(0, 500)
    await ledger({
      status: failure.kind === 'timeout' ? 'TIMED_OUT' : 'FAILED',
      reason: failure.kind === 'timeout' ? 'timeout' : failure.kind,
      httpStatus: failure.httpStatus,
      response: failure.response,
      error: message,
      attempts: attempt,
    })
    await health({ lastErrorAt: new Date(nowMs), lastError: `${operation.name}: ${message}`.slice(0, 500) })
    throw new GatewayCallFailed(failure.kind, `${operation.name} failed after ${attempt} attempt(s): ${message}`, failure.retryable, failure.httpStatus, attempt)
  }

  return Object.freeze({ call })
}
