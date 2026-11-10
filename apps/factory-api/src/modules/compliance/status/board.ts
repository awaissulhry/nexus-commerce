import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { linesOf, type GateLine, type GateMarket, type GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { checkOf, notApplying, byGateOrder, ownerOf, type RequirementRow } from '@nexus/factory-domain/compliance/requirements/rules'
import { cellOf, cellWords, expiryMonths, needsAction, windowEnd, type ActionInput, type CellSummary } from '@nexus/factory-domain/compliance/status/board'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf, rulesClock, type Reader } from '../register-of-rules/common'
import { gateRequirements } from '../requirements/store'
import { checkerFor, checksAsked, readGateStyle, readMarkets, styleLabelTemplateId, type GateStyle } from '../gates/facts'

/**
 * The compliance status board's reads (B-W2b-254; PRD-277, PRD-271; design compliance.status SCR-119, screens B-W2b-266):
 *
 *   GET /compliance/status/board     readiness tiles, the style × market matrix (each cell Ready / Missing n / Blocked /
 *                                    Expiring with what to fix first) and the top five "Needs action" lines
 *   GET /compliance/status/cell      one style × market: the requirement checklist (cs-cell) — every requirement with its
 *                                    state (Present / Missing / Expiring / Not needed / checked by a person), the evidence,
 *                                    who can fix it, the fix and the law
 *   GET /compliance/status/actions   every "Needs action" line (the board's "See all")
 *   GET /compliance/status/expiries  what expires in the next months (certificates), per month (cs-expiry)
 *
 * Every cell asks the market's languages as if the style sold there (the style × market link is a schema need: "Not sold
 * there" cannot be told yet). The gate refusals feed is GET /compliance/gates/events. Reading needs
 * compliance.certificates.view; the styles of the companies a person's grants reach.
 */

const STYLES_MAX = 200
const DAY_MS = 24 * 60 * 60 * 1000

const today = (): BusinessDate => businessDate(rulesClock().now())

async function boardMarkets(db: Reader, codes: readonly string[] | undefined): Promise<GateMarket[]> {
  const all = [...(await readMarkets(db)).values()]
  return codes && codes.length > 0 ? all.filter((market) => codes.includes(market.code)) : all.filter((market) => market.switchedOn)
}

const cellTarget = (market: GateMarket): GateTarget => ({ key: market.code, label: '', colourwayId: null, colourwayCode: null, size: null, destination: market.code, market, sellsThere: true })

/** One style's lines per market (one checker for the style: its facts read once). */
async function styleLines(db: Reader, style: GateStyle, requirements: readonly RequirementRow[], markets: readonly GateMarket[], day: BusinessDate, now: Date): Promise<Map<string, GateLine[]>> {
  const check = await checkerFor(db, { style, labelTemplateId: await styleLabelTemplateId(db, style.row.id), day, checks: checksAsked(requirements, checkOf), marketCodes: markets.map((market) => market.code), targets: markets.map(cellTarget), subject: null })
  const out = new Map<string, GateLine[]>()
  for (const market of markets) {
    // The board is not a gate: `blocks` is read from each requirement; no override applies to a style × market cell.
    out.set(market.code, linesOf({ gate: 'SHIPMENT', style: style.subject, requirements, check, overrides: [], day, now }, cellTarget(market)))
  }
  return out
}

const styleWhere = (context: OfficeContext, query: { readonly companyId?: string | undefined; readonly q?: string | undefined }): Prisma.StyleWhereInput => ({
  AND: [
    scopeWhere(actorOf(context), CERTIFICATES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput,
    // Styles in development and in production (an archived one sells nowhere).
    { status: { not: 'ARCHIVED' } },
    query.companyId ? { companyId: query.companyId } : {},
    query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {},
  ],
})

export interface BoardQuery {
  readonly companyId?: string | undefined
  readonly markets?: string | undefined
  readonly q?: string | undefined
  readonly limit?: number | undefined
}

const marketCodesOf = (value: string | undefined): string[] | undefined =>
  value
    ? value
        .split(',')
        .map((code) => code.trim())
        .filter((code) => code.length > 0)
    : undefined

function cellView(marketCode: string, cell: CellSummary) {
  return { marketCode, state: cell.state, words: cellWords(cell), missing: cell.missing, blocking: cell.blocking, expiring: cell.expiring, manual: cell.manual, blockedGates: [...cell.blockedGates], first: cell.first }
}

/** The matrix and its tiles (shared by the board and the actions list; B-W2b-272's compliance reports read it too). */
export async function readMatrix(db: Reader, context: OfficeContext, query: BoardQuery) {
  const now = rulesClock().now()
  const day = businessDate(now)
  const markets = await boardMarkets(db, marketCodesOf(query.markets))
  const limit = Math.min(Math.max(query.limit ?? 100, 1), STYLES_MAX)
  const styles = await db.style.findMany({ where: styleWhere(context, query), select: { id: true, code: true, name: true, companyId: true, brandPartyId: true, soldUnderOurName: true, ppeCategory: true, productType: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: limit + 1 })
  const more = styles.length > limit
  const page = styles.slice(0, limit)
  const brandIds = [...new Set(page.flatMap((style) => (style.brandPartyId ? [style.brandPartyId] : [])))]
  const brands = new Map((brandIds.length > 0 ? await db.party.findMany({ where: { id: { in: brandIds } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : []).map((party) => [party.id, party]))
  const requirements = await gateRequirements(db)
  const rows = []
  const actions: ActionInput[] = []
  // B-W2b-272 (compliance reports): every cell's lines, for the coverage KPI (ANA-025) and the gaps by type.
  const cellLines: { readonly styleId: string; readonly marketCode: string; readonly lines: readonly GateLine[] }[] = []
  let missingLanguages = 0
  for (const style of page) {
    const facts = await readGateStyle(db, style.id)
    if (!facts) continue
    const lines = await styleLines(db, facts, requirements, markets, day, now)
    const cells = markets.map((market) => {
      const marketLines = lines.get(market.code) ?? []
      const cell = cellOf(marketLines)
      if (marketLines.some((line) => line.state === 'MISSING' && (line.check === 'doc.languages' || line.check === 'userInfo.languages' || line.check === 'label.languages'))) missingLanguages += 1
      actions.push({ styleId: style.id, styleCode: style.code, marketCode: market.code, marketName: market.name, cell })
      cellLines.push({ styleId: style.id, marketCode: market.code, lines: marketLines })
      return cellView(market.code, cell)
    })
    const brand = style.brandPartyId ? brands.get(style.brandPartyId) : undefined
    rows.push({
      style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, ppeCategory: style.ppeCategory, productType: style.productType, brand: brand ? { id: brand.id, code: brand.code, name: brand.tradeName ?? brand.legalName } : null, soldUnderOurName: style.soldUnderOurName },
      cells,
      ready: cells.every((cell) => cell.state === 'READY'),
      blocked: cells.some((cell) => cell.state === 'BLOCKED'),
    })
  }
  return { now, day, markets, rows, actions, missingLanguages, more, cellLines }
}

/** Shipments not gone yet with a shipment refusal of the last 30 days and no override in force (the "held by a gate" tile). */
async function shipmentsHeld(db: Reader, context: OfficeContext, now: Date): Promise<number> {
  const refused = await db.gateEvent.findMany({
    where: { AND: [scopeWhere(actorOf(context), CERTIFICATES_VIEW, { company: 'companyId' }) as Prisma.GateEventWhereInput, { gate: 'SHIPMENT', outcome: 'REFUSED', createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }] },
    select: { id: true, subjectId: true },
  })
  if (refused.length === 0) return 0
  const overridden = new Set(
    (await db.gateEvent.findMany({ where: { refusedEventId: { in: refused.map((row) => row.id) }, outcome: 'OVERRIDDEN', overrideUntil: { gt: now } }, select: { refusedEventId: true } })).map((row) => row.refusedEventId),
  )
  const subjects = [...new Set(refused.filter((row) => !overridden.has(row.id)).map((row) => row.subjectId))]
  if (subjects.length === 0) return 0
  return db.shipment.count({ where: { id: { in: subjects }, status: { in: ['DRAFT', 'PACKED'] } } })
}

const certificateWhere = (context: OfficeContext): Prisma.CertificateWhereInput => scopeWhere(actorOf(context), CERTIFICATES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.CertificateWhereInput

/** GET /compliance/status/board */
export async function statusBoard(request: FastifyRequest, query: BoardQuery) {
  const context = officeOf(request)
  return request.withClient(async (db) => {
    const matrix = await readMatrix(db, context, query)
    const within90 = windowEnd(matrix.day, 3)
    const expiring = await db.certificate.count({ where: { AND: [certificateWhere(context), { status: 'VALID', validTo: { gte: new Date(`${matrix.day}T00:00:00Z`), lte: new Date(`${within90}T00:00:00Z`) } }] } })
    const held = await shipmentsHeld(db, context, matrix.now)
    const actions = needsAction(matrix.actions, 5)
    return {
      markets: matrix.markets.map((market) => ({ code: market.code, name: market.name, switchedOn: market.switchedOn })),
      tiles: {
        stylesReady: matrix.rows.filter((row) => row.ready).length,
        stylesBlocked: matrix.rows.filter((row) => row.blocked).length,
        certificatesExpiring90: expiring,
        // Cr VI evidence per lot in stock is B-W2b-256's material profile (not counted here).
        lotsWithoutCrVi: null,
        missingLanguages: matrix.missingLanguages,
        shipmentsHeld: held,
      },
      rows: matrix.rows,
      more: matrix.more,
      needsAction: actions,
      asOf: toUtcIso(matrix.now),
    }
  })
}

/** GET /compliance/status/actions — every "Needs action" line (at most 200). */
export async function statusActions(request: FastifyRequest, query: BoardQuery) {
  const context = officeOf(request)
  return request.withClient(async (db) => {
    const matrix = await readMatrix(db, context, query)
    return { ...needsAction(matrix.actions, 200), asOf: toUtcIso(matrix.now) }
  })
}

/** GET /compliance/status/cell?styleId&market — the requirement checklist of one style × market (cs-cell). */
export async function statusCell(request: FastifyRequest, query: { readonly styleId: string; readonly market: string }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  return request.withClient(async (db) => {
    const style = await readGateStyle(db, query.styleId)
    if (!style || !(style.row.companyId === null || can(actor, CERTIFICATES_VIEW, { companyId: style.row.companyId }))) throw new NotFoundError('Style not found.')
    const market = (await readMarkets(db)).get(query.market)
    if (!market) throw new NotFoundError(`There is no market ${query.market}.`)
    const now = rulesClock().now()
    const day = businessDate(now)
    const requirements = await gateRequirements(db)
    const lines = (await styleLines(db, style, requirements, [market], day, now)).get(market.code) ?? []
    const shown = new Set(lines.map((line) => line.requirement.code))
    const notNeeded = byGateOrder(requirements)
      .filter((requirement) => !shown.has(requirement.code))
      .map((requirement) => ({ requirement, why: notApplying(requirement, style.subject, market.code, day) ?? 'Does not apply.' }))
      .filter((entry) => entry.requirement.status === 'ACTIVE')
    const cell = cellOf(lines)
    const owner = (requirement: RequirementRow) => ownerOf(requirement)
    return {
      style: { id: style.row.id, code: style.row.code, name: style.row.name, ppeCategory: style.row.ppeCategory, productType: style.row.productType },
      market: { code: market.code, name: market.name, switchedOn: market.switchedOn },
      cell: cellView(market.code, cell),
      items: [
        ...lines.map((line) => ({
          requirement: { id: line.requirement.id, code: line.requirement.code, name: line.requirement.name, nameI18n: { ...line.requirement.nameI18n }, legalReference: line.requirement.legalReference, explanationI18n: { ...line.requirement.explanationI18n }, blocks: [...line.requirement.blocks], lockedBlocks: [...line.requirement.lockedBlocks] },
          check: line.check,
          state: line.state,
          message: line.message,
          fix: line.fix,
          evidence: line.evidence,
          who: line.who,
          fixPlace: line.fixPlace,
        })),
        ...notNeeded.map(({ requirement, why }) => ({
          requirement: { id: requirement.id, code: requirement.code, name: requirement.name, nameI18n: { ...requirement.nameI18n }, legalReference: requirement.legalReference, explanationI18n: { ...requirement.explanationI18n }, blocks: [...requirement.blocks], lockedBlocks: [...requirement.lockedBlocks] },
          check: checkOf(requirement),
          state: 'NOT_NEEDED' as const,
          message: why,
          fix: null,
          evidence: null,
          who: owner(requirement).who,
          fixPlace: owner(requirement).fix,
        })),
      ],
      asOf: toUtcIso(now),
    }
  })
}

/** GET /compliance/status/expiries?months — certificates in force that end within the months (1-24, default 12), per month. */
export async function statusExpiries(request: FastifyRequest, query: { readonly months?: number | undefined }) {
  const context = officeOf(request)
  const months = Math.min(Math.max(query.months ?? 12, 1), 24)
  return request.withClient(async (db) => {
    const day = today()
    const end = windowEnd(day, months)
    const rows = await db.certificate.findMany({
      where: { AND: [certificateWhere(context), { status: { in: ['VALID', 'SUSPENDED'] }, validTo: { gte: new Date(`${day}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) } }] },
      select: { id: true, number: true, standard: true, validTo: true, status: true },
      orderBy: [{ validTo: 'asc' }, { number: 'asc' }],
      take: 500,
    })
    const items = rows.map((row) => ({ recordType: 'Certificate', recordId: row.id, label: `${row.number} (${row.standard})`, validTo: row.validTo.toISOString().slice(0, 10) }))
    // Supplier declarations, LWG and claims evidence join with their steps (B-W2b-256, B-W2b-264).
    return { months: expiryMonths(items, day, months), count: items.length, from: day, to: end, asOf: toUtcIso(rulesClock().now()) }
  })
}
