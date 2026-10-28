import type { FastifyRequest } from 'fastify'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { evidenceFor, evidenceNeeds, userAgentOf, type EmailCheck, type EvidenceInput } from '@nexus/factory-domain/links/evidence'
import { answersOf, type LinkAction } from '@nexus/factory-domain/links/purposes'
import { COMMAND_SETTINGS, runCommand, type CommandOutcome, type CommandSpec, type CommandTools } from '../../core/command'
import { ApiError } from '../../core/errors'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { linkSessionOf, linkUnavailable } from './authenticator'

/**
 * One use of a one-off link (plan A1 §3.10 "Links"; features SAL-099 "every open is logged", PLT-073), recorded INSIDE
 * the command of the open or of the answer, so the use, its evidence, its audit row and its event commit with the change
 * or not at all:
 *
 *   1. the purpose must allow the action, and the answer must carry what the purpose asks: a typed name, the address
 *      the link was sent to (factory-domain links/evidence; a refusal rolls everything back and counts nothing);
 *   2. the link is taken in the same transaction: one UPDATE that matches only while it is live (not revoked, not
 *      expired, uses left) moves `lastUsedAt` and, for a counted use, `uses` by one. PostgreSQL re-checks that WHERE on
 *      the newest row when two uses race, so a link with one use left is used once (the other gets the uniform 404);
 *   3. the evidence row (LinkEvidence, append-only): action, use number, typed name, email check, the client address
 *      as an HMAC of its /24 or /64, the user agent, the server time, the request id;
 *   4. an audit row on the link and a `link.used` event (the office screens of the record refresh).
 *
 * The open (`POST /link/open`) calls it; a module's answer route (accepting a quote, confirming a purchase order) calls
 * it in its own command, beside the change of its record:
 *
 *   await linkCommand(request, { name: 'quotes.accept', idempotencyKey, input, record: { type: 'Quote', id, … } }, async (tools) => {
 *     const use = await useLink(tools, request, { action: 'accept', typedName: body.typedName, email: body.email })
 *     …
 *   })
 */

export interface LinkUseInput extends EvidenceInput {
  readonly action: LinkAction
}

export interface LinkUse {
  readonly evidenceId: string
  readonly action: LinkAction
  readonly counted: boolean
  /** The link's counted uses after this one; null when it did not count. */
  readonly useNumber: number | null
  readonly usesLeft: number
  readonly typedName: string | null
  readonly emailCheck: EmailCheck
  readonly at: string
}

/**
 * command() for a link session (or an office write about links) on the sign-in's clock: the same clock the
 * authenticator judged the link's expiry with.
 */
export function linkCommand<Result, State extends string = string, Facts = undefined>(
  request: FastifyRequest,
  spec: CommandSpec<State, Facts>,
  work: (tools: CommandTools) => Promise<Result>,
): Promise<CommandOutcome<Result>> {
  return runCommand(request, spec, work, { ...COMMAND_SETTINGS, clock: officeAuthOf(request.server).clock })
}

/** Records one use of the request's link inside the command's work (see above). */
export async function useLink(tools: CommandTools, request: FastifyRequest, input: LinkUseInput): Promise<LinkUse> {
  const link = linkSessionOf(request)
  const context = tools.context
  if (context.audience !== 'link' || context.linkId !== link.id) {
    throw new ApiError('internal_error', "useLink() runs in a command of the link's own session.")
  }
  const draft = evidenceFor(link.purpose, input.action, { email: link.email }, input)
  const { tx, now } = tools

  const { count } = await tx.oneOffLink.updateMany({
    where: { id: link.id, revokedAt: null, expiresAt: { gt: now }, uses: { lt: link.maxUses } },
    data: draft.counts ? { uses: { increment: 1 }, lastUsedAt: now } : { lastUsedAt: now },
  })
  if (count !== 1) throw linkUnavailable()
  const { uses } = await tx.oneOffLink.findUniqueOrThrow({ where: { id: link.id }, select: { uses: true } })
  const useNumber = draft.counts ? uses : null

  const evidenceId = newId()
  const auth = officeAuthOf(request.server)
  await tx.linkEvidence.createMany({
    data: [
      {
        id: evidenceId,
        partyId: link.partyId,
        linkId: link.id,
        action: draft.action,
        useNumber,
        typedName: draft.typedName,
        emailCheck: draft.emailCheck,
        ipHash: auth.secrets.ipHash(request.ip),
        userAgent: userAgentOf(request.headers['user-agent']),
        at: now,
        requestId: context.requestId,
      },
    ],
  })
  const counted = draft.counts
  tools.audit({
    action: `links.${input.action}`,
    recordType: 'OneOffLink',
    recordId: link.id,
    companyId: link.companyId,
    after: { purpose: link.purpose, action: input.action, counted, useNumber, typedName: draft.typedName, emailCheck: draft.emailCheck, evidenceId },
  })
  tools.emit({
    type: 'link.used',
    subject: link.id,
    companyId: link.companyId,
    payload: { linkId: link.id, purpose: link.purpose, action: input.action, recordType: link.record.type, recordId: link.record.id, counted },
  })
  return {
    evidenceId,
    action: input.action,
    counted,
    useNumber,
    usesLeft: Math.max(0, link.maxUses - uses),
    typedName: draft.typedName,
    emailCheck: draft.emailCheck,
    at: toUtcIso(now),
  }
}

/** What the open answers: what the link is for, until when, and what the page must ask before each answer. */
export function openedView(request: FastifyRequest, use: LinkUse) {
  const link = linkSessionOf(request)
  const answers = answersOf(link.purpose).map((action) => ({ action, ...evidenceNeeds(link.purpose, action, { email: link.email }) }))
  return {
    purpose: link.purpose,
    record: { type: link.record.type, id: link.record.id },
    expiresAt: toUtcIso(link.expiresAt),
    usesLeft: use.usesLeft,
    answers,
  }
}
