import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedThreads } from './threads'

/**
 * The portal frame seed (W2b schema wave 20/22, B-W2b-156), per tenant of seed/_core.ts, written as the app does: the
 * office's rows in the tenant's office scope (the fan-out and the task sources run there), the partner's own acts (a post
 * in a thread, a task marked done, the e-mail settings of the first visit) in the partner scope of the buyer's party P1,
 * as a portal session of the buyer. The CLI runs the seed files in name order and this one sorts before threads.ts, so it
 * runs the files, portal-auth and threads seeds first (each idempotent). Every name is made up; the file is a row only.
 *
 *   tasks          P1 (customer): accept the quote SEED-QT-0001 (OPEN, the threads seed's made-up quote), approve the
 *                  links-depth seed's fit sample (OPEN, reminded once), answer our message on the quote (DONE by the
 *                  buyer in the portal, with the post below); P2 (supplier): confirm SEED-PO-0001 (OPEN, asked by the
 *                  system), upload a certificate (CANCELLED: the office no longer needs it).
 *   portal post    the buyer answers in the quote's thread from the portal (INBOUND, PARTNER, PORTAL, PARTY), attaching a
 *                  file of the quote shared with P1 (its sketch); the thread's last activity moves to it (office scope).
 *   notifications  the buyer's: the sample to approve (unread, e-mailed as it happened) and SEED-SO-0001 shipped (read,
 *                  in the daily summary mail: EMAIL_DIGEST); the order desk's: SEED-PO-0001 to confirm (unread).
 *   e-mail         the buyer's first visit: dates daily, messages as they happen, reminders weekly, documents daily, then
 *                  documents changed to weekly; the order desk's: messages as they happen, reminders daily. The
 *                  transactional topics (orders, shipped, invoices) have no row: the API keeps them on.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy as each role that may insert: so the first task is OPEN and unreminded, the first e-mail setting the buyer's, and
 * the portal post sorts first of the Message rows (a partner session inserts only such a post; an id with eight zeros, in
 * each tenant). Every other row here in a table other seeds also fill (the file, the deliveries) has an id from `lateId`,
 * so the copies stay the other seeds' rows. Fixed instants, so nothing depends on the clock. Idempotent: rows are found by
 * id first or written with skipDuplicates; the partner's acts run once.
 */

const AT = new Date('2026-11-03T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)
const DUE_QUOTE = new Date('2026-11-13T17:00:00.000Z')
const DUE_SAMPLE = new Date('2026-11-07T17:00:00.000Z')
const DUE_PO = new Date('2026-11-10T12:00:00.000Z')

export interface PortalFrameSeed {
  readonly tasks: { readonly acceptQuote: string; readonly approveSample: string; readonly answerMessage: string; readonly confirmPo: string; readonly uploadCertificate: string }
  readonly postId: string
  readonly postFileId: string
  readonly notifications: { readonly sample: string; readonly shipped: string; readonly po: string }
  readonly deliveries: { readonly sample: string; readonly shipped: string }
  readonly preferences: readonly string[]
  readonly partyId: string
  readonly supplierId: string
  readonly buyerId: string
  readonly orderDeskId: string
  readonly companyId: string
  readonly tenantId: string
}

export async function seed(context: SeedContext): Promise<PortalFrameSeed> {
  const { db, namespace } = context
  await seedFiles(context)
  await seedThreads(context)
  const portal = await seedPortalAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const hex = (text: string): string => createHash('sha256').update(`seed portal-frame ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const companyA = id('company:A')
  const partyP1 = id('party:P1')
  const partyP2 = id('party:P2')
  const buyerId = portal.userIds.p1Buyer
  const orderDeskId = portal.userIds.p2Orders
  const store = id('files:account:r2')
  // The threads seed's made-up quote of company A for P1, and its thread (no Quote row: it stands in for one).
  const quote = { type: 'Quote', id: id('quote:Q1'), label: 'SEED-QT-0001' }
  const quoteThread = id('threads:quote:Q1')
  const quoteOut = id('threads:message:quote-out')
  // The links-depth seed's fit sample asked of P1, the supply seed's SEED-PO-0001 for P2, the sales seed's SEED-SO-0001.
  const sampleRequest = `00000000${id('links-depth:approval:sample').slice(8)}`
  const purchaseOrder = id('link:P2:record')
  const salesOrder = id('sales:SO1')

  const tasks = {
    acceptQuote: firstId('portal-frame:task:accept-quote'),
    approveSample: id('portal-frame:task:approve-sample'),
    answerMessage: id('portal-frame:task:answer-message'),
    confirmPo: id('portal-frame:task:confirm-po'),
    uploadCertificate: id('portal-frame:task:upload-certificate'),
  }
  const postId = firstId('portal-frame:message:buyer-post')
  const postFileId = lateId('portal-frame:file:sketch')
  const notifications = { sample: id('portal-frame:notification:sample'), shipped: id('portal-frame:notification:shipped'), po: id('portal-frame:notification:po') }
  const deliveries = { sample: lateId('portal-frame:delivery:sample'), shipped: lateId('portal-frame:delivery:shipped') }
  const preference = (who: string, topic: string): string => id(`portal-frame:preference:${who}:${topic}`)
  const preferences = [
    firstId('portal-frame:preference:buyer:DATES'),
    preference('buyer', 'MESSAGES'),
    preference('buyer', 'REMINDERS'),
    preference('buyer', 'DOCUMENTS'),
    preference('orders', 'MESSAGES'),
    preference('orders', 'REMINDERS'),
  ]

  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  // A portal session runs in its party's scope; its actor is the person signed in (core/context.ts).
  const asBuyer = { audience: 'partner', tenantId, actorId: buyerId, partyId: partyP1 } as const
  const asOrderDesk = { audience: 'partner', tenantId, actorId: orderDeskId, partyId: partyP2 } as const

  const askedByOwner = { askedById: ownerId, askedByName: 'Seed Owner' }
  const taskRows: Prisma.PartnerTaskCreateManyInput[] = [
    { id: tasks.acceptQuote, companyId: companyA, partyId: partyP1, kind: 'ACCEPT_QUOTE', recordType: quote.type, recordId: quote.id, recordLabel: quote.label, sourceKey: `Quote:${quote.id}:v1`, dueAt: DUE_QUOTE, ...askedByOwner, createdAt: AT, updatedAt: AT },
    { id: tasks.approveSample, companyId: companyA, partyId: partyP1, kind: 'APPROVE', recordType: 'ApprovalRequest', recordId: sampleRequest, recordLabel: 'Fit sample JKT-01, size 50', sourceKey: `ApprovalRequest:${sampleRequest}`, dueAt: DUE_SAMPLE, ...askedByOwner, createdAt: AT, updatedAt: AT },
    { id: tasks.answerMessage, companyId: companyA, partyId: partyP1, kind: 'ANSWER_MESSAGE', recordType: quote.type, recordId: quote.id, recordLabel: quote.label, sourceKey: `Message:${quoteOut}`, ...askedByOwner, createdAt: AT, updatedAt: AT },
    { id: tasks.confirmPo, companyId: companyA, partyId: partyP2, kind: 'CONFIRM_PO', recordType: 'PurchaseOrder', recordId: purchaseOrder, recordLabel: 'SEED-PO-0001', sourceKey: `PurchaseOrder:${purchaseOrder}:r1`, dueAt: DUE_PO, createdAt: AT, updatedAt: AT },
    { id: tasks.uploadCertificate, companyId: companyA, partyId: partyP2, kind: 'UPLOAD_DOCUMENT', recordType: 'Party', recordId: partyP2, recordLabel: 'Seed tannery: REACH declaration 2026', sourceKey: `RequiredDocumentRule:${id('portal-frame:rule:reach')}`, ...askedByOwner, createdAt: AT, updatedAt: AT },
  ]

  // The quote's sketch, shared with P1's portal (a row only, no object in any store).
  const fileRow: Prisma.StoredFileCreateManyInput = {
    id: postFileId,
    companyId: companyA,
    recordType: quote.type,
    recordId: quote.id,
    kind: 'PHOTO',
    originalName: 'Seed sketch of the team jacket, front.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 4096,
    sha256: hex('file sketch'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id('portal-frame:key:sketch')}`,
    visibility: ['OFFICE', 'PARTNER'],
    partyId: partyP1,
    status: 'AVAILABLE',
    availableAt: AT,
    storeAccountId: store,
    createdAt: AT,
    updatedAt: AT,
    createdById: ownerId,
  }

  const onRecord = (record: { type: string; id: string; label: string }) => ({ recordType: record.type, recordId: record.id, recordLabel: record.label })
  const notificationRows: Prisma.NotificationCreateManyInput[] = [
    {
      id: notifications.sample,
      userId: buyerId,
      partyId: partyP1,
      companyId: companyA,
      category: 'APPROVAL',
      eventType: 'approval_request.asked',
      eventId: id('portal-frame:event:sample-asked'),
      ...onRecord({ type: 'ApprovalRequest', id: sampleRequest, label: 'Fit sample JKT-01, size 50' }),
      messageKey: 'portal.notifications.approvalAsked',
      params: { kind: 'SAMPLE' },
      actorId: ownerId,
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: notifications.shipped,
      userId: buyerId,
      partyId: partyP1,
      companyId: companyA,
      category: 'FOLLOWING',
      eventType: 'shipment.shipped',
      eventId: id('portal-frame:event:so-shipped'),
      ...onRecord({ type: 'SalesOrder', id: salesOrder, label: 'SEED-SO-0001' }),
      messageKey: 'portal.notifications.orderShipped',
      params: { parcels: 2 },
      readAt: minutes(120),
      version: 2,
      createdAt: minutes(30),
      updatedAt: minutes(120),
    },
    {
      id: notifications.po,
      userId: orderDeskId,
      partyId: partyP2,
      companyId: companyA,
      category: 'ASSIGNMENT',
      eventType: 'purchase_order.sent',
      eventId: id('portal-frame:event:po-sent'),
      ...onRecord({ type: 'PurchaseOrder', id: purchaseOrder, label: 'SEED-PO-0001' }),
      messageKey: 'portal.notifications.purchaseOrderToConfirm',
      params: {},
      createdAt: AT,
      updatedAt: AT,
    },
  ]
  const deliveryRows: Prisma.NotificationDeliveryCreateManyInput[] = [
    { id: deliveries.sample, notificationId: notifications.sample, channel: 'EMAIL', outcome: 'SENT', emailOutboundId: id('portal-frame:email:sample-asked'), at: minutes(1), requestId: 'seed-portal-frame-sample', createdAt: minutes(1) },
    { id: deliveries.shipped, notificationId: notifications.shipped, channel: 'EMAIL_DIGEST', outcome: 'SENT', emailOutboundId: id('portal-frame:email:daily-summary'), at: minutes(90), requestId: 'seed-portal-frame-digest', createdAt: minutes(90) },
  ]

  // The office: the tasks the sources opened, the shared file, the fan-out's notifications and their deliveries.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.partnerTask.createMany({ data: taskRows, skipDuplicates: true })
      await tx.partnerTask.updateMany({ where: { id: tasks.approveSample, remindedAt: null }, data: { remindedAt: minutes(60), version: { increment: 1 }, updatedAt: minutes(60) } })
      await tx.partnerTask.updateMany({ where: { id: tasks.uploadCertificate, status: 'OPEN' }, data: { status: 'CANCELLED', closedAt: minutes(45), version: { increment: 1 }, updatedAt: minutes(45) } })
      await tx.storedFile.createMany({ data: [fileRow], skipDuplicates: true })
      await tx.notification.createMany({ data: notificationRows, skipDuplicates: true })
      await tx.notificationDelivery.createMany({ data: deliveryRows, skipDuplicates: true })
    }),
  )

  // The buyer, in the portal: answers in the quote's thread (with the sketch), which closes the task that asked for it.
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.message.findUnique({ where: { id: postId }, select: { id: true } }))) {
        await tx.message.create({
          data: {
            id: postId,
            threadId: quoteThread,
            partyId: partyP1,
            direction: 'INBOUND',
            audience: 'PARTNER',
            channel: 'PORTAL',
            authorKind: 'PARTY',
            authorName: 'Seed Portal Buyer',
            bodyText: 'Seed portal post: the sizes are fine; here is the sketch with our sponsor logo on the back.',
            attachmentFileIds: [postFileId],
            at: minutes(150),
            createdAt: minutes(150),
          },
          select: { id: true },
        })
      }
      await tx.partnerTask.updateMany({
        where: { id: tasks.answerMessage, status: 'OPEN' },
        data: { status: 'DONE', closedAt: minutes(150), doneById: buyerId, version: { increment: 1 }, updatedAt: minutes(150) },
      })
    }),
  )
  // The thread's last activity is the office's (the partner role neither reads nor writes it).
  await db.withScope(office, (client) =>
    client.thread.updateMany({ where: { id: quoteThread, lastMessageAt: { lt: minutes(150) } }, data: { lastMessageAt: minutes(150), updatedAt: minutes(150) } }),
  )

  // The first visit's e-mail settings, then a change on the account page (the buyer); the order desk's first visit.
  const settings = (who: string, userId: string, partyId: string, topic: Prisma.PartnerEmailPreferenceCreateManyInput['topic'], frequency: Prisma.PartnerEmailPreferenceCreateManyInput['frequency'], rowId = preference(who, topic)) =>
    ({ id: rowId, partyId, userId, topic, frequency, createdAt: minutes(5), updatedAt: minutes(5) }) satisfies Prisma.PartnerEmailPreferenceCreateManyInput
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      await tx.partnerEmailPreference.createMany({
        data: [
          settings('buyer', buyerId, partyP1, 'DATES', 'DAILY', preferences[0]),
          settings('buyer', buyerId, partyP1, 'MESSAGES', 'INSTANT'),
          settings('buyer', buyerId, partyP1, 'REMINDERS', 'WEEKLY'),
          settings('buyer', buyerId, partyP1, 'DOCUMENTS', 'DAILY'),
        ],
        skipDuplicates: true,
      })
      await tx.partnerEmailPreference.updateMany({ where: { id: preference('buyer', 'DOCUMENTS'), version: 1 }, data: { frequency: 'WEEKLY', version: 2, updatedAt: minutes(200) } })
    }),
  )
  await db.withScope(asOrderDesk, (client) =>
    client.partnerEmailPreference.createMany({
      data: [settings('orders', orderDeskId, partyP2, 'MESSAGES', 'INSTANT'), settings('orders', orderDeskId, partyP2, 'REMINDERS', 'DAILY')],
      skipDuplicates: true,
    }),
  )

  return { tasks, postId, postFileId, notifications, deliveries, preferences, partyId: partyP1, supplierId: partyP2, buyerId, orderDeskId, companyId: companyA, tenantId }
}
