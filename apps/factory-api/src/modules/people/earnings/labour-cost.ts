import type { Prisma } from '@nexus/factory-db'
import { perMinuteOf } from '@nexus/factory-domain/costing/ledger/entries'
import { pickRate } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, businessDayRange, businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { ratesOf } from '../../costing/actual/store'
import { dateOf } from '../employees/access'
import { minimumGroupSizeFor } from '../privacy/groups'
import { officeOf, seesPay } from './access'
import type { LabourCostQuery } from './contract'

/**
 * Labour cost per piece (B-W2b-43; MES-266 "office view of labour cost per piece, operation and style against the costing";
 * design finance.costing "labour cost per piece, cost grain"). Per style and operation, never per person.
 *
 *   ledger    what the work-order cost ledger booked for the good pieces (standard minutes × the cost per minute of the day),
 *             the cost grain
 *   costing   what the costing says one piece costs today: the operation's minutes × today's cost per minute, the cost grain
 *   paid      what the earnings ledger paid per piece (pieces and team shares). The pay grain, not cost: a rate per piece is a
 *             pay figure, so it reaches only a caller who holds both, and only for a group of the company's minimum size
 *             (one person's figure otherwise). Finance sees the costing's own numbers; the Owner sees the true one beside them.
 */

const round6 = (value: Decimal): string => value.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed()

export async function labourCost(caller: CommandCaller, query: LabourCostQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!can(actor, COSTING_VIEW, { companyId: query.companyId })) throw new ForbiddenError()
  const now = serverClock.now()
  const today = businessDate(now)
  const from: BusinessDate = query.from ?? `${today.slice(0, 7)}-01`
  const to: BusinessDate = query.to ?? today
  return caller.withClient(async (db) => {
    const scope = scopeWhere(actor, COSTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderCostEntryWhereInput
    const entries = await db.workOrderCostEntry.findMany({
      where: { AND: [scope, { companyId: query.companyId, kind: 'LABOUR', occurredAt: { gte: businessDayStart(from), lt: businessDayRange(to).end } }, query.siteId ? { siteId: query.siteId } : {}] },
      select: { id: true, amount: true, currency: true, workOrderId: true, operationScanId: true, reversalOfId: true },
    })
    const originals = new Map(entries.map((entry) => [entry.id, entry]))
    const missing = [...new Set(entries.flatMap((entry) => (entry.reversalOfId && !originals.has(entry.reversalOfId) ? [entry.reversalOfId] : [])))]
    const earlier = missing.length === 0 ? [] : await db.workOrderCostEntry.findMany({ where: { id: { in: missing } }, select: { id: true, operationScanId: true } })
    const sourceScan = new Map([...entries.map((entry) => [entry.id, entry.operationScanId] as const), ...earlier.map((entry) => [entry.id, entry.operationScanId] as const)])
    const scanIds = [...new Set(entries.flatMap((entry) => {
      const id = entry.reversalOfId ? sourceScan.get(entry.reversalOfId) : entry.operationScanId
      return id ? [id] : []
    }))]
    const scans = scanIds.length === 0 ? [] : await db.operationScan.findMany({ where: { id: { in: scanIds } }, select: { id: true, goodQuantity: true, workOrderId: true, operation: { select: { code: true, name: true, standardMinutes: true, workCentre: { select: { kind: true } } } } } })
    const scanBy = new Map(scans.map((scan) => [scan.id, scan]))
    const workOrders = await db.workOrder.findMany({ where: { id: { in: [...new Set(scans.map((scan) => scan.workOrderId))] } }, select: { id: true, styleId: true } })
    const styleOf = new Map(workOrders.map((row) => [row.id, row.styleId]))
    const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(workOrders.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))

    interface Group { style: { id: string; code: string; name: string }; code: string; name: string; standardMinutes: string; kind: string; pieces: number; amount: number; currency: string; paid: number; paidPieces: Decimal; people: Set<string> }
    const groups = new Map<string, Group>()
    const keyOf = (scan: (typeof scans)[number]): string => `${styleOf.get(scan.workOrderId)}|${scan.operation.code}`
    const groupOf = (scan: (typeof scans)[number], currency: string): Group | null => {
      const styleId = styleOf.get(scan.workOrderId)
      if (query.styleId && styleId !== query.styleId) return null
      const key = keyOf(scan)
      const found = groups.get(key)
      if (found) return found
      const made: Group = { style: styles.get(styleId!)!, code: scan.operation.code, name: scan.operation.name, standardMinutes: scan.operation.standardMinutes.toString(), kind: scan.operation.workCentre.kind, pieces: 0, amount: 0, currency, paid: 0, paidPieces: new Dec(0), people: new Set() }
      groups.set(key, made)
      return made
    }
    for (const entry of entries) {
      const scanId = entry.reversalOfId ? sourceScan.get(entry.reversalOfId) : entry.operationScanId
      const scan = scanId ? scanBy.get(scanId) : undefined
      if (!scan) continue
      const group = groupOf(scan, entry.currency)
      if (!group) continue
      group.amount += entry.amount
      group.pieces += entry.reversalOfId ? 0 - scan.goodQuantity : scan.goodQuantity
    }
    if (seesPay(context)) {
      const paid = await db.earningsEntry.findMany({
        where: { companyId: query.companyId, kind: { in: ['SCAN', 'TEAM_SPLIT'] }, workDate: { gte: dateOf(from), lte: dateOf(to) }, ...(query.siteId ? { siteId: query.siteId } : {}) },
        select: { kind: true, employeeId: true, operationScanId: true, pieces: true, sharePct: true, amount: true, currency: true, operationScan: { select: { id: true, goodQuantity: true, workOrderId: true, operation: { select: { code: true, name: true, standardMinutes: true, workCentre: { select: { kind: true } } } } } } },
      })
      const more = paid.flatMap((row) => (row.operationScan && !styleOf.has(row.operationScan.workOrderId) ? [row.operationScan.workOrderId] : []))
      if (more.length > 0) {
        const rows = await db.workOrder.findMany({ where: { id: { in: [...new Set(more)] } }, select: { id: true, styleId: true } })
        for (const row of rows) styleOf.set(row.id, row.styleId)
        for (const row of await db.style.findMany({ where: { id: { in: rows.map((item) => item.styleId) } }, select: { id: true, code: true, name: true } })) styles.set(row.id, row)
      }
      for (const row of paid) {
        if (!row.operationScan) continue
        const group = groupOf(row.operationScan, row.currency)
        if (!group) continue
        group.paid += row.amount
        group.people.add(row.employeeId)
        const pieces = new Dec(row.pieces ?? 0)
        group.paidPieces = group.paidPieces.plus(row.kind === 'TEAM_SPLIT' && row.sharePct !== null ? pieces.times(row.sharePct.toString()).dividedBy(100) : pieces)
      }
    }
    const rates = await ratesOf(db, query.companyId)
    const minimum = await minimumGroupSizeFor(db, query.companyId)
    const rows = [...groups.values()].sort((a, b) => a.style.code.localeCompare(b.style.code) || a.code.localeCompare(b.code)).map((group) => {
      const perPiece = group.pieces > 0 ? new Dec(fromMinorUnits(group.amount, group.currency)).dividedBy(group.pieces) : null
      const rate = pickRate(rates, group.kind as Parameters<typeof pickRate>[1], query.companyId, today)
      const perMinute = rate ? perMinuteOf(rate) : null
      const costing = perMinute === null ? null : new Dec(perMinute).times(group.standardMinutes)
      const paidShown = group.paidPieces.greaterThan(0) && groupShown(group.people.size, minimum)
      const paid = paidShown ? new Dec(fromMinorUnits(group.paid, group.currency)).dividedBy(group.paidPieces) : null
      return {
        style: group.style,
        operation: { code: group.code, name: group.name },
        pieces: group.pieces,
        standardMinutes: group.standardMinutes,
        currency: group.currency,
        labourCost: asMoney('cost', group.amount),
        labourCostPerPiece: asMoney('cost', perPiece ? round6(perPiece) : null),
        costingPerPiece: asMoney('cost', costing ? round6(costing) : null),
        /** Ledger per piece − costing per piece. */
        differencePerPiece: asMoney('cost', perPiece && costing ? round6(perPiece.minus(costing)) : null),
        /** What the piece rates paid per piece: the pay grain; null for a group too small to show. */
        paidPerPiece: asMoney('pay', paid ? round6(paid) : null),
        paidTotal: asMoney('pay', paidShown ? group.paid : null),
      }
    })
    return { companyId: query.companyId, from, to, rows, words: ['Per style and operation, never per person. What the piece rates paid shows with the pay grain, for groups of the minimum size.'] }
  })
}

