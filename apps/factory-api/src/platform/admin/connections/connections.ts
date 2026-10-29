import type { Prisma } from '@nexus/factory-db'
import { INTEGRATIONS_MANAGE, INTEGRATIONS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { PROVIDER_SLUGS } from '../../inbound/receive'
import type { AccountView, CallView, InboundView } from './contract'

/**
 * The outside services in the Office (B-W0-28, design 02 admin.connections, SCR-087): the integration accounts with
 * what the gateway learned of them, their call ledger and their received webhooks — reads only, never a secret (a
 * SecretValue is sealed; the page shows whether one is saved and when) — and the kill switch: pause (the gateway
 * refuses every call, recorded as refused) and resume, each one command with its audit row from → to.
 *
 * Scope: an account of a company is seen by whoever holds integrations.view over that company; a tenant-wide one
 * (companyId null: SES, R2, VIES) by anyone holding integrations.view. Pausing or resuming a tenant-wide account
 * reaches every company's mail, files or VAT checks, so it needs integrations.manage over every active company.
 */

type Client = Prisma.TransactionClient

const SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }
const DAY_MS = 24 * 3_600_000
const FAILED_CALLS = ['FAILED', 'TIMED_OUT', 'REFUSED'] as const

const SECRET = { select: { createdAt: true, rotatedAt: true } } as const
const ACCOUNT = {
  id: true,
  companyId: true,
  provider: true,
  code: true,
  label: true,
  mode: true,
  status: true,
  settings: true,
  rateLimitPerMinute: true,
  rateLimitBurst: true,
  callTimeoutMs: true,
  circuitFailureThreshold: true,
  circuitCooldownSeconds: true,
  lastOkAt: true,
  lastErrorAt: true,
  lastError: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  tenantId: true,
  credentials: SECRET,
  webhookSecret: SECRET,
} as const satisfies Prisma.IntegrationAccountSelect

type AccountRow = Prisma.IntegrationAccountGetPayload<{ select: typeof ACCOUNT }>

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller) => actorOf(contextOf(caller))

const SLUG_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PROVIDER_SLUGS).map(([slug, provider]) => [provider, slug]))

/** The settings that are not secret, top-level scalars only (a nested value is left out, never guessed at). */
export function plainSettings(settings: Prisma.JsonValue | null): Record<string, string | number | boolean | null> {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

const secretOf = (secret: { createdAt: Date; rotatedAt: Date | null } | null) => ({
  saved: secret !== null,
  savedAt: secret ? toUtcIso(secret.createdAt) : null,
  rotatedAt: secret?.rotatedAt ? toUtcIso(secret.rotatedAt) : null,
})

function viewOf(row: AccountRow, stats: { total: number; failed: number; waiting: number }): AccountView {
  const slug = SLUG_OF[row.provider]
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    code: row.code,
    label: row.label,
    mode: row.mode,
    status: row.status,
    credentials: secretOf(row.credentials),
    webhookSecret: secretOf(row.webhookSecret),
    settings: plainSettings(row.settings),
    limits: {
      ratePerMinute: row.rateLimitPerMinute,
      burst: row.rateLimitBurst,
      timeoutMs: row.callTimeoutMs,
      circuitFailureThreshold: row.circuitFailureThreshold,
      circuitCooldownSeconds: row.circuitCooldownSeconds,
    },
    lastOkAt: row.lastOkAt ? toUtcIso(row.lastOkAt) : null,
    lastErrorAt: row.lastErrorAt ? toUtcIso(row.lastErrorAt) : null,
    lastError: row.lastError,
    calls24h: { total: stats.total, failed: stats.failed },
    inboundWaiting: stats.waiting,
    inboundPath: slug ? `/inbound/${slug}/${row.tenantId}/${row.id}` : null,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Calls of the last 24 h (all and failed) and webhooks waiting, per account. */
async function statsOf(client: Client, ids: readonly string[], now: Date): Promise<Map<string, { total: number; failed: number; waiting: number }>> {
  const since = new Date(now.getTime() - DAY_MS)
  const [calls, failed, waiting] = await Promise.all([
    client.integrationCall.groupBy({ by: ['accountId'], where: { accountId: { in: [...ids] }, startedAt: { gte: since } }, _count: { _all: true } }),
    client.integrationCall.groupBy({ by: ['accountId'], where: { accountId: { in: [...ids] }, startedAt: { gte: since }, status: { in: [...FAILED_CALLS] } }, _count: { _all: true } }),
    client.inboundWebhook.groupBy({ by: ['accountId'], where: { accountId: { in: [...ids] }, status: { in: ['RECEIVED', 'FAILED'] } }, _count: { _all: true } }),
  ])
  const out = new Map<string, { total: number; failed: number; waiting: number }>()
  for (const id of ids) out.set(id, { total: 0, failed: 0, waiting: 0 })
  for (const row of calls) out.get(row.accountId)!.total = row._count._all
  for (const row of failed) out.get(row.accountId)!.failed = row._count._all
  for (const row of waiting) out.get(row.accountId)!.waiting = row._count._all
  return out
}

export interface ListAccountsQuery {
  readonly provider?: AccountView['provider'] | undefined
  readonly includeDisabled?: boolean | undefined
}

/** GET /integrations/accounts: the accounts the caller's grants reach, by provider and code. */
export async function listAccounts(caller: CommandCaller, query: ListAccountsQuery, now: Date = new Date()): Promise<AccountView[]> {
  const scope = scopeWhere(actor(caller), INTEGRATIONS_VIEW, SCOPE) as Prisma.IntegrationAccountWhereInput
  return caller.withClient(async (client) => {
    const rows = await client.integrationAccount.findMany({
      where: { AND: [scope, query.provider ? { provider: query.provider } : {}, query.includeDisabled ? {} : { status: { not: 'DISABLED' } }] },
      select: ACCOUNT,
      orderBy: [{ provider: 'asc' }, { code: 'asc' }],
      take: 200,
    })
    const stats = await statsOf(client, rows.map((row) => row.id), now)
    return rows.map((row) => viewOf(row, stats.get(row.id)!))
  })
}

async function readAccount(caller: CommandCaller, client: Client, accountId: string): Promise<AccountRow> {
  const row = isUuid(accountId) ? await client.integrationAccount.findUnique({ where: { id: accountId }, select: ACCOUNT }) : null
  if (!row || !can(actor(caller), INTEGRATIONS_VIEW, row.companyId ? { companyId: row.companyId } : {})) throw new NotFoundError('Connection not found.')
  return row
}

/** GET /integrations/accounts/:id. */
export async function getAccount(caller: CommandCaller, accountId: string, now: Date = new Date()): Promise<AccountView> {
  return caller.withClient(async (client) => {
    const row = await readAccount(caller, client, accountId)
    const stats = await statsOf(client, [row.id], now)
    return viewOf(row, stats.get(row.id)!)
  })
}

/** An older row to page from (newest first): the anchor must belong to the same account. */
function pageAfter<T extends { startedAt?: Date; receivedAt?: Date; id: string }>(anchor: T | null, field: 'startedAt' | 'receivedAt'): Record<string, unknown> {
  if (!anchor) throw new ValidationError('No such row to page from.', [{ path: 'querystring/before', message: 'Not a row of this connection.' }])
  const at = anchor[field]!
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: anchor.id } }] }
}

/** GET /integrations/accounts/:id/calls: the ledger of the account's calls, newest first (no summaries: they may hold personal data). */
export async function listCalls(caller: CommandCaller, accountId: string, query: { failed?: boolean | undefined; before?: string | undefined; limit: number }): Promise<{ calls: CallView[]; nextBefore: string | null }> {
  return caller.withClient(async (client) => {
    const account = await readAccount(caller, client, accountId)
    const page = query.before
      ? pageAfter(await client.integrationCall.findFirst({ where: { id: query.before, accountId: account.id }, select: { id: true, startedAt: true } }), 'startedAt')
      : {}
    const rows = await client.integrationCall.findMany({
      where: { AND: [{ accountId: account.id }, query.failed ? { status: { in: [...FAILED_CALLS] } } : {}, page as Prisma.IntegrationCallWhereInput] },
      select: { id: true, startedAt: true, durationMs: true, operation: true, status: true, reason: true, httpStatus: true, attempts: true, error: true, requestId: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    })
    const more = rows.length > query.limit
    const shown = more ? rows.slice(0, query.limit) : rows
    return { calls: shown.map((row) => ({ ...row, startedAt: toUtcIso(row.startedAt) })), nextBefore: more ? shown[shown.length - 1]!.id : null }
  })
}

/** GET /integrations/accounts/:id/inbound: the webhooks the account sent, newest first; never a body. */
export async function listInbound(
  caller: CommandCaller,
  accountId: string,
  query: { status?: InboundView['status'] | undefined; before?: string | undefined; limit: number },
): Promise<{ inbound: InboundView[]; nextBefore: string | null }> {
  return caller.withClient(async (client) => {
    const account = await readAccount(caller, client, accountId)
    const page = query.before
      ? pageAfter(await client.inboundWebhook.findFirst({ where: { id: query.before, accountId: account.id }, select: { id: true, receivedAt: true } }), 'receivedAt')
      : {}
    const rows = await client.inboundWebhook.findMany({
      where: { AND: [{ accountId: account.id }, query.status ? { status: query.status } : {}, page as Prisma.InboundWebhookWhereInput] },
      select: { id: true, receivedAt: true, eventType: true, verified: true, status: true, attempts: true, processedAt: true, lastError: true, rejectReason: true, bodyBytes: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    })
    const more = rows.length > query.limit
    const shown = more ? rows.slice(0, query.limit) : rows
    return {
      inbound: shown.map((row) => ({
        id: row.id,
        receivedAt: toUtcIso(row.receivedAt),
        eventType: row.eventType,
        verified: row.verified,
        status: row.status,
        attempts: row.attempts,
        processedAt: row.processedAt ? toUtcIso(row.processedAt) : null,
        error: row.lastError ?? row.rejectReason,
        bodyBytes: row.bodyBytes,
      })),
      nextBefore: more ? shown[shown.length - 1]!.id : null,
    }
  })
}

/** integrations.manage over the account's company; a tenant-wide account: over every active company. */
async function mayManage(caller: CommandCaller, client: Client, row: AccountRow): Promise<void> {
  const who = actor(caller)
  if (row.companyId) {
    if (!can(who, INTEGRATIONS_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
    return
  }
  const companies = await client.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  if (!can(who, INTEGRATIONS_MANAGE, {}) || companies.some((company) => !can(who, INTEGRATIONS_MANAGE, { companyId: company.id }))) throw new ForbiddenError()
}

/**
 * integration.pauseAccount / integration.resumeAccount: the kill switch (ACTIVE ↔ PAUSED). A disabled account is
 * neither; pausing a paused one (or resuming an active one) is refused, so a stale screen never flips it back.
 */
export async function setAccountPaused(
  caller: CommandCaller,
  accountId: string,
  paused: boolean,
  input: { version: number; reason?: string | undefined },
  idempotencyKey?: string,
  now: Date = new Date(),
): Promise<AccountView> {
  const before = await caller.withClient(async (client) => {
    const row = await readAccount(caller, client, accountId)
    await mayManage(caller, client, row)
    return row
  })
  const from = paused ? 'ACTIVE' : 'PAUSED'
  const to = paused ? 'PAUSED' : 'ACTIVE'
  if (before.status !== from) throw new ConflictError(before.status === to ? `The connection is ${to.toLowerCase()} already.` : 'The connection is disabled.')
  const { result } = await command(
    caller,
    {
      name: paused ? 'integration.pauseAccount' : 'integration.resumeAccount',
      idempotencyKey,
      input: { accountId, ...input },
      record: { type: 'IntegrationAccount', id: before.id, expectedVersion: input.version },
    },
    async ({ tx, audit }) => {
      const current = await tx.integrationAccount.findUnique({ where: { id: before.id }, select: { status: true } })
      if (current?.status !== from) throw new ConflictError('The connection changed meanwhile.')
      const row = await tx.integrationAccount.update({ where: { id: before.id }, data: { status: to }, select: ACCOUNT })
      audit({
        recordType: 'IntegrationAccount',
        recordId: row.id,
        companyId: row.companyId,
        before: { status: before.status, mode: before.mode },
        after: { status: row.status, mode: row.mode },
        ...(input.reason ? { reason: input.reason } : {}),
      })
      const stats = await statsOf(tx, [row.id], now)
      return viewOf(row, stats.get(row.id)!)
    },
  )
  return result
}
