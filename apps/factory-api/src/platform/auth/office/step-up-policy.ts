import type { FastifyRequest } from 'fastify'
import type { FactoryClient, StepUpResult } from '@nexus/factory-db'
import { isLocked } from '@nexus/factory-domain/auth/lockout/lockout'
import { failuresLeft, STEP_UP_REFUSALS, stepUpLockedUntil, type StepUpLockRules, type StepUpRefusal, type StepUpTry } from '@nexus/factory-domain/auth/sessions/step-up'
import type { SecurityRules } from '@nexus/factory-domain/auth/sessions/lengths'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { requireContext, type OfficeContext } from '../../../core/context'
import { databaseNow } from '../../audit/security-events/record'
import { officeSessionOf, type OfficeSession } from '../sessions/authenticator'
import type { OfficeAuth } from '../sessions/office-auth'
import { securityRulesIn } from '../sessions/rules'
import { STEP_UP_VALID_MS } from '../sessions/session-store'
import { checkSecondFactor, claimOf, markSession, type ProofFailure, type Proof } from './second-factor'
import { STEP_UP_ACTIONS, type StepUpAction } from './step-up-actions'

/**
 * Step-up for risky office actions in depth (B-W2b-404; PLT-063; GDPR art. 32; design admin.security "Actions that ask for
 * a fresh code", shell.profile "Confirm it's you"):
 *
 *   on or off per action   `requireStepUp` (office/account.ts) asks nothing for a request whose route's permission belongs
 *                          to an action the company switched off (SecuritySettings.stepUpOff, read by the authenticator on
 *                          every request: it applies at the next request); a fixed action always asks (step-up-actions.ts)
 *   each code once         every try is a StepUpAttempt in its own command, also a wrong one: the TOTP step is claimed
 *                          (compare-and-set, W0) and a SUCCESS keeps a keyed hash of the code, unique per person (a
 *                          second use is a REUSED_CODE even if the step were not claimed)
 *   the lock               so many wrong or reused codes in a row within the lock time lock step-up (factory-domain
 *                          auth/sessions/step-up; the database keeps the same rule under the same advisory lock): a try
 *                          while locked is recorded as LOCKED and no code is checked; the try that reaches the lock writes
 *                          the security event STEP_UP_LOCKED (its audit row `auth.stepUpFailed` with `stepUpLockedUntil`,
 *                          audit/security-events/ledgers.ts). Wrong step-up codes no longer count towards the account's
 *                          sign-in lockout: the person stays signed in and keeps working; only risky actions wait.
 * Ledger times are the database's own (`databaseNow`): the database refuses a try in the future.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

/** The actions by key (the settings check which may be switched off). */
export const STEP_UP_ACTION_BY_KEY: ReadonlyMap<string, StepUpAction & { readonly canSwitchOff: boolean }> = new Map(
  STEP_UP_ACTIONS.map((entry) => [entry.key, { ...entry, canSwitchOff: entry.fixed === null }]),
)

const ACTION_OF_PERMISSION: ReadonlyMap<Permission, StepUpAction> = new Map(STEP_UP_ACTIONS.flatMap((entry) => entry.permissions.map((permission) => [permission, entry] as const)))

/** The action a request belongs to: its route's manifest permission (null: in no action, or no manifest entry). */
export function stepUpActionOf(request: FastifyRequest): StepUpAction | null {
  const permission = request.routeOptions?.config?.manifest?.permission
  return typeof permission === 'string' ? (ACTION_OF_PERMISSION.get(permission as Permission) ?? null) : null
}

/** The company switched the request's action off: `requireStepUp` asks no fresh code for it. */
export function stepUpSwitchedOff(request: FastifyRequest, session: Pick<OfficeSession, 'security'>): boolean {
  const entry = stepUpActionOf(request)
  return entry !== null && entry.fixed === null && session.security.stepUpOff.includes(entry.key)
}

/** The list Admin › Security shows: every action, the permissions behind it, whether it asks now and may be switched off. */
export function stepUpActionsView(off: readonly string[]) {
  return STEP_UP_ACTIONS.map((entry) => ({
    key: entry.key,
    permissions: [...entry.permissions],
    on: entry.fixed !== null || !off.includes(entry.key),
    canSwitchOff: entry.fixed === null,
    fixed: entry.fixed,
  }))
}

const lockRulesOf = (rules: SecurityRules): StepUpLockRules => ({ maxFailures: rules.stepUpMaxFailures, lockMinutes: rules.stepUpLockMinutes })

/** The person's tries that decide the lock at `at`: the last SUCCESS and the latest failures within the lock time. */
async function triesFor(client: Pick<FactoryClient, 'stepUpAttempt'> | Pick<CommandTx, 'stepUpAttempt'>, userId: string, at: Date, rules: StepUpLockRules): Promise<StepUpTry[]> {
  const attempts = (client as Pick<FactoryClient, 'stepUpAttempt'>).stepUpAttempt
  const [success, failures] = await Promise.all([
    attempts.findFirst({ where: { userId, result: 'SUCCESS', at: { lte: at } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { at: true, result: true } }),
    attempts.findMany({
      where: { userId, result: { in: ['WRONG_CODE', 'REUSED_CODE'] }, at: { lte: at, gt: new Date(at.getTime() - rules.lockMinutes * 60_000) } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: rules.maxFailures,
      select: { at: true, result: true },
    }),
  ])
  return [...(success ? [success] : []), ...failures]
}

/** The person's step-up state now (My profile, the StepUpModal): locked until when, how many wrong codes are left. */
export async function stepUpStateOf(client: FactoryClient, tenantId: string, userId: string): Promise<{ readonly lockedUntil: string | null; readonly failuresLeft: number }> {
  const { rules } = await securityRulesIn(client, tenantId)
  const lock = lockRulesOf(rules)
  const at = await databaseNow(client)
  const tries = await triesFor(client, userId, at, lock)
  const until = stepUpLockedUntil(tries, at, lock)
  return { lockedUntil: until ? toUtcIso(until) : null, failuresLeft: failuresLeft(tries, at, lock) }
}

const refusal = (code: StepUpRefusal, path: 'code' | 'stepUp' = 'code') => [{ path: `${path}/${code}`, message: STEP_UP_REFUSALS[code] }]

type Verdict = { readonly ok: true; readonly proof: Proof; readonly fingerprint: string } | { readonly ok: false; readonly failure: ProofFailure }
/** What a try came to (a command's result: plain JSON). The lock's end is read by GET /auth/office/me. */
type Outcome = { readonly kind: 'ok' } | { readonly kind: 'locked' } | { readonly kind: 'failed'; readonly result: 'WRONG_CODE' | 'REUSED_CODE' }

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** ONE try in ONE command, under the person's step-up lock (the database's advisory lock key). */
async function tryOnce(auth: OfficeAuth, context: OfficeContext, session: OfficeSession, verdict: Verdict): Promise<Outcome> {
  const { result } = await auth.command(context, { name: 'auth.stepUp', input: null }, async ({ tx, now, audit }) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.step-up', ${context.tenantId}::uuid, ${context.actorId}::uuid), 0))`
    const { rules } = await securityRulesIn(tx, context.tenantId)
    const lock = lockRulesOf(rules)
    const at = await databaseNow(tx)
    const tries = await triesFor(tx, context.actorId, at, lock)
    const record = (result: StepUpResult, codeFingerprint: string | null = null) =>
      tx.stepUpAttempt.create({ data: { id: newId(), userId: context.actorId, sessionId: session.id, at, result, action: null, codeFingerprint } })

    const lockedUntil = stepUpLockedUntil(tries, at, lock)
    if (lockedUntil !== null) {
      await record('LOCKED')
      audit({ action: 'auth.stepUpLocked', recordType: 'User', recordId: context.actorId, companyId: null, after: { result: 'LOCKED', lockedUntil: toUtcIso(lockedUntil) } })
      return { kind: 'locked' } as const
    }
    if (verdict.ok) {
      const claim = claimOf(verdict.proof)
      const { count } = await tx.user.updateMany({ where: { id: context.actorId, ...claim.where }, data: claim.data })
      if (count === 1) {
        await record('SUCCESS', verdict.fingerprint)
        await markSession(tx, session.id, { stepUpAt: now })
        audit({ recordType: 'Session', recordId: session.id, companyId: null, after: { stepUpAt: toUtcIso(now) } })
        return { kind: 'ok' } as const
      }
    }
    // A wrong code, or a right one whose time step was already claimed (here or by a request that raced this one).
    const failed: 'WRONG_CODE' | 'REUSED_CODE' = verdict.ok || verdict.failure === 'replayed' ? 'REUSED_CODE' : 'WRONG_CODE'
    await record(failed)
    const after: StepUpTry[] = [...tries, { at, result: failed }]
    const reached = stepUpLockedUntil(after, at, lock)
    audit({
      action: 'auth.stepUpFailed',
      recordType: 'User',
      recordId: context.actorId,
      companyId: null,
      after: { result: failed, failuresLeft: failuresLeft(after, at, lock), ...(reached ? { stepUpLockedUntil: toUtcIso(reached) } : {}) },
    })
    return { kind: 'failed', result: failed } as const
  })
  return result
}

const TOTP_STATE = { totpSecretEnc: true, totpConfirmedAt: true, totpLastStep: true, recoveryCodeHashes: true, lockedUntil: true } as const

/** POST /auth/office/step-up: a fresh code from the authenticator app opens the risky actions for 5 minutes. */
export async function proveStepUp(auth: OfficeAuth, request: FastifyRequest, code: string): Promise<{ stepUpUntil: string }> {
  const context = officeContextOf(request)
  const session = officeSessionOf(request)
  const now = auth.clock.now()
  const user = await request.withClient((client) => client.user.findUniqueOrThrow({ where: { id: context.actorId }, select: TOTP_STATE }))
  if (user.totpConfirmedAt === null) throw new DomainError('invalid_state', STEP_UP_REFUSALS.noTwoFactor, refusal('noTwoFactor', 'stepUp'))
  if (isLocked(user, now)) throw new DomainError('forbidden', STEP_UP_REFUSALS.accountLocked, refusal('accountLocked', 'stepUp'))
  const checked = checkSecondFactor(auth.secrets, user, code, now, { recovery: false })
  // Recovery codes never step up (W0): only a TOTP proof, kept as its keyed fingerprint (never the code).
  const verdict: Verdict =
    checked.ok && checked.proof.kind === 'totp'
      ? { ok: true, proof: checked.proof, fingerprint: auth.secrets.stepUpFingerprint(context.actorId, checked.proof.step, code) }
      : { ok: false, failure: checked.ok ? 'wrong' : checked.failure }
  let outcome: Outcome
  try {
    outcome = await tryOnce(auth, context, session, verdict)
  } catch (error) {
    // The code's fingerprint is taken (the database's unique key): the same code again, recorded as such.
    if (!isUniqueViolation(error)) throw error
    outcome = await tryOnce(auth, context, session, { ok: false, failure: 'replayed' })
  }
  if (outcome.kind === 'locked') throw new DomainError('forbidden', STEP_UP_REFUSALS.locked, refusal('locked', 'stepUp'))
  if (outcome.kind === 'failed') {
    const code = outcome.result === 'REUSED_CODE' ? 'reused' : 'wrong'
    throw new ValidationError(STEP_UP_REFUSALS[code], refusal(code))
  }
  return { stepUpUntil: toUtcIso(new Date(now.getTime() + STEP_UP_VALID_MS)) }
}
