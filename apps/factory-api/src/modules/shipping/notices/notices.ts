import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { eventFor } from '@nexus/factory-domain/events/define'
import { NOTICE_HELD_WORDS, NOTICE_TEMPLATE, noticeHeld, noticeHeldPath, noticeLocaleOf, noticeMail, type NoticeHeld, type NoticeParcel } from '@nexus/factory-domain/shipping/notices/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { events as deliveryEvents } from '@nexus/factory-domain/shipping-delivery/events'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock, type Clock } from '../../../core/time'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { deliverLinkMail } from '../../../platform/links/mail'
import { mayOn, officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import { readContents, readShipment, type ShipmentHeader } from '../store'
import { recipientsOf } from '../tracking-link/office'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061; factory-domain shipping/notices). ONE command per send: the
 * shipment read again and checked (noticeHeld: never a TEST label, never before the goods left; by itself only while the
 * site's switch customerNoticeOn is on, once), each recipient's outbound row QUEUED (template `shipping.customer_notice`,
 * record the Shipment, the subject only: no body kept), their audit rows and shipment.customer_notice_sent. After the
 * commit each mail is composed in the recipient's language and sent at once through the company's mail account
 * (platform/links deliverLinkMail: the company's footer; FAKE locally and in tests). The outbound rows are the design's
 * "sent at, to whom, delivery state".
 *
 *   GET  /shipping/shipments/:shipmentId/notice   shipping.view: the switch, why it would not go now, the recipients, the mails
 *   POST /shipping/shipments/:shipmentId/notice   shipping.manage: Send again (by hand; not held by the switch)
 */

const sentEvent = deliveryEvents.find((event) => event.type === 'shipment.customer_notice_sent')!

type Reader = CommandTx

/** What the notice rule reads of a shipment (outside or inside a command). */
async function noticeFactsOf(db: Reader, shipment: ShipmentHeader) {
  const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, carrierParcelId: true, trackingNumber: true, trackingUrl: true }, orderBy: { seq: 'asc' } })
  const extra = await db.shipment.findUnique({ where: { id: shipment.id }, select: { manualTrackingNumber: true } })
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { customerNoticeOn: true } })
  const sent = await db.emailOutbound.count({ where: { recordType: 'Shipment', recordId: shipment.id, templateKey: NOTICE_TEMPLATE } })
  return { parcels, manualTrackingNumber: extra?.manualTrackingNumber ?? null, switchOn: settings?.customerNoticeOn === true, sentBefore: sent > 0 }
}

/** The parcels as the mail lists them: tracking number, carrier page and contents (style, colour, sizes). */
async function noticeParcelsOf(db: Reader, shipmentId: string, parcels: readonly { id: string; seq: number; trackingNumber: string | null; trackingUrl: string | null }[]): Promise<NoticeParcel[]> {
  const { lines } = await readContents(db, shipmentId)
  return parcels.map((parcel) => {
    const own = lines.filter((line) => line.parcelId === parcel.id || (line.parcelId === null && parcels.length === 1))
    const groups = new Map<string, { style: string; colour: string; sizes: Map<string, number> }>()
    for (const line of own) {
      const style = line.workOrderSize.workOrder.style
      const colour = line.workOrderSize.colourway
      const key = `${style.code}\u0000${colour.code}`
      const group = groups.get(key) ?? { style: `${style.code} ${style.name}`, colour: colour.name, sizes: new Map<string, number>() }
      group.sizes.set(line.size, (group.sizes.get(line.size) ?? 0) + line.quantity)
      groups.set(key, group)
    }
    return {
      seq: parcel.seq,
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      contents: [...groups.values()].map((group) => ({ style: group.style, colour: group.colour, sizes: [...group.sizes].map(([size, quantity]) => ({ size, quantity })) })),
    }
  })
}

const NOTICE_SELECT = { id: true, to: true, locale: true, status: true, queuedAt: true, sentAt: true, deliveredAt: true, bouncedAt: true, failedAt: true, createdById: true } as const

/** GET: the notice of a shipment as the office sees it. */
export async function getNotice(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const recipients = await recipientsOf(caller, shipment.partyId)
  const read = await caller.withClient(async (client) => {
    const facts = await noticeFactsOf(client, shipment)
    const mails = await client.emailOutbound.findMany({ where: { recordType: 'Shipment', recordId: shipment.id, templateKey: NOTICE_TEMPLATE }, select: NOTICE_SELECT, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], take: 100 })
    return { facts, mails }
  })
  const base = { status: shipment.status, parcels: read.facts.parcels, manualTrackingNumber: read.facts.manualTrackingNumber, recipients: recipients.length, switchOn: read.facts.switchOn }
  const automatic = noticeHeld({ ...base, automatic: true, sentBefore: read.facts.sentBefore })
  const byHand = noticeHeld({ ...base, automatic: false, sentBefore: read.facts.sentBefore })
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, siteId: shipment.siteId },
    switchOn: read.facts.switchOn,
    /** Why the notice does not go by itself (null: it goes, or went, when the goods leave). */
    automaticHeld: automatic === 'SENT' ? null : automatic,
    /** Why Send again is held (null: a person may send it now). */
    sendHeld: byHand,
    mayManage: mayOn(context, SHIPPING_MANAGE, shipment),
    recipients: recipients.map(({ contactId, name, email }) => ({ contactId, name, email })),
    mails: read.mails.map((mail) => ({
      id: mail.id,
      to: mail.to,
      locale: mail.locale,
      status: mail.status,
      queuedAt: toUtcIso(mail.queuedAt),
      sentAt: mail.sentAt ? toUtcIso(mail.sentAt) : null,
      deliveredAt: mail.deliveredAt ? toUtcIso(mail.deliveredAt) : null,
      bouncedAt: mail.bouncedAt ? toUtcIso(mail.bouncedAt) : null,
      failedAt: mail.failedAt ? toUtcIso(mail.failedAt) : null,
      automatic: mail.createdById === null,
    })),
  }
}

/** The send was not made: NoticeHeld in words, as a 409 with `refusal/<CODE>`. */
class NoticeHeldError extends DomainError {
  constructor(readonly held: NoticeHeld) {
    super('conflict', NOTICE_HELD_WORDS[held], [{ path: noticeHeldPath(held), message: NOTICE_HELD_WORDS[held] }])
  }
}

export interface NoticeRequest {
  readonly caller: CommandCaller
  /** The tenant's system, which claims and sends the mails. */
  readonly delivery: CommandCaller
  readonly email: EmailRuntime
  readonly clock?: Clock
  readonly shipmentId: string
  readonly automatic: boolean
  /** Some of the customer's ORDERS contacts; none named: all of them. */
  readonly contactIds?: readonly string[] | undefined
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null } | null
  readonly idempotencyKey?: string | undefined
  readonly causationId?: string | undefined
}

export interface NoticeOutcome {
  readonly sent: number
  readonly failed: number
  readonly skipped: readonly string[]
}

/**
 * Sends the notice (see above). By itself (`automatic`) a held notice answers nothing sent (no error); by hand it is
 * refused in words (409). A repeated request answers from its receipt and sends nothing again.
 */
export async function sendNotice(request: NoticeRequest): Promise<NoticeOutcome> {
  const clock = request.clock ?? serverClock
  const shipment = await request.caller.withClient((client) => readShipment(client, request.shipmentId))
  if (!shipment) throw new InvalidStateError('The shipment is gone.')
  const all = await recipientsOf(request.caller, shipment.partyId)
  const unknown = (request.contactIds ?? []).filter((id) => !all.some((recipient) => recipient.contactId === id))
  if (unknown.length > 0) throw new ValidationError('Choose among the customer\'s orders contacts.', [{ path: 'body/contactIds', message: 'One of these is not an active orders contact of the customer with an e-mail address.' }])
  const to = request.contactIds && request.contactIds.length > 0 ? all.filter((recipient) => request.contactIds!.includes(recipient.contactId)) : all
  const words = await request.caller.withClient(async (client) => {
    const order = await client.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } })
    const company = await client.company.findUnique({ where: { id: shipment.companyId }, select: { legalName: true, tradeName: true } })
    const party = await client.party.findUnique({ where: { id: shipment.partyId }, select: { language: true } })
    return { order, companyName: company?.tradeName ?? company?.legalName ?? '', partyLanguage: party?.language ?? null }
  })

  let outcome
  try {
    outcome = await runCommand(
      request.caller,
      { name: 'shipping.customerNotice', idempotencyKey: request.idempotencyKey, input: { shipmentId: shipment.id, automatic: request.automatic, to: to.map((recipient) => recipient.email) }, ...(request.causationId ? { causationId: request.causationId } : {}) },
      async (tools) => {
        const { tx, now } = tools
        const current = await readShipment(tx, shipment.id)
        if (!current) throw new InvalidStateError('The shipment is gone.')
        const facts = await noticeFactsOf(tx, current)
        const held = noticeHeld({ status: current.status, parcels: facts.parcels, manualTrackingNumber: facts.manualTrackingNumber, recipients: to.length, switchOn: facts.switchOn, automatic: request.automatic, sentBefore: facts.sentBefore })
        if (held) throw new NoticeHeldError(held)
        const suppressed = await suppressedAmong(tx, to.map((recipient) => recipient.email))
        const going = to.filter((recipient) => !suppressed.has(recipient.email))
        let identity
        try {
          identity = await sendingIdentity(tx, current.companyId, null, 'NOTIFICATION')
        } catch (error) {
          if (!(error instanceof DomainError)) throw error
          identity = await sendingIdentity(tx, current.companyId, null, 'CONVERSATION')
        }
        const from = fromLine(identity, request.sender ? { name: request.sender.name, email: request.sender.email } : null)
        const parcels = await noticeParcelsOf(tx, current.id, facts.parcels)
        const mails: Array<{ readonly outboundId: string; readonly email: string; readonly text: string }> = []
        for (const recipient of going) {
          const mail = noticeMail({
            locale: noticeLocaleOf(recipient.language, words.partyLanguage, words.order?.language),
            companyName: words.companyName,
            shipmentNumber: current.number,
            orderNumber: words.order?.number ?? null,
            customerRef: words.order?.customerRef ?? null,
            carrierName: current.carrierName,
            manualTrackingNumber: facts.manualTrackingNumber,
            expectedDeliveryAt: current.status === 'SHIPPED' ? current.expectedDeliveryAt : null,
            parcels,
          })
          const outboundId = newId()
          await tx.emailOutbound.create({
            data: {
              id: outboundId,
              companyId: identity.companyId,
              identityId: identity.id,
              recordType: 'Shipment',
              recordId: current.id,
              templateKey: NOTICE_TEMPLATE,
              locale: noticeLocaleOf(recipient.language, words.partyLanguage, words.order?.language),
              fromAddress: from.address,
              fromName: from.name,
              to: [recipient.email],
              subject: mail.subject,
              emailMessageId: messageIdFor(outboundId, identity.domain),
              status: 'QUEUED',
              queuedAt: now,
              createdAt: now,
              updatedAt: now,
              createdById: request.sender?.userId ?? null,
            },
            select: { id: true },
          })
          tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: NOTICE_TEMPLATE, shipmentId: current.id, identityId: identity.id, recipients: 1, automatic: request.automatic, status: 'QUEUED' } })
          mails.push({ outboundId, email: recipient.email, text: mail.text })
        }
        tools.audit({ action: 'shipping.customerNotice', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { mails: mails.length, skipped: [...suppressed], automatic: request.automatic } })
        tools.emit(eventFor(sentEvent, { subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, mails: mails.length, automatic: request.automatic } }))
        return { mails, skipped: [...suppressed] }
      },
      { ...COMMAND_SETTINGS, clock },
    )
  } catch (error) {
    if (request.automatic && error instanceof NoticeHeldError) return { sent: 0, failed: 0, skipped: [] }
    throw error
  }
  if (outcome.replayed) return { sent: 0, failed: 0, skipped: outcome.result.skipped }
  let sent = 0
  let failed = 0
  for (const mail of outcome.result.mails) {
    const delivery = await deliverLinkMail(request.email, request.delivery, mail.outboundId, mail.text, request.sender?.name ?? null, clock)
    if (delivery === 'SENT') sent++
    else if (delivery === 'FAILED') failed++
  }
  return { sent, failed, skipped: outcome.result.skipped }
}
