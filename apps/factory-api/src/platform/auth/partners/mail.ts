import type { FactoryDatabase } from '@nexus/factory-db'
import { composePartnerMail, PARTNER_MAIL_TEMPLATES } from '@nexus/factory-domain/auth/partners/mail'
import { newId } from '@nexus/factory-domain/core/ids'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady, localeOf, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { companyLegalOf } from '../../documents/documents'
import { NoSenderError } from '../../email-out/auth-mail'
import { deliverOutbound } from '../../email-out/outbound'
import { processEmail, type EmailRuntime } from '../../email-out/service'
import { systemContext } from '../../outbox/system'

/**
 * The partner people's e-mails through email out (B-W2b-162), sent like the portal's code mails (auth/portal/mail.ts): made
 * in memory after the command committed, sent at once from the process; one command writes the EmailOutbound row (QUEUED,
 * the record is the person, `User`; no body) and deliverOutbound sends it through the gateway (SES; the FAKE account's
 * in-memory mailbox locally and in tests). Not retried by a job: the office sends an invitation again.
 *
 *   invitation      to an invited person: who invited them, to which portal, as which role, the portal's sign-in page
 *                   (`<web>/p/signin?tenant=<slug>&company=<code>`: no token: the person signs in with an e-mail code)
 *   access_ending   to a person whose access ends within 7 days (PLT-022)
 * The sender is the portal company's ready default NOTIFICATION identity (else CONVERSATION, else the tenant's oldest).
 */

export type PartnerMessage =
  | {
      readonly kind: 'invitation'
      readonly tenantId: string
      readonly companyId: string
      readonly userId: string
      readonly to: string
      readonly organisation: string
      readonly invitedBy: string
      readonly roleName: string
      readonly expiresAt: Date
      readonly accessUntil: Date | null
    }
  | { readonly kind: 'access_ending'; readonly tenantId: string; readonly companyId: string; readonly userId: string; readonly to: string; readonly accessUntil: Date; readonly contact: string }

export interface PartnerMailer {
  deliver(message: PartnerMessage): Promise<void>
}

const IDENTITY = { id: true, companyId: true, kind: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

/** The portal's sign-in page for a tenant and company (the web's /p/signin; B-W2b-164 builds it). */
export const signInPage = (webOrigin: string, tenantSlug: string, companyCode: string): string =>
  `${webOrigin.replace(/\/+$/, '')}/p/signin?tenant=${encodeURIComponent(tenantSlug)}&company=${encodeURIComponent(companyCode)}`

export function partnerMailer(options: { readonly database: FactoryDatabase; readonly clock?: Clock; readonly runtime?: () => EmailRuntime }): PartnerMailer {
  const runtimeOf = options.runtime ?? processEmail
  const clock = options.clock ?? COMMAND_SETTINGS.clock
  const settings = { ...COMMAND_SETTINGS, clock }

  return {
    async deliver(message) {
      const runtime = runtimeOf()
      const caller = callerFor(options.database, systemContext(message.tenantId, newId()))
      const slug = await options.database.withScope({ audience: 'platform' }, (client) => client.tenant.findUnique({ where: { id: message.tenantId }, select: { slug: true } }))
      const facts = await caller.withClient(async (client) => {
        const identities = await client.emailIdentity.findMany({
          where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } },
          orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: IDENTITY,
        })
        const ready = identities.filter((entry) => identityReady(entry))
        const identity = ready.find((entry) => entry.companyId === message.companyId) ?? ready[0] ?? null
        const user = await client.user.findUnique({ where: { id: message.userId }, select: { displayName: true, locale: true } })
        const company = await client.company.findUnique({ where: { id: message.companyId }, select: { code: true, legalName: true, tradeName: true } })
        return { identity, user, company }
      })
      const { identity } = facts
      if (!identity) throw new NoSenderError('The tenant has no verified sending identity: the portal mail was not sent.')
      const legal = await companyLegalOf(caller, message.companyId)
      const locale = localeOf(facts.user?.locale)
      const context = { locale, company: legal, privacyUrl: privacyNoticeUrl(runtime.webOrigin, message.companyId) }
      const recipientName = facts.user?.displayName ?? message.to
      const portalName = facts.company ? (facts.company.tradeName ?? facts.company.legalName) : ''
      const mail =
        message.kind === 'invitation'
          ? composePartnerMail(
              {
                template: PARTNER_MAIL_TEMPLATES.invitation,
                recipientName,
                portalName,
                organisation: message.organisation,
                invitedBy: message.invitedBy,
                roleName: message.roleName,
                link: signInPage(runtime.webOrigin, slug?.slug ?? '', facts.company?.code ?? ''),
                expiresAt: message.expiresAt,
                accessUntil: message.accessUntil,
              },
              context,
            )
          : composePartnerMail({ template: PARTNER_MAIL_TEMPLATES.access_ending, recipientName, portalName, accessUntil: message.accessUntil, contact: message.contact }, context)
      const templateKey = PARTNER_MAIL_TEMPLATES[message.kind]
      const to = normalizeAddress(message.to)
      const from = fromLine(identity, null)
      const outboundId = newId()
      const emailMessageId = messageIdFor(outboundId, identity.domain)

      await runCommand(
        caller,
        { name: 'email.queueSystem', input: { kind: templateKey, userId: message.userId } },
        async ({ tx, now, audit }) => {
          await tx.emailOutbound.create({
            data: {
              id: outboundId,
              companyId: identity.companyId,
              identityId: identity.id,
              recordType: 'User',
              recordId: message.userId,
              templateKey,
              locale,
              fromAddress: from.address,
              fromName: from.name,
              to: [to],
              subject: mail.subject,
              emailMessageId,
              status: 'QUEUED',
              queuedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          })
          audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey, userId: message.userId, identityId: identity.id, status: 'QUEUED' } })
          return null
        },
        settings,
      )

      await deliverOutbound(runtime, caller, outboundId, {
        retry: false,
        clock,
        build: async (row) =>
          buildMime({
            id: row.id,
            from: { name: row.fromName, address: row.fromAddress },
            to: row.to,
            cc: [],
            replyTo: null,
            subject: row.subject,
            messageId: row.emailMessageId,
            inReplyTo: null,
            references: [],
            date: clock.now(),
            text: mail.text,
            html: mail.html,
            automatic: true,
          }),
      })
    },
  }
}

const byDatabase = new WeakMap<object, PartnerMailer>()

/** The process's partner mailer for this database and clock (one per database). */
export function partnerMailerOf(database: FactoryDatabase, clock: Clock): PartnerMailer {
  let mailer = byDatabase.get(database)
  if (!mailer) {
    mailer = partnerMailer({ database, clock })
    byDatabase.set(database, mailer)
  }
  return mailer
}
