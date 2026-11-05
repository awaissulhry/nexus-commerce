import type { FactoryDatabase } from '@nexus/factory-db'
import { composePortalMail, PORTAL_MAIL_TEMPLATES } from '@nexus/factory-domain/auth/portal/mail'
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
 * The portal's sign-in and step-up mails through email out (B-W2b-159; PLT-050; Owner answer C3: e-mail codes, free).
 * Like the office's sign-in mail (platform/email-out/auth-mail.ts) a code mail is made IN MEMORY and sent at once, in the
 * API process, right after the command that made the code committed:
 *
 *   1. as the tenant's system, the sender is the portal company's ready default NOTIFICATION identity (else its
 *      CONVERSATION one, else the tenant's oldest ready default one);
 *   2. the text and HTML (factory-domain auth/portal/mail.ts) hold the 6-digit code and, for a sign-in, the link, in the
 *      person's language, with the company's footer;
 *   3. one command writes the EmailOutbound row (QUEUED; the record is the person, `User`; template auth.portal_sign_in or
 *      auth.portal_step_up; the subject never holds the code) with its audit row — NO body, NO code, NO link;
 *   4. deliverOutbound claims and sends it through the gateway (SES; the FAKE account's in-memory mailbox locally and in
 *      tests), SENT or FAILED with why. Not retried by a job (the body was never stored): the person asks for a new code.
 * The code and the link exist in the sent mail only: never in a row, an audit entry, an event, a receipt or a log.
 */

export type PortalMessage =
  | { readonly kind: 'sign_in'; readonly tenantId: string; readonly companyId: string; readonly userId: string; readonly to: string; readonly code: string; readonly link: string; readonly expiresAt: Date }
  | { readonly kind: 'step_up'; readonly tenantId: string; readonly companyId: string; readonly userId: string; readonly to: string; readonly code: string; readonly expiresAt: Date }

export interface PortalMailer {
  deliver(message: PortalMessage): Promise<void>
}

const IDENTITY = { id: true, companyId: true, kind: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

export function portalMailer(options: { readonly database: FactoryDatabase; readonly clock?: Clock; readonly runtime?: () => EmailRuntime }): PortalMailer {
  const runtimeOf = options.runtime ?? processEmail
  const clock = options.clock ?? COMMAND_SETTINGS.clock
  const settings = { ...COMMAND_SETTINGS, clock }

  return {
    async deliver(message) {
      const runtime = runtimeOf()
      const caller = callerFor(options.database, systemContext(message.tenantId, newId()))
      const facts = await caller.withClient(async (client) => {
        const identities = await client.emailIdentity.findMany({
          where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } },
          orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: IDENTITY,
        })
        const ready = identities.filter((entry) => identityReady(entry))
        const identity = ready.find((entry) => entry.companyId === message.companyId) ?? ready[0] ?? null
        const user = await client.user.findUnique({ where: { id: message.userId }, select: { displayName: true, locale: true } })
        const company = await client.company.findUnique({ where: { id: message.companyId }, select: { legalName: true, tradeName: true } })
        return { identity, user, portalName: company ? (company.tradeName ?? company.legalName) : '' }
      })
      const { identity } = facts
      if (!identity) throw new NoSenderError('The tenant has no verified sending identity: the portal code mail was not sent.')
      const legal = await companyLegalOf(caller, message.companyId)
      const locale = localeOf(facts.user?.locale)
      const context = { locale, company: legal, privacyUrl: privacyNoticeUrl(runtime.webOrigin, message.companyId) }
      const recipientName = facts.user?.displayName ?? message.to
      const mail =
        message.kind === 'sign_in'
          ? composePortalMail({ template: PORTAL_MAIL_TEMPLATES.sign_in, recipientName, portalName: facts.portalName, code: message.code, link: message.link, expiresAt: message.expiresAt }, context)
          : composePortalMail({ template: PORTAL_MAIL_TEMPLATES.step_up, recipientName, portalName: facts.portalName, code: message.code, expiresAt: message.expiresAt }, context)
      const templateKey = PORTAL_MAIL_TEMPLATES[message.kind]
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
