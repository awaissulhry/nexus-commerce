import type { Prisma } from '@nexus/factory-db'
import { EMAIL_MANAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Actor, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { EMAIL_DELIVERY_UNBLOCK, EMAIL_DELIVERY_VIEW } from '@nexus/factory-domain/email-delivery/permissions'
import { events as deliveryEvents } from '@nexus/factory-domain/email-delivery/events'
import {
  addressOfSuppression,
  deliveryStateOf,
  deliveryTimeOf,
  isUnblocked,
  maskAddress,
  STATUSES_OF,
  unblockedAddress,
  unblockProblems,
  UNBLOCKED_PREFIX,
  DELIVERY_STATES,
  type DeliveryState,
} from '@nexus/factory-domain/email-delivery/rules'
import type { OutboundStatus, SuppressionReason } from '@nexus/factory-domain/email/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { eventFor } from '@nexus/factory-domain/events/define'
import { recordLabelOf } from '../../threads/labels'
import type { BlockedView, DeliveryView } from './contract'

/**
 * The mail delivery log and the blocked addresses (B-W2a-41; PLT-149; design admin.connections "Delivery log and
 * blocked addresses"):
 *
 *   GET  /email/delivery                       every mail the reader's companies sent, newest state first: what it is
 *                                              about (a link to its record), to whom (masked unless the reader manages
 *                                              that company's mail), where it is, when, and why it failed or bounced; a
 *                                              mail that carried a one-off link says so (PLT-149: bounced invoices and
 *                                              links must be visible). Counts per state over 30 days, blocked now.
 *   GET  /email/blocked                        the addresses no mail goes to (Suppression, tenant-wide), why, and the
 *                                              mail that blocked them; or the unblocked ones (kept as the record).
 *   POST /email/blocked/:suppressionId/unblock  one command: the row stays (never deleted) with its address moved aside
 *                                              (factory-domain email/delivery/rules), audited from → to with the reason,
 *                                              event email.address_unblocked. Every send looks the address up, so mail
 *                                              goes to it again; a later bounce blocks it again in a new row.
 *
 * Reads the outbox rows (EmailOutbound) and, for digests, NotificationDelivery (how many notifications a mail carried).
 */

type Client = Prisma.TransactionClient
const SCOPE: ScopeColumns = { company: 'companyId' }
const DAY_MS = 24 * 3_600_000

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actorOfCaller = (caller: CommandCaller): Actor => actorOf(contextOf(caller))

const OUTBOUND = {
  id: true,
  companyId: true,
  templateKey: true,
  recordType: true,
  recordId: true,
  to: true,
  cc: true,
  bcc: true,
  status: true,
  attempts: true,
  lastError: true,
  queuedAt: true,
  sentAt: true,
  deliveredAt: true,
  bouncedAt: true,
  complainedAt: true,
  failedAt: true,
} as const satisfies Prisma.EmailOutboundSelect
type OutboundRow = Prisma.EmailOutboundGetPayload<{ select: typeof OUTBOUND }>

/** The time column of each status (the log's order and its from/to filter). */
const kindOf = (templateKey: string): DeliveryView['kind'] => (templateKey.startsWith('auth.') ? 'SIGN_IN' : templateKey === 'notifications.digest' ? 'DIGEST' : 'RECORD')

/** A record's chip: a person's record (sign-in mail, the digest) is never labelled by name here. */
async function recordRefOf(client: Client, cache: Map<string, string | null>, recordType: string | null, recordId: string | null): Promise<DeliveryView['record']> {
  if (!recordType || !recordId) return null
  if (recordType === 'User') return { type: recordType, id: recordId, label: null }
  const key = `${recordType}:${recordId}`
  if (!cache.has(key)) cache.set(key, await recordLabelOf(client, recordType, recordId))
  return { type: recordType, id: recordId, label: cache.get(key) ?? null }
}

/** The mail's state time filter: a mail counts at the time of its latest state, read from the status's own column. */
function atBetween(from: Date | undefined, to: Date | undefined): Prisma.EmailOutboundWhereInput {
  if (!from && !to) return {}
  const range = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) }
  return {
    OR: [
      { status: { in: ['QUEUED', 'SENDING'] }, queuedAt: range },
      { status: 'SENT', sentAt: range },
      { status: 'DELIVERED', deliveredAt: range },
      { status: 'BOUNCED', bouncedAt: range },
      { status: 'COMPLAINED', complainedAt: range },
      { status: 'FAILED', failedAt: range },
    ],
  }
}

export interface DeliveryQuery {
  readonly state?: DeliveryState | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly about?: 'INVOICES' | 'LINKS' | undefined
  readonly companyId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly before?: string | undefined
  readonly limit?: number | undefined
}

/** One-off links to these mails' recipients on their records: (record, address) → the link's purpose. */
async function linksOf(client: Client, rows: readonly OutboundRow[]): Promise<Map<string, string>> {
  const records = rows.filter((row) => row.recordType && row.recordId && row.recordType !== 'User')
  const out = new Map<string, string>()
  if (records.length === 0) return out
  const links = await client.oneOffLink.findMany({
    where: { OR: [...new Map(records.map((row) => [`${row.recordType}:${row.recordId}`, { recordType: row.recordType!, recordId: row.recordId! }])).values()] },
    select: { recordType: true, recordId: true, email: true, purpose: true },
  })
  for (const link of links) if (link.email) out.set(`${link.recordType}:${link.recordId}:${link.email.toLowerCase()}`, link.purpose)
  return out
}

/** GET /email/delivery. */
export async function listDelivery(caller: CommandCaller, query: DeliveryQuery, now: Date = new Date()): Promise<{ mails: DeliveryView[]; nextBefore: string | null; counts: Record<DeliveryState, number>; blocked: number }> {
  const actor = actorOfCaller(caller)
  if (query.companyId && !can(actor, EMAIL_DELIVERY_VIEW, { companyId: query.companyId })) throw new ForbiddenError()
  const scope = scopeWhere(actor, EMAIL_DELIVERY_VIEW, SCOPE) as Prisma.EmailOutboundWhereInput
  const limit = query.limit ?? 50
  return caller.withClient(async (client) => {
    let linkWhere: Prisma.EmailOutboundWhereInput = {}
    if (query.about === 'LINKS') {
      const links = await client.oneOffLink.findMany({ where: { email: { not: null } }, select: { recordType: true, recordId: true }, distinct: ['recordType', 'recordId'], take: 5000 })
      linkWhere = links.length === 0 ? { id: { in: [] } } : { OR: links.map((link) => ({ recordType: link.recordType, recordId: link.recordId })) }
    }
    const filters: Prisma.EmailOutboundWhereInput[] = [
      scope,
      query.companyId ? { companyId: query.companyId } : {},
      query.state ? { status: { in: [...STATUSES_OF[query.state]] } } : {},
      query.recordType ? { recordType: query.recordType } : {},
      query.recordId ? { recordId: query.recordId } : {},
      query.about === 'INVOICES' ? { recordType: 'Invoice' } : {},
      linkWhere,
      atBetween(query.from ? new Date(query.from) : undefined, query.to ? new Date(query.to) : undefined),
    ]
    if (query.before) {
      const anchor = await client.emailOutbound.findFirst({ where: { AND: [scope, { id: query.before }] }, select: { id: true, queuedAt: true } })
      if (!anchor) throw new ValidationError('No such mail to page from.', [{ path: 'querystring/before', message: 'Not a mail of this log.' }])
      filters.push({ OR: [{ queuedAt: { lt: anchor.queuedAt } }, { queuedAt: anchor.queuedAt, id: { lt: anchor.id } }] })
    }
    const rows = await client.emailOutbound.findMany({ where: { AND: filters }, select: OUTBOUND, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const more = rows.length > limit
    const shown = more ? rows.slice(0, limit) : rows
    const labels = new Map<string, string | null>()
    const links = await linksOf(client, shown)
    const digests = shown.filter((row) => row.templateKey === 'notifications.digest').map((row) => row.id)
    const carried = digests.length === 0 ? [] : await client.notificationDelivery.groupBy({ by: ['emailOutboundId'], where: { emailOutboundId: { in: digests } }, _count: { _all: true } })
    const carriedBy = new Map(carried.map((row) => [row.emailOutboundId, row._count._all]))
    const mails: DeliveryView[] = []
    for (const row of shown) {
      const full = can(actor, EMAIL_MANAGE, { companyId: row.companyId })
      const visible = [...row.to, ...row.cc]
      const link = visible.map((address) => links.get(`${row.recordType}:${row.recordId}:${address}`)).find((purpose) => purpose !== undefined) ?? null
      mails.push({
        id: row.id,
        companyId: row.companyId,
        kind: kindOf(row.templateKey),
        templateKey: row.templateKey,
        record: await recordRefOf(client, labels, row.recordType, row.recordId),
        to: visible.map((address) => (full ? address : maskAddress(address))),
        recipients: visible.length + row.bcc.length,
        fullAddresses: full,
        state: deliveryStateOf(row.status as OutboundStatus),
        status: row.status as OutboundStatus,
        at: toUtcIso(deliveryTimeOf({ ...row, status: row.status as OutboundStatus })),
        queuedAt: toUtcIso(row.queuedAt),
        attempts: row.attempts,
        problem: row.status === 'FAILED' || row.status === 'BOUNCED' || row.status === 'COMPLAINED' || row.lastError ? row.lastError : null,
        link,
        notifications: row.templateKey === 'notifications.digest' ? (carriedBy.get(row.id) ?? 0) : null,
      })
    }
    const since = new Date(now.getTime() - 30 * DAY_MS)
    const grouped = await client.emailOutbound.groupBy({ by: ['status'], where: { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, { queuedAt: { gte: since } }] }, _count: { _all: true } })
    const counts = Object.fromEntries(DELIVERY_STATES.map((state) => [state, 0])) as Record<DeliveryState, number>
    for (const row of grouped) counts[deliveryStateOf(row.status as OutboundStatus)] += row._count._all
    const blocked = await client.suppression.count({ where: { NOT: { address: { startsWith: UNBLOCKED_PREFIX } } } })
    return { mails, nextBefore: more ? shown[shown.length - 1]!.id : null, counts, blocked }
  })
}

// ---- blocked addresses ----------------------------------------------------------------------------------------------

const SUPPRESSION = { id: true, address: true, reason: true, detail: true, at: true, outboundId: true, version: true, updatedAt: true } as const satisfies Prisma.SuppressionSelect
type SuppressionRow = Prisma.SuppressionGetPayload<{ select: typeof SUPPRESSION }>

/** The blocked list is tenant-wide: any grant of email.delivery.view reads it. */
function mayReadBlocked(actor: Actor): void {
  if (!holds(actor, EMAIL_DELIVERY_VIEW)) throw new ForbiddenError()
}

/** Unblocking reaches every company's mail: email.delivery.unblock over every active company. */
async function mayUnblock(actor: Actor, client: Client): Promise<boolean> {
  if (!can(actor, EMAIL_DELIVERY_UNBLOCK, {})) return false
  const companies = await client.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  return companies.every((company) => can(actor, EMAIL_DELIVERY_UNBLOCK, { companyId: company.id }))
}

async function blockedViews(client: Client, actor: Actor, rows: readonly SuppressionRow[]): Promise<BlockedView[]> {
  const mailIds = rows.flatMap((row) => (row.outboundId ? [row.outboundId] : []))
  const mails = mailIds.length === 0 ? [] : await client.emailOutbound.findMany({ where: { id: { in: mailIds } }, select: { id: true, companyId: true, recordType: true, recordId: true } })
  const mailOf = new Map(mails.map((mail) => [mail.id, mail]))
  const unblockedIds = rows.filter((row) => isUnblocked(row.address)).map((row) => row.id)
  const audits = unblockedIds.length === 0
    ? []
    : await client.auditLog.findMany({ where: { recordType: 'Suppression', recordId: { in: unblockedIds }, action: 'email.unblockAddress' }, select: { recordId: true, at: true, actorId: true, audience: true, reason: true }, orderBy: { at: 'desc' } })
  const auditOf = new Map<string, (typeof audits)[number]>()
  for (const audit of audits) if (!auditOf.has(audit.recordId)) auditOf.set(audit.recordId, audit)
  const full = holds(actor, EMAIL_MANAGE)
  const labels = new Map<string, string | null>()
  const out: BlockedView[] = []
  for (const row of rows) {
    const address = addressOfSuppression(row.address)
    const mail = row.outboundId ? mailOf.get(row.outboundId) : undefined
    const mayMail = mail !== undefined && can(actor, EMAIL_DELIVERY_VIEW, { companyId: mail.companyId })
    const audit = auditOf.get(row.id)
    out.push({
      id: row.id,
      address: full ? address : maskAddress(address),
      fullAddress: full,
      reason: row.reason as SuppressionReason,
      detail: row.detail,
      at: toUtcIso(row.at),
      mail: mail && mayMail ? { id: mail.id, companyId: mail.companyId, record: await recordRefOf(client, labels, mail.recordType, mail.recordId) } : null,
      unblocked: isUnblocked(row.address) ? { at: toUtcIso(audit?.at ?? row.updatedAt), byId: audit && audit.audience === 'OFFICE' ? audit.actorId : null, reason: audit?.reason ?? null } : null,
      version: row.version,
    })
  }
  return out
}

/** GET /email/blocked. */
export async function listBlocked(
  caller: CommandCaller,
  query: { state?: 'BLOCKED' | 'UNBLOCKED' | undefined; reason?: SuppressionReason | undefined; before?: string | undefined; limit?: number | undefined },
): Promise<{ addresses: BlockedView[]; nextBefore: string | null; canUnblock: boolean }> {
  const actor = actorOfCaller(caller)
  mayReadBlocked(actor)
  const limit = query.limit ?? 50
  return caller.withClient(async (client) => {
    const filters: Prisma.SuppressionWhereInput[] = [
      query.state === 'UNBLOCKED' ? { address: { startsWith: UNBLOCKED_PREFIX } } : { NOT: { address: { startsWith: UNBLOCKED_PREFIX } } },
      query.reason ? { reason: query.reason } : {},
    ]
    if (query.before) {
      const anchor = await client.suppression.findFirst({ where: { id: query.before }, select: { id: true, at: true } })
      if (!anchor) throw new ValidationError('No such address to page from.', [{ path: 'querystring/before', message: 'Not a row of this list.' }])
      filters.push({ OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] })
    }
    const rows = await client.suppression.findMany({ where: { AND: filters }, select: SUPPRESSION, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const more = rows.length > limit
    const shown = more ? rows.slice(0, limit) : rows
    return { addresses: await blockedViews(client, actor, shown), nextBefore: more ? shown[shown.length - 1]!.id : null, canUnblock: await mayUnblock(actor, client) }
  })
}

const [unblocked] = deliveryEvents

/** email.unblockAddress: the row stays, its address moved aside; audited with the reason; email.address_unblocked. */
export async function unblockAddress(caller: CommandCaller, suppressionId: string, input: { version: number; reason: string }, idempotencyKey?: string): Promise<BlockedView> {
  const actor = actorOfCaller(caller)
  mayReadBlocked(actor)
  const row = await caller.withClient(async (client) => {
    const found = isUuid(suppressionId) ? await client.suppression.findUnique({ where: { id: suppressionId }, select: SUPPRESSION }) : null
    if (!found) throw new NotFoundError('Blocked address not found.')
    if (!(await mayUnblock(actor, client))) throw new ForbiddenError()
    return found
  })
  const problems = unblockProblems({ address: row.address, reason: input.reason })
  if (problems.length > 0) throw new DomainError('conflict', problems[0]!.message, problems)
  const { result } = await command(
    caller,
    { name: 'email.unblockAddress', idempotencyKey, input: { suppressionId, ...input }, record: { type: 'Suppression', id: row.id, expectedVersion: input.version } },
    async ({ tx, audit, emit }) => {
      const current = await tx.suppression.findUniqueOrThrow({ where: { id: row.id }, select: SUPPRESSION })
      if (isUnblocked(current.address)) throw new DomainError('conflict', 'This address was unblocked already: mail may go to it.', [{ path: 'suppression/unblocked', message: 'unblocked' }])
      const address = current.address
      await tx.suppression.update({ where: { id: row.id }, data: { address: unblockedAddress(row.id, address) }, select: { id: true } })
      audit({ recordType: 'Suppression', recordId: row.id, companyId: null, before: { blocked: true, reason: current.reason }, after: { blocked: false }, reason: input.reason.trim() })
      emit(eventFor(unblocked, { subject: row.id, companyId: null, payload: { suppressionId: row.id, reason: current.reason as SuppressionReason } }))
      const saved = await tx.suppression.findUniqueOrThrow({ where: { id: row.id }, select: SUPPRESSION })
      const [view] = await blockedViews(tx, actor, [saved])
      const context = contextOf(caller)
      return { ...view!, unblocked: { at: view!.unblocked!.at, byId: context.audience === 'office' ? context.actorId : null, reason: input.reason.trim() } }
    },
  )
  return result
}
