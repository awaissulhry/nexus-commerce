import type { FastifyRequest } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import { APPROVAL_MAIL_TEMPLATES, officeApprovalsMail } from '@nexus/factory-domain/approvals-out/mail'
import { approvalMailKey, approvalMailUrl, asksForDecision, readApprovalMailKey } from '@nexus/factory-domain/approvals-out/rules'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { abuseKey } from '../../../platform/abuse/guard'
import { deliverMail, queueMail } from '../../../platform/approvals-out/mail'
import { localeOf } from '../../../platform/approvals-out/store'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { authSecrets, type AuthSecrets } from '../../../platform/auth/sessions/secrets'
import { processEmail } from '../../../platform/email-out/service'
import { logDeliveries } from '../../../platform/notifications/store'
import { activeTenants, systemContext } from '../../../platform/outbox/system'

/**
 * Approve from e-mail (B-W2b-184; PLT-089 "approve from email or phone push"; design links.approve addr "staff approvals
 * from e-mail open the Office approval in this frame after a quick sign-in, so margin stays behind the Office's grains").
 * Home › Approvals' own requests (a quote under the margin floor, a nudge: the office notifications of category APPROVAL
 * that ask for a decision) reach the person by mail AS THEY COME, when the person turned it on for themselves (PLT-142:
 * nothing is e-mailed unless the person asked; a ReportSubscription `approvals.mail` of theirs, on or off):
 *
 *   GET|PUT /approvals/mail-me {on}   the person's own switch (office, home.view)
 *   cron approvals.officeMail         every 5 minutes, per ACTIVE tenant: each person switched on gets ONE mail with the
 *                                     approval notifications made for them since they first switched it on (at most the
 *                                     last two days), still unread, not done, never mailed (no EMAIL delivery yet), at most 20; each
 *                                     line a link /l/approve#key=<am1 key>; a NotificationDelivery EMAIL per line (SENT or
 *                                     FAILED) and the subscription's lastSentAt in one command after the send. FAKE locally.
 *   POST /approvals/mail-open {key}   after the office sign-in (two-factor where the role asks it: the office sign-in's own
 *                                     rule): the key names ONE notification of ONE person; another person (a forwarded
 *                                     mail) or a forged key gets the one 404. Answers where the approval opens (the record
 *                                     and the notification's anchor) and whether it still waits; the decision itself runs
 *                                     on the office's own routes, behind the person's grants and grains (the mail carries
 *                                     no figure). Phone push stays W2b-6.
 */

export const APPROVALS_MAIL_REPORT = 'approvals.mail'
const LOOKBACK_MS = 2 * 86_400_000
const MAX_ITEMS = 20

/** The key of the links (HMAC from FACTORY_COOKIE_SECRET, as the portal's unsubscribe link). */
export const approvalsMailKeyOf = (secrets: Pick<AuthSecrets, 'recoveryCodeHash'>): Buffer => abuseKey(secrets, 'approvals-mail')

const SUBSCRIPTION = { id: true, userId: true, locale: true, active: true, lastSentAt: true, version: true, createdAt: true, updatedAt: true } as const

function officePerson(request: FastifyRequest) {
  const context = requireContext(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

async function mine(caller: CommandCaller, userId: string) {
  return caller.withClient((client) => client.reportSubscription.findFirst({ where: { userId, reportKey: APPROVALS_MAIL_REPORT }, orderBy: { createdAt: 'asc' }, select: SUBSCRIPTION }))
}

const settingsView = (row: { readonly active: boolean; readonly updatedAt: Date; readonly lastSentAt: Date | null; readonly version: number } | null) => ({
  on: row?.active ?? false,
  since: row?.active ? toUtcIso(row.updatedAt) : null,
  lastSentAt: row?.lastSentAt ? toUtcIso(row.lastSentAt) : null,
  /** 0: never turned on. */
  version: row?.version ?? 0,
})

/** GET /approvals/mail-me. */
export async function approvalsMailSettings(request: FastifyRequest) {
  const context = officePerson(request)
  return settingsView(await mine(request, context.actorId))
}

/** PUT /approvals/mail-me {on}: the person's own switch (a row made the first time; turning it on starts "since" now). */
export async function setApprovalsMail(request: FastifyRequest, body: { readonly on: boolean }, idempotencyKey?: string) {
  const context = officePerson(request)
  await command(request, { name: 'approvalsOut.mailMe', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const existing = await tx.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: APPROVALS_MAIL_REPORT }, orderBy: { createdAt: 'asc' }, select: SUBSCRIPTION })
    let id = existing?.id ?? null
    if (existing) {
      await tx.reportSubscription.update({ where: { id: existing.id }, data: { active: body.on, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    } else {
      const user = await tx.user.findUnique({ where: { id: context.actorId }, select: { locale: true } })
      id = newId()
      await tx.reportSubscription.create({
        data: { id, userId: context.actorId, locale: localeOf(user?.locale), reportKey: APPROVALS_MAIL_REPORT, channel: 'EMAIL', weekdays: [1, 2, 3, 4, 5, 6, 7], sendTime: '00:00', active: body.on, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: { id: true },
      })
    }
    tools.audit({ recordType: 'ReportSubscription', recordId: id!, ...(existing ? { before: { on: existing.active } } : {}), after: { on: body.on, report: APPROVALS_MAIL_REPORT } })
    return null
  })
  return settingsView(await mine(request, context.actorId))
}

/** POST /approvals/mail-open {key}: where the mailed approval opens, for its own person only. */
export async function openApprovalFromMail(request: FastifyRequest, key: string) {
  const context = officePerson(request)
  const read = readApprovalMailKey(approvalsMailKeyOf(officeAuthOf(request.server).secrets), key)
  const notFound = new NotFoundError('This link is not valid, or it is for another person: open Home › Approvals.')
  if (!read || read.tenantId !== context.tenantId || read.userId !== context.actorId) throw notFound
  const row = await request.withClient((client) => client.notification.findUnique({ where: { id: read.notificationId }, select: { userId: true, category: true, recordType: true, recordId: true, recordLabel: true, anchor: true, messageKey: true, readAt: true, doneAt: true, companyId: true } }))
  if (!row || row.userId !== context.actorId || row.category !== 'APPROVAL') throw notFound
  return { record: { type: row.recordType, id: row.recordId, label: row.recordLabel }, companyId: row.companyId, anchor: row.anchor, messageKey: row.messageKey, waiting: row.doneAt === null }
}

// ---- the mail ------------------------------------------------------------------------------------------------------------

export interface OfficeMailOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly cookieSecret: string
  readonly clock?: Clock
}

export interface OfficeMailResult {
  readonly people: number
  readonly sent: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it with their clock). */
export async function mailOfficeApprovals(options: OfficeMailOptions): Promise<OfficeMailResult> {
  const clock = options.clock ?? serverClock
  const now = clock.now()
  const key = approvalsMailKeyOf(authSecrets(options.cookieSecret))
  const result = { people: 0, sent: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    const requestId = `approvals-mail-${newId()}`
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    try {
      const subscriptions = await caller.withClient((client) => client.reportSubscription.findMany({ where: { reportKey: APPROVALS_MAIL_REPORT, active: true, user: { status: 'ACTIVE', audience: 'OFFICE' } }, orderBy: { id: 'asc' }, select: SUBSCRIPTION }))
      for (const subscription of subscriptions) {
        try {
          const outcome = await mailPerson(caller, tenantId, subscription, key, now, clock)
          if (outcome === null) continue
          result.people += 1
          result[outcome] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, subscriptionId: subscription.id }, 'the approvals mail of a person could not be sent')
        }
      }
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the approvals mail of a tenant could not be read')
    }
  }
  return result
}

type Subscription = { readonly id: string; readonly userId: string; readonly locale: string; readonly createdAt: Date; readonly lastSentAt: Date | null }

async function mailPerson(caller: CommandCaller, tenantId: string, subscription: Subscription, key: Buffer, now: Date, clock: Clock): Promise<'sent' | 'failed' | null> {
  // Never mailed (no EMAIL delivery) is the dedupe; the window keeps a first switch-on from mailing old approvals.
  const since = new Date(Math.max(subscription.createdAt.getTime(), now.getTime() - LOOKBACK_MS))
  const facts = await caller.withClient(async (client) => {
    const rows = await client.notification.findMany({
      where: { userId: subscription.userId, category: 'APPROVAL', readAt: null, doneAt: null, createdAt: { gte: since, lte: now }, deliveries: { none: { channel: 'EMAIL' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, recordLabel: true, messageKey: true, companyId: true },
    })
    const user = await client.user.findUnique({ where: { id: subscription.userId }, select: { email: true } })
    const company = await client.company.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
    return { rows: rows.filter((row) => asksForDecision(row.messageKey)), user, company }
  })
  if (facts.rows.length === 0 || !facts.user) return null
  const listed = facts.rows.slice(0, MAX_ITEMS)
  const locale = localeOf(subscription.locale)
  const webOrigin = processEmail().webOrigin
  const mail = officeApprovalsMail(
    locale,
    listed.map((row) => ({ label: row.recordLabel, url: approvalMailUrl(webOrigin, approvalMailKey(key, tenantId, subscription.userId, row.id)) })),
    facts.rows.length - listed.length,
  )
  const companyId = listed.find((row) => row.companyId !== null)?.companyId ?? facts.company?.id ?? null
  const to = facts.user.email.toLowerCase()
  const settings = { ...COMMAND_SETTINGS, clock }
  const { result: outboundId } = await runCommand(caller, { name: 'approvalsOut.officeMail', input: { userId: subscription.userId, notificationIds: listed.map((row) => row.id) } }, async (tools) =>
    companyId ? queueMail(tools, { companyId, record: { type: 'User', id: subscription.userId }, template: APPROVAL_MAIL_TEMPLATES.office, to, locale, subject: mail.subject, sender: null }) : null,
  settings)
  const delivered = outboundId ? await deliverMail(caller, outboundId, mail.body, null, clock) : 'FAILED'
  const outcome = delivered === 'FAILED' ? 'failed' : 'sent'
  await runCommand(caller, { name: 'approvalsOut.officeMailed', input: { subscriptionId: subscription.id, outboundId, notificationIds: listed.map((row) => row.id) } }, async (tools) => {
    await logDeliveries(
      tools.tx,
      listed.map((row) => ({ id: newId(), notificationId: row.id, outcome: outcome === 'sent' ? 'SENT' : 'FAILED', emailOutboundId: outcome === 'sent' ? outboundId : null, detail: outcome === 'sent' ? null : 'the mail could not be sent (no sending address, a suppressed address, or the provider refused it)' })),
      tools.now,
      tools.context.requestId,
    )
    await tools.tx.reportSubscription.update({ where: { id: subscription.id }, data: { lastSentAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'ReportSubscription', recordId: subscription.id, after: { outcome, listed: listed.length, more: facts.rows.length - listed.length, ...(outboundId ? { emailOutboundId: outboundId } : {}) } })
    return null
  }, settings)
  return outcome
}

export function officeApprovalsMailCron(options: OfficeMailOptions): CronJob {
  return defineCron({
    name: 'approvals.officeMail',
    schedule: '*/5 * * * *',
    lockTtlMs: 240_000,
    async run() {
      const result = await mailOfficeApprovals(options)
      if (result.people > 0) options.log.info({ ...result }, 'office approvals mailed')
    },
  })
}
