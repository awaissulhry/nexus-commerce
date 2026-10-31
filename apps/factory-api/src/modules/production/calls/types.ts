import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_CALLS_MANAGE, PRODUCTION_CALLS_VIEW } from '@nexus/factory-domain/production/calls/permissions'
import { CALL_REFUSALS, nextTypeOrder, typeDraftProblems, type CallKind } from '@nexus/factory-domain/production/calls/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMay, may, officeOf, problemsError, refuse } from './access'
import { lockType, readType, siteOf, typesOfSite, typeViews, type Reader, type SiteRow, type TypeRow } from './store'

/**
 * The site's help-call types and who answers them (B-W2b-35; MES-144; design production.settings "Help-call routing":
 * type · group · escalate after minutes, autosave per cell; production.calls "Who is called": type · group · members):
 *
 *   GET   /production/calls/types?siteId          the routing (production.calls.view): every type with its words (its
 *                                                 HELP_CALL code's), kind, team (or the site's team leaders) and how many
 *                                                 answer now, escalation minutes, waiting code, order, how often used
 *   POST  /production/calls/types                 a type (production.calls.manage): an active code of the HELP_CALL
 *                                                 reason list not yet a type of the site, its kind and its routing
 *   PATCH /production/calls/types/:typeId         its routing, order, active (version); its kind never changes
 *
 * A team is an ACTIVE team of the site; the waiting code an ACTIVE off-standard (OFF_STANDARD) code of the site's company
 * (B-W2b-29 refuses switching off a code an active type books to: BOOKED_BY_CALLS). Escalation minutes are kept for the
 * timed escalation (MES-146, a later wave): nothing escalates a call yet. A type is never deleted: switched off.
 */

export interface RoutingFields {
  readonly responderTeamId?: string | null | undefined
  readonly escalateAfterMinutes?: number | null | undefined
  readonly offStandardCodeId?: string | null | undefined
  readonly sortOrder?: number | undefined
}

async function knownSite(caller: CommandCaller, context: OfficeContext, siteId: string): Promise<SiteRow> {
  const site = isUuid(siteId) ? await caller.withClient((db) => siteOf(db, siteId)) : null
  if (!site) throw new NotFoundError('Site not found.')
  assertMay(context, PRODUCTION_CALLS_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
  return site
}

const assertManage = (context: OfficeContext, site: { readonly companyId: string; readonly id: string }) => {
  if (!may(context, PRODUCTION_CALLS_MANAGE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError("A site's help-call types are kept with production.calls.manage (Floor rules & codes).")
}

/** The routing fields sent, checked against the site: an ACTIVE team of the site, an ACTIVE off-standard code of its company. */
async function checkRouting(db: Reader | CommandTx, site: SiteRow, fields: RoutingFields, before: TypeRow | null): Promise<void> {
  const problems = typeDraftProblems({ escalateAfterMinutes: fields.escalateAfterMinutes, sortOrder: fields.sortOrder })
  if (problems.length > 0) throw problemsError(problems, 'The type has problems.')
  if (fields.responderTeamId && fields.responderTeamId !== before?.responderTeamId) {
    const team = await db.team.findUnique({ where: { id: fields.responderTeamId }, select: { siteId: true, status: true } })
    if (!team || team.siteId !== site.id || team.status !== 'ACTIVE') refuse(CALL_REFUSALS.TEAM_NOT_ACTIVE)
  }
  if (fields.offStandardCodeId && fields.offStandardCodeId !== before?.offStandardCodeId) {
    const code = await db.offStandardCode.findUnique({ where: { id: fields.offStandardCodeId }, select: { companyId: true, kind: true, active: true } })
    if (!code || code.companyId !== site.companyId || code.kind !== 'OFF_STANDARD' || !code.active) refuse(CALL_REFUSALS.WAITING_CODE)
  }
}

const routingAudit = (type: Pick<TypeRow, 'kind' | 'responderTeamId' | 'escalateAfterMinutes' | 'offStandardCodeId' | 'sortOrder' | 'active'>) => ({
  kind: type.kind,
  responderTeamId: type.responderTeamId,
  escalateAfterMinutes: type.escalateAfterMinutes,
  offStandardCodeId: type.offStandardCodeId,
  sortOrder: type.sortOrder,
  active: type.active,
})

/** GET /production/calls/types. */
export async function listTypes(caller: CommandCaller, query: { readonly siteId: string; readonly active?: boolean | undefined }) {
  const context = officeOf(caller)
  const site = await knownSite(caller, context, query.siteId)
  return caller.withClient(async (db) => ({
    site: { id: site.id, code: site.code, name: site.name },
    types: await typeViews(db, await typesOfSite(db, site.id, query.active === undefined ? {} : { active: query.active })),
    canManage: may(context, PRODUCTION_CALLS_MANAGE, { companyId: site.companyId, siteId: site.id }),
  }))
}

export interface CreateTypeBody extends RoutingFields {
  readonly siteId: string
  readonly code: string
  readonly kind: CallKind
}

/** POST /production/calls/types. */
export async function createType(caller: CommandCaller, body: CreateTypeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const site = await knownSite(caller, context, body.siteId)
  assertManage(context, site)
  const code = body.code.trim().toUpperCase()
  const problems = typeDraftProblems({ code })
  if (problems.length > 0) throw problemsError(problems, 'The type has problems.')
  const { result, replayed } = await command(caller, { name: 'production.addCallType', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const listed = await tx.reasonCode.findFirst({ where: { list: 'HELP_CALL', code, active: true }, select: { id: true } })
    if (!listed) refuse(CALL_REFUSALS.CODE_NOT_LISTED)
    if (await tx.helpCallType.findFirst({ where: { siteId: site.id, code }, select: { id: true } })) refuse(CALL_REFUSALS.CODE_TAKEN)
    await checkRouting(tx, site, body, null)
    const id = newId()
    const sortOrder = body.sortOrder ?? nextTypeOrder((await tx.helpCallType.findMany({ where: { siteId: site.id }, select: { sortOrder: true } })).map((row) => row.sortOrder))
    await tx.helpCallType.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        code,
        kind: body.kind,
        responderTeamId: body.responderTeamId ?? null,
        escalateAfterMinutes: body.escalateAfterMinutes ?? null,
        offStandardCodeId: body.offStandardCodeId ?? null,
        sortOrder,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const type = (await readType(tx, id))!
    tools.audit({ recordType: 'HelpCallType', recordId: id, companyId: site.companyId, siteId: site.id, after: { code, ...routingAudit(type) } })
    tools.emit({ type: 'help_call_type.changed', subject: id, companyId: site.companyId, siteId: site.id, payload: { typeId: id, code, kind: body.kind, change: 'ADDED', fields: [] } })
    return { type: (await typeViews(tx, [type]))[0]! }
  })
  return { ...result, replayed }
}

export interface UpdateTypeBody extends RoutingFields {
  readonly version: number
  readonly kind?: CallKind | undefined
  readonly active?: boolean | undefined
}

/** PATCH /production/calls/types/:typeId. */
export async function updateType(caller: CommandCaller, typeId: string, body: UpdateTypeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = isUuid(typeId) ? await caller.withClient((db) => readType(db, typeId)) : null
  if (!known) throw new NotFoundError('Help-call type not found.')
  assertMay(context, PRODUCTION_CALLS_VIEW, known, 'Help-call type')
  const site = (await caller.withClient((db) => siteOf(db, known.siteId)))!
  assertManage(context, site)
  if (body.kind !== undefined && body.kind !== known.kind) refuse(CALL_REFUSALS.KIND_FIXED)
  const { result, replayed } = await command(caller, { name: 'production.changeCallType', idempotencyKey, input: { typeId, ...body }, record: { type: 'HelpCallType', id: typeId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const before = (await lockType(tx, typeId))!
    await checkRouting(tx, site, body, before)
    const data = {
      ...(body.responderTeamId !== undefined ? { responderTeamId: body.responderTeamId } : {}),
      ...(body.escalateAfterMinutes !== undefined ? { escalateAfterMinutes: body.escalateAfterMinutes } : {}),
      ...(body.offStandardCodeId !== undefined ? { offStandardCodeId: body.offStandardCodeId } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    }
    const fields = Object.keys(data).filter((field) => (data as Record<string, unknown>)[field] !== (before as unknown as Record<string, unknown>)[field])
    if (fields.length > 0) await tx.helpCallType.update({ where: { id: typeId }, data: { ...data, updatedAt: now }, select: { id: true } })
    const after = (await readType(tx, typeId))!
    const pick = (row: TypeRow) => Object.fromEntries(Object.entries(routingAudit(row)).filter(([field]) => fields.includes(field)))
    tools.audit({ recordType: 'HelpCallType', recordId: typeId, companyId: site.companyId, siteId: site.id, before: pick(before), after: pick(after) })
    const change = fields.includes('active') ? (after.active ? 'SWITCHED_ON' : 'SWITCHED_OFF') : 'CHANGED'
    tools.emit({ type: 'help_call_type.changed', subject: typeId, companyId: site.companyId, siteId: site.id, payload: { typeId, code: after.code, kind: after.kind as CallKind, change, fields } })
    return { type: (await typeViews(tx, [after]))[0]! }
  })
  return { ...result, replayed }
}
