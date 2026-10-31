import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import type { DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { QUALITY_NCR_RAISE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { allMet, BOARD_LANES, firstUnmet, NCR_LIMITS, NCR_STAGES, nextStage, OPEN_NCR_STAGES, stageChecks, type NcrFromType, type NcrSource, type NcrStage } from '@nexus/factory-domain/quality/ncr/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { may, officeOf, recordOf, visibleNcr } from './ncr'
import { containmentHoursOf } from './settings'
import { prefillFrom } from './sources'
import { factsOf, NCR_COLUMNS, ncrSummary, summaryFactsOf, type NcrRow, type Reader } from './store'

/**
 * The NCRs' reads (B-W2a-47; design quality.ncr ncr-metrics, ncr-grid, ncr-board, the NCR record, ncr-new's prefill).
 * Office only, within the caller's companies and sites (quality.ncr.view); the prefill with quality.ncr.raise.
 *
 *   GET /quality/ncr            newest first: stage (a list, or open = not closed or cancelled, the default), severity,
 *                               source, site, owner (`me`), the containment overdue, waiting for disposition (quantity
 *                               not yet decided), a record's NCRs (raised from it or linked to it, or naming it: its
 *                               work order, lot, style), style, work order, lot, supplier, number or title; at most 200.
 *   GET /quality/ncr/counts     the tiles: open, containment overdue, waiting disposition, critical open, closed this
 *                               month (Rome), mine.
 *   GET /quality/ncr/board      the lanes Open → Contained → Decided → Closed (closed in the last 30 days), each card with
 *                               its next stage and what it still needs (the drag's refusal in words), the list's filters.
 *   GET /quality/ncr/prefill    what an NCR raised from a record would say (ncr-new), the record's files, its NCRs.
 *   GET /quality/ncr/:ncrId     the record: problem, containment, decisions, links, holds, register, the next stage and
 *                               the closing checklist, the band's actions.
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const

export interface ListQuery {
  readonly stage?: string | undefined
  readonly open?: boolean | undefined
  readonly severity?: DefectClass | undefined
  readonly source?: NcrSource | undefined
  readonly siteId?: string | undefined
  readonly ownerId?: string | undefined
  readonly overdue?: boolean | undefined
  readonly waiting?: boolean | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly styleId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly lotId?: string | undefined
  readonly supplierId?: string | undefined
  readonly q?: string | undefined
}

function stagesOf(query: ListQuery): NcrStage[] | null {
  if (!query.stage) return query.open === false ? null : [...OPEN_NCR_STAGES]
  const stages = query.stage.split(',').map((value) => value.trim().toUpperCase())
  const unknown = stages.filter((value) => !(NCR_STAGES as readonly string[]).includes(value))
  if (unknown.length > 0) throw new ValidationError('Not a stage.', [{ path: 'querystring/stage', message: `Stages: ${NCR_STAGES.join(', ')}.` }])
  return stages as NcrStage[]
}

/** A record's NCRs: raised from it, linked to it, or naming it (its work order, lot, style, supplier, item). */
function recordWhere(recordType: string, recordId: string): Prisma.NonconformanceWhereInput {
  const named: Prisma.NonconformanceWhereInput[] = []
  if (recordType === 'WorkOrder') named.push({ workOrderId: recordId })
  if (recordType === 'Lot') named.push({ lotId: recordId })
  if (recordType === 'Style') named.push({ styleId: recordId })
  if (recordType === 'Party') named.push({ supplierId: recordId })
  if (recordType === 'Item') named.push({ itemId: recordId })
  return { OR: [{ sourceType: recordType, sourceId: recordId }, { links: { some: { recordType, recordId } } }, ...named] }
}

function whereOf(caller: CommandCaller, query: ListQuery, now: Date): Prisma.NonconformanceWhereInput {
  const context = officeOf(caller)
  if (query.ownerId && query.ownerId !== 'me' && !/^[0-9a-f-]{36}$/i.test(query.ownerId)) throw new ValidationError('Not an owner.', [{ path: 'querystring/ownerId', message: "A person's id, or me." }])
  if ((query.recordType === undefined) !== (query.recordId === undefined)) throw new ValidationError('Name the record as a type and an id.', [{ path: 'querystring/recordType', message: 'Both or neither.' }])
  const stages = stagesOf(query)
  const q = query.q?.trim()
  return {
    AND: [
      scopeWhere(actorOf(context), QUALITY_NCR_VIEW, SCOPE) as Prisma.NonconformanceWhereInput,
      stages ? { stage: { in: stages } } : {},
      query.severity ? { severity: query.severity } : {},
      query.source ? { source: query.source } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.ownerId ? { ownerId: query.ownerId === 'me' ? context.actorId : query.ownerId } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.lotId ? { lotId: query.lotId } : {},
      query.supplierId ? { supplierId: query.supplierId } : {},
      query.recordType && query.recordId ? recordWhere(query.recordType, query.recordId) : {},
      q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] } : {},
      query.overdue ? { stage: 'OPEN', OR: [{ containmentDueAt: { lt: now } }, { containment: { some: { status: 'OPEN', dueAt: { lt: now } } } }] } : {},
      query.waiting ? { stage: { in: ['OPEN', 'CONTAINED'] } } : {},
    ],
  }
}

/** The ids of NCRs whose whole quantity is not decided yet (of those read). */
async function waitingIds(db: Reader, rows: readonly Pick<NcrRow, 'id' | 'quantityAffected'>[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set()
  const sums = await db.ncrDispositionLine.groupBy({ by: ['ncrId'], where: { ncrId: { in: rows.map((row) => row.id) } }, _sum: { quantity: true } })
  const decided = new Map(sums.map((row) => [row.ncrId, new Dec(row._sum.quantity?.toString() ?? '0')]))
  return new Set(rows.filter((row) => (decided.get(row.id) ?? new Dec(0)).lt(row.quantityAffected.toString())).map((row) => row.id))
}

const ORDER: Prisma.NonconformanceOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }]

export async function listNcrs(caller: CommandCaller, query: ListQuery) {
  const now = serverClock.now()
  const where = whereOf(caller, query, now)
  return caller.withClient(async (client) => {
    let rows = await client.nonconformance.findMany({ where, select: NCR_COLUMNS, orderBy: ORDER, take: query.waiting ? 1000 : NCR_LIMITS.list + 1 })
    if (query.waiting) {
      const waiting = await waitingIds(client, rows)
      rows = rows.filter((row) => waiting.has(row.id))
    }
    const shown = rows.slice(0, NCR_LIMITS.list)
    const facts = await summaryFactsOf(client, shown)
    return { items: shown.map((row) => ncrSummary(row, facts, now)), truncated: rows.length > NCR_LIMITS.list }
  })
}

export async function ncrCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const monthStart = businessDayStart(`${businessDate(now).slice(0, 7)}-01`)
  const base = (extra: ListQuery) => whereOf(caller, { ...(query.siteId ? { siteId: query.siteId } : {}), ...extra }, now)
  return caller.withClient(async (client) => {
    const deciding = await client.nonconformance.findMany({ where: base({ waiting: true }), select: { id: true, quantityAffected: true }, take: 5000 })
    return {
      counts: {
        open: await client.nonconformance.count({ where: base({}) }),
        containmentOverdue: await client.nonconformance.count({ where: base({ overdue: true }) }),
        waitingDisposition: (await waitingIds(client, deciding)).size,
        criticalOpen: await client.nonconformance.count({ where: base({ severity: 'CRITICAL' }) }),
        closedThisMonth: await client.nonconformance.count({ where: { AND: [base({ stage: 'CLOSED' }), { closedAt: { gte: monthStart } }] } }),
        mine: await client.nonconformance.count({ where: base({ ownerId: context.actorId }) }),
      },
    }
  })
}

export async function ncrBoard(caller: CommandCaller, query: Omit<ListQuery, 'stage' | 'open'>) {
  const now = serverClock.now()
  const closedSince = new Date(now.getTime() - NCR_LIMITS.closedLaneDays * 86_400_000)
  return caller.withClient(async (client) => {
    const lanes = []
    for (const stage of BOARD_LANES) {
      const where: Prisma.NonconformanceWhereInput = { AND: [whereOf(caller, { ...query, stage }, now), stage === 'CLOSED' ? { closedAt: { gte: closedSince } } : {}] }
      let rows = await client.nonconformance.findMany({ where, select: NCR_COLUMNS, orderBy: stage === 'CLOSED' ? [{ closedAt: 'desc' }, { id: 'desc' }] : ORDER, take: query.waiting ? 1000 : NCR_LIMITS.list + 1 })
      if (query.waiting) {
        const waiting = await waitingIds(client, rows)
        rows = rows.filter((row) => waiting.has(row.id))
      }
      const count = query.waiting ? rows.length : await client.nonconformance.count({ where })
      const shown = rows.slice(0, NCR_LIMITS.list)
      const facts = await summaryFactsOf(client, shown)
      const holds = shown.length === 0 ? [] : await client.qualityHold.groupBy({ by: ['ncrId'], where: { ncrId: { in: shown.map((row) => row.id) }, status: 'ACTIVE' }, _count: { _all: true } })
      const activeHolds = new Map(holds.map((row) => [row.ncrId, row._count._all]))
      const cards = shown.map((row) => {
        const next = nextStage(row.stage as NcrStage)
        const checks = next ? stageChecks(factsOf(row, facts.actions.get(row.id) ?? [], facts.decisions.get(row.id) ?? [], activeHolds.get(row.id) ?? 0), next) : []
        return { ...ncrSummary(row, facts, now), next: { stage: next, ready: next !== null && allMet(checks), words: firstUnmet(checks)?.words ?? null } }
      })
      lanes.push({ stage, count, truncated: rows.length > NCR_LIMITS.list, cards })
    }
    return { lanes }
  })
}

export async function ncrRecord(caller: CommandCaller, ncrId: string) {
  const { context, row } = await visibleNcr(caller, ncrId)
  return caller.withClient(async (client) => ({ record: await recordOf(client, row, context, serverClock.now()) }))
}

export async function ncrPrefill(caller: CommandCaller, query: { readonly recordType: NcrFromType; readonly recordId: string; readonly defectIds?: readonly string[] | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const prefill = await prefillFrom(client, query.recordType, query.recordId, { defectIds: query.defectIds })
    if (!prefill) throw new NotFoundError(`${query.recordType.replace(/([a-z])([A-Z])/g, '$1 $2')} not found.`)
    if (prefill.siteId && prefill.companyId && !may(context, QUALITY_NCR_RAISE, { companyId: prefill.companyId, siteId: prefill.siteId })) throw new ForbiddenError('You raise NCRs only at the sites your role reaches.')
    const files = await client.storedFile.findMany({ where: { recordType: query.recordType, recordId: query.recordId, status: 'AVAILABLE' }, select: { id: true, kind: true, originalName: true }, orderBy: { createdAt: 'asc' }, take: 20 })
    const existing = await client.nonconformance.findMany({ where: { AND: [scopeWhere(actorOf(context), QUALITY_NCR_VIEW, SCOPE) as Prisma.NonconformanceWhereInput, recordWhere(query.recordType, query.recordId)] }, select: { id: true, number: true, stage: true }, orderBy: ORDER, take: 20 })
    return {
      prefill: {
        ...prefill,
        foundOn: prefill.foundOn?.toISOString() ?? null,
        links: prefill.links.map((link) => ({ recordType: link.recordType, recordId: link.recordId, note: link.note })),
        holdIds: [...prefill.holdIds],
        defectIds: [...prefill.defectIds],
        titleParts: prefill.titleParts ? { key: prefill.titleParts.key, values: { ...prefill.titleParts.values } } : null,
        files: files.map((file) => ({ id: file.id, kind: file.kind, originalName: file.originalName })),
        existing: existing.map((ncr) => ({ id: ncr.id, number: ncr.number, stage: ncr.stage as NcrStage })),
        /** B-W2b-17: the company's containment time (hours after it was found; null when the record names no company). */
        containmentHours: prefill.companyId ? (await containmentHoursOf(client, prefill.companyId)).hours : null,
      },
    }
  })
}

