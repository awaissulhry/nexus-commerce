import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  matchesPortalCode,
  newPortalCode,
  normalizePortalCode,
  PORTAL_CODE,
  PORTAL_CODE_WORDS,
  portalCodeHash,
  portalCodeState,
  portalTriesLeft,
  type PortalCodeState,
} from '@nexus/factory-domain/auth/portal/codes'
import { portalStepUpUntil } from '@nexus/factory-domain/auth/portal/session'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalSessionOf, type PortalSession } from './authenticator'
import { answerFloor, portalOf } from './service'
import { issueCode, lockedCode, newestCode } from './store'

/**
 * Step-up by an e-mail code (B-W2b-159; PLT-050; design portal.supplier.profile step-up "Confirm it's you — We sent a
 * 6-digit code to …"): before a sensitive partner act (people, roles, security, bank details: B-W2b-162, B-W2b-193 and
 * later) a route calls `requirePortalStepUp`, which asks for a fresh code proved on THIS session in the last 5 minutes.
 *
 *   POST /portal/step-up/start   a STEP_UP code to the signed-in person's address (at most one new code a minute;
 *                                3 per 10 minutes; the guard);
 *   POST /portal/step-up         the code, checked under its row lock; bound to the session that asked (the binding is
 *                                inside its hash: a code asked in another session matches nothing); right → the session's
 *                                stepUpAt, answered as `stepUpUntil`.
 * An office preview of a portal never steps up (the authenticator refuses its writes).
 */

/** The step-up a sensitive partner route needs: a 403 that names `stepUp` when there is none this recent. */
export class PortalStepUpRequiredError extends DomainError {
  override name = 'PortalStepUpRequiredError'
  constructor() {
    super('forbidden', "Confirm it's you first: we e-mail you a 6-digit code (step-up).", [{ path: 'stepUp', message: 'Required.' }])
  }
}

/** For B-W2b-162 and later: refuses a sensitive partner act without a step-up on this session in the last 5 minutes. */
export function requirePortalStepUp(app: FastifyInstance, request: FastifyRequest): void {
  const session = portalSessionOf(request)
  if (session.preview || portalStepUpUntil(session.stepUpAt, portalOf(app).auth.clock.now()) === null) throw new PortalStepUpRequiredError()
}

const codeError = (path: string, message: string) => new DomainError('unauthenticated', message, [{ path, message }])

const contextOf = (app: FastifyInstance, request: FastifyRequest, session: PortalSession) => portalOf(app).auth.contextFor(request, session.tenantId, session.userId)

export async function startStepUp(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  const p = portalOf(app)
  const session = portalSessionOf(request)
  await p.guard.check(request, reply, 'portal.stepup.start', { subject: session.userId })
  const answer = { status: 'sent' as const, to: session.person.email, expiresInSeconds: PORTAL_CODE.ttlMs / 1000, resendAfterSeconds: PORTAL_CODE.resendAfterMs / 1000 }
  // One new code a minute per person: a second press within it keeps the code already sent.
  if (!(await p.guard.claim('portal.stepup.code', 'gap', session.userId, PORTAL_CODE.resendAfterMs))) return answer
  const code = newPortalCode()
  const codeHash = portalCodeHash(p.codeKey, { purpose: 'STEP_UP', tenantId: session.tenantId, userId: session.userId, boundTo: session.id }, code)
  const { result } = await p.auth.command(contextOf(app, request, session), { name: 'portal.stepUpCodeSent', input: { sessionId: session.id } }, async ({ tx, now, audit }) => {
    const issued = await issueCode(tx, { userId: session.userId, purpose: 'STEP_UP', codeHash, linkTokenHash: null, now, ipHash: p.auth.secrets.ipHash(request.ip) })
    audit({ recordType: 'PortalSignInCode', recordId: issued.id, companyId: session.company.id, after: { purpose: 'STEP_UP', sessionId: session.id, expiresAt: issued.expiresAt, replaced: issued.replaced } })
    return issued
  })
  await p.mailer.deliver({ kind: 'step_up', tenantId: session.tenantId, companyId: session.company.id, userId: session.userId, to: session.person.email, code, expiresAt: new Date(result.expiresAt) })
  return answer
}

class DeadCode extends Error {
  constructor(readonly state: PortalCodeState) {
    super(`The code is ${state}.`)
  }
}

export async function stepUp(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: { readonly code: string }) {
  const startedAt = Date.now()
  const p = portalOf(app)
  const session = portalSessionOf(request)
  await p.guard.check(request, reply, 'portal.stepup.code', { subject: session.userId })
  const code = normalizePortalCode(body.code)
  if (code === null) throw new ValidationError('Type the 6 digits of the code from the e-mail.', [{ path: 'body/code', message: 'Type the 6 digits of the code from the e-mail.' }])
  const binding = { purpose: 'STEP_UP' as const, tenantId: session.tenantId, userId: session.userId, boundTo: session.id }
  const row = await p.auth.inTenant(session.tenantId, session.userId, (client) => newestCode(client, session.userId, 'STEP_UP'))

  const failed = async (path: string, message: string): Promise<never> => {
    await p.guard.failed(request, 'portal.stepup.code')
    await answerFloor(startedAt, p.answerFloorMs)
    throw codeError(path, message)
  }
  const deadWords = (state: PortalCodeState): [string, string] =>
    state === 'tried_out' ? ['code/TRIED_OUT', PORTAL_CODE_WORDS.triedOut] : state === 'expired' ? ['code/EXPIRED', PORTAL_CODE_WORDS.expired] : ['code/USED', 'This code was already used. Ask for a new one.']
  if (!row) return failed('code/NONE', 'Ask for a code first: we e-mail it to you.')
  const now = p.auth.clock.now()
  const state = portalCodeState(row, now)
  if (state !== 'live') return failed(...deadWords(state))

  let outcome: { readonly kind: 'wrong'; readonly tries: number } | { readonly kind: 'proved'; readonly at: string }
  try {
    ;({ result: outcome } = await p.auth.command(contextOf(app, request, session), { name: 'portal.stepUp', input: { sessionId: session.id } }, async ({ tx, now: at, audit }) => {
      const locked = await lockedCode(tx, row.id)
      if (!locked || locked.userId !== session.userId || locked.purpose !== 'STEP_UP') throw new DeadCode('revoked')
      const current = portalCodeState(locked, at)
      if (current !== 'live') throw new DeadCode(current)
      if (!matchesPortalCode(p.codeKey, binding, code, locked.codeHash)) {
        const tries = locked.tries + 1
        await tx.portalSignInCode.update({ where: { id: locked.id }, data: { tries }, select: { id: true } })
        audit({ action: 'portal.stepUpFailed', recordType: 'PortalSignInCode', recordId: locked.id, companyId: session.company.id, after: { tries } })
        return { kind: 'wrong' as const, tries }
      }
      await tx.portalSignInCode.update({ where: { id: locked.id }, data: { usedAt: at }, select: { id: true } })
      const { count } = await tx.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { stepUpAt: at } })
      if (count !== 1) throw new DeadCode('revoked')
      audit({ recordType: 'Session', recordId: session.id, companyId: session.company.id, after: { stepUpAt: toUtcIso(at) } })
      audit({ recordType: 'PortalSignInCode', recordId: locked.id, companyId: session.company.id, after: { usedAt: toUtcIso(at) } })
      return { kind: 'proved' as const, at: toUtcIso(at) }
    }))
  } catch (error) {
    if (error instanceof DeadCode) return failed(...deadWords(error.state))
    throw error
  }
  if (outcome.kind === 'wrong') {
    const left = portalTriesLeft(outcome.tries)
    return left === 0 ? failed('code/TRIED_OUT', PORTAL_CODE_WORDS.triedOut) : failed('code', PORTAL_CODE_WORDS.wrong(left))
  }
  const at = new Date(outcome.at)
  return { stepUpUntil: toUtcIso(portalStepUpUntil(at, at)!) }
}
