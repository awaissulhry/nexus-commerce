import { DomainError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { newId } from '@nexus/factory-domain/core/ids'
import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { appointmentIcs } from '@nexus/factory-domain/sales/fittings/ics'
import { appointmentKindWords, appointmentMail, type AppointmentKind, type AppointmentMail, type MailLanguage } from '@nexus/factory-domain/sales/fittings/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { serverClock, type Clock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound, sendingIdentity, type ClaimedOutbound } from '../../../platform/email-out/outbound'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { mailTargetOf } from '../mtm/profiles'
import { APPOINTMENT_RECORD, MAIL_TEMPLATES, type AppointmentRow, type Reader } from './store'

/**
 * The rider's mails of an appointment (B-W2b-360; SAL-054; design mtm.fitting "Invite (.ics) to the rider"): the invite, its
 * update when the appointment moves, the reminder the day before and the cancellation, each with the calendar object (.ics,
 * METHOD REQUEST or CANCEL; UID the appointment's, SEQUENCE its version) attached. As B-W2b-358's "need more" mail: INSIDE the
 * appointment's command the EmailOutbound row (QUEUED, record Appointment, template fittings.invite | update | reminder | cancel)
 * with its audit row, and the appointment's inviteSentAt / reminderSentAt set in the same command; after the commit the mail is
 * composed in memory and sent at once (deliverOutbound, never retried by a job: a failed one stays FAILED and the office sends
 * the invite again). From the company's identity: the office person's own mail (CONVERSATION, their name in the From line), the
 * system's for the reminder (NOTIFICATION, else CONVERSATION). To the rider: the appointment's contact, else the profile's
 * contact, else the address the profile's link went to, else the customer's orders contact. The tenant's mail account: FAKE
 * locally and in tests. No body data, no price, no link.
 */

export interface MailTarget {
  readonly email: string
  readonly language: MailLanguage
}

/** Where the rider's mails go (see the file's head), or null. */
export async function riderTargetOf(db: Reader, row: Pick<AppointmentRow, 'partyId' | 'contactId' | 'measurementProfileId'>): Promise<MailTarget | null> {
  if (row.contactId) {
    const contact = await db.partyContact.findFirst({ where: { id: row.contactId, partyId: row.partyId, status: 'ACTIVE', email: { not: null } }, select: { email: true, language: true } })
    if (contact?.email) return { email: contact.email.trim().toLowerCase(), language: contact.language === 'en' ? 'en' : 'it' }
  }
  const profile = row.measurementProfileId ? await db.measurementProfile.findUnique({ where: { id: row.measurementProfileId }, select: { partyId: true, contactId: true, submittedViaLinkId: true } }) : null
  const target = await mailTargetOf(db, profile ?? { partyId: row.partyId, contactId: null, submittedViaLinkId: null })
  return target ? { email: target.email, language: target.language === 'en' ? 'en' : 'it' } : null
}

/** The words the rider reads about an appointment (the garment's name from its template, the fitter's name). */
export async function mailFactsOf(db: Reader, row: Pick<AppointmentRow, 'kind' | 'riderName' | 'startsAt' | 'endsAt' | 'place' | 'withUserId' | 'withName'>, garmentType: string | null, language: MailLanguage) {
  const template = garmentType ? await db.measurementTemplate.findFirst({ where: { code: garmentType }, select: { name: true, nameI18n: true } }) : null
  const garment = template ? ((((template.nameI18n ?? {}) as Record<string, unknown>)[language] as string | undefined) ?? template.name) : null
  const fitter = row.withName ?? (row.withUserId ? ((await db.user.findUnique({ where: { id: row.withUserId }, select: { displayName: true } }))?.displayName ?? null) : null)
  return { kind: row.kind as AppointmentKind, riderName: row.riderName, startsAt: row.startsAt, endsAt: row.endsAt, place: row.place, withWho: fitter, garment }
}

export interface QueuedMail {
  readonly mail: AppointmentMail
  readonly outboundId: string
  readonly body: string
  readonly language: MailLanguage
  readonly riderName: string | null
  /** Plain JSON (a command's answer): the times as ISO strings. */
  readonly appointment: { readonly id: string; readonly kind: AppointmentKind; readonly startsAt: string; readonly endsAt: string; readonly place: string; readonly sequence: number }
  readonly senderName: string | null
}

/**
 * Inside the appointment's command: the QUEUED outbound row and its audit row (null when the company has no sending identity: the
 * appointment stands, the answer says the mail did not go). `sequence` is the appointment's version after this command.
 */
export async function queueAppointmentMail(
  tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>,
  input: {
    readonly mail: AppointmentMail
    readonly companyId: string
    readonly appointment: Pick<AppointmentRow, 'id' | 'kind' | 'riderName' | 'startsAt' | 'endsAt' | 'place' | 'withUserId' | 'withName'>
    readonly sequence: number
    readonly garmentType: string | null
    readonly to: MailTarget
    readonly language: MailLanguage
    /** The office person who sends; null for the system (the reminder). */
    readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null } | null
  },
): Promise<QueuedMail | null> {
  let identity
  try {
    identity = input.sender ? await sendingIdentity(tools.tx, input.companyId, null, 'CONVERSATION') : await systemIdentity(tools, input.companyId)
  } catch (error) {
    if (error instanceof DomainError) return null
    throw error
  }
  const words = appointmentMail(input.mail, input.language, await mailFactsOf(tools.tx, input.appointment, input.garmentType, input.language))
  const from = fromLine(identity, input.sender ? { name: input.sender.name, email: input.sender.email } : null)
  const outboundId = newId()
  const template = MAIL_TEMPLATES[input.mail]
  await tools.tx.emailOutbound.create({
    data: {
      id: outboundId,
      companyId: identity.companyId,
      identityId: identity.id,
      recordType: APPOINTMENT_RECORD,
      recordId: input.appointment.id,
      templateKey: template,
      locale: input.language,
      fromAddress: from.address,
      fromName: from.name,
      to: [input.to.email],
      subject: words.subject,
      emailMessageId: messageIdFor(outboundId, identity.domain),
      status: 'QUEUED',
      queuedAt: tools.now,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: input.sender?.userId ?? null,
    },
    select: { id: true },
  })
  tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: template, appointmentId: input.appointment.id, identityId: identity.id, recipients: 1, attachments: 1, status: 'QUEUED' } })
  const appointment = input.appointment
  return {
    mail: input.mail,
    outboundId,
    body: words.body,
    language: input.language,
    riderName: appointment.riderName,
    appointment: { id: appointment.id, kind: appointment.kind as AppointmentKind, startsAt: toUtcIso(appointment.startsAt), endsAt: toUtcIso(appointment.endsAt), place: appointment.place, sequence: input.sequence },
    senderName: input.sender?.name ?? null,
  }
}

async function systemIdentity(tools: Pick<CommandTools, 'tx'>, companyId: string) {
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
    throw error
  }
}

/** After the commit: the mail composed with its .ics, in memory, and sent at once. 'SENT' | 'FAILED' | 'QUEUED'. */
export async function deliverAppointmentMail(email: EmailRuntime, caller: CommandCaller, queued: QueuedMail, clock: Clock = serverClock): Promise<'SENT' | 'FAILED' | 'QUEUED'> {
  const outcome = await deliverOutbound(email, caller, queued.outboundId, { retry: false, clock, build: (row) => mimeOf(email, caller, row, queued, clock) })
  return outcome === 'sent' ? 'SENT' : outcome === 'failed' ? 'FAILED' : 'QUEUED'
}

async function mimeOf(email: EmailRuntime, caller: CommandCaller, row: ClaimedOutbound, queued: QueuedMail, clock: Clock): Promise<string> {
  const company = await companyLegalOf(caller, row.companyId)
  const filename = queued.language === 'it' ? 'appuntamento.ics' : 'appointment.ics'
  const mail = compose({ template: 'thread.message', body: cleanBody(queued.body), senderName: queued.senderName, companyName: row.identity.displayName, attachmentNames: [filename] }, { locale: queued.language, company, privacyUrl: privacyNoticeUrl(email.webOrigin, row.companyId) })
  const what = appointmentKindWords(queued.appointment.kind, queued.language)
  const ics = appointmentIcs({
    method: queued.mail === 'CANCEL' ? 'CANCEL' : 'REQUEST',
    appointmentId: queued.appointment.id,
    domain: row.identity.domain,
    sequence: queued.appointment.sequence,
    stamp: clock.now(),
    startsAt: new Date(queued.appointment.startsAt),
    endsAt: new Date(queued.appointment.endsAt),
    summary: `${what.charAt(0).toUpperCase()}${what.slice(1)} · ${row.identity.displayName}`,
    location: queued.appointment.place,
    description: queued.body,
    organizer: { name: row.fromName, email: row.fromAddress },
    attendee: { name: queued.riderName, email: row.to[0]! },
  })
  return buildMime({
    id: row.id,
    from: { name: row.fromName, address: row.fromAddress },
    to: row.to,
    cc: row.cc,
    replyTo: null,
    subject: row.subject,
    messageId: row.emailMessageId,
    inReplyTo: null,
    references: [],
    date: clock.now(),
    text: mail.text,
    html: mail.html,
    automatic: queued.senderName === null,
    attachments: [{ filename, contentType: 'text/calendar', content: new TextEncoder().encode(ics) }],
  })
}
