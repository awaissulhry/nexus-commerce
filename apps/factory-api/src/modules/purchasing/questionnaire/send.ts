import type { FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { QUESTIONNAIRE_SEND } from '@nexus/factory-domain/purchasing/questionnaire/permissions'
import { questionnaireMail } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import { command, idempotencyKeyFrom, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { deliverLinkMail } from '../../../platform/links/mail'
import { assertNoPayByLink, LinkRefusedError } from '../../../platform/links/pay'
import { currentVersion } from './store'

/**
 * The questionnaire by link (B-W2b-172; SCM-023; design purchasing.suppliers "Links › Supplier questionnaire —
 * Onboarding", links.onboard; the purpose SUPPLIER_ONBOARD of B-W2b-154/163, record = the supplier itself):
 *
 *   POST /purchasing/suppliers/:partyId/questionnaire-link {contactId? | email?, send, language?, expiresInDays?, note?}
 *        purchasing.questionnaire.send over the supplier's company (a tenant-wide supplier: the screen's company). The
 *        company must have a PUBLISHED version (the link asks the newest one when it is opened and when it is sent). ONE
 *        command withdraws the supplier's earlier open questionnaire links of the company (one form, one draft at a time),
 *        makes the new link (the token minted before it, only its hash stored; the buyer's note kept on it), and queues
 *        its mail; after the commit the mail goes (FAKE locally) or, without `send`, the address comes back ONCE for the
 *        buyer to pass on. Asked again = a new link and, once sent, a new answer: an answer is never changed.
 *
 * The link opens nothing but its supplier's questionnaire: no price, no other record (the purpose holds no grain).
 */

export const QUESTIONNAIRE_MAIL_TEMPLATE = 'purchasing.questionnaire_link'

export interface SendLinkBody {
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly send: boolean
  readonly language?: 'it' | 'en' | undefined
  readonly expiresInDays?: number | undefined
  readonly note?: string | undefined
}

const localeOf = (language: string | null | undefined): 'it' | 'en' => (language === 'en' ? 'en' : 'it')

export async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string) {
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
    throw error
  }
}

/** The office person who may send the questionnaire to this supplier, in the company the questionnaire is of. */
export function senderOf(request: FastifyRequest, party: { readonly companyId: string | null }): { context: OfficeContext; companyId: string } {
  const context = request.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  const companyId = party.companyId ?? context.companyId
  if (!companyId) throw new ValidationError('Choose the company first.', [{ path: 'headers/x-factory-company', message: 'The company that asks.' }])
  return { context, companyId }
}

/** POST /purchasing/suppliers/:partyId/questionnaire-link. */
export async function sendQuestionnaireLink(request: FastifyRequest, partyId: string, body: SendLinkBody) {
  const auth = officeAuthOf(request.server)
  const facts = isUuid(partyId)
    ? await request.withClient(async (client) => {
        const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, companyId: true, language: true, roles: true, status: true } })
        if (!party) return null
        const contact = body.contactId && isUuid(body.contactId) ? await client.partyContact.findFirst({ where: { id: body.contactId, partyId, status: 'ACTIVE' }, select: { email: true, language: true } }) : null
        return { party, contact }
      })
    : null
  if (!facts) throw new NotFoundError('Supplier not found.')
  const { context, companyId } = senderOf(request, facts.party)
  if (!can(actorOf(context), QUESTIONNAIRE_SEND, { companyId, partyId })) throw new NotFoundError('Supplier not found.')
  if (facts.party.status === 'ARCHIVED') throw new InvalidStateError('This supplier is archived: reactivate it first.')
  if (body.contactId && !facts.contact?.email) throw new ValidationError('Not a contact of this supplier with an e-mail.', [{ path: 'body/contactId', message: 'Not a contact of this supplier with an e-mail.' }])
  const typed = body.email === undefined || body.email === '' ? null : emailOrThrow(body.email, 'body/email')
  const to = facts.contact?.email?.trim().toLowerCase() ?? typed
  if (body.send && !to) throw new ValidationError('Give the address the link goes to, or take the link to pass it on yourself.', [{ path: 'body/email', message: 'An address to send the link to.' }])
  const locale = body.language ?? localeOf(facts.contact?.language ?? facts.party.language)
  const note = body.note?.trim() || null
  const { company, user, version } = await request.withClient(async (client) => ({
    company: await client.company.findUnique({ where: { id: companyId }, select: { legalName: true, tradeName: true } }),
    user: await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }),
    version: await currentVersion(client, companyId),
  }))
  if (!version) throw new InvalidStateError('The company has no published questionnaire yet: publish one first.')
  const companyName = company?.tradeName ?? company?.legalName ?? ''
  const sender = user ? { name: user.displayName, email: user.email } : null
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId, linkId })

  const { result, replayed } = await command(
    request,
    { name: 'purchasing.questionnaire.sendLink', idempotencyKey: idempotencyKeyFrom(request), input: { partyId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      // The supplier's row locked (never changed): two sends at once withdraw and make one after the other.
      await tx.$queryRaw`SELECT id FROM "Party" WHERE id = ${partyId}::uuid FOR UPDATE`
      await assertNoPayByLink(tx, { recordType: 'Party', recordId: partyId })
      if (body.send && to && (await suppressedAmong(tx, [to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
      // One open questionnaire at a time: the earlier open links of this supplier in this company are withdrawn.
      const earlier = await tx.oneOffLink.findMany({ where: { companyId, partyId, purpose: 'SUPPLIER_ONBOARD', revokedAt: null }, select: { id: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
      const live = earlier.filter((link) => linkState(link, now) === 'LIVE').map((link) => link.id)
      if (live.length > 0) {
        await tx.oneOffLink.updateMany({ where: { id: { in: live }, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
        for (const id of live) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: id, companyId, after: { revokedAt: toUtcIso(now), why: 'a new questionnaire link' } })
      }
      const terms = linkTerms('SUPPLIER_ONBOARD', { expiresInDays: body.expiresInDays }, now)
      await tx.oneOffLink.createMany({
        data: [
          {
            id: linkId,
            companyId,
            partyId,
            purpose: 'SUPPLIER_ONBOARD',
            recordType: 'Party',
            recordId: partyId,
            tokenHash: linkTokenHash(token.value),
            email: to,
            note,
            expiresAt: terms.expiresAt,
            maxUses: terms.maxUses,
            contactId: facts.contact ? body.contactId! : null,
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
        ],
      })
      tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId, after: { purpose: 'SUPPLIER_ONBOARD', recordType: 'Party', recordId: partyId, partyId, email: to, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses, questionnaireId: version.id, revision: version.revision } })
      let outboundId: string | null = null
      if (body.send && to) {
        const identity = await identityFor(tools, companyId)
        const from = fromLine(identity, sender)
        const mail = questionnaireMail(locale, { companyName, expiresOn: businessDate(terms.expiresAt), note }, '')
        outboundId = newId()
        await tx.emailOutbound.create({
          data: {
            id: outboundId,
            companyId: identity.companyId,
            identityId: identity.id,
            recordType: 'OneOffLink',
            recordId: linkId,
            templateKey: QUESTIONNAIRE_MAIL_TEMPLATE,
            locale,
            fromAddress: from.address,
            fromName: from.name,
            to: [to],
            subject: mail.subject,
            emailMessageId: messageIdFor(outboundId, identity.domain),
            status: 'QUEUED',
            queuedAt: now,
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: QUESTIONNAIRE_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
      }
      tools.audit({ action: 'purchasing.questionnaire.sendLink', recordType: 'Party', recordId: partyId, companyId, after: { linkId, questionnaireId: version.id, revision: version.revision, mailed: outboundId !== null, withdrawn: live.length } })
      tools.emit({ type: 'supplier_questionnaire.link_sent', subject: partyId, companyId, payload: { linkId, partyId, questionnaireId: version.id, mailed: outboundId !== null, withdrawn: live.length, expiresAt: toUtcIso(terms.expiresAt) } })
      return { linkId, outboundId, expiresAt: toUtcIso(terms.expiresAt), withdrawn: live.length }
    },
  )
  const link = { id: result.linkId, expiresAt: result.expiresAt, email: to, withdrawn: result.withdrawn }
  if (replayed) {
    const status = result.outboundId ? await request.withClient((client) => client.emailOutbound.findUnique({ where: { id: result.outboundId! }, select: { status: true } })) : null
    return { link, url: null, delivery: status ? (status.status === 'SENT' ? ('SENT' as const) : status.status === 'FAILED' ? ('FAILED' as const) : ('QUEUED' as const)) : null }
  }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { link, url, delivery: null }
  const text = questionnaireMail(locale, { companyName, expiresOn: businessDate(new Date(result.expiresAt)), note }, url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { link, url: null, delivery }
}
