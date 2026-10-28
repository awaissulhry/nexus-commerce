import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { AUTH_TEMPLATES, compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady, localeOf, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../core/command'
import type { Clock } from '../../core/time'
import type { AuthMailer, AuthMessage } from '../auth/sessions/mail'
import { systemContext } from '../outbox/system'
import { deliverOutbound } from './outbound'
import { processEmail, type EmailRuntime } from './service'

/**
 * Sign-in mail through email out (features PLT-015 invitations, PLT-070 password resets; the mail seam of
 * platform/auth/sessions/mail.ts). A sign-in mail carries a single-use link, so — unlike a record mail, whose text is
 * its thread message and which the worker sends later — it is made IN MEMORY and sent at once, in the API process,
 * right after the command that made the link committed:
 *
 *   1. as the tenant's system (no session: the mail is the tenant's, not the person's), the sender is the tenant's
 *      oldest ready default NOTIFICATION identity (else a ready default CONVERSATION one);
 *   2. the text and HTML are composed with the link, in the person's language, with the company's footer;
 *   3. one command writes the EmailOutbound row (QUEUED: to whom, from which identity, the subject, the Message-ID —
 *      NO body and NO link; the record is the person, `User`), with its audit row (no link either);
 *   4. deliverOutbound claims it (the suppression list and the identity checked again), sends it through the gateway
 *      (`mail.send`, one IntegrationCall row: no address, no link) and records SENT, or FAILED with why. A sign-in mail
 *      is not retried by a job (its body was never stored): the person asks again (a new invitation, a new reset).
 *
 * No thread: a sign-in mail is between the tenant and one person, not part of a record's conversation, and nobody
 * answers it (no Reply-To; `Auto-Submitted: auto-generated`). Its link exists in the sent mail only: never in a row,
 * an audit entry, an event, a receipt, the gateway ledger or a log.
 */

export interface AuthMailOptions {
  readonly database: FactoryDatabase
  /** The commands' clock (the office sign-in's). Default the server's. */
  readonly clock?: Clock
  /** Default the process's (processEmail). */
  readonly runtime?: () => EmailRuntime
}

export class NoSenderError extends Error {
  override name = 'NoSenderError'
}

const IDENTITY = {
  id: true,
  companyId: true,
  domain: true,
  fromAddress: true,
  displayName: true,
  displayNamePolicy: true,
  status: true,
  verificationStatus: true,
  dkimStatus: true,
} as const

export function emailAuthMailer(options: AuthMailOptions): AuthMailer {
  const runtimeOf = options.runtime ?? processEmail
  const clock = options.clock ?? COMMAND_SETTINGS.clock
  const settings = { ...COMMAND_SETTINGS, clock }

  return {
    async deliver(message: AuthMessage): Promise<void> {
      const runtime = runtimeOf()
      const caller = callerFor(options.database, systemContext(message.tenantId, newId()))
      const facts = await caller.withClient(async (client) => {
        const identities = await client.emailIdentity.findMany({
          where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } },
          orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: IDENTITY,
        })
        const identity = identities.find((entry) => identityReady(entry)) ?? null
        const user = await client.user.findUnique({ where: { id: message.userId }, select: { displayName: true, locale: true } })
        const tenant = await client.tenant.findUnique({ where: { id: message.tenantId }, select: { name: true } })
        const inviter =
          message.kind === 'invitation' && message.invitedById ? await client.user.findUnique({ where: { id: message.invitedById }, select: { displayName: true } }) : null
        const company = identity
          ? await client.company.findUniqueOrThrow({
              where: { id: identity.companyId },
              select: { legalName: true, address: true, vatNumber: true, fiscalCode: true, reaOffice: true, reaNumber: true, shareCapital: true, currency: true, pec: true },
            })
          : null
        return { identity, user, tenant, inviter, company }
      })
      const { identity, company } = facts
      if (!identity || !company) throw new NoSenderError('The tenant has no verified sending identity: the sign-in mail was not sent.')

      const locale = localeOf(facts.user?.locale)
      const recipientName = facts.user?.displayName ?? message.to
      const context = { locale, company: { ...company, shareCapital: company.shareCapital?.toString() ?? null }, privacyUrl: privacyNoticeUrl(runtime.webOrigin, identity.companyId) }
      const mail =
        message.kind === 'invitation'
          ? compose(
              { template: AUTH_TEMPLATES.invitation, recipientName, inviterName: facts.inviter?.displayName ?? null, tenantName: facts.tenant?.name ?? '', link: message.link, expiresAt: message.expiresAt },
              context,
            )
          : compose({ template: AUTH_TEMPLATES.password_reset, recipientName, link: message.link, expiresAt: message.expiresAt }, context)
      const to = normalizeAddress(message.to)
      const from = fromLine(identity, null)
      const templateKey = AUTH_TEMPLATES[message.kind]
      const subject = mail.subject ?? ''
      const outboundId = newId()
      const emailMessageId = messageIdFor(outboundId, identity.domain)

      await runCommand(caller, { name: 'email.queueSystem', input: { kind: message.kind, userId: message.userId } }, async ({ tx, now, audit }) => {
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
            subject,
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
      }, settings)

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
