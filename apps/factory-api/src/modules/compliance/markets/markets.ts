import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { languageMatrix, marketProblems, switchRefusal, type NationalRule } from '@nexus/factory-domain/compliance/markets/rules'
import { RULES_MANAGE } from '@nexus/factory-domain/compliance/register-of-rules/permissions'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, companyReach, mayReadCompany, namesFor, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import { phraseCoverage } from '../phrases/store'
import type { MarketView } from './contract'

/**
 * Market profiles (B-W2b-249; PRD-275; design compliance.settings › rm-markets): per destination, the languages of the
 * garment label, the DoC and the user information, the marks, national rules in words, whether an importer (or
 * authorised representative) and a GPSR contact are needed, and the switch — ON, or OFF with the reason (Owner 11-09:
 * open lines and markets stay OFF until needed; the seed's UK, CH and US wait for question Q23). One row per code in the
 * tenant (a company's own market is still the only one of its code); archived, never deleted.
 *
 * Reading needs compliance.certificates.view (the markets of the companies a person's grants reach and every company's);
 * keeping one needs compliance.rules.manage over its company (a market of every company: over every company). Each
 * write is ONE command on the market's version with its audit row and `compliance_rules.market_changed`.
 */

const MARKET_SELECT = {
  id: true,
  code: true,
  name: true,
  nameI18n: true,
  companyId: true,
  labelLanguages: true,
  docLanguages: true,
  userInfoLanguages: true,
  markings: true,
  nationalRules: true,
  importerNeeded: true,
  gpsrContactNeeded: true,
  seq: true,
  switchedOn: true,
  offReason: true,
  switchedAt: true,
  switchedById: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.MarketProfileSelect
type MarketRow = Prisma.MarketProfileGetPayload<{ select: typeof MARKET_SELECT }>

const WHAT = 'A market'
const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const textsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

function rulesOf(value: unknown): MarketView['nationalRules'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string')
    .map((entry) => ({ key: entry.key as string, words: textsOf(entry.words), law: typeof entry.law === 'string' ? entry.law : null, href: typeof entry.href === 'string' ? entry.href : null }))
}

async function viewsOf(db: Reader, rows: readonly MarketRow[]): Promise<MarketView[]> {
  const person = await namesFor(db, rows.map((row) => row.switchedById))
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    nameI18n: textsOf(row.nameI18n),
    companyId: row.companyId,
    labelLanguages: row.labelLanguages,
    docLanguages: row.docLanguages,
    userInfoLanguages: row.userInfoLanguages,
    markings: row.markings,
    nationalRules: rulesOf(row.nationalRules),
    importerNeeded: row.importerNeeded,
    gpsrContactNeeded: row.gpsrContactNeeded,
    seq: row.seq,
    switchedOn: row.switchedOn,
    offReason: row.offReason,
    switchedAt: row.switchedAt ? toUtcIso(row.switchedAt) : null,
    switchedBy: person(row.switchedById),
    note: row.note,
    status: row.status as MarketView['status'],
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }))
}

const ORDER = [{ seq: 'asc' }, { code: 'asc' }] as const satisfies Prisma.MarketProfileOrderByWithRelationInput[]

/** The ACTIVE markets a person may read, in their order (for the matrix and the phrase columns). */
export async function activeMarkets(db: Reader, context: OfficeContext): Promise<MarketRow[]> {
  return db.marketProfile.findMany({ where: { AND: [companyReach(actorOf(context)) as Prisma.MarketProfileWhereInput, { status: 'ACTIVE' }] }, select: MARKET_SELECT, orderBy: [...ORDER] })
}

/** GET /compliance/rules/markets */
export async function listMarkets(request: FastifyRequest, query: { readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const status = query.status ?? 'ACTIVE'
  return request.withClient(async (db) => {
    const rows = await db.marketProfile.findMany({
      where: { AND: [companyReach(actor) as Prisma.MarketProfileWhereInput, status === 'ALL' ? {} : { status }] },
      select: MARKET_SELECT,
      orderBy: [...ORDER],
    })
    return {
      markets: await viewsOf(db, rows),
      matrix: languageMatrix(rows.filter((row) => row.status === 'ACTIVE')),
      asOf: toUtcIso(rulesClock().now()),
      mayManage: mayWrite(actor, RULES_MANAGE, null),
    }
  })
}

/** GET /compliance/rules/markets/languages: the LanguageMatrix and, per language, how much of the phrase library prints in it. */
export async function marketLanguages(request: FastifyRequest) {
  const context = officeOf(request)
  return request.withClient(async (db) => {
    const rows = await activeMarkets(db, context)
    const matrix = languageMatrix(rows)
    const onLanguages = [...new Set(rows.filter((row) => row.switchedOn).flatMap((row) => [...row.labelLanguages, ...row.docLanguages, ...row.userInfoLanguages]))].sort()
    return { matrix, phrases: await phraseCoverage(db, context, onLanguages), asOf: toUtcIso(rulesClock().now()) }
  })
}

async function readMarket(db: Reader, context: OfficeContext, code: string): Promise<MarketRow> {
  const row = await db.marketProfile.findFirst({ where: { code }, select: MARKET_SELECT })
  if (!row || !mayReadCompany(actorOf(context), row.companyId)) throw new NotFoundError(`There is no market ${code}.`)
  return row
}

/** GET /compliance/rules/markets/:code */
export async function getMarket(request: FastifyRequest, code: string) {
  const context = officeOf(request)
  return request.withClient(async (db) => ({ market: (await viewsOf(db, [await readMarket(db, context, code)]))[0]! }))
}

function check(problems: ReturnType<typeof marketProblems>): void {
  if (problems.length > 0) throw new ValidationError('The market is not valid.', problems)
}

const auditOf = (row: MarketRow) => ({
  code: row.code,
  name: row.name,
  companyId: row.companyId,
  labelLanguages: row.labelLanguages,
  docLanguages: row.docLanguages,
  userInfoLanguages: row.userInfoLanguages,
  markings: row.markings,
  nationalRules: rulesOf(row.nationalRules).map((rule) => rule.key),
  importerNeeded: row.importerNeeded,
  gpsrContactNeeded: row.gpsrContactNeeded,
  seq: row.seq,
  switchedOn: row.switchedOn,
  status: row.status,
})

function changed(tools: CommandTools, row: MarketRow, change: 'CREATED' | 'EDITED' | 'SWITCHED' | 'ARCHIVED' | 'RESTORED'): void {
  tools.emit({ type: 'compliance_rules.market_changed', subject: row.id, companyId: row.companyId, payload: { marketId: row.id, code: row.code, change, switchedOn: row.switchedOn } })
}

export interface CreateBody {
  readonly code: string
  readonly companyId?: string | null | undefined
  readonly name: string
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly labelLanguages?: string[] | undefined
  readonly docLanguages?: string[] | undefined
  readonly userInfoLanguages?: string[] | undefined
  readonly markings?: string[] | undefined
  readonly nationalRules?: NationalRule[] | undefined
  readonly importerNeeded?: boolean | undefined
  readonly gpsrContactNeeded?: boolean | undefined
  readonly seq?: number | undefined
  readonly note?: string | null | undefined
  readonly switchedOn?: boolean | undefined
  readonly offReason?: string | undefined
}

const takenWords = (code: string) => `There is a market ${code} already (perhaps archived): edit or restore it.`

/** POST /compliance/rules/markets */
export async function createMarket(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ market: MarketView }> {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, RULES_MANAGE, companyId, WHAT)
  check(marketProblems(body))
  const on = body.switchedOn ?? true
  if (on && body.offReason) throw new ValidationError('The market is not valid.', [{ path: 'body/offReason', message: 'A market switched on names no reason to be off.' }])
  if (!on && !body.offReason) throw new ValidationError('The market is not valid.', [{ path: 'body/offReason', message: 'Say why the market is off (the Owner question it waits for).' }])
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.rules.createMarket', idempotencyKey: key, input: body },
        async (tools) => {
          const { tx, now, audit } = tools
          if (await tx.marketProfile.findFirst({ where: { code: body.code }, select: { id: true } })) throw new ConflictError(takenWords(body.code))
          if (companyId && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
          const id = newId()
          const row = await tx.marketProfile.create({
            data: {
              id,
              code: body.code,
              companyId,
              name: body.name,
              ...(body.nameI18n ? { nameI18n: body.nameI18n } : {}),
              labelLanguages: body.labelLanguages ?? [],
              docLanguages: body.docLanguages ?? [],
              userInfoLanguages: body.userInfoLanguages ?? [],
              markings: body.markings ?? [],
              nationalRules: (body.nationalRules ?? []) as unknown as Prisma.InputJsonValue,
              importerNeeded: body.importerNeeded ?? false,
              gpsrContactNeeded: body.gpsrContactNeeded ?? false,
              seq: body.seq ?? 0,
              note: body.note ?? null,
              switchedOn: on,
              offReason: on ? null : body.offReason!,
              switchedAt: now,
              switchedById: context.actorId,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: MARKET_SELECT,
          })
          audit({ recordType: 'MarketProfile', recordId: id, companyId, after: auditOf(row), ...(on ? {} : { reason: body.offReason! }) })
          changed(tools, row, 'CREATED')
          return { market: (await viewsOf(tx, [row]))[0]! }
        },
        settings(),
      ),
    { taken: takenWords(body.code) },
  )
  return result
}

export interface EditBody extends Omit<CreateBody, 'code' | 'companyId' | 'name' | 'switchedOn' | 'offReason'> {
  readonly version: number
  readonly name?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
}

/** The market at the version the person read, inside a command (the version bump is command()'s). */
async function guardedMarket(caller: CommandCaller, context: OfficeContext, code: string): Promise<MarketRow> {
  const row = await caller.withClient((db) => readMarket(db, context, code))
  assertMayKeep(context, RULES_MANAGE, row.companyId, WHAT)
  return row
}

/** PATCH /compliance/rules/markets/:code */
export async function editMarket(caller: CommandCaller, code: string, body: EditBody, key: string | null | undefined): Promise<{ market: MarketView }> {
  const context = officeOf(caller)
  const known = await guardedMarket(caller, context, code)
  check(marketProblems(body))
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.editMarket', idempotencyKey: key, input: { code, ...body }, record: { type: 'MarketProfile', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await tx.marketProfile.findUniqueOrThrow({ where: { id: known.id }, select: MARKET_SELECT })
        const row = await tx.marketProfile.update({
          where: { id: known.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.nameI18n !== undefined ? { nameI18n: body.nameI18n === null ? (null as unknown as Prisma.InputJsonValue) : body.nameI18n } : {}),
            ...(body.labelLanguages !== undefined ? { labelLanguages: body.labelLanguages } : {}),
            ...(body.docLanguages !== undefined ? { docLanguages: body.docLanguages } : {}),
            ...(body.userInfoLanguages !== undefined ? { userInfoLanguages: body.userInfoLanguages } : {}),
            ...(body.markings !== undefined ? { markings: body.markings } : {}),
            ...(body.nationalRules !== undefined ? { nationalRules: body.nationalRules as unknown as Prisma.InputJsonValue } : {}),
            ...(body.importerNeeded !== undefined ? { importerNeeded: body.importerNeeded } : {}),
            ...(body.gpsrContactNeeded !== undefined ? { gpsrContactNeeded: body.gpsrContactNeeded } : {}),
            ...(body.seq !== undefined ? { seq: body.seq } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            updatedAt: now,
          },
          select: MARKET_SELECT,
        })
        audit({ recordType: 'MarketProfile', recordId: row.id, companyId: row.companyId, before: auditOf(before), after: auditOf(row) })
        changed(tools, row, before.status !== row.status ? (row.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED')
        return { market: (await viewsOf(tx, [row]))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/** PUT /compliance/rules/markets/:code/switch — ON, or OFF with the reason. */
export async function switchMarket(caller: CommandCaller, code: string, body: { readonly version: number; readonly on: boolean; readonly reason?: string | undefined }, key: string | null | undefined): Promise<{ market: MarketView }> {
  const context = officeOf(caller)
  const known = await guardedMarket(caller, context, code)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.switchMarket', idempotencyKey: key, input: { code, ...body }, record: { type: 'MarketProfile', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await tx.marketProfile.findUniqueOrThrow({ where: { id: known.id }, select: MARKET_SELECT })
        const refusal = switchRefusal({ code, on: body.on, switchedOn: before.switchedOn, reason: body.reason })
        if (refusal) throw new DomainError(refusal.code === 'REASON_NEEDED' ? 'validation_failed' : 'conflict', refusal.message, [{ path: refusal.code === 'REASON_NEEDED' ? 'body/reason' : `refusal/${refusal.code}`, message: refusal.message }])
        // The database wants a new time with every switch: two switches within one millisecond take the next one.
        const at = before.switchedAt && before.switchedAt.getTime() >= now.getTime() ? new Date(before.switchedAt.getTime() + 1) : now
        const row = await tx.marketProfile.update({
          where: { id: known.id },
          data: { switchedOn: body.on, offReason: body.on ? null : body.reason!.trim(), switchedAt: at, switchedById: context.actorId, updatedAt: now },
          select: MARKET_SELECT,
        })
        audit({ recordType: 'MarketProfile', recordId: row.id, companyId: row.companyId, before: { switchedOn: before.switchedOn, offReason: before.offReason }, after: { switchedOn: row.switchedOn, offReason: row.offReason }, ...(body.reason ? { reason: body.reason } : {}) })
        changed(tools, row, 'SWITCHED')
        return { market: (await viewsOf(tx, [row]))[0]! }
      },
      settings(),
    ),
  )
  return result
}
