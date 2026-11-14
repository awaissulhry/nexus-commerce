import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { CURRENCIES_MANAGE } from '@nexus/factory-domain/money/currency/permissions'
import { ECB_DAILY_OPERATION, type EcbDay } from '@nexus/factory-domain/money/currency/ecb'
import { rateKey } from '@nexus/factory-domain/money/currency/rates'
import { FakeEcb } from '../../adapters/ecb/fake'
import { ecbHttpAdapter } from '../../adapters/ecb/http'
import type { EcbAdapter } from '../../adapters/ecb/port'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { loadFactoryEnv } from '../../env'
import { gatewayAccount, GatewayCallFailed, GatewayRefusal, ProviderError, type Gateway } from '../gateway/gateway'
import { processGateway } from '../gateway/service'
import { activeTenants, asSystem, systemContext } from '../outbox/system'
import { assertOnEveryCompany, dayValue, officeOf, refused, refusingInWords, type Reader } from './store'

/**
 * The daily ECB reference rates (B-W2b-389; PLT-133; design finance.settings "Currencies & rates": daily ECB rates).
 *
 *   the switch   the daily ECB rates are ON while the tenant has an ACTIVE tenant-wide integration account of provider ECB
 *                (Admin › Connections shows it, and its kill switch pauses it too). None by default: OFF until a person
 *                switches them on (Owner 11-13: nothing runs by itself unless switched on). Switching on makes the account
 *                (FAKE in local and test, where nothing leaves the process; LIVE elsewhere: the ECB's free public file) or
 *                resumes it; switching off pauses it. A role over every company (the rates serve every company).
 *   a read       ONE gateway call `ecb.daily_rates` outside any transaction (rate limit, circuit, retries of what may pass
 *                later, one IntegrationCall row) through the account's adapter (FAKE → adapters/ecb/fake.ts; LIVE and
 *                SANDBOX → adapters/ecb/http.ts), then ONE command `currency.readEcb`: the ECB rows of the file's days that
 *                are not kept yet (ECB rows never change: a day read twice adds nothing), its audit row and
 *                currency.rates_changed when anything was added. A file that cannot be read keeps nothing (the rates
 *                kept stay) and says why.
 *   the job      the scheduler's cron `currency.ecbDaily` (16:30 and 18:30 Europe/Rome, Monday to Friday: the ECB publishes
 *                at about 16:00 CET) reads the file for every tenant whose switch is on, in its system context. A day
 *                with no new rate adds nothing. "Read today's rates" in the screen does the same at once.
 */

export const ECB_ACCOUNT_CODE = 'ecb'

// ---- the runtime ---------------------------------------------------------------------------------------------------------

export type EcbOutcome = { readonly ok: true; readonly days: readonly EcbDay[] } | { readonly ok: false; readonly problem: string }

export interface EcbRuntime {
  /** One read through the gateway for the account; the ECB's or the gateway's failures are an outcome, never a throw. */
  read(caller: CommandCaller, accountId: string): Promise<EcbOutcome>
  /** The FAKE adapter of this process (local and test), or null: a new account is then LIVE. */
  readonly fake: FakeEcb | null
}

export function createEcbRuntime(options: { readonly gateway: Gateway; readonly fake: FakeEcb | null; readonly remote?: EcbAdapter }): EcbRuntime {
  const remote = options.remote ?? ecbHttpAdapter()
  return Object.freeze({
    fake: options.fake,
    async read(caller: CommandCaller, accountId: string): Promise<EcbOutcome> {
      try {
        const answer = await options.gateway.call(gatewayAccount(caller, accountId), { ...ECB_DAILY_OPERATION, request: { file: 'daily' } }, async (call) => {
          if (call.account.provider !== 'ECB') throw new ProviderError('This account is not an ECB account.', { retryable: false })
          if (call.account.mode !== 'FAKE') return remote.daily(call)
          if (!options.fake) throw new ProviderError('A FAKE ECB account needs the fake ECB file, which this environment does not have.', { retryable: false })
          return options.fake.daily(call)
        })
        return { ok: true, days: answer.days }
      } catch (thrown) {
        if (thrown instanceof GatewayRefusal) return { ok: false, problem: thrown.message }
        if (thrown instanceof GatewayCallFailed) return { ok: false, problem: thrown.message }
        throw thrown
      }
    },
  } satisfies EcbRuntime)
}

let configured: EcbRuntime | undefined
let fromEnv: EcbRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function useEcb(runtime: EcbRuntime | undefined): void {
  configured = runtime
}

export function processEcb(): EcbRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createEcbRuntime({ gateway: processGateway(), fake: local ? new FakeEcb() : null })
  }
  return fromEnv
}

// ---- the switch ----------------------------------------------------------------------------------------------------------

const ACCOUNT_COLUMNS = { id: true, code: true, mode: true, status: true, lastOkAt: true, lastErrorAt: true, lastError: true, version: true } as const

/** The tenant-wide ECB account (the one in use when several exist), or null. */
export async function ecbAccountOf(db: Reader) {
  const rows = await db.integrationAccount.findMany({ where: { provider: 'ECB', companyId: null }, select: ACCOUNT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return rows.find((row) => row.status === 'ACTIVE') ?? rows.find((row) => row.status === 'PAUSED') ?? rows[0] ?? null
}

export interface FeedView {
  readonly on: boolean
  readonly status: 'NONE' | 'ACTIVE' | 'PAUSED' | 'DISABLED'
  readonly mode: 'LIVE' | 'SANDBOX' | 'FAKE' | null
  readonly accountId: string | null
  readonly lastOkAt: string | null
  readonly lastErrorAt: string | null
  readonly lastError: string | null
  /** The newest day of an ECB rate kept. */
  readonly lastEcbDay: BusinessDate | null
}

export async function feedOf(db: Reader): Promise<FeedView> {
  const account = await ecbAccountOf(db)
  const newest = await db.exchangeRate.findFirst({ where: { source: 'ECB' }, select: { rateDate: true }, orderBy: { rateDate: 'desc' } })
  return {
    on: account?.status === 'ACTIVE',
    status: (account?.status ?? 'NONE') as FeedView['status'],
    mode: (account?.mode ?? null) as FeedView['mode'],
    accountId: account?.id ?? null,
    lastOkAt: account?.lastOkAt ? toUtcIso(account.lastOkAt) : null,
    lastErrorAt: account?.lastErrorAt ? toUtcIso(account.lastErrorAt) : null,
    lastError: account?.lastError ?? null,
    lastEcbDay: newest ? newest.rateDate.toISOString().slice(0, 10) : null,
  }
}

/**
 * PUT /exchange-rates/feed {on}: switches the daily ECB rates on (the tenant-wide ECB account made, or resumed) or off
 * (paused). currencies.manage over every company. Switching to what it is already changes nothing (200, no command).
 */
export async function switchFeed(caller: CommandCaller, body: { readonly on: boolean }, idempotencyKey?: string): Promise<{ feed: FeedView }> {
  const context = officeOf(caller)
  assertOnEveryCompany(context, CURRENCIES_MANAGE)
  const fake = processEcb().fake !== null
  const to = body.on ? 'ACTIVE' : 'PAUSED'
  const before = await caller.withClient((client) => ecbAccountOf(client))
  if ((!before && !body.on) || before?.status === to) return { feed: await caller.withClient((client) => feedOf(client)) }
  await refusingInWords(() =>
    command(caller, { name: 'currency.switchFeed', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      const account = await ecbAccountOf(tx)
      if (account && account.status === to) {
        tools.audit({ recordType: 'IntegrationAccount', recordId: account.id, companyId: null, before: { status: account.status }, after: { status: to }, reason: 'Switched meanwhile: unchanged.' })
        return null
      }
      let id: string
      if (account) {
        id = account.id
        await tx.integrationAccount.update({ where: { id }, data: { status: to, version: account.version + 1, updatedAt: now }, select: { id: true } })
      } else {
        id = newId()
        const taken = await tx.integrationAccount.findFirst({ where: { code: ECB_ACCOUNT_CODE }, select: { id: true } })
        await tx.integrationAccount.create({
          data: { id, companyId: null, provider: 'ECB', code: taken ? `${ECB_ACCOUNT_CODE}-${id.slice(-6)}` : ECB_ACCOUNT_CODE, label: 'Exchange rates (ECB)', mode: fake ? 'FAKE' : 'LIVE', status: 'ACTIVE', rateLimitPerMinute: 10, rateLimitBurst: 5, callTimeoutMs: 15_000, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
      }
      tools.audit({ recordType: 'IntegrationAccount', recordId: id, companyId: null, before: { status: account?.status ?? 'NONE' }, after: { status: to, provider: 'ECB', mode: account?.mode ?? (fake ? 'FAKE' : 'LIVE') } })
      tools.emit({ type: 'currency.rates_changed', subject: id, companyId: null, payload: { action: body.on ? 'FEED_ON' : 'FEED_OFF', days: [], quote: null, rows: 0 } })
      return null
    }),
  )
  return { feed: await caller.withClient((client) => feedOf(client)) }
}

// ---- reading the file ----------------------------------------------------------------------------------------------------

/** In a command: keeps the ECB rows of the file's days not kept yet (today and before); the days that got a row. */
export async function keepEcbDays(tools: CommandTools, accountId: string, days: readonly EcbDay[]): Promise<{ days: BusinessDate[]; rows: number }> {
  const { tx, now } = tools
  const today = businessDate(now)
  const wanted = days
    .filter((entry) => entry.day <= today)
    .flatMap((entry) => entry.rates.map((rate) => ({ base: 'EUR', quote: rate.currency, rateDate: entry.day, rate: rate.rate, source: 'ECB' as const })))
  const keys = wanted.map(rateKey)
  const kept = new Set(keys.length === 0 ? [] : (await tx.exchangeRate.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((row) => row.key))
  const fresh = wanted.filter((row) => !kept.has(rateKey(row)))
  if (fresh.length > 0) {
    await tx.exchangeRate.createMany({
      data: fresh.map((row) => ({ id: newId(), base: row.base, quote: row.quote, rateDate: dayValue(row.rateDate), rate: row.rate, source: 'ECB', overriddenById: null, key: rateKey(row), createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null })),
      skipDuplicates: true,
    })
  }
  const added = [...new Set(fresh.map((row) => row.rateDate))].sort()
  tools.audit({ action: 'currency.readEcb', recordType: 'IntegrationAccount', recordId: accountId, companyId: null, after: { fileDays: days.map((entry) => entry.day), addedDays: added, rows: fresh.length } })
  if (fresh.length > 0) tools.emit({ type: 'currency.rates_changed', subject: accountId, companyId: null, payload: { action: 'ECB_READ', days: added, quote: null, rows: fresh.length } })
  return { days: added, rows: fresh.length }
}

export interface ReadAnswer {
  readonly fileDays: BusinessDate[]
  readonly addedDays: BusinessDate[]
  readonly rows: number
  readonly feed: FeedView
}

/** POST /exchange-rates/fetch: reads the ECB's file now (the switch must be on). currencies.manage over every company. */
export async function readEcbNow(caller: CommandCaller, idempotencyKey?: string): Promise<ReadAnswer> {
  const context = officeOf(caller)
  assertOnEveryCompany(context, CURRENCIES_MANAGE)
  const account = await caller.withClient((client) => ecbAccountOf(client))
  if (!account || account.status !== 'ACTIVE') throw refused('FEED_OFF', 'The daily ECB rates are off: switch them on first.')
  const outcome = await processEcb().read(caller, account.id)
  if (!outcome.ok) throw refused('ECB_UNREADABLE', `The ECB file could not be read now (${outcome.problem}) The rates kept stay as they are; try again later.`)
  const { result } = await refusingInWords(() => command(caller, { name: 'currency.readEcb', idempotencyKey, input: { accountId: account.id } }, (tools) => keepEcbDays(tools, account.id, outcome.days)))
  return { fileDays: outcome.days.map((entry) => entry.day), addedDays: result.days, rows: result.rows, feed: await caller.withClient((client) => feedOf(client)) }
}

// ---- the job ---------------------------------------------------------------------------------------------------------------

export interface EcbDailyOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly runtime?: () => EcbRuntime
}

/** One run over every active tenant whose daily ECB rates are on (the cron's tick; tests call it directly). */
export async function runEcbDaily(options: EcbDailyOptions): Promise<{ tenants: number; read: number; rows: number; off: number; failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const runtime = (options.runtime ?? processEcb)()
  const requestId = `currency-ecb-${newId()}`
  let read = 0
  let rows = 0
  let off = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const account = await asSystem(options.database, tenantId, requestId, (client) => ecbAccountOf(client))
      if (!account || account.status !== 'ACTIVE') {
        off++
        continue
      }
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const outcome = await runtime.read(caller, account.id)
      if (!outcome.ok) {
        failed++
        options.log.warn({ tenantId, problem: outcome.problem }, 'the ECB file could not be read')
        continue
      }
      const { result } = await runCommand(caller, { name: 'currency.readEcb', input: { accountId: account.id, job: true } }, (tools) => keepEcbDays(tools, account.id, outcome.days), settings)
      read++
      rows += result.rows
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the ECB rates of a tenant could not be kept')
    }
  }
  const outcome = { tenants: tenants.length, read, rows, off, failed }
  options.log.info({ ...outcome }, 'ECB rates read')
  return outcome
}

/** The scheduler's cron: 16:30 and 18:30 Europe/Rome, Monday to Friday (the ECB publishes at about 16:00 CET). */
export function ecbDailyCron(options: EcbDailyOptions): CronJob {
  return defineCron({
    name: 'currency.ecbDaily',
    schedule: '30 16,18 * * 1-5',
    async run() {
      await runEcbDaily(options)
    },
  })
}
