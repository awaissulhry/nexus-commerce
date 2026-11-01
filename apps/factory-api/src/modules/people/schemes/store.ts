import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_PIECERATES_MANAGE, PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import {
  activationPlan,
  affectedPeriods,
  deleteRefusal,
  editRefusal,
  endRefusal,
  KIND_WORDS,
  periodsInWords,
  rulesInWords,
  schemeFor,
  schemeStateOf,
  type GuaranteedBasis,
  type IncentiveKind,
  type OwnFaultPay,
  type PaidTimeRate,
  type PeriodRow,
  type PeriodStatus,
  type SchemeRefusal,
  type SchemeRow,
  type SchemeStatus,
  type TeamSplit,
} from '@nexus/factory-domain/people/schemes/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, seesPay } from './access'
import type { SchemeDetail } from './contract'

/**
 * The reads of incentive schemes (B-W2b-38; design people.piecerates "Scheme"). Office only, within the caller's grants
 * (people.piecerates.view on the scheme's company, and on its site for a line's scheme). A company's scheme applies at
 * every site of the company, so keeping one (people.piecerates.manage) needs a grant that reaches each of them. Every
 * guaranteed rate is returned as `money.pay`; the grain filter drops it for a caller without the pay grain, and
 * `payShown` says so. No person is named here.
 */

export type Db = CommandTx

export const day = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
export const dateOf = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const todayOf = (now: Date): BusinessDate => businessDate(now)
const decimalOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed())

export const SCHEME_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  lineId: true,
  name: true,
  kind: true,
  efficiencyThresholdPct: true,
  guaranteedBasis: true,
  guaranteedHourlyRate: true,
  traineeHourlyRate: true,
  teamSplit: true,
  reworkOwnFault: true,
  scrapOwnFault: true,
  ownFaultRatePct: true,
  othersFaultPay: true,
  waitingPay: true,
  payOnlyWhileClockedIn: true,
  currency: true,
  validFrom: true,
  validTo: true,
  status: true,
  activatedAt: true,
  activatedById: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.IncentiveSchemeSelect
export type SchemeRecord = Prisma.IncentiveSchemeGetPayload<{ select: typeof SCHEME_SELECT }>

/** A scheme row as the domain rules read it. */
export const schemeRowOf = (row: SchemeRecord): SchemeRow => ({
  id: row.id,
  name: row.name,
  companyId: row.companyId,
  lineId: row.lineId,
  kind: row.kind as IncentiveKind,
  efficiencyThresholdPct: decimalOrNull(row.efficiencyThresholdPct),
  guaranteedBasis: row.guaranteedBasis as GuaranteedBasis,
  guaranteedHourlyRate: decimalOrNull(row.guaranteedHourlyRate),
  traineeHourlyRate: decimalOrNull(row.traineeHourlyRate),
  teamSplit: row.teamSplit as TeamSplit | null,
  reworkOwnFault: row.reworkOwnFault as OwnFaultPay,
  scrapOwnFault: row.scrapOwnFault as OwnFaultPay,
  ownFaultRatePct: decimalOrNull(row.ownFaultRatePct),
  othersFaultPay: row.othersFaultPay as PaidTimeRate,
  waitingPay: row.waitingPay as PaidTimeRate,
  payOnlyWhileClockedIn: row.payOnlyWhileClockedIn,
  currency: row.currency,
  validFrom: day(row.validFrom)!,
  validTo: day(row.validTo),
  status: row.status as SchemeStatus,
})

const VIEW_COLUMNS = { company: 'companyId', site: { field: 'siteId', nullable: true } } as const

const mayView = (context: OfficeContext, row: { companyId: string; siteId: string | null }): boolean =>
  can(actorOf(context), PEOPLE_PIECERATES_VIEW, row.siteId ? { companyId: row.companyId, siteId: row.siteId } : { companyId: row.companyId })

/**
 * The caller may do `permission` on a scheme: a line's at its company and site; a company's at the company and at every
 * one of its sites (a company's scheme pays at all of them).
 */
export async function mayOn(db: Db, context: OfficeContext, permission: Permission, row: { companyId: string; siteId: string | null }): Promise<boolean> {
  const actor = actorOf(context)
  if (row.siteId) return can(actor, permission, { companyId: row.companyId, siteId: row.siteId })
  if (!can(actor, permission, { companyId: row.companyId })) return false
  const sites = await db.site.findMany({ where: { companyId: row.companyId }, select: { id: true } })
  return sites.every((site) => can(actor, permission, { companyId: row.companyId, siteId: site.id }))
}

/** The scheme, when the caller may see it (else 404) and do `permission` on it (else 403). */
export async function schemeOf(caller: CommandCaller, schemeId: string, permission: Permission): Promise<{ context: OfficeContext; scheme: SchemeRecord }> {
  const context = officeOf(caller)
  const found = isUuid(schemeId)
    ? await caller.withClient(async (client) => {
        const scheme = await client.incentiveScheme.findUnique({ where: { id: schemeId }, select: SCHEME_SELECT })
        if (!scheme || !mayView(context, scheme)) return null
        return { scheme, allowed: permission === PEOPLE_PIECERATES_VIEW || (await mayOn(client, context, permission, scheme)) }
      })
    : null
  if (!found) throw new NotFoundError('Incentive scheme not found.')
  if (!found.allowed) throw new ForbiddenError()
  return { context, scheme: found.scheme }
}

/** The company (and the line, of one of its sites) a new scheme is for: 404 when the caller cannot see them, 403 without `permission`. */
export async function ownerOf(caller: CommandCaller, companyId: string, lineId: string | null, permission: Permission): Promise<{ context: OfficeContext; companyId: string; siteId: string | null; lineId: string | null }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { id: true } })
    if (!company) return null
    if (lineId === null) return mayView(context, { companyId, siteId: null }) ? { siteId: null, allowed: await mayOn(client, context, permission, { companyId, siteId: null }) } : null
    const line = await client.line.findUnique({ where: { id: lineId }, select: { id: true, siteId: true, status: true, site: { select: { companyId: true } } } })
    if (!line || line.site.companyId !== companyId || line.status !== 'ACTIVE' || !mayView(context, { companyId, siteId: line.siteId })) return null
    return { siteId: line.siteId, allowed: await mayOn(client, context, permission, { companyId, siteId: line.siteId }) }
  })
  if (!found) throw new NotFoundError(lineId === null ? 'Company not found.' : 'No such active line of this company.')
  if (!found.allowed) throw new ForbiddenError()
  return { context, companyId, siteId: found.siteId, lineId }
}

const names = async (db: Db, userIds: readonly (string | null)[]) => {
  const ids = [...new Set(userIds.filter((value): value is string => value !== null))]
  const rows = ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

const linesOf = async (db: Db, lineIds: readonly (string | null)[]) => {
  const ids = [...new Set(lineIds.filter((value): value is string => value !== null))]
  const rows = ids.length === 0 ? [] : await db.line.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

function summaryOf(row: SchemeRecord, line: { id: string; code: string; name: string } | null, today: BusinessDate) {
  const rules = schemeRowOf(row)
  const { state, words } = schemeStateOf(rules, today)
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    line,
    name: row.name,
    kind: rules.kind,
    kindWords: KIND_WORDS[rules.kind],
    status: rules.status,
    state,
    stateWords: words,
    validFrom: rules.validFrom,
    validTo: rules.validTo,
    guaranteedBasis: rules.guaranteedBasis,
    guaranteedHourlyRate: asMoney('pay', rules.guaranteedHourlyRate),
    teamSplit: rules.teamSplit,
    currency: row.currency,
    version: row.version,
  }
}

/** The company's pay periods, as the rules read them. */
export async function periodsOf(db: Db, companyId: string): Promise<PeriodRow[]> {
  const rows = await db.payPeriod.findMany({ where: { companyId }, select: { id: true, periodStart: true, periodEnd: true, status: true }, orderBy: { periodStart: 'asc' } })
  return rows.map((row) => ({ id: row.id, periodStart: day(row.periodStart)!, periodEnd: day(row.periodEnd)!, status: row.status as PeriodStatus }))
}

/** The other ACTIVE or RETIRED schemes of the same company and line (what a DRAFT follows). */
export const neighboursOf = (db: Db, scheme: Pick<SchemeRecord, 'id' | 'companyId' | 'lineId'>) =>
  db.incentiveScheme.findMany({ where: { companyId: scheme.companyId, lineId: scheme.lineId, id: { not: scheme.id }, status: { in: ['ACTIVE', 'RETIRED'] } }, select: SCHEME_SELECT, orderBy: { validFrom: 'asc' } })

/** The sites whose piece-pay switch names the scheme, with their state and name. */
export async function switchesNaming(db: Db, schemeId: string) {
  const rows = await db.piecePaySwitch.findMany({ where: { schemeId }, select: { siteId: true, state: true } })
  const sites = rows.length === 0 ? [] : await db.site.findMany({ where: { id: { in: rows.map((row) => row.siteId) } }, select: { id: true, code: true, name: true } })
  const byId = new Map(sites.map((site) => [site.id, site]))
  return rows
    .map((row) => ({ site: byId.get(row.siteId) ?? { id: row.siteId, code: '?', name: '?' }, state: row.state as 'OFF' | 'ON' }))
    .sort((a, b) => a.site.code.localeCompare(b.site.code))
}

const action = (refusal: SchemeRefusal | null) => ({ allowed: refusal === null, refusal })

/** One scheme's record: its rules, the periods it touches, the schemes beside it, the switches naming it, its actions. */
export async function schemeDetailOf(db: Db, context: OfficeContext, schemeId: string, now: Date): Promise<SchemeDetail> {
  const today = todayOf(now)
  const record = (await db.incentiveScheme.findUnique({ where: { id: schemeId }, select: SCHEME_SELECT }))!
  const scheme = schemeRowOf(record)
  const company = (await db.company.findUnique({ where: { id: record.companyId }, select: { id: true, code: true, legalName: true, tradeName: true } }))!
  const site = record.siteId ? await db.site.findUnique({ where: { id: record.siteId }, select: { id: true, code: true, name: true } }) : null
  const line = (await linesOf(db, [record.lineId])).get(record.lineId ?? '') ?? null
  const userNames = await names(db, [record.activatedById, record.createdById])
  const periods = await periodsOf(db, record.companyId)
  const others = await neighboursOf(db, record)
  const switches = await switchesNaming(db, record.id)
  const touched = affectedPeriods(periods, scheme.validFrom, scheme.validTo)
  const before = [...others].filter((other) => other.validFrom < record.validFrom).pop()
  const after = others.find((other) => other.validFrom > record.validFrom)
  const neighbour = (row: SchemeRecord | undefined) => (row ? { id: row.id, name: row.name, validFrom: day(row.validFrom)!, validTo: day(row.validTo), status: row.status as SchemeStatus } : null)
  const canManage = await mayOn(db, context, PEOPLE_PIECERATES_MANAGE, record)
  const onAt = switches.filter((row) => row.state === 'ON').map((row) => row.site.name)
  return {
    scheme: {
      ...summaryOf(record, line, today),
      efficiencyThresholdPct: scheme.efficiencyThresholdPct,
      traineeHourlyRate: asMoney('pay', scheme.traineeHourlyRate),
      reworkOwnFault: scheme.reworkOwnFault,
      scrapOwnFault: scheme.scrapOwnFault,
      ownFaultRatePct: scheme.ownFaultRatePct,
      othersFaultPay: scheme.othersFaultPay,
      waitingPay: scheme.waitingPay,
      payOnlyWhileClockedIn: scheme.payOnlyWhileClockedIn,
      note: record.note,
      activatedAt: record.activatedAt ? toUtcIso(record.activatedAt) : null,
      activatedByName: record.activatedById ? (userNames.get(record.activatedById) ?? null) : null,
      createdAt: toUtcIso(record.createdAt),
      createdByName: record.createdById ? (userNames.get(record.createdById) ?? null) : null,
    },
    company: { id: company.id, code: company.code, name: company.tradeName ?? company.legalName },
    site,
    rules: rulesInWords(scheme),
    periods: touched,
    periodWords: periodsInWords(scheme.validFrom, scheme.validTo, touched),
    follows: neighbour(before),
    followedBy: neighbour(after),
    switches,
    actions: {
      edit: action(editRefusal(scheme)),
      activate: action(activationPlan({ scheme, today, others: others.map(schemeRowOf), periods }).refusal),
      end: action(endRefusal({ scheme, lastDay: scheme.validFrom > today ? scheme.validFrom : today, today, onAt })),
      delete: action(deleteRefusal(scheme, switches.map((row) => row.site.name))),
    },
    payShown: seesPay(context),
    canManage,
  }
}

// ---- the routes' reads ------------------------------------------------------------------------------------------------

export async function schemes(caller: CommandCaller, query: { companyId?: string | undefined; lineId?: string | undefined; status?: SchemeStatus | undefined; includeEnded?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  const today = todayOf(serverClock.now())
  const where: Prisma.IncentiveSchemeWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PEOPLE_PIECERATES_VIEW, VIEW_COLUMNS) as Prisma.IncentiveSchemeWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.lineId ? { OR: [{ lineId: query.lineId }, { lineId: null }] } : {},
      query.status ? { status: query.status } : {},
      query.includeEnded === 'true' ? {} : { OR: [{ validTo: null }, { validTo: { gte: dateOf(today) } }, { status: 'DRAFT' }] },
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.incentiveScheme.findMany({ where, select: SCHEME_SELECT, orderBy: [{ companyId: 'asc' }, { lineId: { sort: 'asc', nulls: 'first' } }, { validFrom: 'desc' }, { id: 'asc' }], take: 500 })
    const lines = await linesOf(
      client,
      rows.map((row) => row.lineId),
    )
    const applies: { line: { id: string; code: string; name: string; siteId: string } | null; scheme: { id: string; name: string } | null; inherited: boolean }[] = []
    if (query.companyId && mayView(context, { companyId: query.companyId, siteId: null })) {
      const inForce = (await client.incentiveScheme.findMany({ where: { companyId: query.companyId, status: { in: ['ACTIVE', 'RETIRED'] } }, select: SCHEME_SELECT })).map((row) => ({ ...schemeRowOf(row), siteId: row.siteId }))
      const companyScheme = schemeFor(inForce, null, today)
      applies.push({ line: null, scheme: companyScheme ? { id: companyScheme.id, name: companyScheme.name } : null, inherited: false })
      const companyLines = await client.line.findMany({
        where: { status: 'ACTIVE', site: { companyId: query.companyId }, ...(query.lineId ? { id: query.lineId } : {}) },
        select: { id: true, code: true, name: true, siteId: true },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      })
      for (const line of companyLines) {
        if (!mayView(context, { companyId: query.companyId, siteId: line.siteId })) continue
        const applied = schemeFor(inForce, line.id, today)
        applies.push({ line, scheme: applied ? { id: applied.id, name: applied.name } : null, inherited: applied !== null && applied.lineId === null })
      }
    }
    return { today, payShown: seesPay(context), schemes: rows.map((row) => summaryOf(row, row.lineId ? (lines.get(row.lineId) ?? null) : null, today)), applies }
  })
}

export async function scheme(caller: CommandCaller, schemeId: string): Promise<SchemeDetail> {
  const { context, scheme: found } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_VIEW)
  return caller.withClient((client) => schemeDetailOf(client, context, found.id, serverClock.now()))
}
