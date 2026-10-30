import type { FactoryDatabase } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { escapeHtml, footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady, localeOf } from '@nexus/factory-domain/email/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as notificationEvents } from '@nexus/factory-domain/notifications/events'
import {
  DIGEST_DEFAULT_CATEGORIES,
  DIGEST_DEFAULT_TIME,
  DIGEST_DEFAULT_WEEKDAYS,
  DIGEST_LOOKBACK_MS,
  DIGEST_MAX_ITEMS,
  DIGEST_REPORT_KEY,
  digestCategoriesOf,
  digestDue,
  digestProblems,
  digestText,
  paramsFor,
  peopleOf,
  stateOf,
  type DigestLocale,
  type DigestSettings,
} from '@nexus/factory-domain/notifications/rules'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { heldRoles } from '../../auth/roles/access'
import { companyLegalOf } from '../../documents/documents'
import { latestPerRecord, logDeliveries, NOTIFICATION_COLUMNS } from '../../notifications/store'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { deliverOutbound } from '../outbound'
import { processEmail, type EmailRuntime } from '../service'

/**
 * The daily digest (B-W2a-20; PLT-142 "nothing is e-mailed unless the person turned it on"): the ONE way a notification
 * reaches e-mail in W2a. A person turns it on for themselves (GET/PUT /notifications/digest, platform/notifications): a
 * ReportSubscription `notifications.digest` of theirs (no row, or not active: off — the default). The scheduler's
 * clustered cron `notifications.digest` (every 15 minutes) sends each due one once a day, at its time on its weekdays
 * (Europe/Rome):
 *
 *   1. the person's notifications since the last digest (at most 7 days back), still to look at (not read, not done,
 *      not snoozed), of the kinds they chose (mentions, assignments, approvals, alerts by default), newest first, at
 *      most 50 listed ("and N more in the app"); none: nothing is sent, the day is marked checked;
 *   2. the mail is composed in memory in the person's language from each notification's own params (built for them,
 *      with only the amounts their grains reached), with the company's footer; one EmailOutbound row (record `User`,
 *      template `notifications.digest`, NO body) from the tenant's default NOTIFICATION identity, sent at once through
 *      deliverOutbound (suppression and identity checked again; FAKE accounts locally and in tests);
 *   3. ONE command logs a NotificationDelivery per notification listed (SENT with the mail's id, or FAILED with why) and
 *      the subscription's lastSentAt; event notification.digest_sent.
 *
 * No other person's figure is in a digest: it lists the person's own notifications only (Owner answer W1, F2).
 */

const digestSent = notificationEvents.find((event) => event.type === 'notification.digest_sent')!
export const DIGEST_TEMPLATE_KEY = 'notifications.digest'

const IDENTITY = { id: true, companyId: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const
const SUBSCRIPTION = { id: true, userId: true, locale: true, weekdays: true, sendTime: true, active: true, params: true, lastSentAt: true, version: true, updatedAt: true } as const

// ---- the person's own settings --------------------------------------------------------------------------------------------

function settingsView(row: { active: boolean; sendTime: string; weekdays: number[]; params: unknown; lastSentAt: Date | null; version: number; locale: string } | null) {
  return {
    on: row?.active ?? false,
    sendTime: row?.sendTime ?? DIGEST_DEFAULT_TIME,
    weekdays: row?.weekdays ?? [...DIGEST_DEFAULT_WEEKDAYS],
    categories: row ? digestCategoriesOf(row.params) : [...DIGEST_DEFAULT_CATEGORIES],
    locale: row?.locale ?? null,
    lastSentAt: row?.lastSentAt ? toUtcIso(row.lastSentAt) : null,
    /** 0: never turned on (nothing stored). */
    version: row?.version ?? 0,
  }
}

/** GET /notifications/digest: my digest (off until I turn it on). */
export async function readDigest(caller: CommandCaller, context: OfficeContext) {
  const row = await caller.withClient((client) => client.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: DIGEST_REPORT_KEY }, orderBy: { createdAt: 'asc' }, select: SUBSCRIPTION }))
  return { digest: settingsView(row) }
}

/** PUT /notifications/digest: turn my digest on or off, its time, weekdays and kinds; the version as read (0: none yet). */
export async function saveDigest(caller: CommandCaller, context: OfficeContext, body: DigestSettings & { readonly version: number }, idempotencyKey?: string) {
  const problems = digestProblems(body)
  if (problems.length > 0) throw new ValidationError('The digest settings are not valid.', problems)
  await command(caller, { name: 'notifications.saveDigest', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "ReportSubscription" WHERE "userId" = ${context.actorId}::uuid AND "reportKey" = ${DIGEST_REPORT_KEY} FOR UPDATE`
    const existing = await tx.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: DIGEST_REPORT_KEY }, orderBy: { createdAt: 'asc' }, select: SUBSCRIPTION })
    if ((existing?.version ?? 0) !== body.version) {
      const message = `Your digest settings changed since you read them (now version ${existing?.version ?? 0}). Read them again.`
      throw new ValidationError(message, [{ path: 'body/version', message }])
    }
    const user = await tx.user.findUnique({ where: { id: context.actorId }, select: { locale: true } })
    if (!user) throw new NotFoundError('Person not found.')
    const data = { active: body.on, sendTime: body.sendTime, weekdays: [...body.weekdays], params: { categories: [...body.categories] }, locale: localeOf(user.locale) }
    let id: string
    if (existing) {
      id = existing.id
      await tx.reportSubscription.update({ where: { id }, data: { ...data, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    } else {
      id = newId()
      await tx.reportSubscription.create({ data: { id, userId: context.actorId, reportKey: DIGEST_REPORT_KEY, channel: 'EMAIL', ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    }
    tools.audit({ recordType: 'ReportSubscription', recordId: id, ...(existing ? { before: { on: existing.active, sendTime: existing.sendTime, weekdays: existing.weekdays } } : {}), after: { on: body.on, sendTime: body.sendTime, weekdays: body.weekdays, categories: body.categories } })
    return null
  })
  return readDigest(caller, context)
}

// ---- the run ------------------------------------------------------------------------------------------------------------

const clockOf = (instant: Date): string => new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
const weekdayOf = (instant: Date): number => {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, weekday: 'short' }).format(instant)
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day) + 1
}

export interface DigestRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly runtime?: () => EmailRuntime
}

export interface DigestRunResult {
  readonly due: number
  readonly sent: number
  readonly empty: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it with their clock and email runtime). */
export async function runDigests(options: DigestRunOptions): Promise<DigestRunResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `notifications-digest-${newId()}`
  const at = { weekday: weekdayOf(now), clock: clockOf(now) }
  const result = { due: 0, sent: 0, empty: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const due = await asSystem(options.database, tenantId, requestId, async (client) => {
        const rows = await client.reportSubscription.findMany({ where: { reportKey: DIGEST_REPORT_KEY, active: true, user: { status: 'ACTIVE' } }, orderBy: { id: 'asc' }, select: SUBSCRIPTION })
        return rows.filter((row) => digestDue(row, at, row.lastSentAt !== null && businessDate(row.lastSentAt) === businessDate(now)))
      })
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const subscription of due) {
        result.due += 1
        try {
          const outcome = await sendDigest(caller, subscription, now, (options.runtime ?? processEmail)(), options.clock)
          result[outcome] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, subscriptionId: subscription.id }, 'a daily digest could not be sent')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the daily digests of a tenant could not be read')
    }
  }
  return result
}

type Subscription = { readonly id: string; readonly userId: string; readonly locale: string; readonly params: unknown; readonly lastSentAt: Date | null; readonly version: number }

/** One person's digest (see the module comment). 'sent', 'empty' (nothing to tell: the day marked checked) or 'failed'. */
export async function sendDigest(caller: CommandCaller, subscription: Subscription, now: Date, runtime: EmailRuntime, clock?: Clock): Promise<'sent' | 'empty' | 'failed'> {
  const locale: DigestLocale = subscription.locale === 'en' ? 'en' : 'it'
  const categories = digestCategoriesOf(subscription.params)
  const since = new Date(Math.max(subscription.lastSentAt?.getTime() ?? 0, now.getTime() - DIGEST_LOOKBACK_MS))
  const facts = await caller.withClient(async (client) => {
    const rows = await client.notification.findMany({
      where: { userId: subscription.userId, category: { in: categories }, readAt: null, doneAt: null, createdAt: { gt: since, lte: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: NOTIFICATION_COLUMNS,
    })
    const latest = await latestPerRecord(client, subscription.userId, rows.filter((row) => row.snoozedAt !== null).map((row) => row.recordId))
    const open = rows.filter((row) => stateOf(row, now, latest.get(`${row.recordType}:${row.recordId}`) ?? null) === 'OPEN')
    const user = await client.user.findUnique({ where: { id: subscription.userId }, select: { email: true, displayName: true } })
    const ids = [...new Set(open.flatMap((row) => peopleOf(row)))]
    const names = new Map(ids.length ? (await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]) : [])
    const identities = await client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY })
    // The person's grains now (their live roles): an amount whose grain they lost since the fan-out is left out.
    const tenantId = 'tenantId' in (caller.factoryContext ?? {}) ? (caller.factoryContext as { tenantId: string }).tenantId : ''
    const held = heldGrains({ audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, subscription.userId, now), true) })
    return { open: open.map((row) => ({ ...row, params: paramsFor(row.params, held) })), user, names, identity: identities.find((entry) => identityReady(entry)) ?? null }
  })
  const listed = facts.open.slice(0, DIGEST_MAX_ITEMS)

  const finish = (outcome: 'sent' | 'failed' | 'empty', outboundId: string | null, detail: string | null) =>
    command(caller, { name: 'notifications.digestSent', idempotencyKey: `digest-${subscription.id}-${businessDate(now)}`, input: { subscriptionId: subscription.id, day: businessDate(now) } }, async (tools) => {
      await logDeliveries(
        tools.tx,
        listed.map((row) => ({ id: newId(), notificationId: row.id, outcome: outcome === 'sent' ? 'SENT' : 'FAILED', emailOutboundId: outcome === 'sent' ? outboundId : null, detail: outcome === 'sent' ? null : detail })),
        tools.now,
        tools.context.requestId,
      )
      await tools.tx.reportSubscription.update({ where: { id: subscription.id }, data: { lastSentAt: tools.now, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'ReportSubscription', recordId: subscription.id, after: { outcome, listed: listed.length, more: facts.open.length - listed.length, ...(outboundId ? { emailOutboundId: outboundId } : {}) } })
      if (outcome === 'sent' && outboundId) tools.emit(eventFor(digestSent, { subject: subscription.userId, payload: { userId: subscription.userId, emailOutboundId: outboundId, count: listed.length } }))
      return outcome
    })

  if (listed.length === 0) return (await finish('empty', null, null)).result
  if (!facts.identity || !facts.user) return (await finish('failed', null, !facts.user ? 'the person is not there any more' : 'the tenant has no verified sending identity')).result

  const identity = facts.identity
  const company = await companyLegalOf(caller, identity.companyId)
  const { subject, lines } = digestText(listed, facts.open.length - listed.length, facts.names, locale)
  const greeting = locale === 'it' ? `Ciao ${facts.user.displayName},` : `Hello ${facts.user.displayName},`
  const intro = locale === 'it' ? 'ecco cosa ti aspetta nella fabbrica:' : 'this is what waits for you in the factory:'
  const footer = footerOf(company, privacyNoticeUrl(runtime.webOrigin, identity.companyId), locale)
  const text = [greeting, intro, '', ...lines, '', footer.text].join('\n')
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(intro)}</p><ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^• /, ''))}</li>`).join('')}</ul>${footer.html}`
  const from = fromLine(identity, null)
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  await command(caller, { name: 'email.queueSystem', input: { kind: DIGEST_TEMPLATE_KEY, userId: subscription.userId } }, async ({ tx, now: at, audit }) => {
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'User',
        recordId: subscription.userId,
        templateKey: DIGEST_TEMPLATE_KEY,
        locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [facts.user!.email.toLowerCase()],
        subject,
        emailMessageId,
        status: 'QUEUED',
        queuedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: DIGEST_TEMPLATE_KEY, userId: subscription.userId, identityId: identity.id, status: 'QUEUED' } })
    return null
  })
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    ...(clock ? { clock } : {}),
    build: async (row) => buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: now, text, html, automatic: true }),
  })
  if (delivered === 'sent') return (await finish('sent', outboundId, null)).result
  return (await finish('failed', null, 'the mail could not be sent (a suppressed address, or the provider refused it)')).result
}

export function digestCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({
    name: 'notifications.digest',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runDigests(options)
      if (result.due > 0) options.log.info({ ...result }, 'daily digests')
    },
  })
}
