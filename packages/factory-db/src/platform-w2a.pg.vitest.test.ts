import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedAlerts } from '../seed/alerts'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCalendar } from '../seed/calendar'
import { seed as seedCollab } from '../seed/collab'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedInsights } from '../seed/insights'
import { seed as seedOps } from '../seed/ops'
import { seed as seedReasons } from '../seed/reasons'
import { seed as seedSearch } from '../seed/search'
import { seed as seedViews } from '../seed/views'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import type { Prisma } from './generated/prisma/client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The platform schema of W2a (wave 1/7) beyond the generated isolation tests, on a database built from the migrations
 * and seeded, through the real login and the scoped client (…_platform_w2a_guards):
 *   - the seeds are idempotent;
 *   - the delivery log, the mentions, the alerts' history and the restore drills are append-only for every login;
 *   - calendars name exactly their owner (one ACTIVE each), working weekdays and patterns hold, breaks lie inside shifts;
 *   - notifications keep what they say; deliveries, mentions, followers and tasks keep their rules;
 *   - saved views, exports and subscriptions; alert rules, alerts (one unresolved per condition, history at commit),
 *     their history and timers (one PENDING per record and key, final once fired or cancelled);
 *   - reasons (the floor reads them), search (typo tolerant, pg_trgm), restore drills;
 *   - the W0/W1 changes: the virus scan of StoredFile, Today's snooze, Site.floorLocales, the state a Device reports.
 * The refusals are check_violation (SQLSTATE 23514) or restrict_violation (files), read in their words.
 */

const NS = 'platform-w2a-db'
const DENIED = /permission denied/
const UNIQUE = /Unique constraint|unique|duplicate key/i
let db: MigratedDatabase
let factory: FactoryDatabase
let core: CoreSeed

const key = (name: string): string => seedUuid(NS, name)
const companyA = key('company:A')
const companyB = key('company:B')
const siteA1 = key('site:A1')
const ownerId = key('actor')
const memberId = key('user:member')
const tablet = key('device:A1:cutting')

const office = (): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: core.tenantId, actorId: tablet, siteId: siteA1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const inTx = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  as(office(), (client) => client.$transaction((tx) => work(tx)))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [core.tenantId]))[0]!.n)
const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`)

const PLATFORM_TABLES = [
  'WorkCalendar', 'CalendarDay', 'ShiftPattern', 'ShiftSegment', 'Notification', 'NotificationDelivery', 'RecordFollower', 'MessageMention', 'Task',
  'SavedView', 'ExportJob', 'ReportSubscription', 'AlertRule', 'Alert', 'AlertEvent', 'DueTimer', 'ReasonCode', 'SearchEntry', 'RestoreDrill',
] as const
const SEEDS = [seedCalendar, seedReasons, seedCollab, seedViews, seedAlerts, seedSearch, seedOps]

beforeAll(async () => {
  db = await migratedDatabase('platform_w2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  core = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  await seedInsights({ db: factory, namespace: NS })
  for (const seed of SEEDS) await seed({ db: factory, namespace: NS })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seeds', () => {
  it('are idempotent: a second run inserts nothing', async () => {
    const before = await Promise.all(PLATFORM_TABLES.map(count))
    for (const seed of SEEDS) await seed({ db: factory, namespace: NS })
    expect(await Promise.all(PLATFORM_TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
  })

  it("hold Italy's national holidays of 2026 and 2027 on each company's calendar, and the base reason lists", async () => {
    const holidays = await admin(`SELECT count(*)::int AS n FROM "CalendarDay" WHERE "tenantId" = $1 AND "calendarId" = $2 AND "holidaySet" = 'IT'`, [core.tenantId, key('calendar:company:A')])
    expect(holidays[0]!.n).toBe(24)
    const lists = await admin(`SELECT DISTINCT "list"::text AS list FROM "ReasonCode" WHERE "tenantId" = $1`, [core.tenantId])
    expect(lists).toHaveLength(11)
  })
})

describe('the append-only tables', () => {
  it.each([
    ['NotificationDelivery', 'detail'],
    ['MessageMention', 'recordType'],
    ['AlertEvent', 'requestId'],
    ['RestoreDrill', 'notes'],
  ])('%s: nobody changes or removes a row, the owner included', async (table, column) => {
    const [row] = await admin(`SELECT "id" FROM "${table}" WHERE "tenantId" = $1 LIMIT 1`, [core.tenantId])
    await expect(run(office(), `UPDATE "${table}" SET "${column}" = 'x' WHERE "id" = $1::uuid`, row!.id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "${table}" WHERE "id" = $1::uuid`, row!.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "${table}" SET "${column}" = 'x' WHERE "id" = $1`, [row!.id])).rejects.toThrow(/never changed/)
    await expect(admin(`DELETE FROM "${table}" WHERE "id" = $1`, [row!.id])).rejects.toThrow(/never changed/)
    await expect(admin(`TRUNCATE "${table}"`)).rejects.toThrow(/is refused/)
  })
})

describe('calendars and shift patterns', () => {
  const calendar = (data: Record<string, unknown>) => as(office(), (client) => client.workCalendar.create({ data: { id: randomUUID(), name: 'Test calendar', ...data } as never, select: { id: true } }))

  it('names exactly its owner, one ACTIVE calendar per owner; the owner never changes; archived, never deleted', async () => {
    await expect(calendar({ scope: 'SITE', companyId: companyA })).rejects.toThrow(/names exactly its owner/)
    await expect(calendar({ scope: 'COMPANY', companyId: companyA, siteId: siteA1 })).rejects.toThrow(/names exactly its owner/)
    await expect(calendar({ scope: 'COMPANY', companyId: companyA })).rejects.toThrow(UNIQUE)
    const archived = await calendar({ scope: 'COMPANY', companyId: companyA, status: 'ARCHIVED' })
    await expect(run(office(), `UPDATE "WorkCalendar" SET "status" = 'ACTIVE' WHERE "id" = $1::uuid`, archived.id)).rejects.toThrow(UNIQUE)
    await expect(run(office(), `UPDATE "WorkCalendar" SET "companyId" = $1::uuid WHERE "id" = $2::uuid`, companyB, archived.id)).rejects.toThrow(/keeps its scope and its owner/)
    await expect(run(office(), `DELETE FROM "WorkCalendar" WHERE "id" = $1::uuid`, archived.id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "WorkCalendar" WHERE "id" = $1`, [archived.id])).rejects.toThrow(/archived, never deleted/)
  })

  it('works on ascending ISO weekdays; a supplier keeps its days, not our shifts, in its own company', async () => {
    for (const workingWeekdays of [[], [5, 1], [0, 1], [1, 8], [1, 1]]) {
      await expect(calendar({ scope: 'COMPANY', companyId: companyB, status: 'ARCHIVED', workingWeekdays })).rejects.toThrow(/working weekdays/)
    }
    const supplier = { scope: 'SUPPLIER', partyId: key('party:P2'), status: 'ARCHIVED' }
    await expect(calendar({ ...supplier, companyId: companyA, shiftPatternId: key('calendar:pattern:1T') })).rejects.toThrow(/not our shifts/)
    await expect(calendar({ ...supplier, companyId: companyB })).rejects.toThrow(/supplier's company/)
    expect((await calendar({ ...supplier, companyId: companyA })).id).toBeDefined()
  })

  it('a day: a holiday or a closure has no shifts, a supplier day none of ours; its calendar and date never change', async () => {
    const add = (data: Record<string, unknown>) =>
      as(office(), (client) => client.calendarDay.create({ data: { id: randomUUID(), calendarId: key('calendar:site:A1'), date: day('2026-11-20'), kind: 'WORKING', name: 'Test', ...data } as never, select: { id: true } }))
    await expect(add({ kind: 'CLOSURE', shiftPatternId: key('calendar:pattern:2T') })).rejects.toThrow(/has no shifts/)
    await expect(add({ calendarId: key('calendar:supplier:P2'), shiftPatternId: key('calendar:pattern:2T') })).rejects.toThrow(/keeps no shifts of ours/)
    await expect(add({ kind: 'CLOSURE', holidaySet: 'IT' })).rejects.toThrow(/only a public holiday/)
    const extra = await add({ shiftPatternId: key('calendar:pattern:SAT-AM') })
    await expect(run(office(), `UPDATE "CalendarDay" SET "date" = '2026-11-21' WHERE "id" = $1::uuid`, extra.id)).rejects.toThrow(/keeps its calendar and its date/)
    expect(await run(office(), `DELETE FROM "CalendarDay" WHERE "id" = $1::uuid`, extra.id)).toBe(1)
  })

  it('a break lies inside a shift of its weekday at commit; a pattern in use is not archived', async () => {
    const patternId = randomUUID()
    const segment = (kind: string, startMinute: number, endMinute: number, weekday = 1) => ({ id: randomUUID(), patternId, weekday, kind, startMinute, endMinute }) as never
    await inTx(async (tx) => {
      await tx.shiftPattern.create({ data: { id: patternId, code: `T-${patternId.slice(0, 6)}`, name: 'Test pattern' }, select: { id: true } })
      await tx.shiftSegment.createMany({ data: [segment('SHIFT', 360, 840), segment('BREAK', 600, 615)] })
    })
    await expect(inTx((tx) => tx.shiftSegment.create({ data: segment('BREAK', 900, 915), select: { id: true } }))).rejects.toThrow(/outside every shift/)
    await expect(run(office(), `DELETE FROM "ShiftSegment" WHERE "patternId" = $1::uuid AND "kind" = 'SHIFT'`, patternId)).rejects.toThrow(/outside every shift/)
    await expect(inTx((tx) => tx.shiftSegment.create({ data: segment('SHIFT', 1320, 2800), select: { id: true } }))).rejects.toThrow(/at most 24 hours/)
    await expect(inTx((tx) => tx.shiftSegment.create({ data: segment('SHIFT', 360, 840, 8), select: { id: true } }))).rejects.toThrow(/ISO weekday/)
    // A night shift runs past midnight; the whole pattern is replaced in one command.
    await inTx(async (tx) => {
      await tx.shiftSegment.deleteMany({ where: { patternId } })
      await tx.shiftSegment.createMany({ data: [segment('SHIFT', 1320, 1800), segment('BREAK', 1560, 1580)] })
    })
    await expect(run(office(), `UPDATE "ShiftPattern" SET "status" = 'ARCHIVED' WHERE "id" = $1::uuid`, key('calendar:pattern:2T'))).rejects.toThrow(/used by an active calendar/)
    await expect(run(office(), `UPDATE "ShiftPattern" SET "code" = 'X' WHERE "id" = $1::uuid`, patternId)).rejects.toThrow(/keeps its code and its company/)
  })
})

describe('notifications, deliveries, followers, mentions and tasks', () => {
  const mention = key('collab:notification:mention')
  const mentionId = `00000000${mention.slice(8)}`

  it('a notification keeps what it says; its person reads, finishes and snoozes it; one per person per event', async () => {
    await expect(run(office(), `UPDATE "Notification" SET "messageKey" = 'x' WHERE "id" = $1::uuid`, mentionId)).rejects.toThrow(/keeps what it says/)
    expect(await run(office(), `UPDATE "Notification" SET "readAt" = now(), "snoozedAt" = now(), "snoozedUntil" = now() + interval '1 hour' WHERE "id" = $1::uuid`, mentionId)).toBe(1)
    await expect(run(office(), `UPDATE "Notification" SET "snoozedUntil" = "snoozedAt" - interval '1 hour' WHERE "id" = $1::uuid`, mentionId)).rejects.toThrow(/until a later one/)
    const [row] = await admin(`SELECT "eventId", "eventType", "userId" FROM "Notification" WHERE "id" = $1`, [mentionId])
    const again = { id: randomUUID(), userId: row!.userId, category: 'MENTION', eventType: row!.eventType, eventId: row!.eventId, recordType: 'Quote', recordId: randomUUID(), recordLabel: 'Q', messageKey: 'k' }
    await expect(as(office(), (client) => client.notification.create({ data: again as never, select: { id: true } }))).rejects.toThrow(UNIQUE)
  })

  it('a delivery: an e-mail sent names its mail; skipped or failed says why', async () => {
    const delivery = (data: Record<string, unknown>) =>
      as(office(), (client) => client.notificationDelivery.create({ data: { id: randomUUID(), notificationId: mentionId, channel: 'EMAIL', at: new Date(), requestId: 'test', ...data } as never, select: { id: true } }))
    await expect(delivery({ outcome: 'SENT' })).rejects.toThrow(/names its mail/)
    await expect(delivery({ outcome: 'SKIPPED' })).rejects.toThrow(/says why/)
    await expect(delivery({ channel: 'PUSH', outcome: 'SENT', emailOutboundId: randomUUID() })).rejects.toThrow(/names its mail/)
    expect((await delivery({ outcome: 'FAILED', detail: 'No address' })).id).toBeDefined()
  })

  it('a mention names a person its note mentions, with the note’s thread, author and time', async () => {
    const [mentioned] = await admin(`SELECT * FROM "MessageMention" WHERE "tenantId" = $1 LIMIT 1`, [core.tenantId])
    const copy = (data: Record<string, unknown>) =>
      as(office(), (client) =>
        client.messageMention.create({
          data: { id: randomUUID(), messageId: mentioned!.messageId, threadId: mentioned!.threadId, recordType: mentioned!.recordType, recordId: mentioned!.recordId, userId: mentioned!.userId, authorId: mentioned!.authorId, at: mentioned!.at, ...data } as never,
          select: { id: true },
        }),
      )
    await expect(copy({ userId: ownerId })).rejects.toThrow(/names a person its note mentions/)
    await expect(copy({ at: new Date('2020-01-01T00:00:00.000Z') })).rejects.toThrow(/names a person its note mentions/)
    await expect(copy({ recordId: randomUUID() })).rejects.toThrow(/its thread's record/)
  })

  it('a follower keeps its record, person and reason; mute or unfollow', async () => {
    const follower = key('collab:follower:quote:member')
    await expect(run(office(), `UPDATE "RecordFollower" SET "reason" = 'CHOSE' WHERE "id" = $1::uuid`, follower)).rejects.toThrow(/keeps its record, its person/)
    expect(await run(office(), `UPDATE "RecordFollower" SET "muted" = true WHERE "id" = $1::uuid`, follower)).toBe(1)
  })

  it('a task: closed exactly with its time, a due time on its day, it stays on its record; cancelled, never deleted', async () => {
    const task = `00000000${key('collab:task:open').slice(8)}`
    await expect(run(office(), `UPDATE "Task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, task)).rejects.toThrow(/closing time/)
    await expect(run(office(), `UPDATE "Task" SET "dueDate" = NULL WHERE "id" = $1::uuid`, task)).rejects.toThrow(/due time/)
    await expect(run(office(), `UPDATE "Task" SET "recordId" = $1::uuid WHERE "id" = $2::uuid`, randomUUID(), task)).rejects.toThrow(/stays on its record/)
    await expect(run(office(), `UPDATE "Task" SET "assignedAt" = NULL WHERE "id" = $1::uuid`, task)).rejects.toThrow(/assigned to a person, by someone, at a time/)
    await expect(run(office(), `UPDATE "Task" SET "status" = 'DONE', "closedAt" = now(), "snoozedUntil" = now() WHERE "id" = $1::uuid`, task)).rejects.toThrow(/only an open task is snoozed/)
    expect(await run(office(), `UPDATE "Task" SET "status" = 'DONE', "closedAt" = now(), "closedById" = $1::uuid WHERE "id" = $2::uuid`, memberId, task)).toBe(1)
    expect(await run(office(), `UPDATE "Task" SET "status" = 'OPEN', "closedAt" = NULL, "closedById" = NULL WHERE "id" = $1::uuid`, task)).toBe(1)
    await expect(admin(`DELETE FROM "Task" WHERE "id" = $1`, [task])).rejects.toThrow(/cancelled, never deleted/)
  })
})

describe('saved views, exports and report subscriptions', () => {
  it('a view is shared with an office role exactly when it names one; one role default per list, role and company', async () => {
    const view = (data: Record<string, unknown>) =>
      as(office(), (client) => client.savedView.create({ data: { id: randomUUID(), listKey: 'sales.orders', name: `View ${randomUUID().slice(0, 6)}`, ownerId, state: {}, ...data } as never, select: { id: true } }))
    await expect(view({ audience: 'ROLE' })).rejects.toThrow(/names a role exactly when/)
    await expect(view({ roleDefault: true })).rejects.toThrow(/names a role exactly when/)
    await expect(view({ audience: 'ROLE', roleId: key('role:operator') })).rejects.toThrow(/an office role/)
    await expect(view({ audience: 'ROLE', roleId: key('role:sales'), roleDefault: true, companyId: companyA })).rejects.toThrow(UNIQUE)
    expect((await view({ audience: 'ROLE', roleId: key('role:sales'), roleDefault: true, companyId: companyB })).id).toBeDefined()
    await expect(view({ listKey: 'Sales Orders' })).rejects.toThrow(/page id/)
    await expect(run(office(), `UPDATE "SavedView" SET "listKey" = 'sales.quotes' WHERE "id" = $1::uuid`, key('views:view:this-week'))).rejects.toThrow(/keeps its owner and its list/)
  })

  it('an export: born QUEUED, moves forward only, DONE with its own file, FAILED final', async () => {
    const exportId = randomUUID()
    const base = { companyId: companyA, requestedById: ownerId, listKey: 'sales.orders', format: 'CSV', query: {} }
    await expect(as(office(), (client) => client.exportJob.create({ data: { id: randomUUID(), ...base, status: 'RUNNING', startedAt: new Date() } as never, select: { id: true } }))).rejects.toThrow(/a new export is QUEUED/)
    await as(office(), (client) => client.exportJob.create({ data: { id: exportId, ...base } as never, select: { id: true } }))
    await expect(run(office(), `UPDATE "ExportJob" SET "status" = 'DONE' WHERE "id" = $1::uuid`, exportId)).rejects.toThrow(/without its times, count, file/)
    await expect(run(office(), `UPDATE "ExportJob" SET "status" = 'RUNNING', "startedAt" = now(), "rowCount" = 10, "rowsDone" = 11 WHERE "id" = $1::uuid`, exportId)).rejects.toThrow(/never more than its count/)
    expect(await run(office(), `UPDATE "ExportJob" SET "status" = 'RUNNING', "startedAt" = now(), "rowCount" = 10 WHERE "id" = $1::uuid`, exportId)).toBe(1)
    await expect(
      run(office(), `UPDATE "ExportJob" SET "status" = 'DONE', "finishedAt" = now(), "rowsDone" = 10, "fileId" = $1::uuid WHERE "id" = $2::uuid`, key('files:office'), exportId),
    ).rejects.toThrow(/a file of that export/)
    await expect(run(office(), `UPDATE "ExportJob" SET "listKey" = 'sales.quotes' WHERE "id" = $1::uuid`, exportId)).rejects.toThrow(/keeps what was asked/)
    const failed = key('views:export:failed')
    await expect(run(office(), `UPDATE "ExportJob" SET "status" = 'QUEUED', "finishedAt" = NULL, "failureReason" = NULL WHERE "id" = $1::uuid`, failed)).rejects.toThrow(/changes no more/)
    await expect(admin(`DELETE FROM "ExportJob" WHERE "id" = $1`, [failed])).rejects.toThrow(/never deleted/)
  })

  it('a subscription: a report, a language, a time of day and its weekdays; a site only with its company', async () => {
    const subscription = (data: Record<string, unknown>) =>
      as(office(), (client) => client.reportSubscription.create({ data: { id: randomUUID(), userId: memberId, locale: 'it', reportKey: 'production.daily', sendTime: '07:30', ...data } as never, select: { id: true } }))
    await expect(subscription({ sendTime: '7:30' })).rejects.toThrow(/time of day/)
    await expect(subscription({ weekdays: [6, 1] })).rejects.toThrow(/time of day/)
    await expect(subscription({ reportKey: 'daily' })).rejects.toThrow(/names its report/)
    await expect(subscription({ siteId: siteA1 })).rejects.toThrow(/a site only with its company/)
    const made = await subscription({ companyId: companyA, siteId: siteA1 })
    expect(await run(office(), `DELETE FROM "ReportSubscription" WHERE "id" = $1::uuid`, made.id)).toBe(1)
  })
})

describe('alert rules, alerts, their history and timers', () => {
  const ruleHold = key('alerts:rule:HOLD_TOO_LONG')
  const raise = (recordId: string, data: Record<string, unknown> = {}) =>
    as(office(), (client) =>
      client.alert.create({
        data: { id: randomUUID(), ruleId: ruleHold, ruleKind: 'HOLD_TOO_LONG', severity: 'WARNING', recordType: 'Lot', recordId, recordLabel: 'LOT', dedupeKey: `HOLD_TOO_LONG:${recordId}`, raisedAt: new Date(), ...data } as never,
        select: { id: true },
      }),
    )
  const event = (alertId: string, data: Record<string, unknown>) => ({ id: randomUUID(), alertId, requestId: 'test', ...data }) as never

  it('a rule keeps its kind and trigger, tells an office role by one or more channels; switched off, never deleted', async () => {
    await expect(run(office(), `UPDATE "AlertRule" SET "ruleKind" = 'OTHER' WHERE "id" = $1::uuid`, ruleHold)).rejects.toThrow(/keeps its kind/)
    await expect(run(office(), `UPDATE "AlertRule" SET "recipientRoleId" = $1::uuid WHERE "id" = $2::uuid`, key('role:operator'), ruleHold)).rejects.toThrow(/office role/)
    await expect(run(office(), `UPDATE "AlertRule" SET "channels" = '{}' WHERE "id" = $1::uuid`, ruleHold)).rejects.toThrow(/one or more channels/)
    await expect(run(office(), `UPDATE "AlertRule" SET "siteId" = $1::uuid, "companyId" = NULL WHERE "id" = $2::uuid`, siteA1, ruleHold)).rejects.toThrow(/a site only with its company/)
    expect(await run(office(), `UPDATE "AlertRule" SET "enabled" = false WHERE "id" = $1::uuid`, ruleHold)).toBe(1)
    await expect(admin(`DELETE FROM "AlertRule" WHERE "id" = $1`, [ruleHold])).rejects.toThrow(/never deleted/)
  })

  it('one unresolved alert per condition; raised OPEN with nothing done; raised again only after its resolution', async () => {
    const lot = randomUUID()
    await expect(raise(lot, { dedupeKey: `ORDER_LATE_RISK:${lot}` })).rejects.toThrow(/keyed <rule kind>:<record id>/)
    await expect(raise(lot, { ruleKind: 'ORDER_LATE_RISK', dedupeKey: `ORDER_LATE_RISK:${lot}` })).rejects.toThrow(/its rule's kind/)
    await expect(raise(lot, { state: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: ownerId })).rejects.toThrow(/raised OPEN/)
    const first = await raise(lot)
    await expect(raise(lot, { occurrence: 2 })).rejects.toThrow(/raised again only after/)
    const at = new Date('2026-10-30T10:00:00.000Z')
    await expect(run(office(), `UPDATE "Alert" SET "state" = 'ACKNOWLEDGED', "acknowledgedAt" = $1, "acknowledgedById" = $2::uuid WHERE "id" = $3::uuid`, at, ownerId, first.id)).rejects.toThrow(/not in its history/)
    await expect(run(office(), `UPDATE "Alert" SET "state" = 'RESOLVED', "resolvedAt" = $1, "resolution" = 'HANDLED', "resolvedById" = $2::uuid WHERE "id" = $3::uuid`, at, ownerId, first.id)).rejects.toThrow(/with a note/)
    await inTx(async (tx) => {
      await tx.alertEvent.create({ data: event(first.id, { verb: 'RESOLVED', actorId: ownerId, note: 'Released after the lab report.', at }), select: { id: true } })
      await tx.alert.update({ where: { id: first.id }, data: { state: 'RESOLVED', resolvedAt: at, resolution: 'HANDLED', resolvedById: ownerId, resolveNote: 'Released after the lab report.' }, select: { id: true } })
    })
    await expect(run(office(), `UPDATE "Alert" SET "facts" = '{"x":1}' WHERE "id" = $1::uuid`, first.id)).rejects.toThrow(/keeps its rule, its record and why/)
    await expect(run(office(), `UPDATE "Alert" SET "resolveNote" = 'changed' WHERE "id" = $1::uuid`, first.id)).rejects.toThrow(/changes no more/)
    await expect(raise(lot)).rejects.toThrow(UNIQUE)
    expect((await raise(lot, { occurrence: 2 })).id).toBeDefined()
    await expect(admin(`DELETE FROM "Alert" WHERE "id" = $1`, [first.id])).rejects.toThrow(/never deleted/)
  })

  it('the history carries what its verb needs: a snooze its until-time, a person’s resolution its note', async () => {
    const alertId = key('alerts:alert:hold:lot')
    const add = (data: Record<string, unknown>) => as(office(), (client) => client.alertEvent.create({ data: event(alertId, { at: new Date(), ...data }), select: { id: true } }))
    await expect(add({ verb: 'SNOOZED', actorId: ownerId })).rejects.toThrow(/what its verb needs/)
    await expect(add({ verb: 'RESOLVED', actorId: ownerId })).rejects.toThrow(/what its verb needs/)
    await expect(add({ verb: 'RAISED', actorId: ownerId, facts: {} })).rejects.toThrow(/what its verb needs/)
    await expect(add({ verb: 'ASSIGNED', actorId: ownerId })).rejects.toThrow(/what its verb needs/)
    expect((await add({ verb: 'UNASSIGNED', actorId: ownerId, assigneeId: memberId })).id).toBeDefined()
  })

  it('a timer: one PENDING per record and key, a DATE rule, what it watches never changes, final once fired or cancelled', async () => {
    const pending = key('alerts:timer:certificate:pending')
    const fired = `00000000${key('alerts:timer:certificate:fired').slice(8)}`
    const [row] = await admin(`SELECT * FROM "DueTimer" WHERE "id" = $1`, [pending])
    const timer = (data: Record<string, unknown>) =>
      as(office(), (client) =>
        client.dueTimer.create({
          data: { id: randomUUID(), timerKey: row!.timerKey, recordType: row!.recordType, recordId: row!.recordId, dueAt: new Date(), fireAt: new Date(), ...data } as never,
          select: { id: true },
        }),
      )
    await expect(timer({})).rejects.toThrow(UNIQUE)
    await expect(timer({ timerKey: 'certificate expiry' })).rejects.toThrow(/names its kind and offset/)
    await expect(timer({ timerKey: 'PO_CONFIRM_BY', ruleId: ruleHold })).rejects.toThrow(/DATE rule/)
    await expect(timer({ timerKey: 'PO_CONFIRM_BY', status: 'CANCELLED', cancelledAt: new Date() })).rejects.toThrow(/its time and reason/)
    await expect(run(office(), `UPDATE "DueTimer" SET "fireAt" = now() WHERE "id" = $1::uuid`, pending)).rejects.toThrow(/keeps what it watches/)
    await expect(run(office(), `UPDATE "DueTimer" SET "status" = 'PENDING', "firedAt" = NULL WHERE "id" = $1::uuid`, fired)).rejects.toThrow(/changes no more/)
    await expect(admin(`DELETE FROM "DueTimer" WHERE "id" = $1`, [pending])).rejects.toThrow(/never deleted/)
  })
})

describe('reasons, search and restore drills', () => {
  it('the floor reads the reason lists and writes none; a code and its list never change; never deleted', async () => {
    const seen = await as(floor(), (client) => client.reasonCode.findMany({ where: { list: 'PAUSE' }, select: { code: true } }))
    expect(seen.map((reason) => reason.code)).toContain('MATERIAL_WAIT')
    await expect(run(floor(), `UPDATE "ReasonCode" SET "active" = false`)).rejects.toThrow(DENIED)
    const reason = key('reasons:PAUSE:BREAK')
    await expect(run(office(), `UPDATE "ReasonCode" SET "code" = 'PAUSE' WHERE "id" = $1::uuid`, reason)).rejects.toThrow(/keeps its list and its code/)
    await expect(run(office(), `UPDATE "ReasonCode" SET "colour" = 'red' WHERE "id" = $1::uuid`, reason)).rejects.toThrow(/#RRGGBB/)
    await expect(run(office(), `UPDATE "ReasonCode" SET "labelI18n" = '{"RO": "Pauză"}' WHERE "id" = $1::uuid`, reason)).rejects.toThrow(/keyed by language code/)
    expect(await run(office(), `UPDATE "ReasonCode" SET "labelI18n" = '{"ro": "Pauză"}', "active" = false WHERE "id" = $1::uuid`, reason)).toBe(1)
    await expect(admin(`DELETE FROM "ReasonCode" WHERE "id" = $1`, [reason])).rejects.toThrow(/set inactive, never deleted/)
  })

  it('search forgives typos (pg_trgm) and an entry stays its record’s', async () => {
    const found = await as(office(), (client) =>
      client.$queryRawUnsafe<{ number: string }[]>(`SELECT "number" FROM "SearchEntry" WHERE "searchText" % $1 ORDER BY similarity("searchText", $1) DESC`, 'seed custmer one'),
    )
    expect(found[0]!.number).toBe('SEED-C1')
    const entry = key('search:order:SO1')
    await expect(run(office(), `UPDATE "SearchEntry" SET "recordId" = $1::uuid WHERE "id" = $2::uuid`, randomUUID(), entry)).rejects.toThrow(/stays the entry of its record/)
    await expect(run(office(), `UPDATE "SearchEntry" SET "viewPermission" = 'orders' WHERE "id" = $1::uuid`, entry)).rejects.toThrow(/the permission that sees it/)
  })

  it('a drill passes only when every check matches; its evidence is a file of that drill', async () => {
    const drill = (data: Record<string, unknown>) =>
      as(office(), (client) =>
        client.restoreDrill.create({
          data: { id: randomUUID(), drilledOn: day('2026-10-29'), environment: 'staging', checks: [{ key: 'orders', match: true }], result: 'PASSED', performedById: ownerId, requestId: 'test', ...data } as never,
          select: { id: true },
        }),
      )
    await expect(drill({ checks: [{ key: 'orders', match: true }, { key: 'invoices', match: false }] })).rejects.toThrow(/every check matches/)
    await expect(drill({ checks: [] })).rejects.toThrow(/lists its checks/)
    await expect(drill({ checks: [{ key: 'orders' }] })).rejects.toThrow(/lists its checks/)
    await expect(drill({ evidenceFileId: key('files:office') })).rejects.toThrow(/a file of that drill/)
    expect((await drill({ result: 'FAILED', checks: [{ key: 'orders', match: false }] })).id).toBeDefined()
  })
})

describe('the W0/W1 changes', () => {
  const upload = async (): Promise<string> => {
    const fileId = randomUUID()
    await as(office(), (client) =>
      client.storedFile.create({
        data: {
          id: fileId, recordType: 'Tenant', recordId: core.tenantId, kind: 'ATTACHMENT', originalName: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 10,
          sha256: 'a'.repeat(64), storeAccountId: key('files:account:r2'), storageKey: `t/${core.tenantId}/tenant/2026/${fileId}`,
        },
        select: { id: true },
      }),
    )
    return fileId
  }
  const file = (text: string, fileId: string, ...values: unknown[]) => run(office(), `UPDATE "StoredFile" SET ${text} WHERE "id" = $1::uuid`, fileId, ...values)
  const verdict = (status: string, finding: string | null = null) => `"scanStatus" = '${status}', "scannedAt" = now(), "scanEngine" = 'ClamAV test', "scanFinding" = ${finding ? `'${finding}'` : 'NULL'}`

  it('an upload waits for its scan in quarantine and becomes available only clean', async () => {
    const fileId = await upload()
    await expect(
      as(office(), (client) => client.storedFile.create({ data: { id: randomUUID(), recordType: 'Tenant', recordId: core.tenantId, kind: 'ATTACHMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1, sha256: 'b'.repeat(64), storeAccountId: key('files:account:r2'), storageKey: `t/${core.tenantId}/tenant/2026/${randomUUID()}`, scanStatus: 'PENDING' }, select: { id: true } })),
    ).rejects.toThrow(/a new file is NOT_SCANNED/)
    expect(await file(`"status" = 'QUARANTINED', "quarantineReason" = 'scan_pending', "scanStatus" = 'PENDING'`, fileId)).toBe(1)
    await expect(file(`"status" = 'AVAILABLE', "availableAt" = now()`, fileId)).rejects.toThrow(/cannot move from QUARANTINED to AVAILABLE/)
    await expect(file(`"scanStatus" = 'CLEAN'`, fileId)).rejects.toThrow(/time and scanner exactly with a verdict/)
    expect(await file(`"status" = 'AVAILABLE', "availableAt" = now(), ${verdict('CLEAN')}`, fileId)).toBe(1)
    // A rescan with new signatures finds it infected: it goes back to quarantine and stays there.
    expect(await file(`"scanStatus" = 'PENDING', "scannedAt" = NULL, "scanEngine" = NULL`, fileId)).toBe(1)
    await expect(file(verdict('INFECTED', 'Eicar-Test-Signature'), fileId)).rejects.toThrow(/infected; it is never available/)
    expect(await file(`"status" = 'QUARANTINED', "quarantineReason" = 'virus_found', ${verdict('INFECTED', 'Eicar-Test-Signature')}`, fileId)).toBe(1)
    await expect(file(`"scanStatus" = 'PENDING', "scannedAt" = NULL, "scanEngine" = NULL, "scanFinding" = NULL`, fileId)).rejects.toThrow(/cannot move from INFECTED to PENDING/)
  })

  it('a file quarantined for what it is (a size mismatch) never becomes available, even scanned clean', async () => {
    const fileId = await upload()
    expect(await file(`"status" = 'QUARANTINED', "quarantineReason" = 'size_mismatch'`, fileId)).toBe(1)
    expect(await file(`"scanStatus" = 'PENDING'`, fileId)).toBe(1)
    await expect(file(`"status" = 'AVAILABLE', "availableAt" = now(), ${verdict('CLEAN')}`, fileId)).rejects.toThrow(/cannot move from QUARANTINED to AVAILABLE/)
  })

  it("Today's snooze is the condition, who, when and until when, and it is in the history at commit", async () => {
    const actionId = key('insights:action:SO1')
    const condition = '5eed0000000000000000000000000001'
    const at = new Date('2026-10-30T11:00:00.000Z')
    const until = new Date('2026-10-31T07:00:00.000Z')
    const [action] = await admin(`SELECT * FROM "AttentionAction" WHERE "id" = $1`, [actionId])
    const log = (data: Record<string, unknown>) => ({
      id: randomUUID(), actionId, rowKey: action!.rowKey, kind: action!.kind, recordType: action!.recordType, recordId: action!.recordId, recordLabel: 'SEED-SO-0001',
      companyId: action!.companyId, partyId: action!.partyId, condition, actorId: ownerId, at, requestId: 'test', ...data,
    }) as never
    await expect(run(office(), `UPDATE "AttentionAction" SET "snoozedCondition" = $1, "snoozedById" = $2::uuid, "snoozedAt" = $3 WHERE "id" = $4::uuid`, condition, ownerId, at, actionId)).rejects.toThrow(/snooze of Today action .* is not in its history/)
    await expect(run(office(), `UPDATE "AttentionAction" SET "snoozedUntil" = $1 WHERE "id" = $2::uuid`, until, actionId)).rejects.toThrow(/snoozed in a condition, by someone, at a time/)
    await expect(as(office(), (client) => client.attentionActionLog.create({ data: log({ verb: 'SNOOZED', note: 'later' }), select: { id: true } }))).rejects.toThrow(/a snooze .* names no assignee and carries no note/)
    await expect(as(office(), (client) => client.attentionActionLog.create({ data: log({ verb: 'ACKNOWLEDGED', snoozedUntil: until }), select: { id: true } }))).rejects.toThrow(/only a snooze/)
    await inTx(async (tx) => {
      await tx.attentionActionLog.create({ data: log({ verb: 'SNOOZED', snoozedUntil: until }), select: { id: true } })
      await tx.attentionAction.update({ where: { id: actionId }, data: { snoozedCondition: condition, snoozedById: ownerId, snoozedAt: at, snoozedUntil: until }, select: { id: true } })
    })
    const [snoozed] = await admin(`SELECT "snoozedUntil" FROM "AttentionAction" WHERE "id" = $1`, [actionId])
    expect((snoozed!.snoozedUntil as Date).toISOString()).toBe(until.toISOString())
  })

  it("a site's floor languages are ISO 639 codes, each once, at least one", async () => {
    for (const locales of ['{}', '{it,it}', '{it,IT}', '{it,italiano}']) {
      await expect(run(office(), `UPDATE "Site" SET "floorLocales" = $1::text[] WHERE "id" = $2::uuid`, locales, siteA1)).rejects.toThrow(/floor languages/)
    }
    expect(await run(office(), `UPDATE "Site" SET "floorLocales" = '{it,en,ro}' WHERE "id" = $1::uuid`, siteA1)).toBe(1)
    const [site] = await as(floor(), (client) => client.$queryRawUnsafe<{ floorLocales: string[] }[]>(`SELECT "floorLocales" FROM "Site"`))
    expect(site!.floorLocales).toEqual(['it', 'en', 'ro'])
  })

  it('a tablet reports its own state: battery 0-100 %, its queue, with the time', async () => {
    const report = (text: string) => run(floor(), `UPDATE "Device" SET ${text} WHERE "id" = $1::uuid`, tablet)
    await expect(report(`"batteryPercent" = 120, "statusReportedAt" = now()`)).rejects.toThrow(/reports its battery/)
    await expect(report(`"queuedActions" = -1, "statusReportedAt" = now()`)).rejects.toThrow(/reports its battery/)
    await expect(report(`"batteryPercent" = 80`)).rejects.toThrow(/with the time it reported them/)
    expect(await report(`"batteryPercent" = 80, "batteryCharging" = false, "queuedActions" = 0, "statusReportedAt" = now()`)).toBe(1)
  })
})
