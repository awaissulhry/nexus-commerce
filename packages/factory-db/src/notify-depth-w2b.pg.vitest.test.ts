import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedNotifyDepth, type NotifyDepthSeed } from '../seed/notify-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Notifications, My work and mail in depth (W2b-6, schema wave 47/57, B-W2b-366, …_notify_depth_w2b_guards) on a database
 * built from the migrations and seeded twice, through the real login and the office scope:
 *   - preferences and role defaults: one row per person (role), kind and channel by its key, the daily digest only by
 *     e-mail, an office person's and an office role's, only the cadence moves, removed to reset;
 *   - push subscriptions: https endpoints, live only with keys sealed for push, the keys going only once turned off,
 *     turned off once and frozen, one live per endpoint, never deleted;
 *   - view follows: an ONLY_ME view only by its owner, the count all three or none and only forward, gone with the view;
 *   - reminders: born waiting, a time after `since`, put off only with a later `since`, came back once, done frozen but
 *     Undo, a message of the record's own thread;
 *   - team inboxes, capture addresses and a mail's team-inbox columns, also on a MATCHED mail; a later MATCHED mail on
 *     the thread ends the earlier mails' follow-ups;
 *   - the bounce kind written with bouncedAt; the inquiry addresses.
 * The refusals are check_violation (23514) in words, or the unique keys' 23505.
 */

const NS = 'w2b-366-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: NotifyDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const sql = (text: string, ...values: unknown[]) => as(office(), (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns), as the office. */
const copyRow = (table: string, id: string, changes: Record<string, unknown>) =>
  run(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const update = (table: string, id: string, set: string, ...values: unknown[]) => run(`UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const later = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()

/** A partner user of P1 (no office person): the rules that ask for an office person refuse them. */
let partnerUser: string

beforeAll(async () => {
  db = await migratedDatabase('notifydepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedNotifyDepth({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedNotifyDepth({ db: factory, namespace: NS })
  partnerUser = randomUUID()
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId", "partnerKind") VALUES ($1::uuid, $2::uuid, $3, 'Seed portal buyer', 'ACTIVE', 'PARTNER', $4::uuid, 'CUSTOMER')`, [
    partnerUser, a.tenantId, `buyer.${partnerUser.slice(0, 8)}@example.com`, key('party:P1'),
  ])
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row', async () => {
    const counts = await admin(
      `SELECT (SELECT count(*)::int FROM "NotificationPreference" WHERE "tenantId" = $1::uuid) AS preferences,
              (SELECT count(*)::int FROM "RoleNotificationDefault" WHERE "tenantId" = $1::uuid) AS defaults,
              (SELECT count(*)::int FROM "PushSubscription" WHERE "tenantId" = $1::uuid) AS pushes,
              (SELECT count(*)::int FROM "ViewFollower" WHERE "tenantId" = $1::uuid) AS follows,
              (SELECT count(*)::int FROM "Reminder" WHERE "tenantId" = $1::uuid) AS reminders,
              (SELECT count(*)::int FROM "TeamInbox" WHERE "tenantId" = $1::uuid) AS inboxes,
              (SELECT count(*)::int FROM "CaptureAddress" WHERE "tenantId" = $1::uuid) AS captures,
              (SELECT count(*)::int FROM "InboundEmail" WHERE "tenantId" = $1::uuid AND "teamInboxId" IS NOT NULL) AS mails`,
      [a.tenantId],
    )
    expect(counts[0]).toEqual({ preferences: 4, defaults: 3, pushes: 3, follows: 2, reminders: 3, inboxes: 4, captures: 3, mails: 4 })
  })
})

describe('notification preferences and role defaults (PLT-141)', () => {
  const insertPreference = (userId: string, event: string, channel: string, cadence: string, rowKey = `pref:${userId}:${event}:${channel}`) =>
    run(`INSERT INTO "NotificationPreference" (id, "userId", event, channel, cadence, key) VALUES ($1::uuid, $2::uuid, $3::"NotificationEventKind", $4::"NotificationPreferenceChannel", $5::"NotificationCadence", $6)`, randomUUID(), userId, event, channel, cadence, rowKey)

  it('keeps one row per person, kind and channel by its key, and only the cadence moves', async () => {
    await expect(insertPreference(s.ownerId, 'MENTIONED', 'PUSH', 'OFF')).rejects.toThrow(/NotificationPreference_tenantId_key_key|duplicate key/)
    await expect(insertPreference(s.ownerId, 'ASSIGNED', 'EMAIL', 'INSTANT', `pref:${s.memberId}:ASSIGNED:EMAIL`)).rejects.toThrow(/pref:<person>:<kind>:<channel>/)
    const first = s.preferenceIds[0] as string
    expect(await update('NotificationPreference', first, `cadence = 'OFF'`)).toBe(1)
    await expect(update('NotificationPreference', first, `channel = 'EMAIL'`)).rejects.toThrow(/only its cadence moves/)
  })

  it('has a daily digest only by e-mail, and is an office person\'s', async () => {
    await expect(insertPreference(s.memberId, 'APPROVAL_WAITING', 'PUSH', 'DAILY_DIGEST')).rejects.toThrow(/only e-mail has a daily digest/)
    await expect(insertPreference(partnerUser, 'MENTIONED', 'EMAIL', 'INSTANT')).rejects.toThrow(/an office person's choice/)
    expect(await insertPreference(s.memberId, 'APPROVAL_WAITING', 'EMAIL', 'DAILY_DIGEST')).toBe(1)
  })

  it('is removed to reset to the role defaults', async () => {
    expect(await insertPreference(s.memberId, 'AREA_ALERT', 'IN_APP', 'OFF')).toBe(1)
    expect(await run(`DELETE FROM "NotificationPreference" WHERE "userId" = $1::uuid AND event = 'AREA_ALERT'`, s.memberId)).toBe(1)
  })

  it('takes role defaults of office roles only', async () => {
    const [floorRole] = await admin(`SELECT id FROM "Role" WHERE "tenantId" = $1::uuid AND audience = 'FLOOR' ORDER BY key LIMIT 1`, [a.tenantId])
    const insertDefault = (roleId: string, event: string, channel: string, cadence: string) =>
      run(`INSERT INTO "RoleNotificationDefault" (id, "roleId", event, channel, cadence, key) VALUES ($1::uuid, $2::uuid, $3::"NotificationEventKind", $4::"NotificationPreferenceChannel", $5::"NotificationCadence", $6)`, randomUUID(), roleId, event, channel, cadence, `default:${roleId}:${event}:${channel}`)
    await expect(insertDefault(floorRole!.id as string, 'MENTIONED', 'PUSH', 'INSTANT')).rejects.toThrow(/of an office role/)
    const [sales] = await admin(`SELECT "roleId" FROM "RoleNotificationDefault" WHERE id = $1::uuid`, [s.roleDefaultIds[0]])
    await expect(insertDefault(sales!.roleId as string, 'ASSIGNED', 'IN_APP', 'DAILY_DIGEST')).rejects.toThrow(/only e-mail has a daily digest/)
    expect(await insertDefault(sales!.roleId as string, 'ASSIGNED', 'IN_APP', 'INSTANT')).toBe(1)
    await expect(update('RoleNotificationDefault', s.roleDefaultIds[0] as string, `"roleId" = $2::uuid`, floorRole!.id)).rejects.toThrow(/never change; only its cadence moves/)
  })
})

describe('push subscriptions (PLT-140)', () => {
  const newSecret = async (purpose: string): Promise<string> => {
    const secretId = randomUUID()
    await run(
      `INSERT INTO "SecretValue" (id, purpose, "keyId", algorithm, "wrappedKey", iv, ciphertext, "authTag") VALUES ($1::uuid, $2, 'seed:not-a-key', 'AES-256-GCM', '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)`,
      secretId,
      purpose,
    )
    return secretId
  }
  const insertPush = (endpoint: string, keysSecretId: string | null, userId = s.memberId) =>
    run(`INSERT INTO "PushSubscription" (id, "userId", "deviceLabel", endpoint, "keysSecretId") VALUES ($1::uuid, $2::uuid, 'Test phone', $3, $4::uuid)`, randomUUID(), userId, endpoint, keysSecretId)

  it('is live only with keys sealed for push, at an https endpoint, for an office person', async () => {
    await expect(insertPush('https://push.example.com/test/no-keys', null)).rejects.toThrow(/is live, so it has its sealed keys/)
    await expect(insertPush('https://push.example.com/test/other', await newSecret('integration.credentials'))).rejects.toThrow(/purpose notifications.push/)
    await expect(insertPush('http://push.example.com/test/plain', await newSecret('notifications.push'))).rejects.toThrow(/https address/)
    await expect(insertPush('https://push.example.com/test/partner', await newSecret('notifications.push'), partnerUser)).rejects.toThrow(/an office person's device/)
    expect(await insertPush('https://push.example.com/test/ok', await newSecret('notifications.push'))).toBe(1)
  })

  it('has one live subscription per endpoint; a turned-off one\'s endpoint may come back', async () => {
    const [phone] = await admin(`SELECT endpoint FROM "PushSubscription" WHERE id = $1::uuid`, [s.pushIds.ownerPhone])
    await expect(insertPush(phone!.endpoint as string, await newSecret('notifications.push'))).rejects.toThrow(/PushSubscription_one_live_endpoint|duplicate key/)
    const [old] = await admin(`SELECT endpoint FROM "PushSubscription" WHERE id = $1::uuid`, [s.pushIds.ownerOld])
    expect(await insertPush(old!.endpoint as string, await newSecret('notifications.push'), s.ownerId)).toBe(1)
  })

  it('keeps its keys while live, loses them only once turned off, then changes no more', async () => {
    const secretId = await newSecret('notifications.push')
    const endpoint = `https://push.example.com/test/${randomUUID()}`
    expect(await insertPush(endpoint, secretId)).toBe(1)
    const [row] = await sql(`SELECT id::text FROM "PushSubscription" WHERE endpoint = $1`, endpoint)
    const id = row!.id as string
    await expect(update('PushSubscription', id, `"keysSecretId" = NULL`)).rejects.toThrow(/go only once it is turned off/)
    await expect(update('PushSubscription', id, `"keysSecretId" = $2::uuid`, await newSecret('notifications.push'))).rejects.toThrow(/never change/)
    expect(await update('PushSubscription', id, `"lastUsedAt" = $2::timestamptz`, ago(5))).toBe(1)
    await expect(update('PushSubscription', id, `"lastUsedAt" = $2::timestamptz`, ago(60))).rejects.toThrow(/never goes back/)
    await expect(update('PushSubscription', id, `"revokedAt" = $2::timestamptz`, later(60))).rejects.toThrow(/not in the future/)
    expect(await update('PushSubscription', id, `"revokedAt" = now(), "keysSecretId" = NULL`)).toBe(1)
    expect(await run(`DELETE FROM "SecretValue" WHERE id = $1::uuid`, secretId)).toBe(1)
    await expect(update('PushSubscription', id, `"deviceLabel" = 'Renamed'`)).rejects.toThrow(/turned off .*changes no more/)
    await expect(update('PushSubscription', id, `"endpoint" = 'https://push.example.com/elsewhere'`)).rejects.toThrow(/never change/)
  })

  it('is never deleted, also not by the owner login', async () => {
    await expect(admin(`DELETE FROM "PushSubscription" WHERE id = $1::uuid`, [s.pushIds.ownerOld])).rejects.toThrow(/kept, never deleted/)
  })
})

describe('following a saved view (PLT-151)', () => {
  it('follows a view only its owner sees only as its owner, by its key', async () => {
    await expect(
      run(`INSERT INTO "ViewFollower" (id, "userId", "viewId", key) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, randomUUID(), s.memberId, s.viewIds.lateOrders, `view:${s.viewIds.lateOrders}:${s.memberId}`),
    ).rejects.toThrow(/its owner's alone/)
    await expect(
      run(`INSERT INTO "ViewFollower" (id, "userId", "viewId", key) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, randomUUID(), s.ownerId, s.viewIds.thisWeek, `view:${s.viewIds.thisWeek}:${randomUUID()}`),
    ).rejects.toThrow(/view:<view>:<person>/)
    await expect(
      run(`INSERT INTO "ViewFollower" (id, "userId", "viewId", key) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, randomUUID(), s.memberId, s.viewIds.thisWeek, `view:${s.viewIds.thisWeek}:${s.memberId}`),
    ).rejects.toThrow(/ViewFollower_tenantId_key_key|duplicate key/)
  })

  it('counts with all three or none, and only forward', async () => {
    const id = s.viewFollowerIds.memberWeek
    await expect(update('ViewFollower', id, `"lastCount" = 4`)).rejects.toThrow(/all three or none/)
    await expect(update('ViewFollower', id, `"lastFingerprint" = 'abc', "lastCount" = 4, "lastCountedAt" = now()`)).rejects.toThrow(/SHA-256/)
    expect(await update('ViewFollower', id, `"lastFingerprint" = repeat('a', 64), "lastCount" = 4, "lastCountedAt" = now()`)).toBe(1)
    await expect(update('ViewFollower', id, `"lastCountedAt" = now() - interval '1 day'`)).rejects.toThrow(/only moves forward/)
    await expect(update('ViewFollower', id, `"lastFingerprint" = NULL, "lastCount" = NULL, "lastCountedAt" = NULL`)).rejects.toThrow(/only moves forward/)
  })

  it('goes with its view when the view is deleted', async () => {
    const viewId = randomUUID()
    await run(`INSERT INTO "SavedView" (id, "listKey", name, "ownerId", audience, state) VALUES ($1::uuid, 'sales.orders', $2, $3::uuid, 'EVERYONE', '{}'::jsonb)`, viewId, `Test ${viewId.slice(0, 8)}`, s.ownerId)
    expect(await run(`INSERT INTO "ViewFollower" (id, "userId", "viewId", key) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`, randomUUID(), s.memberId, viewId, `view:${viewId}:${s.memberId}`)).toBe(1)
    expect(await run(`DELETE FROM "SavedView" WHERE id = $1::uuid`, viewId)).toBe(1)
    expect(await sql(`SELECT 1 FROM "ViewFollower" WHERE "viewId" = $1::uuid`, viewId)).toEqual([])
  })
})

describe('reminders (COL-041)', () => {
  /** A new waiting AT_TIME reminder of the member on SEED-SO-0001, set an hour ago, coming back in an hour. */
  const newReminder = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    expect(await copyRow('Reminder', s.reminderIds.ownerPo, { id, userId: s.memberId, since: ago(60), remindAt: later(60), ...changes })).toBe(1)
    return id
  }

  it('is born waiting, with its time after it was set, for an office person', async () => {
    await expect(newReminder({ cameBackAt: ago(5) })).rejects.toThrow(/starts waiting/)
    await expect(newReminder({ remindAt: null })).rejects.toThrow(/its time exactly when it comes back AT_TIME/)
    await expect(newReminder({ kind: 'ON_CHANGE' })).rejects.toThrow(/its time exactly when it comes back AT_TIME/)
    await expect(newReminder({ remindAt: ago(90) })).rejects.toThrow(/comes back after it was set/)
    await expect(newReminder({ since: later(30), remindAt: later(90) })).rejects.toThrow(/not in the future/)
    await expect(newReminder({ userId: partnerUser })).rejects.toThrow(/reminds an office person/)
    await expect(newReminder({ recordType: 'purchase order' })).rejects.toThrow(/is a model name/)
    expect(await newReminder({ kind: 'ON_CHANGE', remindAt: null })).toBeTruthy()
  })

  it('names a message of its record\'s own thread', async () => {
    await expect(newReminder({ messageId: key('threads:message:quote-in') })).rejects.toThrow(/of the thread of its record/)
    expect(await newReminder({ messageId: key('threads:message:quote-in'), recordType: 'Quote', recordId: key('quote:Q1'), recordLabel: 'SEED-QT-0001' })).toBeTruthy()
  })

  it('comes back once, and is put off only with a later since, which leaves it waiting again', async () => {
    const id = await newReminder()
    await expect(update('Reminder', id, `"remindAt" = $2::timestamptz`, later(120))).rejects.toThrow(/only when it is put off/)
    expect(await update('Reminder', id, `"cameBackAt" = now()`)).toBe(1)
    await expect(update('Reminder', id, `"cameBackAt" = NULL`)).rejects.toThrow(/clears only when it is put off again/)
    await expect(update('Reminder', id, `since = now(), "remindAt" = $2::timestamptz`, later(24 * 60))).rejects.toThrow(/waits again/)
    expect(await update('Reminder', id, `since = now(), "remindAt" = $2::timestamptz, "cameBackAt" = NULL`, later(24 * 60))).toBe(1)
    await expect(update('Reminder', id, `since = since - interval '1 day'`)).rejects.toThrow(/never goes back/)
    await expect(update('Reminder', id, `"recordLabel" = 'Other'`)).rejects.toThrow(/never changes/)
  })

  it('is frozen once done but for Undo, and its person removes it', async () => {
    const id = await newReminder()
    expect(await update('Reminder', id, `"doneAt" = now()`)).toBe(1)
    await expect(update('Reminder', id, `note = 'More words'`)).rejects.toThrow(/is done; it changes no more/)
    await expect(update('Reminder', id, `"doneAt" = now() - interval '1 minute'`)).rejects.toThrow(/is done; it changes no more/)
    expect(await update('Reminder', id, `"doneAt" = NULL`)).toBe(1)
    expect(await update('Reminder', id, `note = 'More words'`)).toBe(1)
    expect(await run(`DELETE FROM "Reminder" WHERE id = $1::uuid`, id)).toBe(1)
  })
})

describe('team inboxes and capture addresses (COL-021, COL-027)', () => {
  const insertInbox = (changes: Record<string, unknown>) => copyRow('TeamInbox', s.teamInboxIds.aQuotes, { id: randomUUID(), name: `Inbox ${randomUUID().slice(0, 6)}`, localPart: `box${randomUUID().slice(0, 6)}`, ...changes })

  it('has a lower-case local part that is no reply or capture address, and office people as members, each once', async () => {
    await expect(insertInbox({ localPart: 'Orders' })).rejects.toThrow(/lower-case letters/)
    await expect(insertInbox({ localPart: 'r-orders' })).rejects.toThrow(/cannot start with r- or c-/)
    await expect(insertInbox({ memberIds: [s.memberId, s.memberId] })).rejects.toThrow(/each once/)
    await expect(insertInbox({ memberIds: [partnerUser] })).rejects.toThrow(/office person of the tenant who has not left/)
    await expect(insertInbox({ name: 'Quotes', localPart: 'other' })).rejects.toThrow(/TeamInbox_tenantId_companyId_name_key|duplicate key/)
    expect(await insertInbox({ memberIds: [s.ownerId] })).toBe(1)
    await expect(update('TeamInbox', s.teamInboxIds.aQuotes, `"companyId" = $2::uuid`, s.companyB)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "TeamInbox" WHERE id = $1::uuid`, [s.teamInboxIds.aSamples])).rejects.toThrow(/kept, never deleted/)
  })

  it('keeps one live capture address per company; a turned-off one changes no more', async () => {
    const insertCapture = (changes: Record<string, unknown>) =>
      copyRow('CaptureAddress', s.captureIds.aLive, { id: randomUUID(), token: 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20) + randomUUID().replace(/[^a-z2-7]/g, 'a').slice(0, 6), ...changes })
    await expect(insertCapture({})).rejects.toThrow(/CaptureAddress_one_live|duplicate key/)
    await expect(insertCapture({ token: 'NOT-A-TOKEN-0000000000000000', revokedAt: ago(1) })).rejects.toThrow(/lower-case base32/)
    await expect(insertCapture({ revokedAt: ago(1), defaultTeamInboxId: s.teamInboxIds.aSamples })).rejects.toThrow(/default team inbox .*is switched off/)
    await expect(update('CaptureAddress', s.captureIds.aOld, `"defaultTeamInboxId" = $2::uuid`, s.teamInboxIds.aOrders)).rejects.toThrow(/turned off .*changes no more/)
    await expect(update('CaptureAddress', s.captureIds.bLive, `"defaultTeamInboxId" = $2::uuid`, s.teamInboxIds.aOrders)).rejects.toThrow(/foreign key/)
    expect(await update('CaptureAddress', s.captureIds.bLive, `"defaultTeamInboxId" = $2::uuid`, s.teamInboxIds.bOrders)).toBe(1)
  })
})

describe('a mail in a team inbox (COL-027)', () => {
  it('lands in an inbox of its company that is switched on, assigned with who and when to an office person', async () => {
    const mail = s.mailIds.held
    await expect(update('InboundEmail', mail, `"teamInboxId" = $2::uuid`, s.teamInboxIds.bOrders)).rejects.toThrow(/team inbox of its own company/)
    await expect(update('InboundEmail', mail, `"teamInboxId" = $2::uuid`, s.teamInboxIds.aSamples)).rejects.toThrow(/is switched off/)
    await expect(update('InboundEmail', mail, `"assigneeId" = $2::uuid`, s.ownerId)).rejects.toThrow(/both or neither/)
    await expect(update('InboundEmail', mail, `"assigneeId" = $2::uuid, "assignedAt" = now()`, partnerUser)).rejects.toThrow(/assigned to an office person/)
    await expect(update('InboundEmail', mail, `"closedById" = $2::uuid`, s.ownerId)).rejects.toThrow(/comes with when/)
    expect(await update('InboundEmail', mail, `"teamInboxId" = $2::uuid, "assigneeId" = $3::uuid, "assignedAt" = now(), "snoozedUntil" = now() + interval '1 day'`, s.teamInboxIds.aQuotes, s.ownerId)).toBe(1)
  })

  it('still moves its team-inbox columns once MATCHED, and nothing else; a REJECTED mail changes no more', async () => {
    const thread = key('threads:quote:Q1')
    const matched = randomUUID()
    expect(
      await copyRow('InboundEmail', s.mailIds.triage, {
        id: matched, sesMessageId: `test-${matched}`, emailMessageId: `<seed-${NS}-quote-in@example.com>`, receiptId: randomUUID(), status: 'MATCHED',
        threadId: thread, messageId: key('threads:message:quote-in'), matchedBy: 'SENDER', assigneeId: null, assignedAt: null,
      }),
    ).toBe(1)
    expect(await update('InboundEmail', matched, `"assigneeId" = $2::uuid, "assignedAt" = now(), "closedAt" = now(), "closedById" = $2::uuid, "followUpUntil" = now() + interval '3 days'`, s.memberId)).toBe(1)
    await expect(update('InboundEmail', matched, `"lastError" = 'changed'`)).rejects.toThrow(/is MATCHED; it changes no more/)
    await expect(update('InboundEmail', s.mailIds.rejected, `"teamInboxId" = $2::uuid`, s.teamInboxIds.aOrders)).rejects.toThrow(/is REJECTED; it changes no more/)
  })

  it('ends the follow-ups of a thread\'s earlier mails when a later mail joins it, but a REJECTED one keeps its own', async () => {
    const thread = key('threads:quote:Q1')
    const earlier = randomUUID()
    const rejected = randomUUID()
    expect(await copyRow('InboundEmail', s.mailIds.triage, { id: earlier, sesMessageId: `test-${earlier}`, emailMessageId: `<${earlier}@example.com>`, receiptId: randomUUID(), threadId: thread, followUpUntil: later(3 * 24 * 60) })).toBe(1)
    expect(
      await copyRow('InboundEmail', s.mailIds.rejected, { id: rejected, sesMessageId: `test-${rejected}`, emailMessageId: `<${rejected}@example.com>`, receiptId: randomUUID(), threadId: thread, followUpUntil: later(3 * 24 * 60) }),
    ).toBe(1)
    const [before] = await sql(`SELECT version FROM "InboundEmail" WHERE id = $1::uuid`, earlier)
    // The partner's answer: a new INBOUND mail of the thread, read after the earlier one, joins it.
    const message = randomUUID()
    const reply = randomUUID()
    await run(
      `INSERT INTO "Message" SELECT * FROM jsonb_populate_record(NULL::"Message", (SELECT to_jsonb(m) || $1::jsonb FROM "Message" m WHERE m.id = $2::uuid))`,
      JSON.stringify({ id: message, emailMessageId: `<${reply}@example.com>`, at: new Date().toISOString(), createdAt: new Date().toISOString() }),
      key('threads:message:quote-in'),
    )
    expect(
      await copyRow('InboundEmail', s.mailIds.triage, {
        id: reply, sesMessageId: `test-${reply}`, emailMessageId: `<${reply}@example.com>`, receiptId: randomUUID(), receivedAt: new Date().toISOString(), status: 'MATCHED',
        threadId: thread, messageId: message, matchedBy: 'HEADERS', assigneeId: null, assignedAt: null,
      }),
    ).toBe(1)
    const rows = await sql(`SELECT id::text, "followUpUntil" IS NULL AS ended, version FROM "InboundEmail" WHERE id IN ($1::uuid, $2::uuid)`, earlier, rejected)
    expect(rows.find((row) => row.id === earlier)).toEqual({ id: earlier, ended: true, version: (before!.version as number) + 1 })
    expect(rows.find((row) => row.id === rejected)?.ended).toBe(false)
  })
})

describe('delivery status and inquiry addresses (COL-031, SAL-033)', () => {
  const invitation = (): string => key('email:outbound:invitation')

  it('writes PERMANENT with bouncedAt and never clears a bounce kind', async () => {
    await expect(update('EmailOutbound', key('email:outbound:suppressed'), `"bounceKind" = 'PERMANENT'`)).rejects.toThrow(/only with when it bounced/)
    await expect(update('EmailOutbound', invitation(), `"bounceKind" = NULL`)).rejects.toThrow(/never cleared/)
    expect(await update('EmailOutbound', invitation(), `status = 'BOUNCED', "bouncedAt" = now()`)).toBe(1)
    const [row] = await sql(`SELECT "bounceKind"::text AS kind FROM "EmailOutbound" WHERE id = $1::uuid`, invitation())
    expect(row).toEqual({ kind: 'PERMANENT' })
    await expect(update('EmailOutbound', invitation(), `"bouncedAt" = now() + interval '1 second'`)).rejects.toThrow(/set once/)
    // A later transient bounce of a mail that bounced for good leaves it PERMANENT (the database keeps it with bouncedAt).
    expect(await update('EmailOutbound', invitation(), `"bounceKind" = 'TRANSIENT'`)).toBe(1)
    expect(await sql(`SELECT "bounceKind"::text AS kind FROM "EmailOutbound" WHERE id = $1::uuid`, invitation())).toEqual([{ kind: 'PERMANENT' }])
  })

  it('keeps the inquiry addresses lower-case, each once, at most 20', async () => {
    const tenantWide = a.tenantId
    await expect(update('SalesSettings', tenantWide, `"inquiryAddresses" = ARRAY['Sales@example.com']`)).rejects.toThrow(/not a lower-case e-mail address/)
    await expect(update('SalesSettings', tenantWide, `"inquiryAddresses" = ARRAY['sales@example.com', 'sales@example.com']`)).rejects.toThrow(/each once/)
    await expect(update('SalesSettings', tenantWide, `"inquiryAddresses" = NULL`)).rejects.toThrow(/a list/)
    await expect(update('SalesSettings', tenantWide, `"inquiryAddresses" = ARRAY(SELECT 'q' || n || '@example.com' FROM generate_series(1, 21) n)`)).rejects.toThrow(/at most 20/)
    expect(await update('SalesSettings', tenantWide, `"inquiryAddresses" = ARRAY['sales@example.com', 'offerte@example.it']`)).toBe(1)
  })
})
