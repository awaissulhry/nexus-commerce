import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { QUALITY_AQL_MANAGE, QUALITY_AQL_VIEW } from '@nexus/factory-domain/quality/aql/permissions'
import type { AssignmentChange } from '@nexus/factory-domain/quality/aql/profiles'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { AssignmentView } from './contract'
import { ASSIGNMENT_COLUMNS, assertManage, assignmentViews, assignmentWall, brandOfStyle, lockPair, mayView, officeOf, profileFor, reachesNamed, readAssignment, type AssignmentRow } from './store'

/**
 * AQL profile assignments (B-W2b-93; QHS-021; design quality.plans pl-aql "used by customers / styles", sales.customers
 * "customer AQL profiles"): a profile for a customer, a style, or a style of one customer. One active row per pair (the
 * …_inspection_plans_w2b_guards partial unique index): assigning another profile to a pair ends its old row and adds the
 * new one in ONE command (event REPLACED); an assignment no longer wanted is ended (active false), never deleted, so the
 * history stays. Read with quality.aql.view, kept with quality.aql.manage over the profile's company.
 * op-fx9 (the brand wall): a row names its customer and its style's brand; a person limited to some customers reads, assigns
 * and ends only what names customers it reaches — another customer's row, customer or private-label style answers as an
 * unknown one (no row; the same 400 or 404 words). The production unit (every customer) reads and keeps them all.
 *
 *   GET  /quality/aql/assignments                        the rows the caller sees (by company, profile, customer, style, active)
 *   POST /quality/aql/assignments                        { profileId, customerId?, styleId? }: at least one of the two;
 *                                                        the customer has the CUSTOMER or BRAND role, the style is the
 *                                                        profile's company's or the group's
 *   POST /quality/aql/assignments/:assignmentId/end      { version }
 */

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const emitChange = (tools: CommandTools, row: AssignmentRow, change: AssignmentChange, replacedId: string | null) =>
  tools.emit({
    type: 'quality.aql_assignment_changed',
    subject: row.id,
    companyId: row.companyId,
    payload: { companyId: row.companyId, assignmentId: row.id, profileId: row.profileId, customerId: row.customerId, styleId: row.styleId, change, replacedId },
  })

const audited = (row: AssignmentRow) => ({ profileId: row.profileId, customerId: row.customerId, styleId: row.styleId, active: row.active })

/** GET /quality/aql/assignments */
export async function readAssignments(
  caller: CommandCaller,
  query: { readonly companyId?: string | undefined; readonly profileId?: string | undefined; readonly customerId?: string | undefined; readonly styleId?: string | undefined; readonly active?: 'true' | 'false' | undefined },
): Promise<{ assignments: AssignmentView[] }> {
  const context = officeOf(caller)
  if (query.companyId && !mayView(context, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const rows = await client.aqlProfileAssignment.findMany({
      where: {
        AND: [
          assignmentWall(context, QUALITY_AQL_VIEW), // op-fx9: the brand wall (was the company alone)
          query.companyId ? { companyId: query.companyId } : {},
          query.profileId ? { profileId: query.profileId } : {},
          query.customerId ? { customerId: query.customerId } : {},
          query.styleId ? { styleId: query.styleId } : {},
          query.active ? { active: query.active === 'true' } : {},
        ],
      },
      select: ASSIGNMENT_COLUMNS,
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    })
    return { assignments: await assignmentViews(client, rows) }
  })
}

export interface AssignBody {
  readonly profileId: string
  readonly customerId?: string | null | undefined
  readonly styleId?: string | null | undefined
}

/** POST /quality/aql/assignments */
export async function assignProfile(caller: CommandCaller, body: AssignBody, idempotencyKey?: string): Promise<{ assignment: AssignmentView; replacedId: string | null }> {
  const { context, row: profile } = await profileFor(caller, body.profileId, true)
  const customerId = body.customerId ?? null
  const styleId = body.styleId ?? null
  const problems: Issue[] = []
  if (customerId === null && styleId === null) problems.push({ path: 'customerId', message: 'Assign the profile to a customer, a style, or a style of one customer.' })
  if (!profile.active) problems.push({ path: 'profileId', message: `${profile.code} is retired: make it active again before assigning it.` })
  const facts = await caller.withClient(async (client) => ({
    customer: customerId && isUuid(customerId) ? await client.party.findUnique({ where: { id: customerId }, select: { id: true, roles: true } }) : null,
    style: styleId && isUuid(styleId) ? await client.style.findUnique({ where: { id: styleId }, select: { id: true, companyId: true, code: true, brandPartyId: true } }) : null,
  }))
  // op-fx9: a customer, or a private-label style of a customer, the person does not reach is refused as an unknown one.
  const reached = (named: { customerId: string | null; brandPartyId: string | null }) => reachesNamed(context, [QUALITY_AQL_MANAGE], profile.companyId, named)
  if (customerId !== null && (!facts.customer?.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND') || !reached({ customerId, brandPartyId: null }))) problems.push({ path: 'customerId', message: 'Not a customer (a party with the customer or brand role).' })
  if (styleId !== null && (!facts.style || (facts.style.companyId !== null && facts.style.companyId !== profile.companyId) || !reached({ customerId: null, brandPartyId: facts.style.brandPartyId }))) problems.push({ path: 'styleId', message: "Not a style of the profile's company (or of the whole group)." })
  if (problems.length > 0) refuse(problems, 'The assignment is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'quality.aql.assignProfile', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockPair(tx, profile.companyId, customerId, styleId)
    const old = await tx.aqlProfileAssignment.findFirst({ where: { companyId: profile.companyId, customerId, styleId, active: true }, select: ASSIGNMENT_COLUMNS })
    if (old?.profileId === profile.id) throw new ConflictError(`${profile.code} is already assigned here: nothing to change.`)
    if (old) {
      const ended = await tx.aqlProfileAssignment.update({ where: { id: old.id }, data: { active: false, version: { increment: 1 }, updatedAt: now }, select: ASSIGNMENT_COLUMNS })
      tools.audit({ recordType: 'AqlProfileAssignment', recordId: old.id, companyId: old.companyId, before: audited(old), after: { ...audited(ended), replacedBy: id } })
    }
    const row = await tx.aqlProfileAssignment.create({
      data: { id, companyId: profile.companyId, profileId: profile.id, customerId, styleId, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: ASSIGNMENT_COLUMNS,
    })
    tools.audit({ recordType: 'AqlProfileAssignment', recordId: id, companyId: row.companyId, after: { ...audited(row), profileCode: profile.code, replaces: old?.id ?? null } })
    emitChange(tools, row, old ? 'REPLACED' : 'ASSIGNED', old?.id ?? null)
    return { id, replacedId: old?.id ?? null }
  })
  return caller.withClient(async (client) => ({ assignment: (await assignmentViews(client, [(await readAssignment(client, result.id))!]))[0]!, replacedId: result.replacedId }))
}

/** POST /quality/aql/assignments/:assignmentId/end */
export async function endAssignment(caller: CommandCaller, assignmentId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ assignment: AssignmentView }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (client) => {
    const row = await readAssignment(client, assignmentId)
    return row ? { row, named: { customerId: row.customerId, brandPartyId: await brandOfStyle(client, row.styleId) } } : null
  })
  // op-fx9: an assignment naming a customer the person does not reach is not found, as an unknown one.
  if (!found || !mayView(context, found.row.companyId) || !reachesNamed(context, [QUALITY_AQL_VIEW, QUALITY_AQL_MANAGE], found.row.companyId, found.named)) throw new NotFoundError('AQL profile assignment not found.')
  const before = found.row
  assertManage(context, before.companyId, found.named)
  const { result } = await command(caller, { name: 'quality.aql.endAssignment', idempotencyKey, input: { assignmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number; active: boolean }[]>`SELECT "version", "active" FROM "AqlProfileAssignment" WHERE "id" = ${before.id}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('AQL profile assignment not found.')
    if (locked.version !== body.version) throw new StaleVersionError('AqlProfileAssignment', before.id, locked.version, body.version)
    if (!locked.active) throw new InvalidStateError('This assignment has already ended.')
    const row = await tx.aqlProfileAssignment.update({ where: { id: before.id }, data: { active: false, version: { increment: 1 }, updatedAt: now }, select: ASSIGNMENT_COLUMNS })
    tools.audit({ recordType: 'AqlProfileAssignment', recordId: row.id, companyId: row.companyId, before: audited(before), after: audited(row) })
    emitChange(tools, row, 'ENDED', null)
    return { id: row.id }
  })
  return caller.withClient(async (client) => ({ assignment: (await assignmentViews(client, [(await readAssignment(client, result.id))!]))[0]! }))
}
