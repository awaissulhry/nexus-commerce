import { DomainError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { personDecidesProblems, type PersonDecision } from '@nexus/factory-domain/people/privacy/decisions'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'

/**
 * A person decides (B-W2b-27; MES-281; D.Lgs. 152/1997 art. 1-bis; GDPR art. 22): every decision about a worker names the
 * person who made it. The later People and floor steps call `assertPersonDecides(tools.context, '<DECISION>')` first
 * inside the command that records a skill level, a sign-off, an authorisation, a dispatch assignment, an approved or
 * corrected attendance day, a corrected labour record, a reviewed scan pattern or a locked pay period: the scheduler, a
 * rule, a portal or a link session may suggest, never decide (403 forbidden, `decidedBy/<DECISION>`, in words).
 * Returns the deciding person's id.
 */
export function assertPersonDecides(context: RequestContext | null | undefined, decision: PersonDecision): string {
  if (!context) throw new UnauthenticatedError()
  const actorId = 'actorId' in context ? context.actorId : null
  const problems = personDecidesProblems(decision, { audience: context.audience, actorId, systemActorId: SYSTEM_ACTOR_ID })
  if (problems.length > 0) throw new DomainError('forbidden', problems[0]!.message, problems)
  return actorId as string
}
