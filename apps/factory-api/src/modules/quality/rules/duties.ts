import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { reasonProblem } from '@nexus/factory-domain/quality/final/rules'
import { QUALITY_SETTINGS_MANAGE } from '@nexus/factory-domain/quality/lab/permissions'
import type { FourEyesRule } from '@nexus/factory-domain/quality/release/rules'
import {
  dutiesChanged,
  dutiesInForce,
  dutiesLoosenings,
  isFourEyesCondition,
  SEPARATIONS,
  separationProblems,
  type DutiesInForce,
  type DutiesRow,
  type FourEyesCondition,
  type Loosening,
} from '@nexus/factory-domain/quality/rules/duties'
import { QUALITY_RULES_VIEW } from '@nexus/factory-domain/quality/rules/permissions'
import { benchUndoProblem, RESULT_LIMITS, resultsChanged, resultsInForce, type ResultsRow } from '@nexus/factory-domain/quality/rules/results'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { ruleFor } from '../lab/read'
import type { RulesView } from './contract'

/**
 * Who may sign what and how results are counted (B-W2b-118; QHS-300, QHS-023; design quality.settings qs-sod, qs-results,
 * qs-loosen), kept on QualitySettings (the company's row, id = the company's; or the tenant-wide row, id = the tenant's)
 * beside B-W1-34's Cr VI rule, W1's four-eyes rule (B-W1-45) and B-W2b-17's hold rule:
 *
 *   GET /quality/rules?companyId        quality.rules.view over the company (tenant-wide: any grant): both cards, what is
 *                                       in force and where it comes from, the customers listed, who floor records name
 *                                       per site (the maker check), the separations and the custom roles that break one
 *   PUT /quality/rules/duties           quality.settings.manage over the scope (tenant-wide: over every company): the
 *                                       release rule, its conditions, the customers, the hold release, in ONE command at
 *                                       the row's version; a looser rule (dutiesLoosenings) asks the reason and a fresh
 *                                       code, and is checked again under the row's lock
 *   PUT /quality/rules/results          the same permission: stop at the reject number, the bench's undo window
 *
 * A new row keeps the Cr VI evidence rule in force as it was (as the release and hold rules' saves do). Every save emits
 * quality.rules_changed, and the existing quality.release_rule_changed / quality.hold_rule_changed when those settings
 * change (the inspection and holds screens listen to them).
 */

type Db = FactoryClient | CommandTx

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const COLUMNS = {
  id: true,
  companyId: true,
  releaseFourEyes: true,
  fourEyesConditions: true,
  secondPersonPartyIds: true,
  placerMayRelease: true,
  stopAtRejectNumber: true,
  benchUndoSeconds: true,
  version: true,
  updatedAt: true,
} as const

type Row = { id: string; releaseFourEyes: string | null; fourEyesConditions: string[]; secondPersonPartyIds: string[]; placerMayRelease: boolean | null; stopAtRejectNumber: boolean | null; benchUndoSeconds: number | null; version: number; updatedAt: Date }

async function rowsOf(db: Db, tenantId: string, companyId: string | null): Promise<{ company: Row | null; tenant: Row | null }> {
  const rows = (await db.qualitySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: COLUMNS })) as unknown as Row[]
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

const dutiesOf = (row: Row | null): DutiesRow | null =>
  row ? { releaseFourEyes: (row.releaseFourEyes ?? null) as FourEyesRule | null, fourEyesConditions: row.fourEyesConditions.filter(isFourEyesCondition), secondPersonPartyIds: row.secondPersonPartyIds, placerMayRelease: row.placerMayRelease } : null
const resultsOf = (row: Row | null): ResultsRow | null => (row ? { stopAtRejectNumber: row.stopAtRejectNumber, benchUndoSeconds: row.benchUndoSeconds } : null)

/** What is in force for the scope: a company with its own row and the tenant-wide one, or the tenant-wide row alone. */
const dutiesNow = (companyId: string | null, rows: { company: Row | null; tenant: Row | null }): DutiesInForce => dutiesInForce(companyId === null ? undefined : dutiesOf(rows.company), dutiesOf(rows.tenant))

async function assertCompany(caller: CommandCaller, companyId: string): Promise<{ id: string; code: string; name: string }> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true } })) : null
  if (!row || !(can(actorOf(context), QUALITY_RULES_VIEW, { companyId }) || can(actorOf(context), QUALITY_SETTINGS_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
  return { id: row.id, code: row.code, name: row.legalName }
}

async function viewOf(db: Db, context: OfficeContext, companyId: string | null, company: { id: string; code: string; name: string } | null): Promise<RulesView> {
  const rows = await rowsOf(db, context.tenantId, companyId)
  const own = companyId === null ? rows.tenant : rows.company
  const inForce = dutiesNow(companyId, rows)
  const listed = [
    ...(companyId === null ? [] : (rows.company?.secondPersonPartyIds ?? []).map((id) => ({ id, listedOn: 'COMPANY' as const }))),
    ...(rows.tenant?.secondPersonPartyIds ?? []).map((id) => ({ id, listedOn: 'TENANT' as const })),
  ]
  const parties = listed.length ? new Map((await db.party.findMany({ where: { id: { in: listed.map((entry) => entry.id) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, row])) : new Map<string, { code: string; legalName: string; tradeName: string | null }>()
  const results = resultsInForce(companyId === null ? undefined : resultsOf(rows.company), resultsOf(rows.tenant))
  // Who floor records name at each site of the company (every company: the sites the reader reaches, at most 50).
  const sites = await db.site.findMany({ where: companyId === null ? {} : { companyId }, orderBy: [{ code: 'asc' }], take: 50, select: { id: true, code: true, name: true } })
  const settings = sites.length ? await db.productionSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: { id: true, scanSubject: true } }) : []
  // The separations: every system role keeps them (factory-domain's test); a custom office role copied from a template may not.
  const custom = await db.role.findMany({ where: { system: false, audience: 'OFFICE' }, orderBy: [{ key: 'asc' }], take: 200, select: { id: true, key: true, name: true, basedOn: true, permissions: true, grains: true } })
  const broken = custom.flatMap((role) => separationProblems({ key: role.key, templateKey: role.basedOn, permissions: role.permissions, grains: role.grains }).map((problem) => ({ problem, role })))
  return {
    companyId,
    company,
    version: own?.version ?? 0,
    updatedAt: own ? toUtcIso(own.updatedAt) : null,
    mayChange: mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId),
    duties: {
      own: own ? { ...dutiesOf(own)!, fourEyesConditions: [...dutiesOf(own)!.fourEyesConditions], secondPersonPartyIds: [...own.secondPersonPartyIds] } : null,
      inForce: {
        releaseFourEyes: inForce.releaseFourEyes,
        conditions: [...inForce.conditions],
        conditionsFromTenant: [...inForce.conditionsFromTenant],
        placerMayRelease: inForce.placerMayRelease,
      },
      customers: listed.map((entry) => {
        const party = parties.get(entry.id)
        return { id: entry.id, code: party?.code ?? '', name: party?.tradeName ?? party?.legalName ?? '', listedOn: entry.listedOn }
      }),
    },
    results: {
      own: own ? resultsOf(own) : null,
      inForce: results,
      limits: { benchUndoMin: RESULT_LIMITS.benchUndoMin, benchUndoMax: RESULT_LIMITS.benchUndoMax },
    },
    monitoring: sites.map((site) => ({ siteId: site.id, code: site.code, name: site.name, scanSubject: (settings.find((row) => row.id === site.id)?.scanSubject ?? 'WORKER') as 'WORKER' | 'STATION' })),
    separations: SEPARATIONS.map((rule) => {
      const roles = broken.filter((entry) => entry.problem.id === rule.id)
      return { id: rule.id, kept: roles.length === 0, roles: roles.map((entry) => ({ id: entry.role.id, key: entry.role.key, name: entry.role.name, permissions: [...entry.problem.permissions] })) }
    }),
  }
}

/** GET /quality/rules */
export async function getRules(caller: CommandCaller, query: { readonly companyId?: string | undefined }): Promise<RulesView> {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  const company = companyId === null ? null : await assertCompany(caller, companyId)
  return caller.withClient((db) => viewOf(db, context, companyId, company))
}

function assertMayChange(caller: CommandCaller, companyId: string | null): OfficeContext {
  const context = officeOf(caller)
  if (!mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The quality rules of every company are changed only by a role over every company.' : 'Changing the quality rules needs quality.settings.manage for the company.')
  }
  return context
}

/** The scope's row FOR UPDATE at the version read (0: no row yet), then the rows as they are now. */
async function lockRow(tools: CommandTools, context: OfficeContext, companyId: string | null, version: number) {
  const id = companyId ?? context.tenantId
  const [locked] = await tools.tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "QualitySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
  const current = locked?.version ?? 0
  if (current !== version) throw new StaleVersionError('QualitySettings', id, current, version)
  return { id, exists: !!locked, rows: await rowsOf(tools.tx, context.tenantId, companyId) }
}

/** Writes the scope's row: an update, or a new row that keeps the Cr VI evidence rule in force as it is. */
async function writeRow(tools: CommandTools, context: OfficeContext, companyId: string | null, id: string, exists: boolean, data: Record<string, unknown>) {
  const { tx, now } = tools
  if (exists) {
    await tx.qualitySettings.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    return
  }
  const crVi = await ruleFor(tx, context.tenantId, companyId)
  await tx.qualitySettings
    .create({ data: { id, companyId, crViEvidenceRule: crVi.rule, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    .catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These quality rules were just saved by someone else: read them again.')
      throw error
    })
}

export interface SaveDutiesBody {
  readonly companyId?: string | null | undefined
  readonly version: number
  readonly releaseFourEyes: FourEyesRule | null
  readonly fourEyesConditions: readonly FourEyesCondition[]
  readonly secondPersonPartyIds: readonly string[]
  readonly placerMayRelease: boolean | null
  readonly reason?: string | null | undefined
}

/** PUT /quality/rules/duties */
export async function saveDuties(caller: CommandCaller, body: SaveDutiesBody, options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const companyId = body.companyId ?? null
  const context = assertMayChange(caller, companyId)
  const company = companyId === null ? null : await assertCompany(caller, companyId)
  const conditions = [...new Set(body.fourEyesConditions)].sort()
  const partyIds = [...body.secondPersonPartyIds]
  if (new Set(partyIds).size !== partyIds.length) throw new ValidationError('List each customer once.', [{ path: 'body/secondPersonPartyIds', message: 'Each customer once.' }])
  const found = partyIds.length ? await caller.withClient((db) => db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, roles: true } })) : []
  const unknown = partyIds.filter((partyId) => !found.some((party) => party.id === partyId && (party.roles.includes('CUSTOMER') || party.roles.includes('BRAND'))))
  if (unknown.length > 0) throw new ValidationError('Only customers are listed.', unknown.map((partyId) => ({ path: 'body/secondPersonPartyIds', message: `${partyId} is not a customer.` })))
  const after: DutiesRow = { releaseFourEyes: body.releaseFourEyes, fourEyesConditions: conditions, secondPersonPartyIds: partyIds, placerMayRelease: body.placerMayRelease }
  const plan = (rows: { company: Row | null; tenant: Row | null }) => {
    const before = dutiesNow(companyId, rows)
    const next = companyId === null ? dutiesInForce(undefined, after) : dutiesInForce(after, dutiesOf(rows.tenant))
    return dutiesLoosenings(before, next)
  }
  const loosened = plan(await caller.withClient((db) => rowsOf(db, context.tenantId, companyId)))
  if (loosened.length > 0) {
    const problem = reasonProblem(body.reason)
    if (problem) throw new ValidationError('A looser rule needs the reason.', [{ ...problem, path: 'body/reason' }])
    await options.stepUp()
  }
  await command(caller, { name: 'quality.rules.saveDuties', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { id, exists, rows } = await lockRow(tools, context, companyId, body.version)
    const now = plan(rows)
    if (now.some((code) => !loosened.includes(code))) {
      throw new ValidationError('The rules in force changed meanwhile: read them again, then loosen them with the reason and a fresh code.', [{ path: 'body/version', message: 'Read the rules again.' }])
    }
    const ownBefore = dutiesOf(companyId === null ? rows.tenant : rows.company) ?? { releaseFourEyes: null, fourEyesConditions: [], secondPersonPartyIds: [], placerMayRelease: null }
    const fields = dutiesChanged(ownBefore, after)
    // Nothing to change (saved as it is): the attempt is kept, nothing is written or told.
    if (fields.length === 0) {
      tools.audit({ action: 'quality.rules.unchanged', recordType: 'QualitySettings', recordId: id, companyId, after: { card: 'DUTIES' } })
      return { id }
    }
    await writeRow(tools, context, companyId, id, exists, { releaseFourEyes: after.releaseFourEyes, fourEyesConditions: conditions, secondPersonPartyIds: partyIds, placerMayRelease: after.placerMayRelease })
    tools.audit({
      recordType: 'QualitySettings',
      recordId: id,
      companyId,
      before: { ...ownBefore },
      after: { ...after, loosened: now },
      ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
    })
    tools.emit({ type: 'quality.rules_changed', subject: id, companyId, payload: { companyId, card: 'DUTIES', fields, loosened: now } })
    // The screens of the release and the holds read their own events.
    if (fields.includes('releaseFourEyes') || fields.includes('secondPersonPartyIds') || fields.includes('fourEyesConditions')) {
      const added = partyIds.filter((partyId) => !ownBefore.secondPersonPartyIds.includes(partyId))
      const removed = ownBefore.secondPersonPartyIds.filter((partyId) => !partyIds.includes(partyId))
      tools.emit({
        type: 'quality.release_rule_changed',
        subject: id,
        companyId,
        payload: { companyId, releaseFourEyes: after.releaseFourEyes, previousRule: ownBefore.releaseFourEyes, customersAdded: added, customersRemoved: removed, loosened: now.some((code) => code !== 'PLACER_RELEASES') },
      })
    }
    if (fields.includes('placerMayRelease')) {
      tools.emit({ type: 'quality.hold_rule_changed', subject: id, companyId, payload: { companyId, placerMayRelease: after.placerMayRelease, previous: ownBefore.placerMayRelease, loosened: now.includes('PLACER_RELEASES') } })
    }
    return { id }
  })
  return { rules: await caller.withClient((db) => viewOf(db, context, companyId, company)), loosened: loosened as Loosening[] }
}

export interface SaveResultsBody {
  readonly companyId?: string | null | undefined
  readonly version: number
  readonly stopAtRejectNumber: boolean | null
  readonly benchUndoSeconds: number | null
}

/** PUT /quality/rules/results */
export async function saveResults(caller: CommandCaller, body: SaveResultsBody, idempotencyKey?: string) {
  const companyId = body.companyId ?? null
  const context = assertMayChange(caller, companyId)
  const company = companyId === null ? null : await assertCompany(caller, companyId)
  const problem = benchUndoProblem(body.benchUndoSeconds)
  if (problem) throw new ValidationError(problem.message, [{ ...problem, path: `body/${problem.path}` }])
  const after: ResultsRow = { stopAtRejectNumber: body.stopAtRejectNumber, benchUndoSeconds: body.benchUndoSeconds }
  const { result } = await command(caller, { name: 'quality.rules.saveResults', idempotencyKey, input: body }, async (tools) => {
    const { id, exists, rows } = await lockRow(tools, context, companyId, body.version)
    const before = resultsOf(companyId === null ? rows.tenant : rows.company) ?? { stopAtRejectNumber: null, benchUndoSeconds: null }
    const changed = resultsChanged(before, after)
    if (changed.length === 0) {
      tools.audit({ action: 'quality.rules.unchanged', recordType: 'QualitySettings', recordId: id, companyId, after: { card: 'RESULTS' } })
      return { changed }
    }
    await writeRow(tools, context, companyId, id, exists, { stopAtRejectNumber: after.stopAtRejectNumber, benchUndoSeconds: after.benchUndoSeconds })
    tools.audit({ recordType: 'QualitySettings', recordId: id, companyId, before: { ...before }, after: { ...after } })
    tools.emit({ type: 'quality.rules_changed', subject: id, companyId, payload: { companyId, card: 'RESULTS', fields: changed, loosened: [] } })
    return { changed }
  })
  return { rules: await caller.withClient((db) => viewOf(db, context, companyId, company)), changed: result.changed }
}
