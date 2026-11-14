import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { portalAccessProblem, portalAccessWords, type PortalAccessProblem } from '@nexus/factory-domain/auth/portal/access'
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
import { PORTAL_SESSION } from '@nexus/factory-domain/auth/portal/session'
import { matchesPortalToken, mintPortalToken, parsePortalToken, portalTokenHash, type PortalToken } from '@nexus/factory-domain/auth/portal/token'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { isAddress } from '@nexus/factory-domain/email/rules'
import { assertCsrf, csrfCookieOf, newCsrfToken } from '../sessions/cookies'
import { PRE_SESSION_ACTOR_ID } from '../sessions/office-auth'
import { normalizeEmail } from '../users/email'
import { userStatus } from '../users/status'
import type { ProofInput } from '../../abuse/guard'
import { clearPortalCookie, portalCookieOf, setPortalCookies } from './cookies'
import { answerFloor, portalOf, type PortalServices } from './service'
import { portalTermsInForce } from './terms'
import { portalSignInRefused } from '../../audit/security-events/sign-in'
import {
  CODE_SELECT,
  companyById,
  contactOf,
  createPortalSession,
  issueCode,
  lockedCode,
  newestCode,
  openInvitation,
  partnerByEmail,
  partnerById,
  partyOf,
  partyOfCompany,
  portalCompany,
  portalOn,
  termsState,
  type PartnerParty,
  type PartnerPerson,
  type PortalCompany,
} from './store'

/**
 * Portal sign-in (B-W2b-159; PLT-050, PLT-066; Owner answer C3: e-mail codes only, no password, no SMS; A1 §3.10: invite
 * only, a 6-digit code, 12 h sessions; design portal.signin):
 *
 *   start      POST /portal/signin/start {tenant, company?, email}: ALWAYS the same answer, at once ("If … is invited, we
 *              sent a link and a code. They work for 15 minutes."); the work runs after the answer, so neither its
 *              content nor its time tells whether the address has a partner account. A partner person of the tenant
 *              (active, invited with an open invitation, or paused: what is wrong is said only after the code) whose
 *              organisation works with that company gets ONE e-mail with a 6-digit code AND a link (auth/portal/mail.ts);
 *              at most one new code a minute per address, and 3 requests per address in 10 minutes (the abuse guard);
 *   code       POST /portal/signin/code {tenant, company?, email, code}: the code, checked under a row lock (parallel
 *              guesses queue and see each other's tries); wrong → "That code does not match. N tries left." (5 tries),
 *              tried out, expired; an address without an account or a code answers the same words from the guard's own
 *              count, after the same answer floor;
 *   link       POST /portal/signin/link/preview {token}: what the landing page shows ("Continue to the <Company> portal
 *              as anna@…"), WITHOUT using the link — so a mail scanner that opens the link (Outlook Safe Links …) never
 *              burns it; POST /portal/signin/link {token}: Continue, the one press that uses it;
 *   then       the code is used (once); refused in words only now, after the address was proved (auth/portal/access.ts:
 *              paused, ended, invitation no longer valid, portal not switched on, portal terms not published — GATE-PRIVACY);
 *              else ONE command opens the PARTNER session (30 minutes idle, 12 hours; bound to the person's party and the
 *              company) — and, for an invited person, accepts the invitation (ACTIVE, its end of access, the partner roles
 *              it names that exist and the person does not hold yet);
 *   sign-out   POST /portal/sign-out: ends the cookie's session, clears the portal cookie.
 * Every unsafe call passes the CSRF double submit (a login CSRF would sign a victim into someone else's portal). The
 * session token is minted before its command and only its hash goes in; codes and links never leave the API but in the
 * mail (no answer, row, audit entry, event, receipt or log holds them).
 */

export interface StartBody {
  readonly tenant: string
  readonly company?: string | undefined
  readonly email: string
  readonly proof?: ProofInput | undefined
}

export interface CodeBody extends StartBody {
  readonly code: string
}

export interface LinkBody {
  readonly token: string
  readonly proof?: ProofInput | undefined
}

export const START_ANSWER = { status: 'sent' as const, expiresInSeconds: PORTAL_CODE.ttlMs / 1000, resendAfterSeconds: PORTAL_CODE.resendAfterMs / 1000 }

/** One subject per typed address and tenant: the abuse guard's limits count it the same, known or not. */
const subjectOf = (tenant: string, email: string): string => `${tenant.trim().toLowerCase()}|${email}`

function emailOf(value: string): string {
  const email = normalizeEmail(value)
  if (!isAddress(email)) throw new ValidationError('Type an e-mail like name@company.com.', [{ path: 'body/email', message: 'Type an e-mail like name@company.com.' }])
  return email
}

interface Target {
  readonly tenantId: string
  readonly company: PortalCompany
  readonly person: PartnerPerson
  readonly party: PartnerParty
}

/** The partner person an address names in a tenant's portal, or null (read in the tenant's office scope, no session). */
async function targetOf(p: PortalServices, slug: string, companyCode: string | undefined, email: string, now: Date): Promise<Target | null> {
  const tenant = await p.auth.inPlatform((client) => client.tenant.findUnique({ where: { slug: slug.toLowerCase() }, select: { id: true, status: true } }))
  if (tenant?.status !== 'ACTIVE') return null
  return p.auth.inTenant(tenant.id, PRE_SESSION_ACTOR_ID, async (client) => {
    const company = await portalCompany(client, companyCode)
    const person = company ? await partnerByEmail(client, tenant.id, email) : null
    if (!company || !person || person.status === 'DEACTIVATED') return null
    const party = await partyOf(client, person.partyId)
    if (!party || !partyOfCompany(party, company.id)) return null
    if (person.status === 'INVITED' && !(await openInvitation(client, person.id, now))) return null
    return { tenantId: tenant.id, company, person, party }
  })
}

// --- start ------------------------------------------------------------------------------------------------------------------

export async function startSignIn(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: StartBody): Promise<typeof START_ANSWER> {
  const p = portalOf(app)
  assertCsrf(request)
  const email = emailOf(body.email)
  const subject = subjectOf(body.tenant, email)
  await p.guard.check(request, reply, 'portal.signin.start', { subject, proof: body.proof })
  p.auth.afterAnswer(async () => {
    // At most one new code a minute per address — the same rule for an address without an account, whose counted tries
    // start again with it, so "4 tries left" after a new code tells nothing either.
    if (!(await p.guard.claim('portal.signin.code', 'gap', subject, PORTAL_CODE.resendAfterMs))) return
    await p.guard.forget('portal.signin.code', 'tries', subject)
    const target = await targetOf(p, body.tenant, body.company, email, p.auth.clock.now())
    if (!target) return
    const { tenantId, company, person } = target
    // Minted outside the command: only the hashes go in; the code and the link reach the mail and nothing else.
    const code = newPortalCode()
    const link = mintPortalToken('link', { tenantId, scopeId: company.id, userId: person.id })
    const codeHash = portalCodeHash(p.codeKey, { purpose: 'SIGN_IN', tenantId, userId: person.id, boundTo: company.id }, code)
    const { result } = await p.auth.command(p.auth.contextFor(request, tenantId, person.id), { name: 'portal.signInCodeSent', input: { email, companyId: company.id } }, async ({ tx, now, audit }) => {
      const issued = await issueCode(tx, { userId: person.id, purpose: 'SIGN_IN', codeHash, linkTokenHash: portalTokenHash(link.value), now, ipHash: p.auth.secrets.ipHash(request.ip) })
      audit({ recordType: 'PortalSignInCode', recordId: issued.id, companyId: company.id, after: { purpose: 'SIGN_IN', expiresAt: issued.expiresAt, replaced: issued.replaced } })
      return issued
    })
    try {
      await p.mailer.deliver({ kind: 'sign_in', tenantId, companyId: company.id, userId: person.id, to: person.email, code, link: p.auth.link('/p/signin/continue', link.value), expiresAt: new Date(result.expiresAt) })
    } catch (error) {
      request.log.error({ err: error }, 'a portal sign-in code could not be handed to the mailer')
    }
  }, request.log)
  return START_ANSWER
}

// --- proving a code or a link -------------------------------------------------------------------------------------------------

class DeadCode extends Error {
  constructor(readonly state: PortalCodeState) {
    super(`The code is ${state}.`)
  }
}

type Proved =
  | { readonly kind: 'dead'; readonly state: PortalCodeState }
  | { readonly kind: 'wrong'; readonly tries: number }
  | { readonly kind: 'refused'; readonly problem: PortalAccessProblem }
  | { readonly kind: 'proved'; readonly invited: boolean }

/**
 * Checks a live SIGN_IN code under its row lock and, when it is right, uses it and reads (in the same transaction) whether
 * the person may open a session: ONE command, `portal.signInCodeChecked`. A wrong code counts a try (the fifth kills it).
 */
type CodeRow = NonNullable<Awaited<ReturnType<typeof lockedCode>>>

async function proveCode(p: PortalServices, request: FastifyRequest, target: Target, codeId: string, right: (row: CodeRow) => boolean, method: 'CODE' | 'LINK'): Promise<Proved> {
  const companyId = target.company.id
  try {
    const { result } = await p.auth.command(
      p.auth.contextFor(request, target.tenantId, target.person.id),
      { name: 'portal.signInCodeChecked', input: { companyId, method } },
      async ({ tx, now, audit }): Promise<Proved> => {
        const row = await lockedCode(tx, codeId)
        if (!row || row.userId !== target.person.id || row.purpose !== 'SIGN_IN') throw new DeadCode('revoked')
        const state = portalCodeState(row, now)
        if (state !== 'live') throw new DeadCode(state)
        if (!right(row)) {
          const tries = row.tries + 1
          await tx.portalSignInCode.update({ where: { id: row.id }, data: { tries }, select: { id: true } })
          audit({ action: 'portal.signInFailed', recordType: 'PortalSignInCode', recordId: row.id, companyId, after: { tries, method } })
          return { kind: 'wrong', tries }
        }
        await tx.portalSignInCode.update({ where: { id: row.id }, data: { usedAt: now }, select: { id: true } })
        const person = await partnerById(tx, target.person.id)
        const party = person ? await partyOf(tx, person.partyId) : null
        const invitation = person?.status === 'INVITED' ? await openInvitation(tx, person.id, now) : null
        const problem: PortalAccessProblem | null =
          !person || !party || person.partyId !== target.person.partyId
            ? 'PAUSED'
            : portalAccessProblem(
                { user: person, party, portalOn: await portalOn(tx, party.id), termsInForce: (await portalTermsInForce(tx, companyId)) !== null, invitationOpen: invitation !== null },
                now,
              )
        audit({ recordType: 'PortalSignInCode', recordId: row.id, companyId, after: { usedAt: toUtcIso(now), method, refused: problem } })
        return problem ? { kind: 'refused', problem } : { kind: 'proved', invited: person!.status === 'INVITED' }
      },
    )
    return result
  } catch (error) {
    if (error instanceof DeadCode) return { kind: 'dead', state: error.state }
    throw error
  }
}

const codeError = (path: string, message: string) => new DomainError('unauthenticated', message, [{ path, message }])

/** The words of a refused sign-in, with whom to contact (read in the tenant's office scope). */
async function refusal(p: PortalServices, target: Target, problem: PortalAccessProblem): Promise<DomainError> {
  const words = await p.auth.inTenant(target.tenantId, target.person.id, async (client) => {
    const person = await partnerById(client, target.person.id)
    return portalAccessWords(problem, {
      company: target.company.name,
      contact: await contactOf(client, target.company),
      accessUntil: person?.accessUntil ? businessDate(person.accessUntil).split('-').reverse().join('/') : null,
    })
  })
  return new DomainError('forbidden', words, [{ path: `access/${problem}`, message: words }])
}

export interface SignedInAnswer {
  readonly status: 'signed_in'
  readonly csrfToken: string
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string; readonly locale: string }
  readonly party: { readonly id: string; readonly name: string }
  readonly company: { readonly id: string; readonly code: string; readonly name: string }
  readonly session: { readonly idleExpiresAt: string; readonly absoluteExpiresAt: string }
  /** The first visit asks for the portal terms in force (once per version): until then the session holds no permission. */
  readonly termsDue: boolean
}

/**
 * Opens the PARTNER session of a proved code (a second command, `portal.signIn`): for an invited person it first accepts
 * the invitation (status machine INVITED → ACTIVE; the invitation's end of access; the partner roles it names that exist
 * and the person does not hold yet). The session token is minted before the command; only its hash goes in.
 */
async function openSession(p: PortalServices, request: FastifyRequest, reply: FastifyReply, target: Target, invited: boolean, method: 'CODE' | 'LINK'): Promise<SignedInAnswer> {
  const { tenantId, company, person } = target
  const token = mintPortalToken('session', { tenantId, scopeId: person.partyId, userId: person.id })
  const csrfToken = csrfCookieOf(request) ?? newCsrfToken()
  const tokenHash = portalTokenHash(token.value)
  const { result } = await p.auth.command(
    p.auth.contextFor(request, tenantId, person.id),
    {
      name: 'portal.signIn',
      input: { companyId: company.id, method },
      ...(invited ? { record: { type: 'User' as const, id: person.id, transition: { machine: userStatus, to: 'ACTIVE' as const } } } : {}),
    },
    async ({ tx, now, audit, emit }) => {
      let accepted: { readonly invitationId: string; readonly roleKeysGiven: string[]; readonly roleKeysMissing: string[] } | null = null
      if (invited) {
        const invitation = await openInvitation(tx, person.id, now)
        if (!invitation) throw new ForbiddenError('Your invitation is no longer valid. Ask for a new one.')
        const { count } = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } })
        if (count !== 1) throw new ForbiddenError('Your invitation is no longer valid. Ask for a new one.')
        if (invitation.accessUntil) await tx.user.update({ where: { id: person.id }, data: { accessUntil: invitation.accessUntil }, select: { id: true } })
        const roles = await tx.role.findMany({ where: { key: { in: invitation.partnerRoleKeys }, audience: 'PARTNER' }, select: { id: true, key: true } })
        const held = await tx.roleAssignment.findMany({ where: { userId: person.id, endedAt: null, roleId: { in: roles.map((role) => role.id) } }, select: { roleId: true } })
        const given: string[] = []
        for (const role of roles) {
          if (held.some((entry) => entry.roleId === role.id)) continue
          await tx.roleAssignment.create({
            data: { id: newId(), userId: person.id, roleId: role.id, allCompanies: true, companyIds: [], siteIds: [], partyIds: [person.partyId], validFrom: now, grantedById: null, createdAt: now, updatedAt: now },
            select: { id: true },
          })
          given.push(role.key)
        }
        accepted = { invitationId: invitation.id, roleKeysGiven: given, roleKeysMissing: invitation.partnerRoleKeys.filter((key) => !roles.some((role) => role.key === key)) }
        audit({ recordType: 'Invitation', recordId: invitation.id, companyId: company.id, after: { acceptedAt: toUtcIso(now), ...accepted } })
        audit({ recordType: 'User', recordId: person.id, companyId: company.id, before: { status: 'INVITED' }, after: { status: 'ACTIVE', accessUntil: invitation.accessUntil ? toUtcIso(invitation.accessUntil) : null } })
      }
      await tx.user.update({ where: { id: person.id }, data: { lastSignInAt: now }, select: { id: true } })
      const session = await createPortalSession(tx, { userId: person.id, partyId: person.partyId, companyId: company.id, tokenHash, now, ipHash: p.auth.secrets.ipHash(request.ip), userAgent: request.headers['user-agent'] })
      audit({ action: 'portal.signIn', recordType: 'Session', recordId: session.id, companyId: company.id, after: { userId: person.id, partyId: person.partyId, method, invitationAccepted: accepted !== null } })
      // B-W2b-180: the office's Portal access tab says "… signed in" live (and the person turns Active there).
      emit({ type: 'partner_user.signed_in', subject: person.id, companyId: company.id, payload: { userId: person.id, partyId: person.partyId, firstSignIn: accepted !== null } })
      return session
    },
  )
  setPortalCookies(reply, token.value, csrfToken, PORTAL_SESSION.absoluteMs)
  const facts = await p.auth.inTenant(tenantId, person.id, async (client) => ({ person: await partnerById(client, person.id), terms: await termsState(client, company.id, person.id) }))
  return {
    status: 'signed_in',
    csrfToken,
    user: { id: person.id, email: person.email, displayName: facts.person?.displayName ?? person.displayName, locale: facts.person?.locale ?? person.locale },
    party: { id: target.party.id, name: target.party.name },
    company: { id: company.id, code: company.code, name: company.name },
    session: { idleExpiresAt: result.idleExpiresAt, absoluteExpiresAt: result.absoluteExpiresAt },
    termsDue: facts.terms !== null && !facts.terms.acknowledged,
  }
}

// --- the code -----------------------------------------------------------------------------------------------------------------

export async function signInWithCode(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: CodeBody): Promise<SignedInAnswer> {
  const startedAt = Date.now()
  const p = portalOf(app)
  assertCsrf(request)
  const email = emailOf(body.email)
  const subject = subjectOf(body.tenant, email)
  await p.guard.check(request, reply, 'portal.signin.code', { subject, proof: body.proof })
  const code = normalizePortalCode(body.code)
  if (code === null) throw new ValidationError('Type the 6 digits of the code from the e-mail.', [{ path: 'body/code', message: 'Type the 6 digits of the code from the e-mail.' }])
  const now = p.auth.clock.now()

  const target = await targetOf(p, body.tenant, body.company, email, now)
  const row = target ? await p.auth.inTenant(target.tenantId, target.person.id, (client) => newestCode(client, target.person.id, 'SIGN_IN')) : null

  /** No account, no code, or a used or replaced one: the guard's own count of tries for the address, the same words. */
  const unknown = async (): Promise<never> => {
    // B-W2b-399 (PLT-075): unknown attempts too, after the answer; never the address typed.
    portalSignInRefused(p.auth, request, body.tenant, target ? { id: target.person.id, partyId: target.person.partyId } : null)
    const { count } = await p.guard.hit('portal.signin.code', 'tries', subject, PORTAL_CODE.ttlMs)
    await p.guard.failed(request, 'portal.signin.code')
    await answerFloor(startedAt, p.answerFloorMs)
    const left = portalTriesLeft(count)
    throw left === 0 ? codeError('code/TRIED_OUT', PORTAL_CODE_WORDS.triedOut) : codeError('code', PORTAL_CODE_WORDS.wrong(left))
  }
  if (!target || !row) return unknown()
  const binding = { purpose: 'SIGN_IN' as const, tenantId: target.tenantId, userId: target.person.id, boundTo: target.company.id }
  const right = (stored: Pick<CodeRow, 'codeHash'>) => matchesPortalCode(p.codeKey, binding, code, stored.codeHash)

  const dead = async (state: PortalCodeState, matched: boolean): Promise<never> => {
    if (state === 'tried_out') {
      await p.guard.failed(request, 'portal.signin.code')
      await answerFloor(startedAt, p.answerFloorMs)
      throw codeError('code/TRIED_OUT', PORTAL_CODE_WORDS.triedOut)
    }
    if (state === 'expired' && matched) {
      await answerFloor(startedAt, p.answerFloorMs)
      throw codeError('code/EXPIRED', PORTAL_CODE_WORDS.expired)
    }
    return unknown()
  }
  const state = portalCodeState(row, now)
  if (state !== 'live') return dead(state, right(row))

  const proved = await proveCode(p, request, target, row.id, right, 'CODE')
  if (proved.kind === 'dead') return dead(proved.state, right(row))
  if (proved.kind === 'wrong') {
    await p.guard.failed(request, 'portal.signin.code')
    await answerFloor(startedAt, p.answerFloorMs)
    const left = portalTriesLeft(proved.tries)
    throw left === 0 ? codeError('code/TRIED_OUT', PORTAL_CODE_WORDS.triedOut) : codeError('code', PORTAL_CODE_WORDS.wrong(left))
  }
  if (proved.kind === 'refused') throw await refusal(p, target, proved.problem)
  return openSession(p, request, reply, target, proved.invited, 'CODE')
}

// --- the link -----------------------------------------------------------------------------------------------------------------

const linkDead = () => new NotFoundError(PORTAL_CODE_WORDS.linkDead)

/** The live SIGN_IN code a link names, with its person, party and company; else null (one answer for every dead link). */
async function linkTarget(p: PortalServices, token: PortalToken, now: Date): Promise<{ target: Target; codeId: string } | null> {
  const tenant = await p.auth.inPlatform((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return null
  return p.auth.inTenant(token.tenantId, token.userId, async (client) => {
    const row = await client.portalSignInCode.findUnique({ where: { linkTokenHash: portalTokenHash(token.value) }, select: CODE_SELECT })
    if (!row || row.purpose !== 'SIGN_IN' || row.userId !== token.userId || !matchesPortalToken(token, row.linkTokenHash) || portalCodeState(row, now) !== 'live') return null
    const person = await partnerById(client, token.userId)
    const company = await companyById(client, token.scopeId)
    const party = person ? await partyOf(client, person.partyId) : null
    if (!person || !company || !party || person.status === 'DEACTIVATED' || !partyOfCompany(party, company.id)) return null
    return { target: { tenantId: token.tenantId, company, person, party }, codeId: row.id }
  })
}

export async function previewLink(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: LinkBody) {
  const p = portalOf(app)
  const token = parsePortalToken('link', body.token)
  await p.guard.check(request, reply, 'portal.signin.link', { subject: token ? portalTokenHash(token.value) : 'malformed', proof: body.proof })
  const found = token ? await linkTarget(p, token, p.auth.clock.now()) : null
  if (!found) {
    await p.guard.failed(request, 'portal.signin.link')
    throw linkDead()
  }
  const { target } = found
  return { company: { code: target.company.code, name: target.company.name }, email: target.person.email }
}

export async function continueLink(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: LinkBody): Promise<SignedInAnswer> {
  const p = portalOf(app)
  assertCsrf(request)
  const token = parsePortalToken('link', body.token)
  await p.guard.check(request, reply, 'portal.signin.link', { subject: token ? portalTokenHash(token.value) : 'malformed', proof: body.proof })
  const found = token ? await linkTarget(p, token, p.auth.clock.now()) : null
  if (!found || !token) {
    await p.guard.failed(request, 'portal.signin.link')
    throw linkDead()
  }
  // Under the code's lock, the row must still be the link's own (its stored link hash matches the token).
  const proved = await proveCode(p, request, found.target, found.codeId, (row) => matchesPortalToken(token, row.linkTokenHash), 'LINK')
  if (proved.kind === 'dead' || proved.kind === 'wrong') throw linkDead()
  if (proved.kind === 'refused') throw await refusal(p, found.target, proved.problem)
  return openSession(p, request, reply, found.target, proved.invited, 'LINK')
}

// --- sign-out -------------------------------------------------------------------------------------------------------------------

/** Ends the portal cookie's session, if it is live, and clears the portal cookie whatever it was. */
export async function signOut(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'signed_out' }> {
  const p = portalOf(app)
  assertCsrf(request)
  const token = parsePortalToken('session', portalCookieOf(request))
  if (token) {
    const now = p.auth.clock.now()
    const row = await p.auth.inTenant(token.tenantId, token.userId, (client) =>
      client.session.findUnique({ where: { tokenHash: portalTokenHash(token.value) }, select: { id: true, userId: true, partyId: true, audience: true, revokedAt: true, absoluteExpiresAt: true, companyId: true } }),
    )
    if (row && row.audience === 'PARTNER' && row.userId === token.userId && row.partyId === token.scopeId && row.revokedAt === null && row.absoluteExpiresAt.getTime() > now.getTime()) {
      await p.auth.command(p.auth.contextFor(request, token.tenantId, token.userId), { name: 'portal.signOut', input: null }, async ({ tx, now: at, audit }) => {
        await tx.session.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: at, revokedReason: 'SIGNED_OUT' } })
        audit({ recordType: 'Session', recordId: row.id, companyId: row.companyId, after: { revokedReason: 'SIGNED_OUT' } })
        return null
      })
    }
  }
  clearPortalCookie(reply)
  return { status: 'signed_out' }
}
