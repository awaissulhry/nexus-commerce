import { newId } from '@nexus/factory-domain/core/ids'
import { privacyNoticeUrl, footerOf } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { portalEmailSettingsUrl } from '@nexus/factory-domain/portal/home/links'
import { composeDigestMail, composeNotificationMail, PORTAL_MAIL_TEMPLATES, unsubscribeToken, unsubscribeUrl, type ComposedMail, type MailItem } from '@nexus/factory-domain/portal/notifications/mail'
import { abuseKey } from '../../abuse/guard'
import { authSecrets, type AuthSecrets } from '../../auth/sessions/secrets'
import { command, COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { companyLegalOf } from '../../documents/documents'
import { deliverOutbound } from '../../email-out/outbound'
import type { EmailRuntime } from '../../email-out/service'

/**
 * The partner mails' sender (B-W2b-167; PLT-148, COL-063): made in memory, one EmailOutbound row per mail (record `User`: the
 * person; template `portal.notification` or `portal.digest`; NO body), sent at once through deliverOutbound (the gateway; the
 * FAKE account's mailbox locally and in tests: no real mail leaves the machine), then ONE command logs a NotificationDelivery
 * per notification it carried (EMAIL for one as it happens, EMAIL_DIGEST for a summary's: SENT with the mail's id, or FAILED
 * with why). The sender is the portal company's ready default NOTIFICATION identity (else CONVERSATION, else the tenant's).
 *
 * Every mail carries "Manage e-mails" (the portal's E-mail settings) and the person's signed unsubscribe link (GDPR). Its key is
 * derived from the cookie secret and handed in by the caller (the API from its sign-in object's secrets, the worker and the
 * scheduler from their env at boot): nothing here reads the process's env. A suppressed address is not sent to
 * (deliverOutbound's own check).
 */

/** The key of the unsubscribe links, from the cookie secret's derived keys (the API's office sign-in object). */
export const unsubscribeKeyOf = (secrets: Pick<AuthSecrets, 'recoveryCodeHash'>): Buffer => abuseKey(secrets, 'portal-unsubscribe')

/** The same key from the cookie secret itself (the worker and the scheduler, which have no sign-in object). */
export const unsubscribeKeyFor = (cookieSecret: string): Buffer => unsubscribeKeyOf(authSecrets(cookieSecret))

const IDENTITY = { id: true, companyId: true, kind: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

export interface MailPerson {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly locale: 'it' | 'en'
  readonly partyId: string
}

export type PartnerMailBody =
  | { readonly kind: 'notification'; readonly item: MailItem & { readonly notificationId: string } }
  | { readonly kind: 'digest'; readonly weekly: boolean; readonly items: readonly (MailItem & { readonly notificationId: string })[]; readonly more: number }

export interface SentMail {
  readonly outcome: 'SENT' | 'FAILED'
  readonly outboundId: string | null
  readonly detail: string | null
}

/** Sends one partner mail; never throws for a refused send (FAILED with why), so the caller logs what happened. */
export async function sendPartnerMail(caller: CommandCaller, input: { readonly tenantId: string; readonly companyId: string; readonly person: MailPerson; readonly body: PartnerMailBody; readonly runtime: EmailRuntime; readonly unsubscribeKey: Buffer; readonly clock?: Clock }): Promise<SentMail> {
  const { person, body, runtime } = input
  const facts = await caller.withClient(async (client) => {
    const identities = await client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY })
    const ready = identities.filter((entry) => identityReady(entry))
    const party = await client.party.findUnique({ where: { id: person.partyId }, select: { code: true } })
    const company = await client.company.findUnique({ where: { id: input.companyId }, select: { legalName: true, tradeName: true } })
    return { identity: ready.find((entry) => entry.companyId === input.companyId) ?? ready[0] ?? null, partyCode: party?.code ?? person.partyId, company }
  })
  if (!facts.identity) return { outcome: 'FAILED', outboundId: null, detail: 'the tenant has no verified sending identity' }
  const identity = facts.identity
  const legal = await companyLegalOf(caller, input.companyId)
  const footer = footerOf(legal, privacyNoticeUrl(runtime.webOrigin, input.companyId), person.locale)
  const links = { manage: portalEmailSettingsUrl(runtime.webOrigin, facts.partyCode), unsubscribe: unsubscribeUrl(runtime.webOrigin, unsubscribeToken(input.unsubscribeKey, input.tenantId, person.id)) }
  const companyName = facts.company ? (facts.company.tradeName ?? facts.company.legalName) : ''
  const mail: ComposedMail =
    body.kind === 'notification'
      ? composeNotificationMail({ recipientName: person.displayName, item: body.item, links, footer, locale: person.locale })
      : composeDigestMail({ recipientName: person.displayName, company: companyName, weekly: body.weekly, items: body.items, more: body.more, links, footer, locale: person.locale })
  const templateKey = PORTAL_MAIL_TEMPLATES[body.kind]
  const from = fromLine(identity, null)
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  await runCommand(caller, { name: 'email.queueSystem', input: { kind: templateKey, userId: person.id } }, async ({ tx, now, audit }) => {
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'User',
        recordId: person.id,
        templateKey,
        locale: person.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [normalizeAddress(person.email)],
        subject: mail.subject,
        emailMessageId,
        status: 'QUEUED',
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey, userId: person.id, identityId: identity.id, status: 'QUEUED' } })
    return null
  }, { ...COMMAND_SETTINGS, ...(input.clock ? { clock: input.clock } : {}) })
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    ...(input.clock ? { clock: input.clock } : {}),
    build: async (row) =>
      buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: (input.clock ?? { now: () => new Date() }).now(), text: mail.text, html: mail.html, automatic: true }),
  })
  return delivered === 'sent' ? { outcome: 'SENT', outboundId, detail: null } : { outcome: 'FAILED', outboundId: null, detail: 'the mail could not be sent (a suppressed address, or the provider refused it)' }
}

/** Logs what happened to each notification a mail carried, or why it was not mailed (append-only rows). */
export async function logPartnerDeliveries(
  caller: CommandCaller,
  input: { readonly key: string; readonly channel: 'EMAIL' | 'EMAIL_DIGEST'; readonly rows: readonly { readonly notificationId: string; readonly outcome: 'SENT' | 'SKIPPED' | 'FAILED'; readonly emailOutboundId: string | null; readonly detail: string | null }[]; readonly audit: { readonly recordType: string; readonly recordId: string; readonly after: Record<string, unknown> } },
): Promise<void> {
  if (input.rows.length === 0) return
  await command(caller, { name: 'portalNotifications.delivered', idempotencyKey: input.key, input: { channel: input.channel, notificationIds: input.rows.map((row) => row.notificationId) } }, async (tools) => {
    await tools.tx.notificationDelivery.createMany({
      data: input.rows.map((row) => ({ id: newId(), notificationId: row.notificationId, channel: input.channel, outcome: row.outcome, emailOutboundId: row.outcome === 'SENT' ? row.emailOutboundId : null, detail: row.outcome === 'SENT' ? null : row.detail, at: tools.now, requestId: tools.context.requestId, createdAt: tools.now })),
    })
    tools.audit({ recordType: input.audit.recordType, recordId: input.audit.recordId, after: input.audit.after })
    return null
  })
}
