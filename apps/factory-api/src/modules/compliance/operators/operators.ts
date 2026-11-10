import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { operatorProblems, overlapOf, overlapWords, resolveOperators, scopeLevelOf, validOn, type OperatorRole, type OperatorRow, type ResolvedOperator } from '@nexus/factory-domain/compliance/operators/rules'
import { RULES_MANAGE } from '@nexus/factory-domain/compliance/register-of-rules/permissions'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, companyReach, mayReadCompany, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import type { OperatorView } from './contract'

/**
 * Economic operators per style and market (B-W2b-249; PRD-298; PPE Reg. (EU) 2016/425 arts. 8(6), 10(3); GPSR art. 9):
 * the manufacturer, authorised representative, importer, distributor or fulfilment provider of a style, a brand's
 * private-label styles, a company's styles or every style, for a market or every market, with what is printed. The most
 * specific row wins (factory-domain compliance/operators resolveOperators; Owner 11-09 question 3: a brand style sold
 * under the brand's name has the brand as manufacturer). One row per scope, market and role on a day: refused here, under
 * the tenant's advisory lock `factory.economic-operators`, before the write (the database cannot hold it).
 *
 * Reading needs compliance.certificates.view (the rows of the companies a person's grants reach and every company's);
 * keeping a row needs compliance.rules.manage over its company (a row of every company: over every company). A row's
 * scope, role and market never change (a new scope is a new row); a row ends by its last day, never removed.
 */

export const OPERATOR_SELECT = {
  id: true,
  companyId: true,
  styleId: true,
  brandPartyId: true,
  marketCode: true,
  role: true,
  partyId: true,
  printedName: true,
  printedAddress: true,
  contact: true,
  validFrom: true,
  validTo: true,
  note: true,
  version: true,
  updatedAt: true,
  style: { select: { id: true, code: true, name: true } },
  brandParty: { select: { id: true, code: true, legalName: true, tradeName: true } },
  party: { select: { id: true, code: true, legalName: true, tradeName: true } },
} as const satisfies Prisma.EconomicOperatorRoleSelect
type Row = Prisma.EconomicOperatorRoleGetPayload<{ select: typeof OPERATOR_SELECT }>

const WHAT = 'An economic operator'
const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const dateOf = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const partyName = (party: { tradeName: string | null; legalName: string }) => party.tradeName ?? party.legalName

export const rowFacts = (row: Omit<Row, 'style' | 'brandParty' | 'party' | 'note' | 'version' | 'updatedAt'>): OperatorRow => ({
  id: row.id,
  companyId: row.companyId,
  styleId: row.styleId,
  brandPartyId: row.brandPartyId,
  marketCode: row.marketCode,
  role: row.role as OperatorRole,
  partyId: row.partyId,
  printedName: row.printedName,
  printedAddress: row.printedAddress,
  contact: row.contact,
  validFrom: day(row.validFrom),
  validTo: row.validTo ? day(row.validTo) : null,
})

export const viewOf = (row: Row, on: BusinessDate): OperatorView => {
  const facts = rowFacts(row)
  return {
    id: row.id,
    role: facts.role,
    level: scopeLevelOf(row),
    companyId: row.companyId,
    style: row.style,
    brand: row.brandParty ? { id: row.brandParty.id, code: row.brandParty.code, name: partyName(row.brandParty) } : null,
    marketCode: row.marketCode,
    party: row.party ? { id: row.party.id, code: row.party.code, name: partyName(row.party) } : null,
    printedName: row.printedName,
    printedAddress: row.printedAddress,
    contact: row.contact,
    validFrom: facts.validFrom,
    validTo: facts.validTo,
    validOnDay: validOn(facts, on),
    note: row.note,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const today = (): BusinessDate => businessDate(rulesClock().now())

/** GET /compliance/rules/operators */
export async function listOperators(
  request: FastifyRequest,
  query: { readonly styleId?: string | undefined; readonly brandPartyId?: string | undefined; readonly marketCode?: string | undefined; readonly role?: OperatorRole | undefined; readonly on?: BusinessDate | undefined; readonly current?: 'true' | 'false' | undefined },
) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const on = query.on ?? today()
  const filters: Prisma.EconomicOperatorRoleWhereInput[] = [companyReach(actor) as Prisma.EconomicOperatorRoleWhereInput]
  if (query.styleId) filters.push({ styleId: query.styleId })
  if (query.brandPartyId) filters.push({ brandPartyId: query.brandPartyId })
  if (query.marketCode) filters.push({ marketCode: query.marketCode })
  if (query.role) filters.push({ role: query.role })
  const rows = await request.withClient((db) => db.economicOperatorRole.findMany({ where: { AND: filters }, select: OPERATOR_SELECT, orderBy: [{ role: 'asc' }, { marketCode: 'asc' }, { validFrom: 'desc' }, { id: 'asc' }] }))
  const views = rows.map((row) => viewOf(row, on)).filter((view) => query.current !== 'true' || view.validOnDay)
  return { operators: views, day: on, asOf: toUtcIso(rulesClock().now()), mayManage: mayWrite(actor, RULES_MANAGE, null) }
}

async function readOperator(db: Reader, context: OfficeContext, operatorId: string): Promise<Row> {
  const row = await db.economicOperatorRole.findUnique({ where: { id: operatorId }, select: OPERATOR_SELECT })
  if (!row || !mayReadCompany(actorOf(context), row.companyId)) throw new NotFoundError('There is no such economic operator.')
  return row
}

/** GET /compliance/rules/operators/:operatorId */
export async function getOperator(request: FastifyRequest, operatorId: string) {
  const context = officeOf(request)
  return { operator: viewOf(await request.withClient((db) => readOperator(db, context, operatorId)), today()) }
}

export interface StyleTarget {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly brandPartyId: string | null
  readonly soldUnderOurName: boolean
}

/**
 * The operators that apply to a style in a market on a day (every row of the tenant the session sees: the public DoC page
 * reads it in the tenant's system scope), with the rows' views. `companyId`: the company that makes it.
 */
export async function operatorsFor(db: Reader, style: StyleTarget, input: { readonly marketCode: string | null; readonly day: BusinessDate; readonly companyId?: string | null | undefined }): Promise<{ resolved: ResolvedOperator[]; rows: Map<string, Row> }> {
  const companyId = input.companyId ?? style.companyId
  const rows = await db.economicOperatorRole.findMany({
    where: {
      AND: [
        { OR: [{ styleId: style.id }, ...(style.brandPartyId ? [{ brandPartyId: style.brandPartyId }] : []), { styleId: null, brandPartyId: null }] },
        { OR: [{ marketCode: null }, ...(input.marketCode ? [{ marketCode: input.marketCode }] : [])] },
      ],
    },
    select: OPERATOR_SELECT,
  })
  const resolved = resolveOperators(rows.map(rowFacts), { styleId: style.id, companyId, brandPartyId: style.brandPartyId, soldUnderOurName: style.soldUnderOurName, marketCode: input.marketCode, day: input.day })
  return { resolved, rows: new Map(rows.map((row) => [row.id, row])) }
}

/** GET /compliance/rules/operators/resolve?styleId&marketCode&on&companyId */
export async function resolveForStyle(request: FastifyRequest, query: { readonly styleId: string; readonly marketCode?: string | undefined; readonly on?: BusinessDate | undefined; readonly companyId?: string | undefined }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const on = query.on ?? today()
  return request.withClient(async (db) => {
    const style = await db.style.findUnique({ where: { id: query.styleId }, select: { id: true, code: true, name: true, companyId: true, brandPartyId: true, soldUnderOurName: true } })
    if (!style || !mayReadCompany(actor, style.companyId)) throw new NotFoundError('There is no such style.')
    const market = query.marketCode ? await db.marketProfile.findFirst({ where: { code: query.marketCode }, select: { code: true, importerNeeded: true, gpsrContactNeeded: true, companyId: true } }) : null
    if (query.marketCode && (!market || !mayReadCompany(actor, market.companyId))) throw new NotFoundError(`There is no market ${query.marketCode}.`)
    const { resolved, rows } = await operatorsFor(db, style, { marketCode: query.marketCode ?? null, day: on, companyId: query.companyId ?? null })
    const shown = resolved.filter((entry) => mayReadCompany(actor, entry.row.companyId))
    const has = (role: OperatorRole) => shown.some((entry) => entry.role === role)
    const needs: { role: 'MANUFACTURER' | 'IMPORTER_OR_REPRESENTATIVE' | 'GPSR_CONTACT'; met: boolean }[] = [{ role: 'MANUFACTURER', met: has('MANUFACTURER') }]
    if (market?.importerNeeded) needs.push({ role: 'IMPORTER_OR_REPRESENTATIVE', met: has('IMPORTER') || has('AUTHORISED_REPRESENTATIVE') })
    if (market?.gpsrContactNeeded) needs.push({ role: 'GPSR_CONTACT', met: shown.some((entry) => entry.row.contact !== null) })
    return {
      style,
      marketCode: query.marketCode ?? null,
      day: on,
      operators: shown.map((entry) => ({ role: entry.role, level: entry.level, forMarket: entry.forMarket, operator: viewOf(rows.get(entry.row.id)!, on) })),
      needs,
    }
  })
}

const auditOf = (row: OperatorRow) => ({ ...row })

function changed(tools: CommandTools, row: OperatorRow, change: 'CREATED' | 'EDITED'): void {
  tools.emit({ type: 'compliance_rules.operator_changed', subject: row.id, companyId: row.companyId, payload: { operatorId: row.id, role: row.role, styleId: row.styleId, brandPartyId: row.brandPartyId, marketCode: row.marketCode, change } })
}

/** Inside a command: the tenant's operator lock, then the overlap check against every row of the same scope. */
async function refuseOverlap(tools: CommandTools, candidate: OperatorRow, where: string): Promise<void> {
  const { tx, context } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.economic-operators', ${(context as OfficeContext).tenantId}::uuid), 0))`
  const rows = await tx.economicOperatorRole.findMany({
    where: { role: candidate.role, styleId: candidate.styleId, brandPartyId: candidate.brandPartyId, companyId: candidate.companyId, marketCode: candidate.marketCode },
    select: OPERATOR_SELECT,
  })
  const other = overlapOf(candidate, rows.map(rowFacts))
  if (other) throw new ConflictError(overlapWords(other, where))
}

function check(problems: ReturnType<typeof operatorProblems>): void {
  if (problems.length > 0) throw new ValidationError('The economic operator is not valid.', problems)
}

export interface CreateBody {
  readonly role: OperatorRole
  readonly styleId?: string | null | undefined
  readonly brandPartyId?: string | null | undefined
  readonly companyId?: string | null | undefined
  readonly marketCode?: string | null | undefined
  readonly partyId?: string | null | undefined
  readonly printedName: string
  readonly printedAddress: string
  readonly contact?: string | null | undefined
  readonly validFrom: BusinessDate
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** POST /compliance/rules/operators */
export async function createOperator(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ operator: OperatorView }> {
  const context = officeOf(caller)
  check(operatorProblems(body, true))
  // The row's company: a style's row is the style's company's (the database's rule); otherwise as given.
  const scope = await caller.withClient(async (db) => {
    if (body.styleId) {
      const style = await db.style.findUnique({ where: { id: body.styleId }, select: { code: true, companyId: true } })
      if (!style || !mayReadCompany(actorOf(context), style.companyId)) throw new NotFoundError('There is no such style.')
      return { companyId: style.companyId, where: `Style ${style.code}` }
    }
    if (body.brandPartyId) {
      const brand = await db.party.findUnique({ where: { id: body.brandPartyId }, select: { code: true, legalName: true, tradeName: true, roles: true } })
      if (!brand) throw new NotFoundError('There is no such brand.')
      if (!brand.roles.includes('BRAND')) throw new ValidationError('The economic operator is not valid.', [{ path: 'body/brandPartyId', message: `${partyName(brand)} is not a brand (give the party the BRAND role first).` }])
      return { companyId: body.companyId ?? null, where: `Brand ${partyName(brand)}` }
    }
    return { companyId: body.companyId ?? null, where: body.companyId ? 'The company' : 'Every style' }
  })
  assertMayKeep(context, RULES_MANAGE, scope.companyId, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.createOperator', idempotencyKey: key, input: body },
      async (tools) => {
        const { tx, now, audit } = tools
        if (body.marketCode && !(await tx.marketProfile.findFirst({ where: { code: body.marketCode }, select: { id: true } }))) {
          throw new ValidationError('The economic operator is not valid.', [{ path: 'body/marketCode', message: `There is no market ${body.marketCode} (add it under Markets first).` }])
        }
        if (body.partyId && !(await tx.party.findUnique({ where: { id: body.partyId }, select: { id: true } }))) throw new NotFoundError('There is no such party.')
        if (scope.companyId && !(await tx.company.findUnique({ where: { id: scope.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
        const id = newId()
        const candidate: OperatorRow = {
          id,
          companyId: scope.companyId,
          styleId: body.styleId ?? null,
          brandPartyId: body.brandPartyId ?? null,
          marketCode: body.marketCode ?? null,
          role: body.role,
          partyId: body.partyId ?? null,
          printedName: body.printedName,
          printedAddress: body.printedAddress,
          contact: body.contact ?? null,
          validFrom: body.validFrom,
          validTo: body.validTo ?? null,
        }
        await refuseOverlap(tools, candidate, scope.where)
        const row = await tx.economicOperatorRole.create({
          data: { ...candidate, validFrom: dateOf(candidate.validFrom), validTo: candidate.validTo ? dateOf(candidate.validTo) : null, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: OPERATOR_SELECT,
        })
        audit({ recordType: 'EconomicOperatorRole', recordId: id, companyId: row.companyId, after: auditOf(candidate) })
        changed(tools, candidate, 'CREATED')
        return { operator: viewOf(row, businessDate(now)) }
      },
      settings(),
    ),
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly partyId?: string | null | undefined
  readonly printedName?: string | undefined
  readonly printedAddress?: string | undefined
  readonly contact?: string | null | undefined
  readonly validFrom?: BusinessDate | undefined
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/rules/operators/:operatorId */
export async function editOperator(caller: CommandCaller, operatorId: string, body: EditBody, key: string | null | undefined): Promise<{ operator: OperatorView }> {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readOperator(db, context, operatorId))
  assertMayKeep(context, RULES_MANAGE, known.companyId, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.editOperator', idempotencyKey: key, input: { operatorId, ...body }, record: { type: 'EconomicOperatorRole', id: operatorId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = rowFacts(await tx.economicOperatorRole.findUniqueOrThrow({ where: { id: operatorId }, select: OPERATOR_SELECT }))
        const next: OperatorRow = {
          ...before,
          partyId: body.partyId !== undefined ? body.partyId : before.partyId,
          printedName: body.printedName ?? before.printedName,
          printedAddress: body.printedAddress ?? before.printedAddress,
          contact: body.contact !== undefined ? body.contact : before.contact,
          validFrom: body.validFrom ?? before.validFrom,
          validTo: body.validTo !== undefined ? body.validTo : before.validTo,
        }
        check(operatorProblems({ ...next, note: body.note }, true))
        if (next.partyId && next.partyId !== before.partyId && !(await tx.party.findUnique({ where: { id: next.partyId }, select: { id: true } }))) throw new NotFoundError('There is no such party.')
        if (next.validFrom !== before.validFrom || next.validTo !== before.validTo) {
          const where = known.style ? `Style ${known.style.code}` : known.brandParty ? `Brand ${partyName(known.brandParty)}` : known.companyId ? 'The company' : 'Every style'
          await refuseOverlap(tools, next, where)
        }
        const row = await tx.economicOperatorRole.update({
          where: { id: operatorId },
          data: {
            partyId: next.partyId,
            printedName: next.printedName,
            printedAddress: next.printedAddress,
            contact: next.contact,
            validFrom: dateOf(next.validFrom),
            validTo: next.validTo ? dateOf(next.validTo) : null,
            ...(body.note !== undefined ? { note: body.note } : {}),
            updatedAt: now,
          },
          select: OPERATOR_SELECT,
        })
        audit({ recordType: 'EconomicOperatorRole', recordId: operatorId, companyId: row.companyId, before: auditOf(before), after: auditOf(next) })
        changed(tools, next, 'EDITED')
        return { operator: viewOf(row, businessDate(now)) }
      },
      settings(),
    ),
  )
  return result
}
