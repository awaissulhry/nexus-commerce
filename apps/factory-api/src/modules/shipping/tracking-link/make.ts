import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { localeOf, type Locale } from '@nexus/factory-domain/email/rules'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { trackingLinkMail } from '@nexus/factory-domain/shipping/tracking-link/mail'
import { expectedDeliveryOf, makeHeld, MAKE_HELD_WORDS, TRACKING_LINK, TRACKING_NOTES, type TrackingVia } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { runCommand, COMMAND_SETTINGS, type CommandCaller, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { deliverLinkMail } from '../../../platform/links/mail'
import { assertNoPayByLink, LinkRefusedError } from '../../../platform/links/pay'
import { tenantOf } from '../cells'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * Makes tracking links of a shipment (B-W2b-170; LOG-062; SHIPMENT_TRACK × Shipment): one per address it is mailed to, or
 * one to pass on (its URL in the answer, once). Tokens are minted OUTSIDE the command: only their hashes go in. ONE command
 * (on the caller: the office person, the tenant's system, the portal person in the office scope): the shipment read again
 * (a link only for one packed, on the way or delivered less than 60 days ago: factory-domain makeHeld), the pay rule, a
 * suppressed address skipped, the links (the purpose's longest life; a search's link one day; the note says how it came
 * to be), their audit rows, per mailed address the outbound row (QUEUED, the subject only: no body, no link) and its
 * audit row, and the event shipment.tracking_link_made. After the commit each mail is composed in memory WITH its link and
 * sent at once (platform/links deliverLinkMail; FAKE locally): the token is in the sent mail only, or in this answer once.
 *
 *   SHIPPED   once per address: an address that has a link not withdrawn gets nothing (a repeated event sends nothing)
 *   RENEWED   not twice to an address within ten minutes
 *   PORTAL    at most ten live links copied in the portal per shipment
 */

export const TRACKING_MAIL_TEMPLATE = 'shipping.tracking_link'

/** Nothing to make: every address had its link (or asked again too soon). */
class NothingToMake extends Error {
  constructor(readonly skipped: Skipped[]) {
    super('nothing to make')
  }
}

export interface Skipped {
  readonly email: string
  readonly reason: 'SUPPRESSED' | 'ALREADY_SENT' | 'ASKED_RECENTLY'
}

export interface MadeLink {
  readonly id: string
  readonly email: string | null
  readonly expiresAt: string
  readonly delivery: 'QUEUED' | 'SENT' | 'FAILED' | null
}

export interface MakeResult {
  readonly links: readonly MadeLink[]
  readonly skipped: readonly Skipped[]
  /** The link to pass on (when nothing was mailed): in this answer only. */
  readonly url: string | null
  /** Each link's token (made here, never stored): the search answers them to its own visitor. */
  readonly tokens: ReadonlyMap<string, string>
}

export interface Recipient {
  readonly email: string
  readonly contactId: string | null
  readonly language: string | null
}

export interface MakeRequest {
  /** The writer: an office session, the tenant's system, or a portal person in the tenant's office scope. */
  readonly caller: CommandCaller
  /** The tenant's system, which claims and sends the mails. */
  readonly delivery: CommandCaller
  readonly email: EmailRuntime
  readonly clock: Clock
  /** The web's link address for a token (officeAuth.link). */
  readonly linkUrl: (token: string) => string
  readonly shipment: ShipmentHeader
  readonly via: TrackingVia
  /** The addresses it is mailed to; empty: one link to pass on. */
  readonly to: readonly Recipient[]
  readonly language?: Locale | undefined
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null } | null
  readonly createdById: string
  readonly idempotencyKey?: string | undefined
  readonly causationId?: string | undefined
  readonly renewalOfId?: string | null | undefined
}

const DAY_MS = 24 * 60 * 60 * 1000

async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string, system: boolean) {
  if (!system) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
    throw error
  }
}

/** The facts the mail says (read outside the command, in the caller's scope). */
async function mailFactsOf(caller: CommandCaller, shipment: ShipmentHeader) {
  return caller.withClient(async (client) => {
    const order = await client.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } })
    const company = await client.company.findUnique({ where: { id: shipment.companyId }, select: { legalName: true, tradeName: true } })
    const party = await client.party.findUnique({ where: { id: shipment.partyId }, select: { language: true } })
    return { order, companyName: company?.tradeName ?? company?.legalName ?? '', partyLanguage: party?.language ?? null }
  })
}

export async function makeTrackingLinks(request: MakeRequest): Promise<MakeResult> {
  const { caller, shipment, via } = request
  const context = caller.factoryContext!
  const tenantId = tenantOf(context)
  const facts = await mailFactsOf(caller, shipment)
  const localeFor = (recipient: Recipient | null): Locale => request.language ?? localeOf(recipient?.language ?? facts.partyLanguage ?? facts.order?.language ?? null)
  const mailOf = (current: ShipmentHeader, recipient: Recipient, url: string | null) =>
    trackingLinkMail(
      {
        locale: localeFor(recipient),
        companyName: facts.companyName,
        shipmentNumber: current.number,
        orderNumber: facts.order?.number ?? null,
        customerRef: facts.order?.customerRef ?? null,
        status: current.status,
        carrierName: current.carrierName,
        expectedDeliveryAt: expectedDeliveryOf(current.status, current.expectedDeliveryAt),
        renewal: via === 'RENEWED',
      },
      url,
    )

  // One token per address, or one to pass on: minted here, only their hashes enter the transaction.
  const targets: Array<Recipient | null> = request.to.length > 0 ? [...request.to] : [null]
  const minted = targets.map((recipient) => {
    const linkId = newId()
    return { recipient, linkId, token: mintLinkToken({ tenantId, partyId: shipment.partyId, linkId }).value }
  })
  const days = via === 'SEARCH' ? TRACKING_LINK.searchExpiryDays : TRACKING_LINK.expiryDays

  let outcome
  try {
    outcome = await runCommand(
      caller,
      {
        name: 'shipping.trackingLink',
        idempotencyKey: request.idempotencyKey,
        input: { shipmentId: shipment.id, via, to: request.to.map((recipient) => recipient.email), renewalOf: request.renewalOfId ?? null },
        ...(request.causationId ? { causationId: request.causationId } : {}),
      },
      async (tools) => {
        const { tx, now } = tools
        const current = await readShipment(tx, shipment.id)
        if (!current) throw new InvalidStateError('The shipment is gone.')
        const held = makeHeld(current, now)
        if (held) throw new InvalidStateError(MAKE_HELD_WORDS[held])
        await assertNoPayByLink(tx, { recordType: 'Shipment', recordId: current.id })

        const addresses = request.to.map((recipient) => recipient.email)
        const suppressed = await suppressedAmong(tx, addresses)
        const skipped: Skipped[] = addresses.filter((address) => suppressed.has(address)).map((address) => ({ email: address, reason: 'SUPPRESSED' as const }))
        const existing = addresses.length > 0 ? await tx.oneOffLink.findMany({ where: { recordType: 'Shipment', recordId: current.id, purpose: 'SHIPMENT_TRACK', email: { in: addresses } }, select: { email: true, revokedAt: true, createdAt: true } }) : []
        if (via === 'PORTAL') {
          const live = await tx.oneOffLink.count({ where: { recordType: 'Shipment', recordId: current.id, purpose: 'SHIPMENT_TRACK', note: TRACKING_NOTES.PORTAL, revokedAt: null, expiresAt: { gt: now } } })
          if (live >= TRACKING_LINK.portalLinksPerShipment) {
            throw new LinkRefusedError('TOO_MANY', `${TRACKING_LINK.portalLinksPerShipment} tracking links of this shipment were copied already: pass on one of them.`)
          }
        }
        const making = minted.filter(({ recipient }) => {
          if (!recipient) return true
          if (suppressed.has(recipient.email)) return false
          const own = existing.filter((link) => link.email === recipient.email)
          if (via === 'SHIPPED' && own.some((link) => link.revokedAt === null)) {
            skipped.push({ email: recipient.email, reason: 'ALREADY_SENT' })
            return false
          }
          if (via === 'RENEWED' && own.some((link) => link.createdAt.getTime() > now.getTime() - TRACKING_LINK.renewCoalesceMs)) {
            skipped.push({ email: recipient.email, reason: 'ASKED_RECENTLY' })
            return false
          }
          return true
        })
        if (making.length === 0) throw new NothingToMake(skipped)

        const expiresAt = new Date(now.getTime() + days * DAY_MS)
        const system = context.audience !== 'office' || request.sender === null
        const identity = making.some(({ recipient }) => recipient !== null) ? await identityFor(tools, current.companyId, system) : null
        const from = identity ? fromLine(identity, request.sender ? { name: request.sender.name, email: request.sender.email } : null) : null
        const links: Array<MadeLink & { readonly outboundId: string | null; readonly locale: Locale | null }> = []
        for (const { recipient, linkId, token } of making) {
          await tx.oneOffLink.createMany({
            data: [
              {
                id: linkId,
                companyId: current.companyId,
                partyId: current.partyId,
                purpose: 'SHIPMENT_TRACK',
                recordType: 'Shipment',
                recordId: current.id,
                tokenHash: linkTokenHash(token),
                email: recipient?.email ?? null,
                contactId: recipient?.contactId ?? null,
                renewalOfId: request.renewalOfId ?? null,
                note: TRACKING_NOTES[via],
                expiresAt,
                maxUses: 1,
                createdAt: now,
                updatedAt: now,
                createdById: request.createdById,
              },
            ],
          })
          tools.audit({
            action: 'links.create',
            recordType: 'OneOffLink',
            recordId: linkId,
            companyId: current.companyId,
            siteId: current.siteId,
            after: { purpose: 'SHIPMENT_TRACK', recordType: 'Shipment', recordId: current.id, partyId: current.partyId, email: recipient?.email ?? null, expiresAt: toUtcIso(expiresAt), maxUses: 1, via, renewalOf: request.renewalOfId ?? null },
          })
          let outboundId: string | null = null
          if (recipient && identity && from) {
            outboundId = newId()
            const locale = localeFor(recipient)
            await tx.emailOutbound.create({
              data: {
                id: outboundId,
                companyId: identity.companyId,
                identityId: identity.id,
                recordType: 'OneOffLink',
                recordId: linkId,
                templateKey: TRACKING_MAIL_TEMPLATE,
                locale,
                fromAddress: from.address,
                fromName: from.name,
                to: [recipient.email],
                subject: mailOf(current, recipient, null).subject,
                emailMessageId: messageIdFor(outboundId, identity.domain),
                status: 'QUEUED',
                queuedAt: now,
                createdAt: now,
                updatedAt: now,
                createdById: request.sender?.userId ?? null,
              },
              select: { id: true },
            })
            tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: TRACKING_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
          }
          links.push({ id: linkId, email: recipient?.email ?? null, expiresAt: toUtcIso(expiresAt), delivery: outboundId ? 'QUEUED' : null, outboundId, locale: recipient ? localeFor(recipient) : null })
        }
        tools.emit({
          type: 'shipment.tracking_link_made',
          subject: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          payload: { shipmentId: current.id, number: current.number, links: links.length, via, mailed: links.filter((link) => link.outboundId !== null).length },
        })
        return { links, skipped, shipment: { status: current.status, expectedDeliveryAt: current.expectedDeliveryAt ? toUtcIso(current.expectedDeliveryAt) : null } }
      },
      { ...COMMAND_SETTINGS, clock: request.clock },
    )
  } catch (error) {
    if (error instanceof NothingToMake) return { links: [], skipped: error.skipped, url: null, tokens: new Map() }
    throw error
  }
  const { result, replayed } = outcome
  const tokens = new Map(minted.map((entry) => [entry.linkId, entry.token]))

  if (replayed) {
    // A repeat: its mails went (or failed) the first time; the tokens of that first answer are gone.
    const statuses = await caller.withClient((client) => client.emailOutbound.findMany({ where: { id: { in: result.links.flatMap((link) => (link.outboundId ? [link.outboundId] : [])) } }, select: { id: true, status: true } }))
    const delivery = (outboundId: string | null) => {
      const status = statuses.find((row) => row.id === outboundId)?.status
      return status === 'SENT' ? ('SENT' as const) : status === 'FAILED' ? ('FAILED' as const) : outboundId ? ('QUEUED' as const) : null
    }
    return { links: result.links.map((link) => ({ id: link.id, email: link.email, expiresAt: link.expiresAt, delivery: delivery(link.outboundId) })), skipped: result.skipped, url: null, tokens: new Map() }
  }

  const sent: MadeLink[] = []
  for (const link of result.links) {
    if (!link.outboundId || !link.email) {
      sent.push({ id: link.id, email: link.email, expiresAt: link.expiresAt, delivery: null })
      continue
    }
    const url = request.linkUrl(tokens.get(link.id)!)
    const recipient = request.to.find((entry) => entry.email === link.email) ?? null
    const current = { ...shipment, status: result.shipment.status, expectedDeliveryAt: result.shipment.expectedDeliveryAt ? new Date(result.shipment.expectedDeliveryAt) : null }
    const body = mailOf(current, recipient ?? { email: link.email, contactId: null, language: link.locale }, url).body
    const delivery = await deliverLinkMail(request.email, request.delivery, link.outboundId, body, request.sender?.name ?? null, request.clock)
    sent.push({ id: link.id, email: link.email, expiresAt: link.expiresAt, delivery })
  }
  const passOn = result.links.find((link) => link.email === null)
  return { links: sent, skipped: result.skipped, url: passOn ? request.linkUrl(tokens.get(passOn.id)!) : null, tokens }
}
