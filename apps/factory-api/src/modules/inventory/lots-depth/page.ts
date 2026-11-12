import type { FactoryClient } from '@nexus/factory-db'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { attributeKeysFor } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { CAUSE_WORDS, lifecycleFor, type LifecycleCause, type LotLifecycle, type LotQuality } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { daysLeft, documentState, incomingCheck, separationCheck, type IncomingFacts } from '@nexus/factory-domain/inventory/lots-depth/page'
import { INVENTORY_LOTS_MANAGE, INVENTORY_TRACE_REPORT } from '@nexus/factory-domain/inventory/lots-depth/permissions'
import { familyRefusal } from '@nexus/factory-domain/inventory/lots-depth/split'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { fixed, locatedBy } from '../stock/read-kit'
import type { LotView } from './contract'
import { factsOf, familyOf, lotFor, namesOf, type LotData } from './store'

/**
 * The lot page's W2b facts (B-W2b-313; SCM-238; design warehouse.lots record: lt-facts "W2b attributes", lt-release
 * "incoming inspection passed (W2b)", lt-status "the person who received the lot cannot release it (W2b)", lt-stock
 * "depleted: 'Nothing left · depleted 3 Nov'"; lt-metrics "Documents expiring in 30 days (W2b)"). GET
 * /inventory/lots/:lotId/depth, inventory.stock.view on the lot's company and site, read only; W1's GET /inventory/lots/:id
 * keeps the stock per place and the trace, the lab's GET /quality/lots/:id the release checklist.
 *
 *   lifecycle    the state, since when, what the ledger says it should be (a difference: a move the handler has not
 *                handled yet), its history from the audit rows: the lifecycle's own moves, the quality decisions that moved
 *                it in the database, the splits
 *   attributes   the kind's keys and the values (SCM-185), editable with inventory.lots.manage
 *   family       the lot it was split from and the lots split from it, each with its stock
 *   incoming     did it pass its incoming inspection (a child lot: its parent's inspections count)
 *   separation   who received it and who decided, and whether the viewer may release it (Owner answer W3)
 *   documents    its ACTIVE documents (a child's: also its parent's), each VALID, NO_END, EXPIRING (30 days) or EXPIRED
 */

const QUALITY_ACTIONS = ['quality.lots.release', 'quality.lots.unblock', 'quality.lots.reject', 'quality.lots.block'] as const
const SPLIT_ACTIONS = ['inventory.splitLot', 'inventory.regroupLot', 'inventory.lotMadeBySplit'] as const
const QUALITY_TO: Readonly<Record<string, LotLifecycle>> = { 'quality.lots.release': 'RELEASED', 'quality.lots.unblock': 'RELEASED', 'quality.lots.reject': 'BLOCKED', 'quality.lots.block': 'BLOCKED' }
const QUALITY_WORDS: Readonly<Record<string, string>> = {
  'quality.lots.release': 'Released by quality.',
  'quality.lots.unblock': 'Released again after a block.',
  'quality.lots.reject': 'Rejected by quality.',
  'quality.lots.block': 'Blocked by quality.',
}
const SPLIT_WORDS: Readonly<Record<string, string>> = {
  'inventory.splitLot': 'Hides went into child lots (shade groups).',
  'inventory.regroupLot': 'Hides moved between the lots of the family.',
  'inventory.lotMadeBySplit': 'Made by a split, from the lot it keeps as its parent.',
}

type History = LotView['lifecycle']['history']

async function historyOf(client: FactoryClient, lot: LotData): Promise<History> {
  const rows = await client.auditLog.findMany({
    where: { recordType: 'Lot', recordId: lot.id, action: { in: ['inventory.lotLifecycle', ...QUALITY_ACTIONS, ...SPLIT_ACTIONS] } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: { at: true, action: true, audience: true, before: true, after: true },
    take: 200,
  })
  return rows.map((row) => {
    const before = (row.before ?? {}) as { lifecycle?: LotLifecycle }
    const after = (row.after ?? {}) as { lifecycle?: LotLifecycle; cause?: LifecycleCause }
    if (row.action === 'inventory.lotLifecycle') {
      return { at: toUtcIso(row.at), kind: 'LIFECYCLE' as const, from: before.lifecycle ?? null, to: after.lifecycle ?? null, cause: after.cause ?? null, action: row.action, audience: row.audience, words: after.cause ? CAUSE_WORDS[after.cause] : 'Lifecycle changed.' }
    }
    if ((QUALITY_ACTIONS as readonly string[]).includes(row.action)) {
      return { at: toUtcIso(row.at), kind: 'QUALITY' as const, from: null, to: QUALITY_TO[row.action] ?? null, cause: row.action.endsWith('release') || row.action.endsWith('unblock') ? ('RELEASE' as const) : ('BLOCK' as const), action: row.action, audience: row.audience, words: QUALITY_WORDS[row.action] ?? row.action }
    }
    return { at: toUtcIso(row.at), kind: 'SPLIT' as const, from: null, to: null, cause: null, action: row.action, audience: row.audience, words: SPLIT_WORDS[row.action] ?? row.action }
  })
}

const ref = (lot: LotData) => ({ id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, lifecycle: lot.lifecycle as LotLifecycle, shade: lot.shade })

/** The lot page's W2b facts, read in the caller's scope. */
export async function lotViewOf(client: FactoryClient, lot: LotData, context: OfficeContext, today: string): Promise<LotView> {
  const { parent, children } = await familyOf(client, lot)
  const familyIds = [parent.id, ...children.map((child) => child.id)]
  const [facts, hideStock, history, inspections, documents] = await Promise.all([
    factsOf(client, familyIds),
    locatedBy(client, 'hideId', { lotId: { in: familyIds }, hideId: { not: null } }),
    historyOf(client, lot),
    client.incomingInspection.findMany({
      where: { lotId: { in: lot.parentLotId ? [lot.id, lot.parentLotId] : [lot.id] } },
      select: { id: true, lotId: true, number: true, status: true, computedResult: true, overrideReason: true, acceptedQuantity: true, rejectedQuantity: true, toSortQuantity: true, decidedAt: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    client.lotDocument.findMany({
      where: { lotId: { in: lot.parentLotId ? [lot.id, lot.parentLotId] : [lot.id] }, status: 'ACTIVE' },
      select: { id: true, lotId: true, kind: true, fileId: true, validTo: true },
      orderBy: [{ validTo: 'asc' }, { id: 'asc' }],
    }),
  ])
  // Hides in stock per lot of the family: a hide's lot is fixed, so the hide rows of a lot are its own.
  const hideRows = await client.hide.findMany({ where: { lotId: { in: familyIds } }, select: { id: true, lotId: true } })
  const hidesInStock = new Map<string, number>()
  for (const hide of hideRows) if (hideStock.get(hide.id)?.onHand.greaterThan(0)) hidesInStock.set(hide.lotId, (hidesInStock.get(hide.lotId) ?? 0) + 1)
  const own = facts.get(lot.id)!
  const actor = actorOf(context)
  const mayManage = can(actor, INVENTORY_LOTS_MANAGE, { companyId: lot.companyId, siteId: lot.siteId })
  const refusal = familyRefusal({ code: parent.code, qualityStatus: parent.qualityStatus, tracking: parent.item.tracking })
  const names = await namesOf(client, [lot.createdById, lot.qualityDecidedById])
  const separation = separationCheck({ qualityStatus: lot.qualityStatus, receivedById: lot.createdById, decidedById: lot.qualityDecidedById, viewerId: context.actorId })
  const person = (id: string | null) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
  const incoming = incomingCheck(
    inspections.map((row): IncomingFacts => ({
      number: row.number,
      status: row.status,
      computedResult: row.computedResult,
      overrideReason: row.overrideReason,
      accepted: row.acceptedQuantity?.toString() ?? null,
      rejected: row.rejectedQuantity?.toString() ?? null,
      toSort: row.toSortQuantity?.toString() ?? null,
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      createdAt: toUtcIso(row.createdAt),
    })),
  )
  const documentRows = documents.map((row) => {
    const validTo = row.validTo ? row.validTo.toISOString().slice(0, 10) : null
    return { id: row.id, kind: row.kind, fileId: row.fileId, validTo, state: documentState(validTo, today), daysLeft: validTo ? daysLeft(validTo, today) : null, from: row.lotId === lot.id ? ('LOT' as const) : ('PARENT' as const) }
  })
  const state = lot.lifecycle as LotLifecycle
  const lastTo = [...history].reverse().find((row) => row.to === state)
  const depleted = state === 'DEPLETED' ? ([...history].reverse().find((row) => row.kind === 'LIFECYCLE' && row.to === 'DEPLETED') ?? null) : null
  return {
    lot: {
      id: lot.id,
      code: lot.code,
      companyId: lot.companyId,
      siteId: lot.siteId,
      version: lot.version,
      item: lot.item,
      colour: lot.itemColour,
      shade: lot.shade,
      qualityStatus: lot.qualityStatus,
      lifecycle: state,
      onHand: fixed(own.onHand),
      hidesInStock: hidesInStock.get(lot.id) ?? 0,
    },
    lifecycle: { state, since: lastTo?.at ?? toUtcIso(lot.createdAt), depletedAt: depleted?.at ?? null, expected: lifecycleFor(lot.qualityStatus as LotQuality, own), history },
    attributes: { kind: lot.item.kind, keys: [...attributeKeysFor(lot.item.kind)], values: (lot.attributes ?? {}) as LotView['attributes']['values'], canEdit: mayManage && lot.qualityStatus !== 'REJECTED' },
    family: {
      parent: lot.parentLotId ? ref(parent) : null,
      children: (lot.parentLotId ? [] : children).map((child) => ({ ...ref(child), onHand: fixed(facts.get(child.id)?.onHand), hidesInStock: hidesInStock.get(child.id) ?? 0 })),
    },
    incoming: {
      ...incoming,
      inspections: inspections.map((row) => ({ id: row.id, number: row.number, status: row.status, result: row.computedResult, decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null, from: row.lotId === lot.id ? ('LOT' as const) : ('PARENT' as const) })),
    },
    separation: { ...separation, receivedBy: person(lot.createdById), decidedBy: lot.qualityStatus === 'QUARANTINE' ? null : person(lot.qualityDecidedById) },
    documents: { rows: documentRows, expiring: documentRows.filter((row) => row.state === 'EXPIRING').length, expired: documentRows.filter((row) => row.state === 'EXPIRED').length },
    may: { manage: mayManage, split: mayManage && refusal === null, report: can(actor, INVENTORY_TRACE_REPORT, { companyId: lot.companyId, siteId: lot.siteId }) },
    splitRefusal: refusal,
  }
}

/** GET /inventory/lots/:lotId/depth. */
export async function readLotView(caller: CommandCaller, lotId: string): Promise<LotView> {
  const { lot, context } = await lotFor(caller, lotId)
  return caller.withClient((client) => lotViewOf(client, lot, context, businessDate(serverClock.now())))
}
