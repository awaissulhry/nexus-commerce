import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_REPORTS_SUBSCRIBE, PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { DAILY_REPORT_KEY, reportLocaleOf, subscriptionProblems, type ReportKey } from '@nexus/factory-domain/production/reports/subscriptions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import type { Reader } from '../../planning/store'
import type { ChangeSubscriptionBody, SubscribeBody } from './contract'
import { officeContextOf, siteFor } from './daily'

/**
 * Who gets a production report by e-mail (B-W2a-38; MES-301 "sent each morning"; design production.reports
 * "Email me this report": time, recipients, language; PLT-142 quiet defaults: nothing is sent until someone subscribes).
 * One ReportSubscription per recipient, report and site (views.prisma; B-W2a-01's decision). A person subscribes
 * themselves with production.reports.view; naming colleagues needs production.reports.subscribe at the site, and each
 * colleague must be an ACTIVE office person who may read the report there (their live roles; else 400 at their index).
 * A subscription is seen and changed by its recipient and by the person who made it. Writes are ONE command each
 * (rows locked FOR UPDATE, audited), with production.report_subscription_changed. No floor worker is ever a recipient.
 */

const COLUMNS = {
  id: true,
  userId: true,
  reportKey: true,
  siteId: true,
  companyId: true,
  sendTime: true,
  weekdays: true,
  locale: true,
  active: true,
  lastSentAt: true,
  version: true,
  createdById: true,
  user: { select: { displayName: true } },
  site: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.ReportSubscriptionSelect
type Row = Prisma.ReportSubscriptionGetPayload<{ select: typeof COLUMNS }>

/** The most office people the recipient list reads (a tenant's office staff). */
const MAX_PEOPLE = 500

function viewOf(row: Row, me: string) {
  return {
    id: row.id,
    reportKey: row.reportKey as ReportKey,
    user: { id: row.userId, name: row.user.displayName },
    mine: row.userId === me,
    site: row.site ? { id: row.site.id, code: row.site.code, name: row.site.name } : null,
    sendTime: row.sendTime,
    weekdays: [...row.weekdays],
    locale: reportLocaleOf(row.locale),
    active: row.active,
    lastSentAt: row.lastSentAt ? toUtcIso(row.lastSentAt) : null,
    version: row.version,
  }
}

/** A person as an office actor from their live roles (two-factor taken as proved: a report holds no money). */
export async function readerOf(db: Reader | CommandTx, tenantId: string, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
}

/** GET /production/reports/subscriptions: mine and those I made for colleagues (of one site, when asked). */
export async function listSubscriptions(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeContextOf(caller)
  const rows = await caller.withClient((db) =>
    db.reportSubscription.findMany({
      where: { reportKey: DAILY_REPORT_KEY, OR: [{ userId: context.actorId }, { createdById: context.actorId }], ...(query.siteId ? { siteId: query.siteId } : {}) },
      select: COLUMNS,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  // Mine first.
  const sorted = [...rows.filter((row) => row.userId === context.actorId), ...rows.filter((row) => row.userId !== context.actorId)]
  return { subscriptions: sorted.map((row) => viewOf(row, context.actorId)) }
}

/** GET /production/reports/recipients?siteId (production.reports.subscribe there): who may get the report of the site. */
export async function listRecipients(caller: CommandCaller, siteId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, actor, PRODUCTION_REPORTS_VIEW, siteId)
    if (!can(actor, PRODUCTION_REPORTS_SUBSCRIBE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError()
    const users = await db.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
    const subscribed = new Set(
      (await db.reportSubscription.findMany({ where: { reportKey: DAILY_REPORT_KEY, siteId: site.id, active: true }, select: { userId: true } })).map((row) => row.userId),
    )
    const people: { id: string; name: string; me: boolean; subscribed: boolean }[] = []
    for (const user of users) {
      const reader = await readerOf(db, context.tenantId, user.id, now)
      if (can(reader, PRODUCTION_REPORTS_VIEW, { companyId: site.companyId, siteId: site.id })) people.push({ id: user.id, name: user.displayName, me: user.id === context.actorId, subscribed: subscribed.has(user.id) })
    }
    return { people: [...people.filter((person) => person.me), ...people.filter((person) => !person.me)] }
  })
}

function settingsProblems(body: { readonly sendTime: string; readonly weekdays: readonly number[] }): Issue[] {
  return subscriptionProblems({ sendTime: body.sendTime, weekdays: body.weekdays })
}

/** POST /production/reports/subscriptions: subscribe me, or colleagues, to the daily report of one site. */
export async function subscribe(caller: CommandCaller, body: SubscribeBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const problems = settingsProblems(body)
  if (problems.length > 0) throw new ValidationError('The e-mail settings are not valid.', problems)
  const recipients = [...new Set(body.recipients ?? [context.actorId])]
  const site = await caller.withClient((db) => siteFor(db, actor, PRODUCTION_REPORTS_VIEW, body.siteId))
  if (recipients.some((userId) => userId !== context.actorId) && !can(actor, PRODUCTION_REPORTS_SUBSCRIBE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError()

  const { result, replayed } = await command(caller, { name: 'production.subscribeReport', idempotencyKey, input: { ...body, recipients } }, async (tools) => {
    const { tx, now } = tools
    // Who they are now, and whether each may read the report at the site.
    const users = await tx.user.findMany({ where: { id: { in: recipients } }, select: { id: true, status: true, locale: true } })
    const refused: Issue[] = []
    for (const [index, userId] of recipients.entries()) {
      const user = users.find((entry) => entry.id === userId)
      if (!user || user.status !== 'ACTIVE') {
        refused.push({ path: `body/recipients/${index}`, message: 'Not an active person of this tenant.' })
        continue
      }
      if (!can(await readerOf(tx, context.tenantId, userId, now), PRODUCTION_REPORTS_VIEW, { companyId: site.companyId, siteId: site.id }))
        refused.push({ path: `body/recipients/${index}`, message: `This person may not read the production reports of ${site.code}.` })
    }
    if (refused.length > 0) throw new ValidationError('Some people cannot get this report.', refused)
    await tx.$queryRaw`SELECT id FROM "ReportSubscription" WHERE "reportKey" = ${body.reportKey} AND "siteId" = ${site.id}::uuid AND "userId" = ANY(${recipients}::uuid[]) FOR UPDATE`
    const existing = await tx.reportSubscription.findMany({ where: { reportKey: body.reportKey, siteId: site.id, userId: { in: recipients } }, select: COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const ids: string[] = []
    for (const userId of recipients) {
      const user = users.find((entry) => entry.id === userId)!
      const locale = reportLocaleOf(body.locale, user.locale)
      const data = { sendTime: body.sendTime, weekdays: [...body.weekdays], locale, active: true }
      const row = existing.find((entry) => entry.userId === userId)
      if (row) {
        await tx.reportSubscription.update({ where: { id: row.id }, data: { ...data, version: row.version + 1, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'ReportSubscription', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { active: row.active, sendTime: row.sendTime, weekdays: row.weekdays, locale: row.locale }, after: data })
        ids.push(row.id)
      } else {
        const id = newId()
        await tx.reportSubscription.create({
          data: { id, userId, locale, reportKey: body.reportKey, companyId: site.companyId, siteId: site.id, params: {}, channel: 'EMAIL', sendTime: body.sendTime, weekdays: [...body.weekdays], active: true, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
        tools.audit({ recordType: 'ReportSubscription', recordId: id, companyId: site.companyId, siteId: site.id, after: { ...data, userId, reportKey: body.reportKey } })
        ids.push(id)
      }
    }
    tools.emit({ type: 'production.report_subscription_changed', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { reportKey: body.reportKey, siteId: site.id, subscriptionIds: ids, change: 'SUBSCRIBED' } })
    const saved = await tx.reportSubscription.findMany({ where: { id: { in: ids } }, select: COLUMNS })
    return ids.map((id) => viewOf(saved.find((row) => row.id === id)!, context.actorId))
  })
  return { subscriptions: result, replayed }
}

/** PATCH /production/reports/subscriptions/:id: on or off, time, weekdays, language (its recipient or its maker). */
export async function changeSubscription(caller: CommandCaller, subscriptionId: string, body: ChangeSubscriptionBody, idempotencyKey?: string) {
  const context: OfficeContext = officeContextOf(caller)
  const actor = actorOf(context)
  const row = isUuid(subscriptionId) ? await caller.withClient((db) => db.reportSubscription.findUnique({ where: { id: subscriptionId }, select: COLUMNS })) : null
  if (!row || (row.userId !== context.actorId && row.createdById !== context.actorId)) throw new NotFoundError('Subscription not found.')
  if (row.companyId && row.siteId && !can(actor, PRODUCTION_REPORTS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Subscription not found.')
  const next = { active: body.active ?? row.active, sendTime: body.sendTime ?? row.sendTime, weekdays: body.weekdays ? [...body.weekdays] : [...row.weekdays], locale: body.locale ?? reportLocaleOf(row.locale) }
  const problems = settingsProblems(next)
  if (problems.length > 0) throw new ValidationError('The e-mail settings are not valid.', problems)
  const { result } = await command(caller, { name: 'production.changeReportSubscription', idempotencyKey, input: { subscriptionId, ...body }, record: { type: 'ReportSubscription', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const current = await tools.tx.reportSubscription.findUnique({ where: { id: row.id }, select: COLUMNS })
    if (!current) throw new ConflictError('This subscription is gone; read the page again.')
    await tools.tx.reportSubscription.update({ where: { id: row.id }, data: { ...next, updatedAt: tools.now }, select: { id: true } })
    tools.audit({
      recordType: 'ReportSubscription',
      recordId: row.id,
      ...(row.companyId ? { companyId: row.companyId } : {}),
      ...(row.siteId ? { siteId: row.siteId } : {}),
      before: { active: current.active, sendTime: current.sendTime, weekdays: current.weekdays, locale: current.locale },
      after: next,
    })
    tools.emit({
      type: 'production.report_subscription_changed',
      subject: row.siteId ?? row.id,
      ...(row.companyId ? { companyId: row.companyId } : {}),
      ...(row.siteId ? { siteId: row.siteId } : {}),
      payload: { reportKey: row.reportKey, siteId: row.siteId, subscriptionIds: [row.id], change: next.active ? 'CHANGED' : 'TURNED_OFF' },
    })
    const saved = await tools.tx.reportSubscription.findUnique({ where: { id: row.id }, select: COLUMNS })
    return viewOf(saved!, context.actorId)
  })
  return { subscription: result }
}
