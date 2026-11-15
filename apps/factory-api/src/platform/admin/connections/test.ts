import type { Prisma } from '@nexus/factory-db'
import { INTEGRATIONS_MANAGE, INTEGRATIONS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { TEST_OPERATION } from '@nexus/factory-domain/integration-health/errors'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { processEcb } from '../../currency/feed'
import { GatewayCallFailed, GatewayRefusal, gatewayAccount, type GatewayCall } from '../../gateway/gateway'
import { GatewayLimits } from '../../gateway/limits'
import { processGateway } from '../../gateway/service'
import { processHealthRedis } from '../jobs/redis'

/**
 * Test and Reconnect of a connection (B-W2b-415; PLT-196; design admin.connections pop:test, the record's Overview › State
 * "Test · Pause · Resume"): ONE harmless call through the gateway (platform/gateway/gateway.ts), so it passes the same
 * steps as every call — the account read again, its mode, its kill switch, its circuit, its rate limit — and leaves its one
 * ledger row (IntegrationCall) and the account's last OK or last error, which the Connections page shows.
 *
 *   FAKE accounts      the call answers from the factory's own fake: no network, nothing leaves the factory (local, test)
 *   ECB (live)         the ECB's daily rates file is read (a public file; nothing is kept by the test)
 *   other live / test  held with why until the service's adapter has a harmless read (NO_PROBE): never a call that sends
 *
 * Reconnect first forgets the failures in a row of the account's circuit (the gateway's Redis state; an open circuit
 * closes), audited as integration.reconnectAccount, then makes the same test call. A paused account is resumed by Resume,
 * never by Reconnect (held). integrations.manage over the account's company; a tenant-wide account over every active
 * company. The outcome is audited (integration.testAccount) with the event integration.account_tested. A test call is never
 * an item of the error queue (operation `connection.test`).
 */

type Client = Prisma.TransactionClient

export type TestOutcome = 'OK' | 'FAILED' | 'REFUSED'
export type TestHeld = 'DISABLED' | 'PAUSED' | 'NO_PROBE'

export interface TestAnswer {
  readonly accountId: string
  readonly outcome: TestOutcome
  /** The gateway's reason code (`account_paused`, `circuit_open`, `timeout`, `provider_error` …), null when OK. */
  readonly reason: string | null
  /** The provider's (scrubbed) message, when it failed. */
  readonly message: string | null
  readonly httpStatus: number | null
  readonly durationMs: number
  /** The account answered from the factory's own fake (nothing left the factory). */
  readonly fake: boolean
  readonly reconnected: boolean
  /** The circuit as it stood before the test: failures in a row, and until when it was rested. */
  readonly circuitBefore: { readonly failures: number; readonly openUntil: string | null } | null
  readonly testedAt: string
}

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

const ACCOUNT = {
  id: true,
  companyId: true,
  provider: true,
  mode: true,
  status: true,
  rateLimitPerMinute: true,
  rateLimitBurst: true,
  circuitFailureThreshold: true,
  circuitCooldownSeconds: true,
} as const satisfies Prisma.IntegrationAccountSelect
type AccountRow = Prisma.IntegrationAccountGetPayload<{ select: typeof ACCOUNT }>

async function readAccount(caller: CommandCaller, client: Client, accountId: string): Promise<AccountRow> {
  const who = actorOf(contextOf(caller))
  const row = isUuid(accountId) ? await client.integrationAccount.findUnique({ where: { id: accountId }, select: ACCOUNT }) : null
  if (!row || !can(who, INTEGRATIONS_VIEW, row.companyId ? { companyId: row.companyId } : {})) throw new NotFoundError('Connection not found.')
  if (row.companyId) {
    if (!can(who, INTEGRATIONS_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
    return row
  }
  const companies = await client.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  if (!can(who, INTEGRATIONS_MANAGE, {}) || companies.some((company) => !can(who, INTEGRATIONS_MANAGE, { companyId: company.id }))) throw new ForbiddenError()
  return row
}

/** Why a test (or Reconnect) is held for this account, or null. */
export function testHeldOf(account: Pick<AccountRow, 'status' | 'mode' | 'provider'>, reconnect: boolean): TestHeld | null {
  if (account.status === 'DISABLED') return 'DISABLED'
  if (reconnect && account.status === 'PAUSED') return 'PAUSED'
  if (account.mode !== 'FAKE' && account.provider !== 'ECB') return 'NO_PROBE'
  return null
}

const HELD_WORDS: Readonly<Record<TestHeld, string>> = Object.freeze({
  DISABLED: 'This connection is disabled: it is not called any more.',
  PAUSED: 'This connection is paused: resume it first; Reconnect never switches a paused connection on.',
  NO_PROBE: "This service has no harmless test call yet: its next real call shows whether it works (last OK and last error).",
})

/** The circuit as the gateway's Redis holds it (limits.ts: `<prefix>:gateway:circuit:<accountId>`), read only. */
async function circuitOf(accountId: string): Promise<TestAnswer['circuitBefore']> {
  try {
    const { redis, prefix } = processHealthRedis()
    const [failures, openUntil] = await redis.hmget(`${prefix}:gateway:circuit:${accountId}`, 'failures', 'openUntil')
    const until = Number(openUntil ?? 0)
    return { failures: Number(failures ?? 0), openUntil: until > Date.now() ? toUtcIso(new Date(until)) : null }
  } catch {
    return null
  }
}

/** The one harmless call through the gateway. */
async function testCall(caller: CommandCaller, account: AccountRow): Promise<Omit<TestAnswer, 'reconnected' | 'circuitBefore' | 'testedAt'>> {
  const started = Date.now()
  const base = { accountId: account.id, fake: account.mode === 'FAKE' }
  try {
    if (account.mode !== 'FAKE' && account.provider === 'ECB') {
      const outcome = await processEcb().read(caller, account.id)
      if (!outcome.ok) return { ...base, outcome: 'FAILED', reason: 'provider_error', message: String(outcome.problem ?? 'The ECB file could not be read.').slice(0, 500), httpStatus: null, durationMs: Date.now() - started }
      return { ...base, outcome: 'OK', reason: null, message: null, httpStatus: 200, durationMs: Date.now() - started }
    }
    await processGateway().call(gatewayAccount(caller, account.id), { name: TEST_OPERATION, idempotent: true, maxAttempts: 1, request: { test: true } }, async (call: GatewayCall) => {
      call.answer({ httpStatus: 200, response: { fake: true } })
      return true
    })
    return { ...base, outcome: 'OK', reason: null, message: null, httpStatus: 200, durationMs: Date.now() - started }
  } catch (error) {
    if (error instanceof GatewayRefusal) return { ...base, outcome: 'REFUSED', reason: error.reason, message: error.message, httpStatus: null, durationMs: Date.now() - started }
    if (error instanceof GatewayCallFailed) return { ...base, outcome: 'FAILED', reason: error.kind === 'timeout' ? 'timeout' : error.kind, message: error.message.slice(0, 500), httpStatus: error.httpStatus, durationMs: Date.now() - started }
    throw error
  }
}

/** POST /integrations/accounts/:id/test (reconnect false) and …/reconnect (true). */
export async function testAccount(caller: CommandCaller, accountId: string, options: { readonly reconnect: boolean; readonly idempotencyKey?: string | undefined }): Promise<TestAnswer> {
  const account = await caller.withClient((client) => readAccount(caller, client, accountId))
  const held = testHeldOf(account, options.reconnect)
  if (held) throw new InvalidStateError(HELD_WORDS[held])
  const circuitBefore = await circuitOf(account.id)
  if (options.reconnect) {
    await command(caller, { name: 'integration.reconnectAccount', idempotencyKey: options.idempotencyKey, input: { accountId } }, async (tools) => {
      tools.audit({ recordType: 'IntegrationAccount', recordId: account.id, companyId: account.companyId, before: { circuit: circuitBefore }, after: { circuit: 'closed' } })
      try {
        const { redis, prefix } = processHealthRedis()
        await new GatewayLimits(redis, prefix).succeeded(account)
      } catch {
        throw new ApiError('not_ready', "The gateway's limits (Redis) cannot be reached right now: nothing was changed. Try again in a moment.")
      }
      return { closed: true }
    })
  }
  const answer = await testCall(caller, account)
  const { result } = await command(caller, { name: 'integration.testAccount', input: { accountId, reconnect: options.reconnect } }, async (tools) => {
    tools.audit({ recordType: 'IntegrationAccount', recordId: account.id, companyId: account.companyId, after: { outcome: answer.outcome, reason: answer.reason, reconnect: options.reconnect } })
    tools.emit({ type: 'integration.account_tested', subject: account.id, companyId: account.companyId, payload: { accountId: account.id, outcome: answer.outcome, reconnect: options.reconnect } })
    return { ...answer, reconnected: options.reconnect, circuitBefore, testedAt: toUtcIso(tools.now) }
  })
  return result
}
