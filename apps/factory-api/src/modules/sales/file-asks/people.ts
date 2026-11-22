import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { askLocaleOf, askShapeProblem, FILE_ASK_LIMITS, refusalWords, type AskLocale, type FileAskAddressee, type FileAskRefusal, type FileAskTarget } from '@nexus/factory-domain/files/asks'
import { seesPrices } from '@nexus/factory-domain/files/priced'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { heldRoles, liveAssignment } from '../../../platform/auth/roles/access'
import { takesIssueTask, type TaskRecord } from '../../production/issues/tasks'
import type { Reader } from '../orders/store'

/**
 * B-OF-031 (13-backend §2.1): how the "who" of an ask becomes people.
 *
 *   PERSON        one Task, if the person may be given a task on the order (an ACTIVE office person who reads its thread and keeps
 *                 tasks there: production issues' `takesIssueTask`, platform tasks' `mayBeAssigned`) — and sees prices when the
 *                 file shows prices, holds the measurements right when it is body data; else PERSON_CANNOT_SEE / PERSON_NO_PRICES /
 *                 PERSON_NO_MEASUREMENTS, in words that name the person
 *   OFFICE_ROLE   each live holder of the role (an ACTIVE office person) who passes the same checks — a holder limited to other
 *                 customers falls out through can() and the assignment's customers; nobody: NOBODY_WITH_ROLE; more than 20:
 *                 TOO_MANY_PEOPLE ("pick one person"). Fixed at the ask: a later holder is reached by Reassign
 *   FLOOR_ROLE    no Task: a live role of the floor audience (the tablets of its holders at the work order's site read the ask)
 *   FLOOR_TEAM    no Task: an ACTIVE team of the work order's site
 *   STEP          no Task: the target's step (whoever works it reads the ask on the tablet)
 * Never one named floor worker (worker privacy, Statuto art. 4). Read in the command's transaction.
 */

export interface AskOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

export interface Who {
  readonly kind: FileAskAddressee
  readonly userId?: string | undefined
  readonly roleId?: string | undefined
  readonly teamId?: string | undefined
}

/** Where the ask lands, as resolved: the work order's site and the step when it lands on a work order. */
export interface Landing {
  readonly target: FileAskTarget
  readonly siteId: string | null
  readonly operationId: string | null
}

/** The addressee as stored, and the office people who get a Task (none for the floor). */
export interface Resolved {
  readonly addressee: FileAskAddressee
  readonly addresseeUserId: string | null
  readonly addresseeRoleId: string | null
  readonly addresseeTeamId: string | null
  readonly people: readonly { readonly id: string; readonly locale: AskLocale }[]
}

/** A refusal in words (409), its code in the issue's path (`fileAsk/<CODE>`): the web reads it. */
export function refused(code: FileAskRefusal, values: { readonly name?: string; readonly n?: number } = {}): DomainError {
  const words = refusalWords(code, values)
  return new DomainError('conflict', words.en, [{ path: `fileAsk/${code}`, message: words.en }])
}

/** A shape problem in words (400), its code in the issue's path. */
export function badShape(code: FileAskRefusal): ValidationError {
  const words = refusalWords(code)
  return new ValidationError(words.en, [{ path: `fileAsk/${code}`, message: words.en }])
}

/** A field of the body that does not fit (400 by place). */
export const badField = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])

/** The order as a Task's record (its customer walls it). */
const recordOf = (order: AskOrder): TaskRecord => ({ type: 'SalesOrder', id: order.id, label: order.number, companyId: order.companyId, siteId: null, partyId: order.partyId })

/** A person's office grants now (two-factor taken as proved: they prove it to sign in), as the task rules read them. */
async function personActor(db: Reader, tenantId: string, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
}

/** Why this person may not get the ask's Task (null: they may). */
async function personProblem(db: Reader, tenantId: string, order: AskOrder, userId: string, ask: { readonly priced: boolean; readonly bodyData: boolean }, now: Date): Promise<FileAskRefusal | null> {
  if (!(await takesIssueTask(db, tenantId, userId, recordOf(order), now))) return 'PERSON_CANNOT_SEE'
  if (!ask.priced && !ask.bodyData) return null
  const actor = await personActor(db, tenantId, userId, now)
  if (ask.priced && !seesPrices(actor)) return 'PERSON_NO_PRICES'
  if (ask.bodyData && !can(actor, SALES_MEASUREMENTS_VIEW, { companyId: order.companyId, partyId: order.partyId })) return 'PERSON_NO_MEASUREMENTS'
  return null
}

/** The "who" of an ask, checked, and its people (see the head). Throws a refusal in words. */
export async function resolveWho(db: Reader, tenantId: string, order: AskOrder, who: Who, landing: Landing, ask: { readonly priced: boolean; readonly bodyData: boolean }, now: Date): Promise<Resolved> {
  const shape = askShapeProblem({ target: landing.target, addressee: who.kind, priced: ask.priced, bodyData: ask.bodyData, hasStep: landing.operationId !== null })
  if (shape) throw badShape(shape)
  const only = (field: 'userId' | 'roleId' | 'teamId' | null) => {
    for (const name of ['userId', 'roleId', 'teamId'] as const) {
      if (name !== field && who[name] !== undefined) throw badField(`who/${name}`, `An ask to ${who.kind === 'PERSON' ? 'a person' : who.kind === 'FLOOR_TEAM' ? 'a team' : who.kind === 'STEP' ? 'whoever works a step' : 'a role'} names no ${name === 'userId' ? 'person' : name === 'roleId' ? 'role' : 'team'}.`)
    }
    if (field !== null && who[field] === undefined) throw badField(`who/${field}`, `Say which ${field === 'userId' ? 'person' : field === 'roleId' ? 'role' : 'team'} is asked.`)
  }
  const none = { addresseeUserId: null, addresseeRoleId: null, addresseeTeamId: null }

  if (who.kind === 'PERSON') {
    only('userId')
    const user = await db.user.findFirst({ where: { id: who.userId!, audience: 'OFFICE' }, select: { id: true, displayName: true, locale: true } })
    if (!user) throw badField('who/userId', 'This person is not someone of the office.')
    const problem = await personProblem(db, tenantId, order, user.id, ask, now)
    if (problem) throw refused(problem, { name: user.displayName })
    return { addressee: 'PERSON', ...none, addresseeUserId: user.id, people: [{ id: user.id, locale: askLocaleOf(user.locale) }] }
  }

  if (who.kind === 'OFFICE_ROLE' || who.kind === 'FLOOR_ROLE') {
    only('roleId')
    const audience = who.kind === 'OFFICE_ROLE' ? 'OFFICE' : 'FLOOR'
    const role = await db.role.findFirst({ where: { id: who.roleId!, audience, archivedAt: null }, select: { id: true } })
    if (!role) throw badField('who/roleId', audience === 'OFFICE' ? 'Pick a role of the office.' : 'Pick a role of the floor.')
    if (audience === 'FLOOR') return { addressee: 'FLOOR_ROLE', ...none, addresseeRoleId: role.id, people: [] }
    const holders = await db.roleAssignment.findMany({
      where: { roleId: role.id, ...liveAssignment(now), user: { status: 'ACTIVE', audience: 'OFFICE' } },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { userId: true, user: { select: { locale: true } } },
    })
    const people = new Map<string, AskLocale>()
    for (const holder of holders) {
      if (people.has(holder.userId)) continue
      if ((await personProblem(db, tenantId, order, holder.userId, ask, now)) === null) people.set(holder.userId, askLocaleOf(holder.user.locale))
    }
    if (people.size === 0) throw refused('NOBODY_WITH_ROLE')
    if (people.size > FILE_ASK_LIMITS.people) throw refused('TOO_MANY_PEOPLE', { n: people.size })
    return { addressee: 'OFFICE_ROLE', ...none, addresseeRoleId: role.id, people: [...people].map(([id, locale]) => ({ id, locale })) }
  }

  if (who.kind === 'FLOOR_TEAM') {
    only('teamId')
    const team = await db.team.findFirst({ where: { id: who.teamId!, status: 'ACTIVE', ...(landing.siteId ? { siteId: landing.siteId } : {}) }, select: { id: true, siteId: true } })
    if (!team || team.siteId !== landing.siteId) throw badField('who/teamId', "Pick an active team of the work order's plant.")
    return { addressee: 'FLOOR_TEAM', ...none, addresseeTeamId: team.id, people: [] }
  }

  only(null)
  return { addressee: 'STEP', ...none, people: [] }
}
