/**
 * ONE BRAIN AB-12 — the facts of the state lever (brain/state.ts), read for one product in one market: a fixed number of
 * queries whatever the number of campaigns (no N+1). Read only: nothing here writes, in Nexus or at Amazon.
 *
 *   campaigns   the product's own and shared Sponsored Products campaigns of the market (brain/ownership.ts; archived left
 *               out), each with its resolved state lever and settings (brain/settings.ts: the Owner's product and campaign
 *               overrides over the defaults)
 *   stock       each own campaign's ad groups with their products' stock verdicts (ads-stock-risk.service.ts: units, pace,
 *               lead time, inbound units, the restart line), and the earliest DATED arrival of each product — an open
 *               inbound shipment (not a transfer) or an open purchase order, the supplier's confirmed date first
 *   stops       budget enforcement's floor on the campaign (Campaign.bidsSuppressedBy) or its declared STOP hold (the
 *               month's cap); a playbook STOP (AdsPlaybookLink + AdsPlaybook, as the bid brain reads it); the Owner's long
 *               stop (`longStopUntil`)
 *   on record   each campaign's last status change in the action log (not one put back), and Amazon's report of a status
 *               changed outside Nexus (AdDrift EXTERNAL_CHANGE) when newer — the brain's own is its writer's, or a request
 *               it asked for (an approval its log names)
 *   memory      each campaign's newest decision in the brain's log (its pause memory, the stop first seen, its request),
 *               the requests' approval status, the stop recipe's memory now (Campaign + keywords)
 *   dead        impressions over each campaign's archive window from the daily report, judged only when the market's
 *               report is fresh (≤ 3 days) and reaches back over the window
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { readStockAdGroups } from '../ads-stock-risk.service.js'
import { externalStatusChanges } from '../ads-status-lookup.service.js'
import { BRAIN_STATE_ACTOR } from '../ads-write-gate.js'
import { STOP_HOLD_KIND } from '../bid-brain/facts.js'
import { STOP_FLOOR_KIND } from '../ads-playbook/held.js'
import { isLevel, type BrainLevel } from './levers.js'
import { productCampaigns } from './ownership.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import {
  declaredStop, MIN_PAUSED_HOURS, monthlyCapStop, playbookStop, stockStop, type PauseMemory, type StateDecision, type StateFacts, type StatusChanger, type StockGroupFacts,
  type StopCause, type StopMemorySnapshot,
} from './state.js'

const DAY_MS = 86_400_000
/** The daily report counts as fresh for an archive judgement when its newest day is at most this old. */
export const REPORT_FRESH_DAYS = 3
const WATCHING: readonly BrainLevel[] = ['OBSERVE', 'PROPOSE', 'AUTO']
/** Purchase orders still to arrive (sent, confirmed, partly received). */
const OPEN_PO_STATUSES = ['APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL'] as const
/** Inbound shipments still to arrive or being received. A transfer moves units the business already counts. */
const OPEN_INBOUND_STATUSES = ['SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED'] as const
const RULE_ID = /^automation:c[a-z0-9]{20,}$/

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

export interface StateWatched { productId: string; market: string; level: BrainLevel }

/**
 * The enrolled products whose state lever is OBSERVE or higher — for the product, or for one of its campaigns by the
 * Owner's campaign override (two reads). Production today: none, so the job does nothing.
 */
export async function stateWatchProducts(): Promise<StateWatched[]> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } })
  if (!enrollments.length) return []
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, productId: { in: [...new Set(enrollments.map((e) => e.productId))] }, OR: [{ scope: 'PRODUCT' }, { scope: 'CAMPAIGN', kind: 'LEVEL', key: 'state' }] },
    select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  return enrollments.flatMap((e) => {
    const level = resolveBrainSettings({ productId: e.productId, market: e.marketplace, enrolled: true, overrides }).levers.state.effective
    const campaignWatch = overrides.some((o) => o.scope === 'CAMPAIGN' && o.productId === e.productId && o.marketplace === e.marketplace && WATCHING.includes(o.value as BrainLevel))
    if (isLevel(level) && WATCHING.includes(level)) return [{ productId: e.productId, market: e.marketplace, level }]
    return campaignWatch ? [{ productId: e.productId, market: e.marketplace, level: 'OBSERVE' as BrainLevel }] : []
  }).sort((a, b) => a.market.localeCompare(b.market) || a.productId.localeCompare(b.productId))
}

/** One campaign's newest decision in the brain's log. */
export interface PreviousStateRow {
  campaignId: string
  decisionHash: string
  createdAt: Date
  action: string
  outcome: string
  mode: string
  approvalId: string | null
  decision: StateDecision & { asked?: AskedRecord | null }
}

/** A request the brain asked for, carried on its log until it is decided (and, declined, for its quiet days). */
export interface AskedRecord { action: 'pause' | 'resume' | 'archive'; approvalId: string; at: string; memory?: PauseMemory | null }

/** Each campaign's newest decision in the brain's log (one statement). */
export async function newestStateDecisions(campaignIds: readonly string[]): Promise<Map<string, PreviousStateRow>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<PreviousStateRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("campaignId") "campaignId", "decisionHash", "createdAt", "action", "outcome", "mode", "approvalId", "decision"
      FROM "AdsBrainStateDecision"
     WHERE "campaignId" = ANY(${[...campaignIds]}::text[])
     ORDER BY "campaignId", "createdAt" DESC, "id" DESC`)
  return new Map(rows.map((r) => [r.campaignId, { ...r, createdAt: new Date(r.createdAt) }]))
}

/** The action log's outcomes of a write that never landed at Amazon (refused at dispatch, failed, cancelled, replaced). */
const NOT_LANDED = ['SKIPPED', 'FAILED', 'CANCELLED', 'SUPERSEDED']

/** Each campaign's last status change Nexus recorded that landed or is on its way (one put back or never sent left out), one statement. */
async function lastStatusChanges(campaignIds: readonly string[]): Promise<Map<string, { to: string; at: Date; userId: string | null; executionId: string | null }>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ entityId: string; userId: string | null; executionId: string | null; to: string; createdAt: Date }>>(Prisma.sql`
    SELECT DISTINCT ON ("entityId") "entityId", "userId", "executionId", "payloadAfter"->>'status' AS "to", "createdAt"
      FROM "AdvertisingActionLog"
     WHERE "entityType" = 'CAMPAIGN' AND "entityId" = ANY(${[...campaignIds]}::text[]) AND "rolledBackAt" IS NULL
       AND ("amazonResponseStatus" IS NULL OR "amazonResponseStatus" <> ALL(${NOT_LANDED}::text[]))
       AND "payloadAfter"->>'status' IS NOT NULL AND ("payloadBefore"->>'status') IS DISTINCT FROM ("payloadAfter"->>'status')
     ORDER BY "entityId", "createdAt" DESC, "id" DESC`)
  return new Map(rows.map((r) => [r.entityId, { to: r.to, at: new Date(r.createdAt), userId: r.userId, executionId: r.executionId }]))
}

/** Each campaign's newest status write by the brain's own writer that did NOT land, in the last `hours` (one statement). */
async function brainMisses(campaignIds: readonly string[], now: Date, hours: number): Promise<Map<string, { to: string; at: Date; result: string }>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ entityId: string; to: string; createdAt: Date; result: string }>>(Prisma.sql`
    SELECT DISTINCT ON ("entityId") "entityId", "payloadAfter"->>'status' AS "to", "createdAt", "amazonResponseStatus" AS "result"
      FROM "AdvertisingActionLog"
     WHERE "entityType" = 'CAMPAIGN' AND "entityId" = ANY(${[...campaignIds]}::text[]) AND "userId" = ${BRAIN_STATE_ACTOR}
       AND "amazonResponseStatus" = ANY(${NOT_LANDED}::text[]) AND "createdAt" >= ${new Date(now.getTime() - hours * 3_600_000)}
       AND "payloadAfter"->>'status' IS NOT NULL
     ORDER BY "entityId", "createdAt" DESC, "id" DESC`)
  return new Map(rows.map((r) => [r.entityId, { to: r.to, at: new Date(r.createdAt), result: r.result }]))
}

/** Keywords holding a remembered bid (the stop recipe's or a stop's memory), per campaign — one statement. */
async function flooredKeywords(campaignIds: readonly string[]): Promise<Map<string, number>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; n: number }>>(Prisma.sql`
    SELECT g."campaignId", count(*)::int AS n
      FROM "AdTarget" t JOIN "AdGroup" g ON g."id" = t."adGroupId"
     WHERE g."campaignId" = ANY(${[...campaignIds]}::text[]) AND t."suppressedFromBidCents" IS NOT NULL
     GROUP BY g."campaignId"`)
  return new Map(rows.map((r) => [r.campaignId, Number(r.n)]))
}

/**
 * The earliest DATED arrival of each product still to come: an open inbound shipment (not a transfer) with units still
 * expected, or an open purchase order with units still to receive (the supplier's confirmed date first). Two reads.
 */
export async function datedArrivals(productIds: readonly string[]): Promise<Map<string, { at: Date; from: 'inbound' | 'purchase_order' }>> {
  const ids = [...new Set(productIds)]
  const out = new Map<string, { at: Date; from: 'inbound' | 'purchase_order' }>()
  if (!ids.length) return out
  const [inbound, orders] = await Promise.all([
    prisma.inboundShipmentItem.findMany({
      where: { productId: { in: ids }, inboundShipment: { status: { in: [...OPEN_INBOUND_STATUSES] }, type: { not: 'TRANSFER' }, expectedAt: { not: null } } },
      select: { productId: true, quantityExpected: true, quantityReceived: true, inboundShipment: { select: { expectedAt: true } } },
    }),
    prisma.purchaseOrderItem.findMany({
      where: { productId: { in: ids }, purchaseOrder: { status: { in: [...OPEN_PO_STATUSES] } } },
      select: { productId: true, quantityOrdered: true, quantityReceived: true, purchaseOrder: { select: { expectedDeliveryDate: true, supplierConfirmedDeliveryDate: true } } },
    }),
  ])
  const keep = (productId: string | null, at: Date | null | undefined, from: 'inbound' | 'purchase_order') => {
    if (!productId || !at) return
    const had = out.get(productId)
    if (!had || at.getTime() < had.at.getTime()) out.set(productId, { at, from })
  }
  for (const i of inbound) if (i.quantityExpected > i.quantityReceived) keep(i.productId, i.inboundShipment.expectedAt, 'inbound')
  for (const o of orders) if (o.quantityOrdered > o.quantityReceived) keep(o.productId, o.purchaseOrder.supplierConfirmedDeliveryDate ?? o.purchaseOrder.expectedDeliveryDate, 'purchase_order')
  return out
}

/** Who made a status change on record, as the brain reads it (the brain's own: its writer, or a request it asked for). */
export function changerOf(r: { userId: string | null; executionId: string | null }, brainApprovals: ReadonlySet<string>): { by: StatusChanger; who: string; via?: 'auto' | 'request'; approvalId?: string | null } {
  if (r.userId === BRAIN_STATE_ACTOR) return { by: 'brain', who: BRAIN_STATE_ACTOR, via: 'auto', approvalId: null }
  if (r.executionId && brainApprovals.has(r.executionId)) return { by: 'brain', who: r.userId ?? 'a request the brain asked for', via: 'request', approvalId: r.executionId }
  if (r.userId?.startsWith('user:')) return { by: 'person', who: r.userId }
  if (r.userId?.startsWith('automation:')) return { by: 'automation', who: RULE_ID.test(r.userId) ? `a Nexus rule (${r.userId})` : r.userId }
  return { by: 'person', who: r.userId ?? 'an unnamed writer' }
}

export interface ProductStateFacts {
  productId: string
  market: string
  enrolled: boolean
  facts: StateFacts[]
  previous: Map<string, PreviousStateRow>
  /** The requests carried on the log, with their status now (for the runner's record). */
  asked: Map<string, AskedRecord & { status: string | null }>
}

/** A JSON object's field, or undefined. */
const field = <T,>(o: unknown, k: string): T | undefined => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] as T : undefined)

/** The facts of every campaign of one product in one market (`productId` may be a variation: its family root is used). Null: no product or no market. */
export async function loadProductStateFacts(productId: string, marketIn: string, opts: { now: Date }): Promise<ProductStateFacts | null> {
  const now = opts.now
  const market = strategyMarket(marketIn)
  if (!market || !/^[A-Z]{2}$/.test(market)) return null
  const camps = await productCampaigns(productId, market)
  if (!camps) return null
  const root = camps.root
  const all = [...camps.owned.map((c) => ({ ...c, side: 'product' as const })), ...camps.shared.map((c) => ({ ...c, side: 'shared' as const }))]
  const ids = all.map((c) => c.campaignId)
  const ownIds = camps.owned.map((c) => c.campaignId)
  const [enrollment, overrides, rows, stock, stopHolds, links, changes, drift, previous, floored, misses] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: root, marketplace: market }, ...(ids.length ? [{ scope: 'CAMPAIGN', campaignId: { in: ids } }] : [])] }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    ids.length ? prisma.campaign.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true, startDate: true, createdAt: true, bidsSuppressedAt: true, bidsSuppressedBy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true, biddingStrategy: true },
    }) : Promise.resolve([]),
    ownIds.length ? readStockAdGroups({ campaignIds: ownIds }) : Promise.resolve({ adGroups: [], missing: [], capped: false }),
    ownIds.length ? prisma.bidHold.findMany({ where: { campaignId: { in: ownIds }, targetId: null, kind: STOP_HOLD_KIND, endedAt: null }, select: { campaignId: true, by: true } }) : Promise.resolve([]),
    ownIds.length ? prisma.adsPlaybookLink.findMany({ where: { refId: { in: ownIds }, OR: [{ kind: 'slot', origin: 'built' }, { kind: STOP_FLOOR_KIND }] }, select: { kind: true, refId: true, playbookId: true } }) : Promise.resolve([]),
    lastStatusChanges(ids),
    externalStatusChanges([{ entityType: 'CAMPAIGN', ids }]),
    newestStateDecisions(ids),
    flooredKeywords(ids),
    brainMisses(ids, now, MIN_PAUSED_HOURS),
  ])
  const books = links.length
    ? new Map((await prisma.adsPlaybook.findMany({ where: { id: { in: [...new Set(links.map((l) => l.playbookId))] } }, select: { id: true, label: true, state: true } })).map((b) => [b.id, b]))
    : new Map<string, { id: string; label: string; state: string }>()
  const productIds = [...new Set(stock.adGroups.flatMap((g) => g.productIds))]
  // The requests the brain's log carries: their status now, and the approvals that make a status change the brain's own.
  const carried = new Map<string, AskedRecord>()
  const brainApprovals = new Set<string>()
  for (const [campaignId, p] of previous) {
    const asked = field<AskedRecord | null>(p.decision, 'asked')
    if (asked?.approvalId) carried.set(campaignId, asked)
    const memory = field<PauseMemory | null>(p.decision, 'memory')
    if (memory?.approvalId) brainApprovals.add(memory.approvalId)
    if (asked?.approvalId && asked.action !== 'archive') brainApprovals.add(asked.approvalId)
  }
  const [arrivals, approvals] = await Promise.all([
    datedArrivals(productIds),
    carried.size ? prisma.agentApproval.findMany({ where: { id: { in: [...carried.values()].map((a) => a.approvalId) } }, select: { id: true, status: true, decidedAt: true, expiresAt: true } }) : Promise.resolve([]),
  ])
  const approvalOf = new Map(approvals.map((a) => [a.id, a]))

  // Each campaign's resolved settings, its archive window, then one impressions read per distinct window.
  const enrolled = !!enrollment
  const settingsOf = new Map(all.map((c) => [c.campaignId, resolveBrainSettings({ productId: root, market, campaignId: c.campaignId, enrolled, overrides })]))
  const windowOf = (id: string) => Number(settingsOf.get(id)!.values.archiveDeadWeeks.value) * 7
  const windows = [...new Set(ownIds.map(windowOf))]
  const newest = await prisma.amazonAdsDailyPerformance.findFirst({ where: { marketplace: market, entityType: 'CAMPAIGN', ...EXCLUDE_AMS_DAILY }, orderBy: { date: 'desc' }, select: { date: true } })
  const fresh = !!newest && now.getTime() - new Date(newest.date).getTime() <= (REPORT_FRESH_DAYS + 1) * DAY_MS
  const impressions = new Map<string, number | null>()
  for (const days of windows) {
    const from = new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - days * DAY_MS)
    const mine = ownIds.filter((id) => windowOf(id) === days)
    const reaches = fresh && !!(await prisma.amazonAdsDailyPerformance.findFirst({ where: { marketplace: market, entityType: 'CAMPAIGN', date: { lte: from }, ...EXCLUDE_AMS_DAILY }, select: { id: true } }))
    if (!reaches) { for (const id of mine) impressions.set(id, null); continue }
    const sums = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: mine }, date: { gte: from }, ...EXCLUDE_AMS_DAILY }, _sum: { impressions: true } })
    const byId = new Map(sums.map((s) => [s.localEntityId, s._sum.impressions ?? 0]))
    for (const id of mine) impressions.set(id, byId.get(id) ?? 0)
  }

  const rowOf = new Map(rows.map((r) => [r.id, r]))
  const holdsOf = (id: string) => stopHolds.filter((h) => h.campaignId === id).map((h) => h.by)
  const facts: StateFacts[] = []
  for (const c of all) {
    const row = rowOf.get(c.campaignId)
    if (!row) continue
    const s = settingsOf.get(c.campaignId)!
    const prev = previous.get(c.campaignId)
    const status = String(row.status)
    // The stops in force.
    const groups: StockGroupFacts[] = stock.adGroups.filter((g) => g.campaign.id === c.campaignId).map((g) => ({
      status: g.status, risk: g.risk, recovered: g.recovered,
      products: g.products.map((p) => ({ productId: p.productId, sku: p.sku, units: p.units, inboundUnits: p.inboundUnits, leadTimeDays: p.leadTimeDays, arrivalAt: arrivals.get(p.productId)?.at ?? null, arrivalFrom: arrivals.get(p.productId)?.from ?? null })),
    }))
    const stockSide = c.side === 'product' ? stockStop(groups, now) : { stopped: false, notRecovered: false, cause: null }
    const book = links.filter((l) => l.refId === c.campaignId).map((l) => ({ l, b: books.get(l.playbookId) })).find(({ l, b }) => b && (l.kind === STOP_FLOOR_KIND || b.state === 'STOPPED'))
    const causes = [
      stockSide.cause,
      monthlyCapStop({ by: row.bidsSuppressedBy, at: row.bidsSuppressedAt }, holdsOf(c.campaignId), now),
      playbookStop(book?.b?.label ?? null),
      declaredStop(s.values.longStopUntil.value, now),
    ].filter((x): x is StopCause => !!x)
    // The last status change on record, and Amazon's report of one made outside Nexus when newer.
    const logged = changes.get(c.campaignId)
    const outside = drift.filter((d) => d.entityId === c.campaignId).sort((a, b) => b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime())[0]
    const last: StateFacts['lastStatusChange'] = outside && (!logged || outside.lastDetectedAt.getTime() > logged.at.getTime())
      ? { to: status, at: outside.lastDetectedAt, by: 'outside', who: 'Amazon (a change outside Nexus)' }
      : logged ? { to: logged.to, at: logged.at, ...changerOf(logged, brainApprovals) } : null
    // The brain's memory of its own pause, carried while that pause is the last change on record.
    const prevMemory = field<PauseMemory | null>(prev?.decision, 'memory') ?? null
    const asked = carried.get(c.campaignId)
    const brainPaused = last?.by === 'brain' && last.to === 'PAUSED'
    const memory = brainPaused
      ? (prevMemory ?? (asked?.action === 'pause' && asked.memory ? { ...asked.memory, pausedAt: last!.at.toISOString(), approvalId: asked.approvalId } : null))
      : null
    const approval = asked ? approvalOf.get(asked.approvalId) : undefined
    const askedState = !asked ? null : !approval ? 'declined' : ['pending', 'scheduled', 'executing'].includes(approval.status) ? 'waiting' : ['rejected', 'expired'].includes(approval.status) ? 'declined' : 'done'
    const stopMemory: StopMemorySnapshot = {
      savedPlacements: row.suppressedFromPlacements ?? null, savedStrategy: row.suppressedFromBiddingStrategy ? String(row.suppressedFromBiddingStrategy) : null,
      biddingStrategy: row.biddingStrategy ? String(row.biddingStrategy) : null, flooredKeywords: floored.get(c.campaignId) ?? 0, floorBy: row.bidsSuppressedAt ? row.bidsSuppressedBy ?? 'an engine' : null,
    }
    const prevSince = field<string | null>(prev?.decision, 'stopSince')
    const started = row.startDate && row.startDate.getTime() < row.createdAt.getTime() ? row.startDate : row.createdAt
    facts.push({
      campaignId: c.campaignId, name: row.name, productId: root, market, status, owner: c.side,
      lever: { effective: s.levers.state.effective, why: s.levers.state.why },
      pauseMinDays: Number(s.values.pauseMinDays.value), archiveDeadWeeks: Number(s.values.archiveDeadWeeks.value),
      causes, stockNotRecovered: stockSide.notRecovered,
      stopSince: causes.length && prevSince ? new Date(prevSince) : null,
      lastStatusChange: last, memory, stopMemory,
      asked: asked && askedState ? { action: asked.action, approvalId: asked.approvalId, state: askedState, at: approval?.decidedAt ?? (askedState === 'declined' ? approval?.expiresAt ?? new Date(asked.at) : new Date(asked.at)) } : null,
      impressions: c.side === 'product' ? impressions.get(c.campaignId) ?? null : null,
      ageDays: Math.floor((now.getTime() - started.getTime()) / DAY_MS),
      shadowPaused: prev?.action === 'pause' && prev.outcome === 'shadow',
      // The brain's own write that did not land, newer than the last change that did: it waits before trying again.
      brainMiss: (() => { const m = misses.get(c.campaignId); return m && (!last || m.at.getTime() > last.at.getTime()) ? m : null })(),
    })
  }
  const askedOut = new Map([...carried].map(([id, a]) => [id, { ...a, status: approvalOf.get(a.approvalId)?.status ?? null }]))
  return { productId: root, market, enrolled, facts, previous, asked: askedOut }
}
