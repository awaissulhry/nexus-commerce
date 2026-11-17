import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { SUPERVISOR_REFUSALS, supervisorRefusals, type SupervisorCandidate, type SupervisorRefusal } from '@nexus/factory-domain/production-brand/supervisor'
import { SUPERVISOR_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/words'
import { heldRoles } from '../../../platform/auth/roles/access'
import { mayOnThread } from '../../../platform/threads/records'
import type { Reader } from './resolver'

/**
 * B-PR-42a — who may be a customer's production supervisor (or backup), and where (production plan §3 "Supervisor", §7.10; lead
 * pick L21; review fixes R-53, R-58; PW-14). The Inquiry assignee's pattern (sales/inquiries mayKeep: the person's LIVE office
 * roles, two-factor taken as proved — they prove it to sign in), with the domain's rule (factory-domain production-brand/supervisor
 * supervisorRefusals) and threads' read rule (`mayOnThread` over the person's own actor: the body of threads' `personReads`, read
 * once per person instead of once per company):
 *
 *   - an ACTIVE office person (else "no longer active" / "only a person of the office");
 *   - production.brand.manage or workorders.view over the company AND that customer (a grant limited to another customer is
 *     never one: PW-14);
 *   - sales.measurements.view over them (given per person, §7.10);
 *   - reads the customer's order threads (threads.read on a SalesOrder of that company and customer): the supervisor follows them
 *     (B-PR-42b) and answers there.
 *
 * Where: an order's company and customer; for a customer's default (it moves every order without its own), every company the
 * customer's orders may be at — its own company, or every ACTIVE company of the tenant for a customer of every company.
 */

/** One place a supervisor must be allowed: a company and the customer. */
export interface CustomerScope {
  readonly companyId: string
  readonly partyId: string
}

/** Why a person may not supervise a customer's production here: the domain's reasons, and the threads' read. */
export type EligibilityRefusal = SupervisorRefusal | 'NO_THREAD'
const REFUSAL_ORDER: readonly EligibilityRefusal[] = [...SUPERVISOR_REFUSALS, 'NO_THREAD']

/** The refusal words (the domain's four, and the thread's: a supervisor follows the customer's order threads). */
export const ELIGIBILITY_WORDS: Readonly<Record<EligibilityRefusal, { readonly it: string; readonly en: string }>> = Object.freeze({
  ...SUPERVISOR_REFUSAL_WORDS,
  NO_THREAD: {
    it: 'Questa persona non può leggere le conversazioni degli ordini di questo cliente: il supervisore le segue e vi risponde.',
    en: "This person cannot read this customer's order threads: a supervisor follows them and answers there.",
  },
})

/** A person as the rule reads them: their User row and the office actor of their live grants. */
export interface Candidate extends SupervisorCandidate {
  readonly id: string
  readonly name: string
}

/** The person (null: no such person in the tenant), with the actor their live office roles make. */
export async function candidateOf(db: Reader, tenantId: string, userId: string, now: Date): Promise<Candidate | null> {
  if (!isUuid(userId)) return null
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, audience: true, status: true } })
  if (!user) return null
  const actor: Actor = { audience: 'office', tenantId, grants: user.audience === 'OFFICE' ? sessionGrants({ requireMfa: false }, await heldRoles(db, user.id, now), true) : [] }
  return { id: user.id, name: user.displayName, audience: user.audience, status: user.status, actor }
}

/** Every reason the person may not supervise over these places (empty: eligible); "not office" alone says it all. */
export function refusalsOver(candidate: Candidate, scopes: readonly CustomerScope[]): EligibilityRefusal[] {
  const found = new Set<EligibilityRefusal>()
  for (const scope of scopes) {
    for (const refusal of supervisorRefusals(candidate, scope)) found.add(refusal)
    if (found.has('NOT_OFFICE')) return ['NOT_OFFICE']
    if (!mayOnThread(candidate.actor, THREADS_READ, 'SalesOrder', { companyId: scope.companyId, siteId: null, partyId: scope.partyId })) found.add('NO_THREAD')
  }
  return REFUSAL_ORDER.filter((refusal) => found.has(refusal))
}

/** The refusals in the office's words at `path` (empty: eligible). */
export function refusalIssues(refusals: readonly EligibilityRefusal[], path: string): Issue[] {
  return refusals.map((refusal) => ({ path, message: ELIGIBILITY_WORDS[refusal].en }))
}

/** A person's refusals at `path`, the person read inside the caller's transaction (no such person: "only a person of the office"). */
export async function personProblems(db: Reader, tenantId: string, userId: string, scopes: readonly CustomerScope[], now: Date, path: string): Promise<Issue[]> {
  const candidate = await candidateOf(db, tenantId, userId, now)
  if (!candidate) return refusalIssues(['NOT_OFFICE'], path)
  return refusalIssues(refusalsOver(candidate, scopes), path)
}

/** The person themselves, whatever the place: an office person (or none such), and still active. */
export function personRefusals(candidate: Candidate | null): EligibilityRefusal[] {
  if (!candidate || candidate.audience !== 'OFFICE') return ['NOT_OFFICE']
  return candidate.status === 'ACTIVE' ? [] : ['NOT_ACTIVE']
}

// ---- the customer and its companies ---------------------------------------------------------------------------------------

/** A customer as the routes read it. */
export interface CustomerRow {
  readonly id: string
  readonly companyId: string | null
  readonly roles: readonly string[]
}

export const readCustomer = async (db: Reader, partyId: string): Promise<CustomerRow | null> =>
  isUuid(partyId) ? db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, roles: true } }) : null

/** A production supervisor is set only for a customer or a brand (the database's rule too, B-PR-12). */
export const isCustomer = (party: CustomerRow): boolean => party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')

/** The companies a customer's production may be at: its own company, else every ACTIVE company of the tenant. */
export async function customerCompanies(db: Reader, party: CustomerRow): Promise<string[]> {
  if (party.companyId !== null) return [party.companyId]
  return (await db.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id)
}

export const scopesOf = (companies: readonly string[], partyId: string): CustomerScope[] => companies.map((companyId) => ({ companyId, partyId }))

/** `permission` over the customer at SOME of these companies (the caller sees it). */
export const reachesSome = (actor: Actor, permission: Permission, scopes: readonly CustomerScope[]): boolean => scopes.some((scope) => can(actor, permission, scope))

/** `permission` over the customer at EVERY one of these companies (the caller acts on the customer's default: it moves them all). */
export const reachesEvery = (actor: Actor, permission: Permission, scopes: readonly CustomerScope[]): boolean => scopes.length > 0 && scopes.every((scope) => can(actor, permission, scope))
