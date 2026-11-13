import { newId } from '@nexus/factory-domain/core/ids'
import { escapeHtml, footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady, normalizeAddress } from '@nexus/factory-domain/email/rules'
import type { DigestLocale } from '@nexus/factory-domain/notifications/rules'
import { command, type CommandCaller } from '../../../core/command'
import { companyLegalOf } from '../../documents/documents'
import { deliverOutbound } from '../../email-out/outbound'
import type { EmailRuntime } from '../../email-out/service'

/**
 * The instant notification mail (B-W2b-385; PLT-141 "e-mail as it happens"; Rule 1 of the plan: e-mail alone can now be
 * chosen): ONE mail per notification for an office person whose e-mail column says "as it happens" for its kind. Made in
 * memory in the person's language from the notification's own params cut to their grains now (PLT-152), one EmailOutbound
 * row (record `User`, template `notifications.instant`, NO body) from the tenant's ready default NOTIFICATION identity (the
 * notification's company first), sent at once through deliverOutbound (suppression and identity checked again; FAKE SES
 * locally and in tests: no real mail leaves the machine). Never retried by a job: a failure is logged as the delivery's.
 */

export const INSTANT_TEMPLATE_KEY = 'notifications.instant'

const IDENTITY = { id: true, companyId: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

const WORDS = {
  en: { hello: (name: string) => `Hello ${name},`, open: 'Open it in the factory:', why: 'You get this mail as it happens because of your notification choices (Home › Notifications › Preferences).' },
  it: { hello: (name: string) => `Ciao ${name},`, open: 'Aprila nella fabbrica:', why: 'Ricevi questa e-mail subito per le tue scelte sulle notifiche (Home › Notifiche › Preferenze).' },
} as const

export interface InstantMail {
  readonly person: { readonly id: string; readonly email: string; readonly displayName: string; readonly locale: DigestLocale }
  readonly companyId: string | null
  readonly subject: string
  readonly sentence: string
  /** The notification's page (absolute). */
  readonly link: string
}

/** Sends one instant mail; never throws for a refused send (FAILED with why), so the caller logs what happened. */
export async function sendInstantMail(caller: CommandCaller, runtime: EmailRuntime, mail: InstantMail): Promise<{ readonly outcome: 'SENT' | 'FAILED'; readonly outboundId: string | null; readonly detail: string | null }> {
  const identities = await caller.withClient((client) => client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY }))
  const ready = identities.filter((entry) => identityReady(entry))
  const identity = ready.find((entry) => entry.companyId === mail.companyId) ?? ready[0] ?? null
  if (!identity) return { outcome: 'FAILED', outboundId: null, detail: 'the tenant has no verified sending identity' }
  const words = WORDS[mail.person.locale]
  const legal = await companyLegalOf(caller, identity.companyId)
  const footer = footerOf(legal, privacyNoticeUrl(runtime.webOrigin, identity.companyId), mail.person.locale)
  const text = [words.hello(mail.person.displayName), '', mail.sentence, '', `${words.open} ${mail.link}`, '', words.why, '', footer.text].join('\n')
  const html = `<p>${escapeHtml(words.hello(mail.person.displayName))}</p><p>${escapeHtml(mail.sentence)}</p><p>${escapeHtml(words.open)} <a href="${escapeHtml(mail.link)}">${escapeHtml(mail.link)}</a></p><p>${escapeHtml(words.why)}</p>${footer.html}`
  const from = fromLine(identity, null)
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  await command(caller, { name: 'email.queueSystem', input: { kind: INSTANT_TEMPLATE_KEY, userId: mail.person.id } }, async ({ tx, now, audit }) => {
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'User',
        recordId: mail.person.id,
        templateKey: INSTANT_TEMPLATE_KEY,
        locale: mail.person.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [normalizeAddress(mail.person.email)],
        subject: mail.subject,
        emailMessageId,
        status: 'QUEUED',
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: INSTANT_TEMPLATE_KEY, userId: mail.person.id, identityId: identity.id, status: 'QUEUED' } })
    return null
  })
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    build: async (row) => buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: new Date(), text, html, automatic: true }),
  })
  return delivered === 'sent' ? { outcome: 'SENT', outboundId, detail: null } : { outcome: 'FAILED', outboundId: null, detail: 'the mail could not be sent (a suppressed address, or the provider refused it)' }
}
