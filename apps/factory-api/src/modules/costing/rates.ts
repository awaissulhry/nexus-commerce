import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { ArchiveRateBody, CostingSettingsView, CreateRateBody, LabourRateView, ListRatesQuery, SaveSettingsBody, SettingsListView, SettingsQuery, UpdateRateBody } from '@nexus/factory-domain/costing/contracts'
import { pickOverhead, pickRate } from '@nexus/factory-domain/costing/inputs'
import { COSTING_RATES_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { labourRateMachine, overheadProblems, rateProblems } from '@nexus/factory-domain/costing/rates'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { contextOf, mayWrite } from '../product/materials/store'
import { companyOrTenant, dayOf, ownOverheadRows, RATE_COLUMNS, rateOf, SETTINGS_COLUMNS, type RateRow, type SettingsRow } from './inputs'

/**
 * The labour rates and the costing settings (B-W1-16; features FIN-004, FIN-005; the Cost tab's "Costing parameters"):
 * the cost of one standard minute per kind of work centre, tenant-wide or per company, from a day; and the overhead
 * percentage. Reads need costing.view (figures only with the cost grain: the grain filter drops them); writes need
 * costing.rates.manage over the row's company (a tenant-wide row: a grant over every company), and a rate's figure the
 * cost grain to send it (the grain filter refuses the body otherwise). Every write goes through command() with its
 * audit row (the cost marked with its grain) and its event. A rate is corrected or archived, never deleted; a new
 * figure from a later day is a new rate.
 */

const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
const invalid = (issues: readonly Issue[], what = 'labour rate'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const RATE_SCOPE = { company: { field: 'companyId', nullable: true } } as const
const text = (value: { toString(): string }): string => decimalText(value.toString())
const today = (): string => businessDate(serverClock.now())
/** The caller's tenant (every route here is the office's; the manifest refuses the others). */
const tenantOf = (context: RequestContext): string => {
  if (!('tenantId' in context)) throw new ForbiddenError()
  return context.tenantId
}
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

function assertMayManage(context: RequestContext, companyId: string | null, permission: Permission = COSTING_RATES_MANAGE): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A tenant-wide rate or setting is changed only by a role over every company.' : undefined)
  }
}

/** A company the caller may see (costing.view), or 404. */
async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

// ---- rate views ---------------------------------------------------------------------------------------------------------

/** A rate as answered; `inForce` against the other rates of its kind for its company (and the tenant-wide ones). */
function rateView(row: RateRow, peers: readonly RateRow[], on: string): LabourRateView {
  const inForce = pickRate(peers.map(rateOf), row.workCentreKind, row.companyId, on)?.id === row.id
  return {
    id: row.id,
    companyId: row.companyId,
    workCentreKind: row.workCentreKind,
    costPerMinute: asMoney('cost', text(row.costPerMinute)),
    currency: row.currency,
    plannedEfficiencyPct: text(row.plannedEfficiencyPct),
    validFrom: dayOf(row.validFrom),
    note: row.note,
    status: row.status,
    inForce,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

async function rateViewIn(client: FactoryClient | CommandTx, rateId: string, on: string): Promise<LabourRateView> {
  const row = await client.labourRate.findUniqueOrThrow({ where: { id: rateId }, select: RATE_COLUMNS })
  const peers = await client.labourRate.findMany({ where: { AND: [companyOrTenant(row.companyId), { workCentreKind: row.workCentreKind }] }, select: RATE_COLUMNS })
  return rateView(row, peers, on)
}

const kindOrder = (kind: RateRow['workCentreKind']): number => WORK_CENTRE_KINDS.indexOf(kind)

/** The rates: a company's own and the tenant-wide ones, or every one the caller sees; by kind, tenant-wide first, newest day first. */
export async function listRates(caller: CommandCaller, query: ListRatesQuery): Promise<{ rates: LabourRateView[] }> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const on = today()
  return caller.withClient(async (client) => {
    const scope = query.companyId === undefined ? (scopeWhere(actorOf(context), COSTING_VIEW, RATE_SCOPE) as Prisma.LabourRateWhereInput) : companyOrTenant(query.companyId)
    const rows = await client.labourRate.findMany({ where: { AND: [scope, query.kind ? { workCentreKind: query.kind } : {}] }, select: RATE_COLUMNS })
    const shown = rows.filter((row) => query.status === 'ALL' || row.status === query.status)
    shown.sort(
      (a, b) =>
        kindOrder(a.workCentreKind) - kindOrder(b.workCentreKind) ||
        Number(a.companyId !== null) - Number(b.companyId !== null) ||
        (a.companyId ?? '').localeCompare(b.companyId ?? '') ||
        b.validFrom.getTime() - a.validFrom.getTime(),
    )
    return { rates: shown.map((row) => rateView(row, rows.filter((peer) => peer.companyId === null || peer.companyId === row.companyId), on)) }
  })
}

async function readRate(caller: CommandCaller, rateId: string): Promise<RateRow> {
  const context = contextOf(caller)
  const row = isUuid(rateId) ? await caller.withClient((client) => client.labourRate.findUnique({ where: { id: rateId }, select: RATE_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Labour rate not found.')
  return row
}

const taken = (kind: string, day: string) => new ConflictError(`A ${kind} rate from ${day} exists already for this company (or tenant-wide): correct it, or choose another first day.`)

async function assertDayFree(tx: CommandTx, row: { companyId: string | null; workCentreKind: RateRow['workCentreKind']; validFrom: string }, except?: string): Promise<void> {
  const clash = await tx.labourRate.findFirst({
    where: { companyId: row.companyId, workCentreKind: row.workCentreKind, validFrom: dateOf(row.validFrom), ...(except ? { id: { not: except } } : {}) },
    select: { id: true },
  })
  if (clash) throw taken(row.workCentreKind, row.validFrom)
}

/** costing.createRate: a new cost per minute for a kind of work centre, tenant-wide or for a company, from a day. */
export async function createRate(caller: CommandCaller, body: CreateRateBody, idempotencyKey?: string): Promise<LabourRateView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayManage(context, companyId)
  if (body.costPerMinute === undefined) throw invalid([{ path: 'body/costPerMinute', message: 'Send the cost of one standard minute.' }])
  const rate = {
    costPerMinute: decimalText(body.costPerMinute),
    currency: body.currency ?? 'EUR',
    plannedEfficiencyPct: body.plannedEfficiencyPct === undefined ? '100' : decimalText(body.plannedEfficiencyPct),
    validFrom: body.validFrom,
  }
  const problems = rateProblems(rate)
  if (problems.length > 0) throw invalid(prefixed(problems))
  const note = body.note ?? null

  const { result } = await command(caller, { name: 'costing.createRate', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    await assertDayFree(tx, { companyId, workCentreKind: body.workCentreKind, validFrom: rate.validFrom })
    const id = newId()
    await tx.labourRate.create({
      data: { id, companyId, workCentreKind: body.workCentreKind, ...rate, validFrom: dateOf(rate.validFrom), note, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    tools.audit({
      recordType: 'LabourRate',
      recordId: id,
      companyId,
      after: { companyId, workCentreKind: body.workCentreKind, costPerMinute: markMoney('cost', rate.costPerMinute), currency: rate.currency, plannedEfficiencyPct: rate.plannedEfficiencyPct, validFrom: rate.validFrom, note, status: 'ACTIVE' },
    })
    tools.emit({ type: 'labour_rate.created', subject: id, companyId, payload: { rateId: id, workCentreKind: body.workCentreKind, validFrom: rate.validFrom } })
    return rateViewIn(tx, id, businessDate(now))
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw taken(body.workCentreKind, rate.validFrom)
    throw error
  })
  return result
}

const RATE_FIELDS = ['costPerMinute', 'currency', 'plannedEfficiencyPct', 'validFrom', 'note'] as const
type RateField = (typeof RATE_FIELDS)[number]

/** costing.updateRate: a correction of an ACTIVE rate (versioned); only the fields sent change. */
export async function updateRate(caller: CommandCaller, rateId: string, body: UpdateRateBody, idempotencyKey?: string): Promise<LabourRateView> {
  const context = contextOf(caller)
  const seen = await readRate(caller, rateId)
  assertMayManage(context, seen.companyId)
  if (seen.status !== 'ACTIVE') throw new InvalidStateError('This rate is archived: add a new rate instead.')
  const sent: Partial<Record<RateField, string | null>> = {
    ...(body.costPerMinute === undefined ? {} : { costPerMinute: decimalText(body.costPerMinute) }),
    ...(body.currency === undefined ? {} : { currency: body.currency }),
    ...(body.plannedEfficiencyPct === undefined ? {} : { plannedEfficiencyPct: decimalText(body.plannedEfficiencyPct) }),
    ...(body.validFrom === undefined ? {} : { validFrom: body.validFrom }),
    ...(body.note === undefined ? {} : { note: body.note }),
  }
  const problems = rateProblems(sent as Partial<Record<Exclude<RateField, 'note'>, string>>)
  if (problems.length > 0) throw invalid(prefixed(problems))

  const { result } = await command(
    caller,
    { name: 'costing.updateRate', idempotencyKey, input: { rateId, ...body }, record: { type: 'LabourRate', id: rateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.labourRate.findUniqueOrThrow({ where: { id: rateId }, select: RATE_COLUMNS })
      if (row.status !== 'ACTIVE') throw new InvalidStateError('This rate is archived: add a new rate instead.')
      const current: Record<RateField, string | null> = {
        costPerMinute: text(row.costPerMinute),
        currency: row.currency,
        plannedEfficiencyPct: text(row.plannedEfficiencyPct),
        validFrom: dayOf(row.validFrom),
        note: row.note,
      }
      const changed = RATE_FIELDS.filter((field) => field in sent && sent[field] !== current[field])
      const next = { ...current, ...sent }
      if (changed.includes('validFrom')) await assertDayFree(tx, { companyId: row.companyId, workCentreKind: row.workCentreKind, validFrom: next.validFrom! }, rateId)
      if (changed.length > 0) {
        const data: Prisma.LabourRateUncheckedUpdateInput = Object.fromEntries(changed.map((field) => [field, field === 'validFrom' ? dateOf(next.validFrom!) : next[field]]))
        await tx.labourRate.update({ where: { id: rateId }, data: { ...data, updatedAt: now }, select: { id: true } })
      }
      const audited = (values: Record<RateField, string | null>) => Object.fromEntries(changed.map((field) => [field, field === 'costPerMinute' ? markMoney('cost', values[field]) : values[field]]))
      tools.audit({ recordType: 'LabourRate', recordId: rateId, companyId: row.companyId, before: audited(current), after: audited(next) })
      if (changed.length > 0) tools.emit({ type: 'labour_rate.updated', subject: rateId, companyId: row.companyId, payload: { rateId, workCentreKind: row.workCentreKind, fields: [...changed] } })
      return rateViewIn(tx, rateId, businessDate(now))
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw taken(seen.workCentreKind, body.validFrom ?? dayOf(seen.validFrom))
    throw error
  })
  return result
}

/** costing.archiveRate: cost sheets no longer use it (final: a new figure is a new rate). */
export async function archiveRate(caller: CommandCaller, rateId: string, body: ArchiveRateBody, idempotencyKey?: string): Promise<LabourRateView> {
  const context = contextOf(caller)
  const seen = await readRate(caller, rateId)
  assertMayManage(context, seen.companyId)
  const { result } = await command(
    caller,
    { name: 'costing.archiveRate', idempotencyKey, input: { rateId, ...body }, record: { type: 'LabourRate', id: rateId, expectedVersion: body.version, transition: { machine: labourRateMachine, to: 'ARCHIVED' } } },
    async (tools) => {
      tools.audit({ recordType: 'LabourRate', recordId: rateId, companyId: seen.companyId, before: { status: tools.record!.from }, after: { status: 'ARCHIVED' }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'labour_rate.status_changed', subject: rateId, companyId: seen.companyId, payload: { rateId, workCentreKind: seen.workCentreKind, status: 'ARCHIVED' } })
      return rateViewIn(tools.tx, rateId, businessDate(tools.now))
    },
  )
  return result
}

// ---- costing settings ---------------------------------------------------------------------------------------------------

const settingsView = (row: SettingsRow): CostingSettingsView => ({ id: row.id, companyId: row.companyId, overheadPct: text(row.overheadPct), overheadFromTenant: row.overheadFromTenant, version: row.version, updatedAt: toUtcIso(row.updatedAt) })

/** The tenant-wide settings, a company's when asked, and which of them a cost sheet for that company uses. */
export async function getSettings(caller: CommandCaller, query: SettingsQuery): Promise<SettingsListView> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const companyId = query.companyId ?? null
  return caller.withClient(async (client) => {
    const rows = await client.costingSettings.findMany({ where: companyOrTenant(companyId), select: SETTINGS_COLUMNS })
    // The tenant-wide row is keyed by the tenant's id; the company's by the company's.
    const tenant = rows.find((row) => row.companyId === null && row.id === tenantOf(context)) ?? null
    const company = companyId === null ? null : (rows.find((row) => row.companyId === companyId && row.id === companyId) ?? null)
    // B-W2b-22: a company row that holds only its costing method follows the tenant-wide overhead.
    const inForce = pickOverhead(ownOverheadRows([tenant, company].flatMap((row) => (row ? [row] : []))).map((row) => ({ id: row.id, companyId: row.companyId, overheadPct: text(row.overheadPct), updatedAt: null })), companyId)
    return { tenant: tenant && settingsView(tenant), company: company && settingsView(company), inForce: inForce?.id ?? null }
  })
}

/**
 * costing.saveSettings: a company's overhead (or the tenant-wide one). The row is keyed by the company's id (the
 * tenant's for the tenant-wide row): the first save creates it (no version), later ones send its version. B-W2b-22
 * (Z9:02): the costing method lives apart from the overhead — a company's row made for its method only follows the
 * tenant-wide overhead (overheadFromTenant); saving an overhead for the company makes it the company's own, and
 * `overheadFromTenant: true` (with 0) makes the company follow the tenant-wide overhead again. The method is untouched.
 */
export async function saveSettings(caller: CommandCaller, body: SaveSettingsBody, idempotencyKey?: string): Promise<CostingSettingsView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayManage(context, companyId)
  if (companyId !== null) await assertCompany(caller, companyId)
  const problems = overheadProblems(body.overheadPct)
  if (problems.length > 0) throw invalid(prefixed(problems), 'costing setting')
  const overheadPct = decimalText(body.overheadPct)
  const fromTenant = body.overheadFromTenant === true
  if (fromTenant && companyId === null) throw invalid([{ path: 'body/overheadFromTenant', message: 'The tenant-wide settings follow no other overhead: only a company follows the tenant-wide one.' }], 'costing setting')
  if (fromTenant && overheadPct !== '0') throw invalid([{ path: 'body/overheadPct', message: 'A company that follows the tenant-wide overhead keeps none of its own: send 0.' }], 'costing setting')
  const id = companyId ?? tenantOf(context)
  const existing = await caller.withClient((client) => client.costingSettings.findUnique({ where: { id }, select: SETTINGS_COLUMNS }))
  if (existing && body.version === undefined) throw new ConflictError('These costing settings exist: send their version to change them.')
  if (!existing && body.version !== undefined) throw new ConflictError('These costing settings do not exist yet: save them without a version.')

  const { result } = await command(
    caller,
    { name: 'costing.saveSettings', idempotencyKey, input: body, ...(existing ? { record: { type: 'CostingSettings', id, expectedVersion: body.version } } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const row = existing ? await tx.costingSettings.findUniqueOrThrow({ where: { id }, select: SETTINGS_COLUMNS }) : null
      const before = row === null ? null : text(row.overheadPct)
      const fields = [...(before !== overheadPct ? ['overheadPct'] : []), ...(row !== null && row.overheadFromTenant !== fromTenant ? ['overheadFromTenant'] : [])]
      if (row === null) {
        await tx.costingSettings.create({ data: { id, companyId, overheadPct, overheadFromTenant: fromTenant, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
      } else if (fields.length > 0) {
        await tx.costingSettings.update({ where: { id }, data: { overheadPct, overheadFromTenant: fromTenant, updatedAt: now }, select: { id: true } })
      }
      tools.audit({ recordType: 'CostingSettings', recordId: id, companyId, ...(row === null ? {} : { before: { overheadPct: before, overheadFromTenant: row.overheadFromTenant } }), after: { companyId, overheadPct, overheadFromTenant: fromTenant } })
      if (row === null || fields.length > 0) tools.emit({ type: 'costing_settings.changed', subject: id, companyId, payload: { settingsId: id, fields: row === null ? ['overheadPct', ...(fromTenant ? ['overheadFromTenant'] : [])] : fields } })
      return settingsView(await tx.costingSettings.findUniqueOrThrow({ where: { id }, select: SETTINGS_COLUMNS }))
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('These costing settings were just saved by someone else: reload them.')
    throw error
  })
  return result
}
