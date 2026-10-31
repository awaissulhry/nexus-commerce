import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDayStart, businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { OPEN_REASON_WORDS, OPEN_REASONS, openReasonProblems, personFigureAccess, type FigureAccess, type FigureDecision, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import type { GatePurpose } from '@nexus/factory-domain/people/privacy/purposes'
import { PEOPLE_FIGURES_VIEW } from '@nexus/factory-domain/people/privacy/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { gateClosedError, legalGateFor, legalGateReader, type GateRecord } from './gate'
import { privacySettingsFor } from './groups'

/**
 * One person's figures: the worker and HR only (B-W2b-27; MES-249; Owner answer H3; design people.efficiency "One
 * person's figures": opened per person with a purpose, recorded, no comparison, no export, no print). Who may open one
 * person's ATTENDANCE or PERFORMANCE figures is decided here, one person at a time; never for a list.
 *
 * For the later per-person reads (B-W2b-44 efficiency, -45 labour records, -61 attendance, -68 floor My day):
 *   personFiguresAccess(caller, employeeId, purpose)   who the viewer is to the person (SELF, FIGURE_ROLE, LEAD) or
 *                                                      why not (GATE_CLOSED, NOT_ALLOWED); 404 for a person out of
 *                                                      the viewer's reach. Office user or floor worker.
 *   requirePersonFigures(access)                       the refusal in words (409 `gate/<PURPOSE>` when the site's gate is
 *                                                      off, 403 `figures/NOT_ALLOWED`)
 *   openPersonFiguresInCommand(tools, access, why)     writes the opening down (audit people.openPersonFigures: who,
 *                                                      whose, which purpose, why) inside the reading command
 *   openPersonFigures(caller, employeeId, body, key)   all three as ONE command (POST /people/privacy/figures/…/open)
 *
 * The rules (factory-domain people/privacy/figures): the site's gate for the purpose open; the worker themselves; a
 * holder of a role the company's People settings name (figureRoleKeys; that role grants people.figures.view over the
 * person's company and site, and so does the session); the lead of a team the person belongs to today where the site's
 * gate lets leads see them (people.figures.view in the office, floor.lead on the floor).
 */

const EMPLOYEE_SELECT = { id: true, companyId: true, siteId: true, status: true } as const

export interface PersonFiguresAccess {
  readonly employee: { readonly id: string; readonly companyId: string; readonly siteId: string }
  readonly purpose: GatePurpose
  readonly decision: FigureDecision
  readonly gate: GateRecord | null
  readonly minimumGroupSize: number
}

type Viewer = { readonly kind: 'user'; readonly context: OfficeContext } | { readonly kind: 'worker'; readonly context: FloorContext }

function viewerOf(caller: CommandCaller): Viewer {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience === 'office') return { kind: 'user', context }
  if (context.audience === 'floor') return { kind: 'worker', context }
  throw new ForbiddenError("One person's figures are opened by the office or on the floor only.")
}

/** "Today" for team memberships (a membership's since and until are days, Europe/Rome). */
const todayStart = (now: Date): Date => businessDayStart(businessDate(now))

/** The employee records whose teams the viewer leads today (team ids). */
async function ledTeams(db: Pick<CommandTx, 'teamMember'>, leadEmployeeId: string, today: Date): Promise<string[]> {
  const rows = await db.teamMember.findMany({
    where: { employeeId: leadEmployeeId, isLead: true, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] },
    select: { teamId: true },
  })
  return rows.map((row) => row.teamId)
}

/** The person belongs today to one of these teams. */
async function memberOfAny(db: Pick<CommandTx, 'teamMember'>, employeeId: string, teamIds: readonly string[], today: Date): Promise<boolean> {
  if (teamIds.length === 0) return false
  const row = await db.teamMember.findFirst({
    where: { employeeId, teamId: { in: [...teamIds] }, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] },
    select: { id: true },
  })
  return row !== null
}

/** The viewer holds, live, a role the settings name that grants people.figures.view over the person's company and site. */
export async function holdsFigureRole(db: Parameters<typeof heldRoles>[0], userId: string, figureRoleKeys: readonly string[], place: { companyId: string; siteId: string }, now: Date): Promise<boolean> {
  if (figureRoleKeys.length === 0) return false
  const held = await heldRoles(db, userId, now)
  return held.some(
    (entry) =>
      figureRoleKeys.includes(entry.roleKey) &&
      entry.role.permissions.includes(PEOPLE_FIGURES_VIEW) &&
      (entry.scope.allCompanies || entry.scope.companyIds.includes(place.companyId)) &&
      (entry.scope.siteIds.length === 0 || entry.scope.siteIds.includes(place.siteId)),
  )
}

/**
 * Who the viewer is to one person's figures for a purpose (see above). A person out of the viewer's reach (another
 * company or site they hold no people.figures.view over, another floor site) is 404: their existence is not told.
 */
export async function personFiguresAccess(caller: CommandCaller, employeeId: string, purpose: GatePurpose): Promise<PersonFiguresAccess> {
  const viewer = viewerOf(caller)
  const now = serverClock.now()
  const today = todayStart(now)
  const found = isUuid(employeeId) ? await caller.withClient((client) => client.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_SELECT })) : null
  if (!found) throw new NotFoundError('Person not found.')
  const employee = { id: found.id, companyId: found.companyId, siteId: found.siteId }
  const place = { companyId: employee.companyId, siteId: employee.siteId }
  const { gate } = await legalGateReader(caller, (db) => legalGateFor(db, employee.siteId, purpose))
  const facts = await caller.withClient(async (client) => {
    const settings = await privacySettingsFor(client, employee.companyId)
    if (viewer.kind === 'user') {
      const actor = actorOf(viewer.context)
      const mayOpen = can(actor, PEOPLE_FIGURES_VIEW, place)
      const own = await client.employee.findFirst({ where: { userId: viewer.context.actorId }, select: { id: true } })
      const isSubject = own?.id === employee.id
      if (!isSubject && !mayOpen) return null
      const holdsRole = mayOpen && (await holdsFigureRole(client, viewer.context.actorId, settings.figureRoleKeys, place, now))
      const leads = mayOpen && own !== null && !isSubject && (await memberOfAny(client, employee.id, await ledTeams(client, own.id, today), today))
      return { settings, isSubject, holdsRole, leads }
    }
    const worker = await client.worker.findUnique({ where: { id: viewer.context.actorId }, select: { employeeId: true } })
    const own = worker?.employeeId ?? null
    const isSubject = own === employee.id
    const mayLead = holds(actorOf(viewer.context), 'floor.lead')
    const leads = mayLead && own !== null && !isSubject && (await memberOfAny(client, employee.id, await ledTeams(client, own, today), today))
    return { settings, isSubject, holdsRole: false, leads }
  })
  if (!facts) throw new NotFoundError('Person not found.')
  const decision = personFigureAccess(
    purpose,
    { open: gate !== null, leadsSeeFigures: gate !== null && gate.basisCoversLeads && gate.leadsSeeFigures },
    { isSubject: facts.isSubject, holdsFigureRole: facts.holdsRole, leadsSubject: facts.leads },
  )
  return { employee, purpose, decision, gate, minimumGroupSize: facts.settings.minimumGroupSize }
}

/** The refusal of a decision that does not allow: 409 `gate/<PURPOSE>` (the site's gate is off) or 403 `figures/NOT_ALLOWED`. */
export function requirePersonFigures(access: PersonFiguresAccess): FigureAccess {
  const { decision } = access
  if (decision.allowed) return decision.as
  if (decision.code === 'GATE_CLOSED') throw gateClosedError(access.purpose)
  throw new DomainError('forbidden', decision.words, [{ path: `figures/${decision.code}`, message: decision.words }])
}

export interface OpenWhy {
  readonly reason?: OpenReason | undefined
  readonly note?: string | null | undefined
}

/** Writes an opening of one person's figures down, inside the reading command (who, whose, which purpose, why). */
export function openPersonFiguresInCommand(tools: Pick<CommandTools, 'audit'>, access: PersonFiguresAccess, why: OpenWhy): void {
  const as = requirePersonFigures(access)
  const note = why.note?.trim() ? why.note.trim() : undefined
  tools.audit({
    action: 'people.openPersonFigures',
    recordType: 'Employee',
    recordId: access.employee.id,
    companyId: access.employee.companyId,
    siteId: access.employee.siteId,
    after: { purpose: access.purpose, as, reason: why.reason ?? null, gateId: access.gate?.id ?? null },
    ...(note ? { reason: note } : {}),
  })
}

/** The reasons to offer for someone else's figures (none for the worker's own). */
export const reasonChoices = (decision: FigureDecision) =>
  decision.allowed && decision.needsReason ? OPEN_REASONS.map((code) => ({ code, words: OPEN_REASON_WORDS[code] })) : []

/** people.figures.view: who the viewer is to this person's figures for the purpose, before anything is opened. */
export async function accessOf(caller: CommandCaller, employeeId: string, purpose: GatePurpose) {
  const access = await personFiguresAccess(caller, employeeId, purpose)
  const { decision } = access
  return {
    employeeId: access.employee.id,
    siteId: access.employee.siteId,
    purpose,
    allowed: decision.allowed,
    as: decision.allowed ? decision.as : null,
    refusal: decision.allowed ? null : decision.code,
    needsReason: decision.allowed ? decision.needsReason : false,
    reasons: reasonChoices(decision),
    words: decision.allowed
      ? decision.needsReason
        ? ["Opening this person's figures is recorded with your reason and visible to HR and the data protection officer; no comparison with others, no export, no print."]
        : ['These are your own figures.']
      : [decision.words],
  }
}

export interface OpenBody {
  readonly purpose: GatePurpose
  readonly reason?: OpenReason | undefined
  readonly note?: string | null | undefined
}

/**
 * people.figures.view: opens one person's figures for a purpose, with a reason when they are someone else's: ONE command
 * that only writes the opening down (audit people.openPersonFigures). The figures themselves come from the module that
 * computes them (B-W2b-44, -45, -61), which asks the same access in its own read.
 */
export async function openPersonFigures(caller: CommandCaller, employeeId: string, body: OpenBody, idempotencyKey?: string) {
  const access = await personFiguresAccess(caller, employeeId, body.purpose)
  const as = requirePersonFigures(access)
  const problems = openReasonProblems(access.decision, body.reason, body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await command(caller, { name: 'people.openPersonFigures', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    // The gate is read again inside the command (the office reads it in the transaction; the floor through the system
    // caller): a gate switched off since the check refuses the opening.
    const { gate } = tools.context.audience === 'floor' ? await legalGateReader(caller, (db) => legalGateFor(db, access.employee.siteId, body.purpose)) : await legalGateFor(tools.tx, access.employee.siteId, body.purpose)
    if (!gate) throw gateClosedError(body.purpose)
    openPersonFiguresInCommand(tools, { ...access, gate }, { reason: body.reason, note: body.note })
    return {
      employeeId: access.employee.id,
      siteId: access.employee.siteId,
      purpose: body.purpose,
      as,
      reason: access.decision.allowed && access.decision.needsReason ? (body.reason ?? null) : null,
      openedAt: toUtcIso(tools.now),
      recorded: true as const,
      words: ["This opening is recorded and visible to HR and the data protection officer: no comparison with others, no export, no print."],
    }
  })
  return result
}
