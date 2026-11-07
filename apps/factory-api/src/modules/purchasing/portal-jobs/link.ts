import type { FastifyRequest } from 'fastify'
import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { acceptedWords, declinedWords, shortDay, type DeclineReason, type Locale } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { command, idempotencyKeyFrom, type CommandTools } from '../../../core/command'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { deliverLinkMail } from '../../../platform/links/mail'
import { assertNoPayByLink, LinkRefusedError } from '../../../platform/links/pay'
import { linkCommand, useLink } from '../../../platform/links/use'
import { dayOf } from '../store'
import { officeOrder } from '../subcontracting/store'
import { acceptInCommand, declineInCommand, rowsInCommand, type Who } from './acts'
import { jobLinkProblem, workshopView } from './office'
import { jobView, localeOf, readJobContext, readJobOrder, readJobRows } from './read'
import { revokeJobLinksInCommand } from './tasks'

/**
 * The job by link (B-W2b-176; PLN-163; design links.job "Accept a job": the job on one phone screen; JOB_ACCEPT, B-W2b-154/163):
 *
 *   office  POST /purchasing/subcontracting/orders/:id/job-link {contactId? | email?, send, language?, expiresInDays?}
 *           (purchasing.subcontract.manage): while the order is issued and the workshop has not answered, ONE command stops
 *           the job's live links, makes a new one (the token minted before the command, only its hash stored), and queues
 *           its mail; after the commit the mail goes (FAKE locally) or, without `send`, the address comes back ONCE so the
 *           office can pass it on (a terzista on WhatsApp). No price on the link (JOB_ACCEPT holds no grain).
 *   link    GET /link/job (links.open): the job — operations, pieces per size, kit day, due back, notes — without any price;
 *           POST /link/job/accept (links.accept), /link/job/move-date (links.moveDate: accept with another due-back day and
 *           why), /link/job/decline (links.decline): ONE link command each, the link used (evidence ACCEPTED, MOVED_DATE or
 *           DECLINED with the typed name) with the answer (./acts.ts, via LINK).
 */

const JOB_MAIL_TEMPLATE = 'purchasing.job_link'

export interface JobLinkBody {
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly send: boolean
  readonly language?: 'it' | 'en' | undefined
  readonly expiresInDays?: number | undefined
}

function jobMail(locale: Locale, input: { readonly companyName: string; readonly number: string; readonly operations: string; readonly pieces: number; readonly due: string | null; readonly expiresAt: Date }, url: string) {
  const until = shortDay(toUtcIso(input.expiresAt).slice(0, 10), locale)
  const due = input.due ? shortDay(input.due, locale) : null
  if (locale === 'it') {
    return {
      subject: `Lavorazione ${input.number} da accettare — ${input.companyName}`,
      body: [
        `Buongiorno,`,
        ``,
        `${input.companyName} ti propone la lavorazione ${input.number}: ${input.operations}, ${input.pieces} pezzi${due ? `, da rendere entro il ${due}` : ''}.`,
        `Apri il link per vedere taglie, kit e date, e accetta, proponi un'altra data o rifiuta:`,
        url,
        ``,
        `Il link vale fino al ${until} ed è solo per te: non inoltrarlo.`,
      ].join('\n'),
    }
  }
  return {
    subject: `Job ${input.number} to accept — ${input.companyName}`,
    body: [
      `Hello,`,
      ``,
      `${input.companyName} offers you job ${input.number}: ${input.operations}, ${input.pieces} pieces${due ? `, due back by ${due}` : ''}.`,
      `Open the link to see the sizes, the kit and the dates, and accept, propose another date or decline:`,
      url,
      ``,
      `The link works until ${until} and is for you only: please do not forward it.`,
    ].join('\n'),
  }
}

async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string) {
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
    throw error
  }
}

/** POST /purchasing/subcontracting/orders/:id/job-link. */
export async function sendJobLink(request: FastifyRequest, orderId: string, body: JobLinkBody) {
  const { context, order: seen } = await officeOrder(request, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const auth = officeAuthOf(request.server)
  const facts = await request.withClient(async (client) => {
    const order = (await readJobOrder(client, seen.id))!
    const rows = await readJobRows(client, order)
    const context2 = await readJobContext(client, rows, null)
    const party = await client.party.findUnique({ where: { id: order.partyId }, select: { language: true } })
    const contact = body.contactId ? await client.partyContact.findFirst({ where: { id: body.contactId, partyId: order.partyId, status: 'ACTIVE' }, select: { email: true, language: true } }) : null
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { order, rows, context: context2, party, contact, user }
  })
  const problem = jobLinkProblem(facts.order)
  if (problem) throw new InvalidStateError(problem)
  if (body.contactId && !facts.contact?.email) throw new ValidationError('Not a contact of this workshop with an e-mail.', [{ path: 'body/contactId', message: 'Not a contact of this workshop with an e-mail.' }])
  const typed = body.email === undefined ? null : emailOrThrow(body.email, 'body/email')
  const to = facts.contact?.email?.trim().toLowerCase() ?? typed
  if (body.send && !to) throw new ValidationError('Give the address the link goes to, or take the link to pass it on yourself.', [{ path: 'body/email', message: 'An address to send the link to.' }])
  const locale: Locale = body.language ?? localeOf(facts.contact?.language ?? facts.party?.language)
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: facts.order.partyId, linkId })
  const view = jobView(facts.rows, facts.context, locale)
  const mailFacts = {
    companyName: facts.context.companyName,
    number: facts.order.number,
    operations: view.operations.map((operation) => operation.name || operation.code).join(', '),
    pieces: view.operations.reduce((sum, operation) => sum + operation.pieces, 0),
    due: view.expectedBackDate,
  }
  const sender = facts.user ? { name: facts.user.displayName, email: facts.user.email } : null
  const { result, replayed } = await command(
    request,
    { name: 'purchasing.subcontract.jobLink', idempotencyKey: idempotencyKeyFrom(request), input: { orderId, ...body }, record: { type: 'SubcontractOrder', id: facts.order.id } },
    async (tools) => {
      const order = (await rowsInCommand(tools, facts.order.id)).order
      const again = jobLinkProblem(order)
      if (again) throw new InvalidStateError(again)
      await assertNoPayByLink(tools.tx, { recordType: 'SubcontractOrder', recordId: order.id })
      if (body.send && to && (await suppressedAmong(tools.tx, [to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
      await revokeJobLinksInCommand(tools, order, context.actorId)
      const terms = linkTerms('JOB_ACCEPT', { expiresInDays: body.expiresInDays }, tools.now)
      await tools.tx.oneOffLink.createMany({
        data: [
          {
            id: linkId,
            companyId: order.companyId,
            partyId: order.partyId,
            purpose: 'JOB_ACCEPT',
            recordType: 'SubcontractOrder',
            recordId: order.id,
            tokenHash: linkTokenHash(token.value),
            email: to,
            expiresAt: terms.expiresAt,
            maxUses: terms.maxUses,
            contactId: body.contactId ?? null,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: context.actorId,
          },
        ],
      })
      tools.audit({
        action: 'links.create',
        recordType: 'OneOffLink',
        recordId: linkId,
        companyId: order.companyId,
        siteId: order.siteId,
        after: { purpose: 'JOB_ACCEPT', recordType: 'SubcontractOrder', recordId: order.id, partyId: order.partyId, email: to, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses },
      })
      let outboundId: string | null = null
      if (body.send && to) {
        const identity = await identityFor(tools, order.companyId)
        const from = fromLine(identity, sender)
        const mail = jobMail(locale, { ...mailFacts, expiresAt: terms.expiresAt }, '')
        outboundId = newId()
        await tools.tx.emailOutbound.create({
          data: {
            id: outboundId,
            companyId: identity.companyId,
            identityId: identity.id,
            recordType: 'OneOffLink',
            recordId: linkId,
            templateKey: JOB_MAIL_TEMPLATE,
            locale,
            fromAddress: from.address,
            fromName: from.name,
            to: [to],
            subject: mail.subject,
            emailMessageId: messageIdFor(outboundId, identity.domain),
            status: 'QUEUED',
            queuedAt: tools.now,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: JOB_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
      }
      tools.emit({
        type: 'subcontract_order.job_sent',
        subject: order.id,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { subcontractOrderId: order.id, number: order.number, status: order.status, partyId: order.partyId, linkId, mailed: outboundId !== null, expiresAt: toUtcIso(terms.expiresAt) },
      })
      return { linkId, outboundId, expiresAt: toUtcIso(terms.expiresAt) }
    },
  )
  const answer = await workshopView(request, orderId)
  if (replayed) {
    const status = result.outboundId ? await request.withClient((client) => client.emailOutbound.findUnique({ where: { id: result.outboundId! }, select: { status: true } })) : null
    const delivery: 'SENT' | 'FAILED' | 'QUEUED' | null = status ? (status.status === 'SENT' ? 'SENT' : status.status === 'FAILED' ? 'FAILED' : 'QUEUED') : null
    return { ...answer, url: null, delivery }
  }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { ...answer, url, delivery: null }
  const text = jobMail(locale, { ...mailFacts, expiresAt: new Date(result.expiresAt) }, url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { ...answer, url: null, delivery }
}

// ---- the link's session ---------------------------------------------------------------------------------------------------

/** The request's link, when it is a job's; anything else is the one 404. */
function jobLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'JOB_ACCEPT' || link.record.type !== 'SubcontractOrder') throw linkUnavailable()
  return link
}

/** GET /link/job?language=: the job on one screen, without any price, and what the holder may answer. */
export async function linkJob(request: FastifyRequest, language?: 'it' | 'en') {
  const link = jobLinkOf(request)
  const order = await request.withClient((client) => readJobOrder(client, link.record.id))
  if (!order) throw linkUnavailable()
  const rows = await request.withClient((client) => readJobRows(client, order))
  const system = systemCallerOf(request)(link.tenantId)
  const { context, party, portalOn } = await system.withClient(async (client) => ({
    context: await readJobContext(client, rows, link.partyId),
    party: await client.party.findUnique({ where: { id: order.partyId }, select: { language: true } }),
    portalOn: (await client.portalSettings.findFirst({ where: { partyId: order.partyId }, select: { portalOn: true } }))?.portalOn === true,
  }))
  const locale = language ?? localeOf(party?.language)
  const job = jobView(rows, context, locale)
  const now = officeAuthOf(request.server).clock.now()
  return {
    job: {
      id: job.id,
      number: job.number,
      state: job.state,
      stateWords: job.stateWords,
      from: job.from,
      workOrder: job.workOrder,
      orderDate: job.orderDate,
      expectedBackDate: job.expectedBackDate,
      note: job.note,
      answer: job.answer,
      operations: job.operations.map((operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, pieces: operation.pieces, sizes: operation.sizes.map(({ finished: _finished, ...size }) => size), expectedBackDate: operation.expectedBackDate, note: operation.note })),
      kit: { sentOn: job.kit.sentOn, lines: job.kit.lines.map((line) => ({ seq: line.seq, item: line.item, colour: line.colour, quantity: line.quantity, uom: line.uom, status: line.status, ddt: line.ddt })) },
      acts: { accept: job.acts.accept, decline: job.acts.decline, moveDate: job.acts.accept },
      choices: { declineReasons: job.choices.declineReasons },
      version: job.version,
    },
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses), live: link.expiresAt.getTime() > now.getTime() },
    /** The workshop's portal is on: "Follow it under Jobs." */
    portalOn,
    locale,
  }
}

async function linkAct(request: FastifyRequest, spec: { readonly name: `${string}.${string}`; readonly version: number; readonly input: unknown; readonly action: 'accept' | 'moveDate' | 'decline'; readonly typedName: string | null | undefined }, work: (tools: CommandTools, rows: Awaited<ReturnType<typeof rowsInCommand>>, context: Awaited<ReturnType<typeof readJobContext>>, who: Who) => Promise<unknown>) {
  const link = jobLinkOf(request)
  const order = await request.withClient((client) => readJobOrder(client, link.record.id))
  if (!order) throw linkUnavailable()
  const rows = await request.withClient((client) => readJobRows(client, order))
  const context = await systemCallerOf(request)(link.tenantId).withClient((client) => readJobContext(client, rows, link.partyId))
  await linkCommand(
    request,
    { name: spec.name, idempotencyKey: idempotencyKeyFrom(request), input: spec.input, record: { type: 'SubcontractOrder', id: link.record.id, expectedVersion: spec.version } },
    async (tools) => {
      const current = await rowsInCommand(tools, link.record.id)
      // The link is used and the answer written in this one command: a refused answer rolls both back.
      const use = await useLink(tools, request, { action: spec.action, typedName: spec.typedName })
      return work(tools, current, context, { via: 'LINK', personId: null, name: use.typedName })
    },
  )
  return context
}

export interface LinkAcceptBody {
  readonly version: number
  readonly typedName?: string | null | undefined
}

/** POST /link/job/accept: as asked. */
export async function acceptByLink(request: FastifyRequest, body: LinkAcceptBody, language?: 'it' | 'en') {
  const context = await linkAct(request, { name: 'purchasing.linkJobAccept', version: body.version, input: body, action: 'accept', typedName: body.typedName }, (tools, rows, facts, who) =>
    acceptInCommand(tools, rows, facts, { name: body.typedName }, who),
  )
  const page = await linkJob(request, language)
  const kitDay = context.bundles.length > 0 ? dayOf(context.bundles.at(-1)!.sentAt) : null
  return { ...page, done: acceptedWords({ proposedDate: null, reason: null, name: null }, kitDay, page.locale) }
}

/** POST /link/job/move-date: accept, proposing another due-back day and why. */
export async function moveDateByLink(request: FastifyRequest, body: LinkAcceptBody & { readonly proposedDate: string; readonly reason: string }, language?: 'it' | 'en') {
  await linkAct(request, { name: 'purchasing.linkJobMoveDate', version: body.version, input: body, action: 'moveDate', typedName: body.typedName }, (tools, rows, facts, who) =>
    acceptInCommand(tools, rows, facts, { proposedDate: body.proposedDate, reason: body.reason, name: body.typedName }, who),
  )
  const page = await linkJob(request, language)
  return { ...page, done: acceptedWords({ proposedDate: body.proposedDate, reason: body.reason, name: null }, null, page.locale) }
}

/** POST /link/job/decline: with a reason. */
export async function declineByLink(request: FastifyRequest, body: LinkAcceptBody & { readonly reason: DeclineReason; readonly note?: string | null | undefined }, language?: 'it' | 'en') {
  await linkAct(request, { name: 'purchasing.linkJobDecline', version: body.version, input: body, action: 'decline', typedName: body.typedName }, (tools, rows, facts, who) =>
    declineInCommand(tools, rows, facts, { reason: body.reason, note: body.note, name: body.typedName }, who),
  )
  const page = await linkJob(request, language)
  return { ...page, done: declinedWords(page.locale) }
}
