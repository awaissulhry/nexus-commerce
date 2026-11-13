import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedEmail } from './email'
import { seed as seedEmailIn } from './email-in'
import { seed as seedRoles } from './roles'
import { seed as seedSales } from './sales'
import { seed as seedThreads } from './threads'
import { seed as seedViews } from './views'

/**
 * The notifications, My work and mail seed (W2b schema wave 47/57, B-W2b-366), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the API writes them. The CLI runs the seed files in name order and this one sorts before
 * roles, sales, threads and views, so it runs the auth, roles, views, email-in, email, threads and sales seeds first (each
 * idempotent). Every name, address and endpoint is made up (example domains); nothing seeded can be opened or reached.
 *
 *   preferences     the owner: mentions pushed as they happen (the first row), approvals waiting in the daily digest,
 *                   records followed off in the app; the member: assigned mail pushed as it happens.
 *   role defaults   sales: mentions by e-mail as they happen (the first row), decided approvals in the daily digest;
 *                   planner: area alerts pushed as they happen.
 *   push            the owner's old phone, turned off and its keys gone (the first row); the owner's phone and the
 *                   member's laptop, live, each with its keys sealed in a SecretValue of purpose notifications.push (made-up
 *                   bytes under a key that does not exist: never openable).
 *   view follows    the owner follows their own "Late orders" (counted: 3 rows; the first row); the member follows the
 *                   orders everyone sees this week (not counted yet).
 *   reminders       the owner: SEED-PO-0001 on Monday 08:00 Rome, "Supplier promised a date" (waiting; the first row); the
 *                   buyer's reply on SEED-QT-0001 when the quote changes (came back); the member: SEED-SO-0001 (came back,
 *                   done).
 *   team inboxes    company A: Orders (orders@, the owner and the member; the first row), Quotes (quotes@, the member), an
 *                   old Samples inbox switched off; company B: Orders.
 *   capture         company A: an old address turned off (the first row) and the live one, landing in Orders; company B:
 *                   its live address, landing in mail to sort.
 *   mail            the email-in seed's mail to orders@ put in company A's Orders: the waiting one, the one to sort
 *                   (assigned to the member), the held one, and the unreadable one (closed by the owner). The rejected one
 *                   changes no more.
 *   delivery        the email seed's delivered sign-in mail first bounced TRANSIENT (a full mailbox), then went through.
 *   inquiries       the tenant-wide sales settings: mail to sales@<company A's reply domain> makes an inquiry.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy as the office: so the first push subscription is turned off without keys, the first capture
 * address turned off, the first reminder waiting. The SecretValue rows have ids from `lateId`, so the copies of that table
 * stay the integration seed's. Fixed instants, so nothing depends on the clock. Idempotent: rows are written with
 * skipDuplicates, and the other seeds' rows are changed only where they are still as those seeds left them.
 */

const AT = new Date('2026-11-10T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

export interface NotifyDepthSeed {
  readonly preferenceIds: readonly string[]
  readonly roleDefaultIds: readonly string[]
  readonly pushIds: { readonly ownerOld: string; readonly ownerPhone: string; readonly memberLaptop: string }
  readonly pushSecretIds: { readonly ownerPhone: string; readonly memberLaptop: string }
  readonly viewFollowerIds: { readonly ownerLate: string; readonly memberWeek: string }
  readonly reminderIds: { readonly ownerPo: string; readonly ownerQuoteReply: string; readonly memberOrder: string }
  readonly teamInboxIds: { readonly aOrders: string; readonly aQuotes: string; readonly aSamples: string; readonly bOrders: string }
  readonly captureIds: { readonly aOld: string; readonly aLive: string; readonly bLive: string }
  readonly mailIds: { readonly waiting: string; readonly triage: string; readonly held: string; readonly rejected: string; readonly failed: string }
  readonly viewIds: { readonly lateOrders: string; readonly thisWeek: string }
  readonly ownerId: string
  readonly memberId: string
  readonly companyA: string
  readonly companyB: string
  readonly tenantId: string
}

export async function seed(context: SeedContext): Promise<NotifyDepthSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  await seedViews(context)
  await seedEmailIn(context)
  await seedEmail(context)
  await seedThreads(context)
  await seedSales(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const hex = (text: string): string => createHash('sha256').update(`seed notify-depth ${namespace} ${text}`).digest('hex')
  const bytes = (text: string, length: number): Uint8Array<ArrayBuffer> => new Uint8Array(createHash('sha256').update(`seed notify-depth ${namespace} ${text}`).digest().subarray(0, length))
  /** 26 lower-case base32 characters, as the API makes a capture token (here derived, so a second run makes the same). */
  const token = (text: string): string => [...createHash('sha256').update(`seed notify-depth token ${namespace} ${text}`).digest().subarray(0, 26)].map((byte) => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join('')
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const domain = `reply.company-a.${namespace.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.example.com`

  // --- preferences and role defaults ------------------------------------------------------------------------------------
  const preference = (key: string, userId: string, event: Prisma.NotificationPreferenceCreateManyInput['event'], channel: Prisma.NotificationPreferenceCreateManyInput['channel'], cadence: Prisma.NotificationPreferenceCreateManyInput['cadence'], first = false) =>
    ({ id: first ? firstId(key) : id(key), userId, event, channel, cadence, key: `pref:${userId}:${event}:${channel}`, createdAt: AT, updatedAt: AT }) satisfies Prisma.NotificationPreferenceCreateManyInput
  const preferences = [
    preference('notify-depth:pref:owner:mentioned:push', ownerId, 'MENTIONED', 'PUSH', 'INSTANT', true),
    preference('notify-depth:pref:owner:approval-waiting:email', ownerId, 'APPROVAL_WAITING', 'EMAIL', 'DAILY_DIGEST'),
    preference('notify-depth:pref:owner:following:in-app', ownerId, 'FOLLOWING_CHANGED', 'IN_APP', 'OFF'),
    preference('notify-depth:pref:member:mail-assigned:push', memberId, 'MAIL_ASSIGNED', 'PUSH', 'INSTANT'),
  ]
  const roleDefault = (key: string, roleId: string, event: Prisma.RoleNotificationDefaultCreateManyInput['event'], channel: Prisma.RoleNotificationDefaultCreateManyInput['channel'], cadence: Prisma.RoleNotificationDefaultCreateManyInput['cadence'], first = false) =>
    ({ id: first ? firstId(key) : id(key), roleId, event, channel, cadence, key: `default:${roleId}:${event}:${channel}`, createdAt: AT, updatedAt: AT, createdById: ownerId }) satisfies Prisma.RoleNotificationDefaultCreateManyInput
  const sales = roleIds.sales as string
  const planner = roleIds.planner as string
  const roleDefaults = [
    roleDefault('notify-depth:default:sales:mentioned:email', sales, 'MENTIONED', 'EMAIL', 'INSTANT', true),
    roleDefault('notify-depth:default:sales:approval-decided:email', sales, 'APPROVAL_DECIDED', 'EMAIL', 'DAILY_DIGEST'),
    roleDefault('notify-depth:default:planner:area-alert:push', planner, 'AREA_ALERT', 'PUSH', 'INSTANT'),
  ]

  // --- push -------------------------------------------------------------------------------------------------------------
  const pushSecretIds = { ownerPhone: lateId('notify-depth:secret:owner-phone'), memberLaptop: lateId('notify-depth:secret:member-laptop') }
  const secret = (key: string, secretId: string) =>
    ({
      id: secretId,
      purpose: 'notifications.push',
      keyId: 'seed:not-a-key',
      algorithm: 'AES-256-GCM',
      wrappedKey: bytes(`${key} wrapped`, 32),
      iv: bytes(`${key} iv`, 12),
      ciphertext: bytes(`${key} ciphertext`, 24),
      authTag: bytes(`${key} tag`, 16),
      createdAt: AT,
      updatedAt: AT,
      createdById: ownerId,
    }) satisfies Prisma.SecretValueCreateManyInput
  const pushIds = { ownerOld: firstId('notify-depth:push:owner-old'), ownerPhone: id('notify-depth:push:owner-phone'), memberLaptop: id('notify-depth:push:member-laptop') }
  const endpoint = (key: string): string => `https://push.example.com/seed/${hex(`endpoint ${key}`).slice(0, 32)}`
  const pushes: Prisma.PushSubscriptionCreateManyInput[] = [
    { id: pushIds.ownerOld, userId: ownerId, deviceLabel: 'Old phone', endpoint: endpoint('owner-old'), keysSecretId: null, lastUsedAt: minutes(-7 * 24 * 60), revokedAt: minutes(-60), createdAt: minutes(-30 * 24 * 60), updatedAt: minutes(-60), createdById: ownerId },
    { id: pushIds.ownerPhone, userId: ownerId, deviceLabel: 'Phone', endpoint: endpoint('owner-phone'), keysSecretId: pushSecretIds.ownerPhone, lastUsedAt: minutes(30), createdAt: minutes(-30), updatedAt: minutes(30), createdById: ownerId },
    { id: pushIds.memberLaptop, userId: memberId, deviceLabel: 'Office laptop', endpoint: endpoint('member-laptop'), keysSecretId: pushSecretIds.memberLaptop, createdAt: minutes(5), updatedAt: minutes(5), createdById: memberId },
  ]

  // --- following a saved view (the views seed's) --------------------------------------------------------------------------
  const viewIds = { lateOrders: firstId('views:view:late-orders'), thisWeek: id('views:view:this-week') }
  const viewFollowerIds = { ownerLate: firstId('notify-depth:follow:owner:late-orders'), memberWeek: id('notify-depth:follow:member:this-week') }
  const follows: Prisma.ViewFollowerCreateManyInput[] = [
    { id: viewFollowerIds.ownerLate, userId: ownerId, viewId: viewIds.lateOrders, key: `view:${viewIds.lateOrders}:${ownerId}`, lastFingerprint: hex('late orders ids'), lastCount: 3, lastCountedAt: minutes(60), createdAt: AT, updatedAt: minutes(60) },
    { id: viewFollowerIds.memberWeek, userId: memberId, viewId: viewIds.thisWeek, key: `view:${viewIds.thisWeek}:${memberId}`, createdAt: minutes(10), updatedAt: minutes(10) },
  ]

  // --- reminders ----------------------------------------------------------------------------------------------------------
  const reminderIds = { ownerPo: firstId('notify-depth:reminder:owner:po'), ownerQuoteReply: id('notify-depth:reminder:owner:quote-reply'), memberOrder: id('notify-depth:reminder:member:order') }
  const reminders: Prisma.ReminderCreateManyInput[] = [
    {
      id: reminderIds.ownerPo,
      userId: ownerId,
      companyId: companyA,
      recordType: 'PurchaseOrder',
      recordId: id('link:P2:record'),
      recordLabel: 'SEED-PO-0001',
      kind: 'AT_TIME',
      remindAt: new Date('2026-11-16T07:00:00.000Z'),
      since: AT,
      note: 'Supplier promised a date',
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: reminderIds.ownerQuoteReply,
      userId: ownerId,
      companyId: companyA,
      recordType: 'Quote',
      recordId: id('quote:Q1'),
      recordLabel: 'SEED-QT-0001',
      messageId: id('threads:message:quote-in'),
      kind: 'ON_CHANGE',
      since: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: reminderIds.memberOrder,
      userId: memberId,
      companyId: companyA,
      recordType: 'SalesOrder',
      recordId: id('sales:SO1'),
      recordLabel: 'SEED-SO-0001',
      kind: 'AT_TIME',
      remindAt: minutes(24 * 60),
      since: AT,
      note: 'Ask the customer about the deposit',
      createdAt: AT,
      updatedAt: AT,
    },
  ]

  // --- team inboxes and capture addresses -------------------------------------------------------------------------------
  const teamInboxIds = { aOrders: firstId('notify-depth:inbox:A:orders'), aQuotes: id('notify-depth:inbox:A:quotes'), aSamples: id('notify-depth:inbox:A:samples'), bOrders: id('notify-depth:inbox:B:orders') }
  const inboxes: Prisma.TeamInboxCreateManyInput[] = [
    { id: teamInboxIds.aOrders, companyId: companyA, name: 'Orders', localPart: 'orders', memberIds: [ownerId, memberId], createdAt: AT, updatedAt: AT, createdById: ownerId },
    { id: teamInboxIds.aQuotes, companyId: companyA, name: 'Quotes', localPart: 'quotes', memberIds: [memberId], createdAt: AT, updatedAt: AT, createdById: ownerId },
    { id: teamInboxIds.aSamples, companyId: companyA, name: 'Old samples', localPart: 'samples', memberIds: [], active: false, createdAt: AT, updatedAt: minutes(5), createdById: ownerId },
    { id: teamInboxIds.bOrders, companyId: companyB, name: 'Orders', localPart: 'orders', memberIds: [ownerId], createdAt: AT, updatedAt: AT, createdById: ownerId },
  ]
  const captureIds = { aOld: firstId('notify-depth:capture:A:old'), aLive: id('notify-depth:capture:A:live'), bLive: id('notify-depth:capture:B:live') }
  const captures: Prisma.CaptureAddressCreateManyInput[] = [
    { id: captureIds.aOld, companyId: companyA, token: token('A old'), revokedAt: minutes(-60), createdAt: minutes(-30 * 24 * 60), updatedAt: minutes(-60), createdById: ownerId },
    { id: captureIds.aLive, companyId: companyA, token: token('A live'), defaultTeamInboxId: teamInboxIds.aOrders, createdAt: minutes(-59), updatedAt: minutes(-59), createdById: ownerId },
    { id: captureIds.bLive, companyId: companyB, token: token('B live'), createdAt: AT, updatedAt: AT, createdById: ownerId },
  ]

  // --- the email-in seed's mail to orders@, and the email seed's delivered sign-in mail -------------------------------------
  const mailIds = { waiting: id('email-in:waiting'), triage: id('email-in:triage'), held: id('email-in:held'), rejected: id('email-in:virus'), failed: id('email-in:failed') }

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.notificationPreference.createMany({ data: preferences, skipDuplicates: true })
      await tx.roleNotificationDefault.createMany({ data: roleDefaults, skipDuplicates: true })
      await tx.secretValue.createMany({ data: [secret('owner-phone', pushSecretIds.ownerPhone), secret('member-laptop', pushSecretIds.memberLaptop)], skipDuplicates: true })
      await tx.pushSubscription.createMany({ data: pushes, skipDuplicates: true })
      await tx.viewFollower.createMany({ data: follows, skipDuplicates: true })
      // Born waiting, as the API sets them; then the scheduler brings two back and the member marks theirs done.
      await tx.reminder.createMany({ data: reminders, skipDuplicates: true })
      await tx.reminder.updateMany({ where: { id: reminderIds.ownerQuoteReply, cameBackAt: null }, data: { cameBackAt: minutes(120), updatedAt: minutes(120) } })
      await tx.reminder.updateMany({ where: { id: reminderIds.memberOrder, cameBackAt: null }, data: { cameBackAt: minutes(24 * 60), updatedAt: minutes(24 * 60) } })
      await tx.reminder.updateMany({ where: { id: reminderIds.memberOrder, doneAt: null }, data: { doneAt: minutes(25 * 60), updatedAt: minutes(25 * 60) } })
      await tx.teamInbox.createMany({ data: inboxes, skipDuplicates: true })
      await tx.captureAddress.createMany({ data: captures, skipDuplicates: true })

      const into = (mailId: string, data: Prisma.InboundEmailUncheckedUpdateManyInput) =>
        tx.inboundEmail.updateMany({ where: { id: mailId, teamInboxId: null }, data: { teamInboxId: teamInboxIds.aOrders, ...data } })
      await into(mailIds.waiting, {})
      await into(mailIds.triage, { assigneeId: memberId, assignedAt: minutes(15) })
      await into(mailIds.held, {})
      await into(mailIds.failed, { closedAt: minutes(20), closedById: ownerId })

      await tx.emailOutbound.updateMany({ where: { id: id('email:outbound:invitation'), status: 'DELIVERED', bounceKind: null }, data: { bounceKind: 'TRANSIENT' } })
      await tx.salesSettings.updateMany({ where: { id: tenantId, inquiryAddresses: { isEmpty: true } }, data: { inquiryAddresses: [`sales@${domain}`] } })
    }),
  )

  return {
    preferenceIds: preferences.map((row) => row.id),
    roleDefaultIds: roleDefaults.map((row) => row.id),
    pushIds,
    pushSecretIds,
    viewFollowerIds,
    reminderIds,
    teamInboxIds,
    captureIds,
    mailIds,
    viewIds,
    ownerId,
    memberId,
    companyA,
    companyB,
    tenantId,
  }
}
