import type { FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import type { ReviewBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { SALES_MTM_REVIEW } from '@nexus/factory-domain/sales/mtm/permissions'
import { reviewNoteProblems, reviewRefusal, type ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { command, idempotencyKeyFrom, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { deliverLinkMail } from '../../../platform/links/mail'
import { mailTargetOf } from './profiles'
import { ordersAfterReview } from './orders'
import { assertMayProfile, latestOf, namesOf, officeOf, PROFILE_RECORD, profileNotFound, profileOf, revisionViewOf, type Reader } from './store'

/**
 * The factory review of a rider's measurements (B-W2b-358; SAL-292; design sales.mtm › Measurements › Factory review and the
 * modal mtm.review "Points flagged · Design notes · Decision: Confirm / Ask for more (message to the rider or dealer)"):
 *
 *   POST /sales/mtm/profiles/:profileId/review   sales.mtm.review over the profile's customer: {decision CONFIRM | NEED_MORE,
 *                                                note, notify, language, companyId}
 *
 * ONE update of the revision's review (reviewStatus + reviewedAt + reviewedById + reviewNote) under its row lock, refused in words
 * first (factory-domain sales/mtm reviewRefusal: a CONFIRMED review never changes, only the rider's newest revision, nobody
 * confirms measures they took themselves (Owner answer Q3, also the Owner), never before the rider was measured or the revision
 * sent; NEED_MORE needs its words). The words of NEED_MORE are mailed to the rider or dealer (the rider's contact, else the
 * address the revision's link went to, else the customer's orders contact) from the company named, else the revision's link's,
 * else the company of the newest made-to-measure unit on the rider's garment type: the EmailOutbound row inside the command, the
 * mail composed and sent after the commit (FAKE locally and in tests; a failed one stays FAILED: the office writes again). A
 * CONFIRM lets the orders go on that waited only for it (./orders.ts). Audit, measurement_profile.reviewed.
 */

export const NEED_MORE_TEMPLATE = 'mtm.need_more'

const needMoreMail = (language: 'it' | 'en', input: { readonly riderName: string; readonly garment: string; readonly revision: number; readonly note: string }) =>
  language === 'it'
    ? { subject: `Misure di ${input.riderName}: ci servono altre misure`, body: `Buongiorno,\n\nabbiamo controllato le misure di ${input.riderName} per ${input.garment} (revisione ${input.revision}). Prima di andare avanti ci serve ancora questo:\n\n${input.note}\n\nGrazie.` }
    : { subject: `${input.riderName}'s measurements: we need a little more`, body: `Hello,\n\nwe checked ${input.riderName}'s measurements for ${input.garment} (revision ${input.revision}). Before we go on we still need this:\n\n${input.note}\n\nThank you.` }

/** The company the mail goes from (see the file's head), or null. */
async function senderCompanyOf(db: Reader, profile: { readonly id: string; readonly partyId: string; readonly submittedViaLinkId: string | null; readonly riderName: string; readonly garmentType: string }, asked: string | undefined): Promise<string | null> {
  if (asked) return (await db.company.findUnique({ where: { id: asked }, select: { id: true } }))?.id ?? null
  if (profile.submittedViaLinkId) {
    const link = await db.oneOffLink.findUnique({ where: { id: profile.submittedViaLinkId }, select: { companyId: true } })
    if (link?.companyId) return link.companyId
  }
  const ids = (await db.measurementProfile.findMany({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, select: { id: true } })).map((row) => row.id)
  const order = await db.salesOrderLine.findFirst({ where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { companyId: true } })
  if (order) return order.companyId
  const quote = await db.quoteLine.findFirst({ where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { versionId: true } })
  if (!quote) return null
  const version = await db.quoteVersion.findUnique({ where: { id: quote.versionId }, select: { quote: { select: { companyId: true } } } })
  return version?.quote.companyId ?? null
}

async function queueNeedMore(tools: CommandTools, input: { readonly companyId: string; readonly profileId: string; readonly to: string; readonly language: 'it' | 'en'; readonly subject: string; readonly sender: { readonly id: string; readonly name: string; readonly email: string | null } }): Promise<string> {
  const identity = await sendingIdentity(tools.tx, input.companyId, null, 'CONVERSATION')
  const from = fromLine(identity, { name: input.sender.name, email: input.sender.email })
  const outboundId = newId()
  await tools.tx.emailOutbound.create({
    data: {
      id: outboundId,
      companyId: identity.companyId,
      identityId: identity.id,
      recordType: PROFILE_RECORD,
      recordId: input.profileId,
      templateKey: NEED_MORE_TEMPLATE,
      locale: input.language,
      fromAddress: from.address,
      fromName: from.name,
      to: [input.to],
      subject: input.subject,
      emailMessageId: messageIdFor(outboundId, identity.domain),
      status: 'QUEUED',
      queuedAt: tools.now,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: input.sender.id,
    },
    select: { id: true },
  })
  tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: NEED_MORE_TEMPLATE, profileId: input.profileId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
  return outboundId
}

/** POST /sales/mtm/profiles/:profileId/review */
export async function reviewProfile(request: FastifyRequest, profileId: string, body: ReviewBody & { readonly companyId?: string | undefined }) {
  const context = officeOf(request)
  const row = await request.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId, SALES_MTM_REVIEW)
  const problems = reviewNoteProblems(body.decision, body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const note = body.note?.trim() || null
  const facts = await request.withClient(async (db) => {
    const target = body.decision === 'NEED_MORE' && body.notify ? await mailTargetOf(db, row) : null
    const companyId = target ? await senderCompanyOf(db, row, body.companyId) : null
    const template = await db.measurementTemplate.findFirst({ where: { code: row.garmentType }, select: { name: true, nameI18n: true } })
    const user = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    const suppressed = target ? (await suppressedAmong(db, [target.email])).size > 0 : false
    return { target, companyId, template, user, suppressed }
  })
  if (body.companyId && !facts.companyId && body.decision === 'NEED_MORE' && body.notify) throw new ValidationError('Not a company of yours.', [{ path: 'body/companyId', message: 'Not a company of yours.' }])
  if (facts.companyId && !can(actorOf(context), SALES_MTM_REVIEW, { partyId: row.partyId, companyId: facts.companyId })) throw new ValidationError('Your roles do not write for this company.', [{ path: 'body/companyId', message: 'Your roles do not write for this company.' }])
  const language: 'it' | 'en' = body.language ?? (facts.target?.language === 'en' ? 'en' : 'it')
  const garment = facts.template ? (((facts.template.nameI18n ?? {}) as Record<string, unknown>)[language] as string | undefined) ?? facts.template.name : row.garmentType
  const mail = note ? needMoreMail(language, { riderName: row.riderName, garment, revision: row.revision, note }) : null
  const mailable = body.decision === 'NEED_MORE' && body.notify && facts.target !== null && facts.companyId !== null && !facts.suppressed && facts.user !== null

  const { result, replayed } = await command(request, { name: 'mtm.review', idempotencyKey: idempotencyKeyFrom(request), input: { profileId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT 1 FROM "MeasurementProfile" WHERE id = ${row.id}::uuid FOR UPDATE`
    const current = (await profileOf(tools.tx, row.id))!
    const latest = (await latestOf(tools.tx, current))!
    const refusal = reviewRefusal(
      { status: current.reviewStatus as ReviewStatus, revision: current.revision, latestRevision: latest.revision, measuredByUserId: current.measuredByUserId, takenAt: current.takenAt, submittedAt: current.submittedAt, reviewedAt: current.reviewedAt },
      body.decision,
      context.actorId,
      tools.now,
    )
    if (refusal) throw new ConflictError(refusal)
    const status = body.decision === 'CONFIRM' ? 'CONFIRMED' : 'NEED_MORE'
    await tools.tx.measurementProfile.update({ where: { id: current.id }, data: { reviewStatus: status, reviewedAt: tools.now, reviewedById: context.actorId, reviewNote: note }, select: { id: true } })
    let outboundId: string | null = null
    if (mailable && mail) {
      try {
        outboundId = await queueNeedMore(tools, { companyId: facts.companyId!, profileId: current.id, to: facts.target!.email, language, subject: mail.subject, sender: { id: context.actorId, name: facts.user!.displayName, email: facts.user!.email } })
      } catch (error) {
        // No sending identity for the company: the review stands, the mail is not queued (the answer says it).
        if (!(error instanceof DomainError)) throw error
      }
    }
    const gone = status === 'CONFIRMED' ? await ordersAfterReview(tools, current.id) : []
    tools.audit({
      recordType: PROFILE_RECORD,
      recordId: current.id,
      before: { reviewStatus: current.reviewStatus, reviewedAt: current.reviewedAt?.toISOString() ?? null, reviewNote: current.reviewNote },
      after: { reviewStatus: status, reviewNote: note, revision: current.revision, mailed: outboundId !== null, ordersGoneOn: gone.map((order) => order.id) },
    })
    tools.emit({ type: 'measurement_profile.reviewed', subject: current.id, payload: { profileId: current.id, partyId: current.partyId, revision: current.revision, status, mailed: outboundId !== null, ordersGoneOn: gone.length } })
    return { outboundId, gone }
  })
  let delivery: string | null = result.outboundId ? 'QUEUED' : null
  if (!replayed && result.outboundId && mail) delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, mail.body, facts.user?.displayName ?? null, serverClock)
  return request.withClient(async (db) => {
    const fresh = (await profileOf(db, row.id))!
    const names = await namesOf(db, [fresh.measuredByUserId, fresh.reviewedById])
    return { profile: revisionViewOf(fresh, names, serverClock.now()), mailed: result.outboundId !== null, delivery, ordersGoneOn: result.gone }
  })
}
