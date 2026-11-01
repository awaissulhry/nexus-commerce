import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { pickRate } from '@nexus/factory-domain/costing/inputs'
import type { WaitingView } from '@nexus/factory-domain/costing/ledger/contracts'
import {
  datedFor,
  entryKeys,
  isProvisional,
  labourEntry,
  moveEntry,
  OVERHEAD_BASE_KINDS,
  overheadEntry,
  perMinuteOf,
  reversalEntry,
  scrapRecords,
  type CostingMethod,
  type EntryDraft,
  type PostedEntryFacts,
} from '@nexus/factory-domain/costing/ledger/entries'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { scrapFactsOf, scrapMaterials } from '../../production/scrap/store'
// B-W2b-53 (MES-128): scrap above a site's limit waits for the team leader's approval.
import { scrapApprovalStatesOf } from '../../production/scrap/over-limit'
// B-W2a-25: the subcontract source (a workshop's fee for the pieces back good).
import { subcontractCostPlan } from '../../purchasing/subcontracting/cost-source'
import { lockMethodInCommand, methodInForce } from '../method/method'
import {
  entryFacts,
  frozenStandards,
  lockedPeriods,
  lockWorkOrderCosts,
  overheadPctOf,
  ratesOf,
  readEntries,
  readWorkOrder,
  romeDay,
  standardFor,
  standardRef,
  unique,
  type CostedWorkOrder,
  type EntryFactsRow,
  type Reader,
} from './store'

/**
 * Posting a work order's cost ledger (B-W2a-21; FIN-026, FIN-027, FIN-038): ONE writer for every source, called by the
 * worker's handler after each stock move, scan and rework of the work order (./handlers.ts), by the catch-up route, and by
 * the standard's freeze (the receipts it values). It reads what the work order's sources say now and posts what the
 * ledger lacks, one entry per source event by its key (factory-domain costing/ledger entryKeys), so a repeat, a retried
 * job or a catch-up never posts twice:
 *
 *   stock moves of the work order (StockMove.workOrderId), once valued: ISSUE / RETURN → MATERIAL, SCRAP → SCRAP (a
 *     charge), PRODUCTION_RECEIPT → COMPLETION; a move's reversal → the reversal of its entry
 *   scans: each standing REPORT or CORRECTION with good garments → LABOUR (good × the operation's standard minutes × the
 *     cost per minute in force that day for its kind of work centre, never per person); one an UNDO or CORRECTION
 *     voided → the reversal of its LABOUR; its scrap → a SCRAP record per material (amount 0: the leather and its value)
 *   reworks DONE with scrap → a SCRAP record per material, with the scan that opened the rework; a rework opened by hand
 *     (an inspection, a nonconformance: no scan) names its rework order instead (B-W2b-22), and one not bundled apart
 *     takes the leather of its cell's bundles
 *   overhead at the company's % with each MATERIAL, stock SCRAP and LABOUR entry (none at 0 %); reversed with it
 * What cannot post yet is answered as `waiting`, in words: a move without a value, a day without a labour rate, another
 * currency, a rework of a cell nothing was cut for. An event of a locked month is posted dated now (and says so). The company's
 * costing method is written on every entry; a decided one is locked by the first entry (lockMethodInCommand).
 *
 * Inside the caller's command: postCostsInCommand(tools, workOrderId, scope); on its own: postWorkOrderCosts(caller, …).
 * Lock order: the work order's costing lock (one poster at a time), then the method's row when it locks.
 */

/**
 * The scans a subcontract receipt line wrote (B-W2b-10): its REPORT names the line; a CORRECTION adding a later receipt
 * carries the line's device-free client scan id (factory-domain production/scans/outside receiptLineClientId).
 */
function outsideScans(rows: readonly { readonly id: string; readonly clientScanId: string; readonly subcontractReceiptLineId: string | null }[]): Set<string> {
  return new Set(rows.filter((row) => row.subcontractReceiptLineId !== null || row.clientScanId.startsWith('receipt-line:')).map((row) => row.id))
}

/** Which sources to read: undefined reads every one (a catch-up); a list reads those ids only (an event's). */
export interface PostScope {
  readonly moveIds?: readonly string[]
  readonly scanIds?: readonly string[]
  readonly reworkIds?: readonly string[]
  /** B-W2a-25: subcontract orders whose pieces came back (purchasing/subcontracting/cost-source.ts). */
  readonly subcontractOrderIds?: readonly string[]
}

export interface Plan {
  readonly drafts: EntryDraft[]
  readonly waiting: WaitingView[]
}

const POSTED_REASONS = ['ISSUE', 'RETURN', 'SCRAP', 'PRODUCTION_RECEIPT'] as const
type PostedReason = (typeof POSTED_REASONS)[number]

const MOVE_COLUMNS = { id: true, reason: true, itemId: true, lotId: true, baseQuantity: true, occurredAt: true, reversalOfId: true, note: true, workOrderId: true } as const satisfies Prisma.StockMoveSelect

const asPosted = (draft: EntryDraft): EntryFactsRow => ({ ...draft, workOrderId: '' })

/** What the ledger lacks for the work order's sources (read only; ids from `ids`). */
export async function planCosts(db: Reader, workOrder: CostedWorkOrder, scope: PostScope | undefined, ids: () => string = newId): Promise<Plan> {
  const drafts: EntryDraft[] = []
  const waiting: WaitingView[] = []
  const existing = (await readEntries(db, [workOrder.id])).map(entryFacts)
  const byKey = new Map<string, EntryFactsRow>(existing.map((entry) => [entry.idempotencyKey, entry]))
  const reversed = new Set(existing.flatMap((entry) => (entry.reversalOfId ? [entry.reversalOfId] : [])))
  const add = (draft: EntryDraft) => {
    drafts.push(draft)
    byKey.set(draft.idempotencyKey, asPosted(draft))
    if (draft.reversalOfId) reversed.add(draft.reversalOfId)
  }
  const wait = (code: WaitingView['code'], sourceType: WaitingView['sourceType'], sourceId: string, words: string) => waiting.push({ code, sourceType, sourceId, words })
  const reverse = (entry: PostedEntryFacts, at: Date, reason: string, source: Parameters<typeof reversalEntry>[4]) => {
    if (reversed.has(entry.id)) return
    add(reversalEntry(ids(), entry, at, reason, source))
  }

  // ---- stock moves ------------------------------------------------------------------------------------------------------
  if (scope === undefined || scope.moveIds !== undefined) {
    const only = scope?.moveIds ? [...scope.moveIds] : null
    const moves = await db.stockMove.findMany({
      where: { workOrderId: workOrder.id, reason: { in: [...POSTED_REASONS] }, ...(only ? { OR: [{ id: { in: only } }, { reversalOfId: { in: only } }] } : {}) },
      select: MOVE_COLUMNS,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    })
    // A reversal names its original (read it when the event named only the reversal), and the reversals of these moves.
    const known = new Set(moves.map((move) => move.id))
    const originals = await db.stockMove.findMany({ where: { id: { in: unique(moves.map((move) => move.reversalOfId)).filter((id) => !known.has(id)) } }, select: MOVE_COLUMNS })
    const reversals = await db.stockMove.findMany({ where: { reversalOfId: { in: moves.filter((move) => move.reversalOfId === null).map((move) => move.id) }, id: { notIn: [...known] } }, select: MOVE_COLUMNS })
    const all = [...originals, ...moves, ...reversals].filter((move) => (POSTED_REASONS as readonly string[]).includes(move.reason))
    const values = new Map(
      (await db.stockValuation.findMany({ where: { moveId: { in: all.map((move) => move.id) } }, select: { moveId: true, valueAmount: true, unitCost: true, currency: true } })).map((row) => [row.moveId, row]),
    )
    const standards = await frozenStandards(db, [workOrder.companyId], unique(all.map((move) => move.itemId)))
    for (const move of all.filter((row) => row.reversalOfId === null)) {
      if (byKey.has(entryKeys.move(move.id))) continue
      const value = values.get(move.id)
      if (!value) {
        wait('NOT_VALUED', 'StockMove', move.id, `The ${move.reason.toLowerCase().replace('_', ' ')} move of ${move.baseQuantity.toString()} has no value yet: its cost posts once the stock ledger values it.`)
        continue
      }
      if (value.currency !== workOrder.currency) {
        wait('CURRENCY', 'StockMove', move.id, `The move is valued in ${value.currency}; the work order's cost is kept in ${workOrder.currency} (no exchange rates).`)
        continue
      }
      const standard = standardFor(standards, workOrder.companyId, move.itemId, romeDay(move.occurredAt), workOrder.currency)
      add(
        moveEntry(
          ids(),
          { id: move.id, reason: move.reason as PostedReason, itemId: move.itemId, baseQuantity: move.baseQuantity.toString(), occurredAt: move.occurredAt, valueAmount: value.valueAmount, unitCost: value.unitCost.toString() },
          standardRef(standard),
        ),
      )
    }
    for (const move of all.filter((row) => row.reversalOfId !== null)) {
      const key = entryKeys.move(move.id)
      if (byKey.has(key)) continue
      const original = byKey.get(entryKeys.move(move.reversalOfId!))
      if (!original) {
        if (!values.has(move.reversalOfId!)) wait('NOT_VALUED', 'StockMove', move.id, 'This reversal waits for the move it reverses, which has no value yet.')
        continue
      }
      reverse(original, move.occurredAt, `Stock move reversed${move.note ? `: ${move.note}` : '.'}`, { key, stockMoveId: move.id })
    }
  }

  // ---- scans ------------------------------------------------------------------------------------------------------------
  if (scope === undefined || scope.scanIds !== undefined) {
    const only = scope?.scanIds ? [...scope.scanIds] : null
    const SCAN = { id: true, kind: true, correctsId: true, goodQuantity: true, scrapQuantity: true, serverTime: true, workOrderOperationId: true, bundleId: true, reason: true, subcontractReceiptLineId: true, clientScanId: true } as const
    const scans = await db.operationScan.findMany({ where: { workOrderId: workOrder.id, ...(only ? { id: { in: only } } : {}) }, select: SCAN, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
    // The scans an UNDO or CORRECTION in the list voids, and the voiders of the listed ones.
    const named = await db.operationScan.findMany({ where: { id: { in: unique(scans.map((scan) => scan.correctsId)).filter((id) => !scans.some((scan) => scan.id === id)) } }, select: SCAN })
    const voiders = await db.operationScan.findMany({ where: { correctsId: { in: [...scans, ...named].map((scan) => scan.id) } }, select: SCAN })
    const voidedBy = new Map(voiders.map((scan) => [scan.correctsId!, scan]))
    // W2b (B-W2b-10): an outside operation reported from a subcontract receipt line (and a correction of such a report)
    // is the workshop's work: no labour (its fee is the SUBCONTRACT entry); its scrap is recorded as any scan's.
    const outside = outsideScans([...named, ...scans, ...voiders])
    const reports = [...named, ...scans].filter((scan) => scan.kind === 'REPORT' || scan.kind === 'CORRECTION')
    const operations = new Map(
      (await db.workOrderOperation.findMany({ where: { workOrderId: workOrder.id }, select: { id: true, seq: true, code: true, standardMinutes: true, workCentreId: true } })).map((row) => [row.id, row]),
    )
    const centres = new Map((await db.workCentre.findMany({ where: { id: { in: unique([...operations.values()].map((row) => row.workCentreId)) } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind]))
    const rates = reports.some((scan) => scan.goodQuantity > 0) ? await ratesOf(db, workOrder.companyId) : []
    const withScrap = reports.filter((scan) => scan.scrapQuantity > 0)
    const bundles = withScrap.length === 0 ? [] : await db.bundle.findMany({ where: { id: { in: unique(withScrap.map((scan) => scan.bundleId)) } }, select: { id: true, workOrderId: true, workOrderSizeId: true, part: true, cutLogIds: true } })
    const facts = bundles.length === 0 ? null : await scrapFactsOf(db, workOrder.id, bundles)
    const standards = facts ? await frozenStandards(db, [workOrder.companyId], [...facts.items.keys()]) : new Map()
    // B-W2b-53 (MES-128): a scan's scrap above its site's limit posts only once the team leader approved it.
    const approvals = withScrap.length === 0 ? new Map<string, string | null>() : await scrapApprovalStatesOf(db, withScrap.map((scan) => scan.id))
    for (const scan of reports) {
      const voider = voidedBy.get(scan.id)
      const operation = operations.get(scan.workOrderOperationId)
      const why = voider ? `${voider.kind === 'UNDO' ? 'Scan undone' : 'Scan corrected'}${voider.reason ? `: ${voider.reason}` : '.'}` : ''
      // Labour.
      const labour = byKey.get(entryKeys.scan(scan.id))
      if (voider) {
        if (labour) reverse(labour, voider.serverTime, why, { key: entryKeys.reversal(labour.id), operationScanId: voider.id })
      } else if (!labour && scan.goodQuantity > 0 && operation && !outside.has(scan.id)) {
        const kind = centres.get(operation.workCentreId)
        const day = romeDay(scan.serverTime)
        const rate = kind ? pickRate(rates, kind, workOrder.companyId, day) : null
        const perMinute = rate ? perMinuteOf(rate) : null
        if (!rate || perMinute === null) wait('NO_RATE', 'OperationScan', scan.id, `No usable cost per minute for ${kind ?? 'this kind of'} work centres is in force on ${day}: the labour of operation ${operation.seq} posts once one is set.`)
        else if (rate.currency !== workOrder.currency) wait('CURRENCY', 'OperationScan', scan.id, `The ${kind} cost per minute is in ${rate.currency}; the work order's cost is kept in ${workOrder.currency}.`)
        else add(labourEntry(ids(), scan, operation.standardMinutes.toString(), perMinute, workOrder.currency))
      }
      // The garments it scrapped: a record per material.
      if (scan.scrapQuantity === 0) continue
      const records = [...byKey.values()].filter((entry) => entry.idempotencyKey.startsWith(`scan-scrap:${scan.id}:`))
      if (voider) {
        for (const record of records) reverse(record, voider.serverTime, why, { key: entryKeys.reversal(record.id), operationScanId: voider.id })
        continue
      }
      if (records.length > 0 || !facts) continue
      // B-W2b-53: waiting scrap waits; refused scrap never posts (its counts are put right by a correction).
      if (approvals.get(scan.id) === 'REFUSED') continue
      if (approvals.get(scan.id) === 'WAITING') {
        wait('SCRAP_APPROVAL', 'OperationScan', scan.id, "The garments it scrapped are above the site's limit for one scan: the scrap is recorded once the team leader approves it.")
        continue
      }
      const bundle = bundles.find((row) => row.id === scan.bundleId)
      const shares = bundle ? scrapMaterials(facts, bundle, scan.scrapQuantity) : []
      if (shares.some((share) => share.value === null)) {
        wait('NOT_VALUED', 'OperationScan', scan.id, 'The leather of the garments it scrapped was issued without a value yet: the scrap is recorded once the issue is valued.')
        continue
      }
      for (const draft of scrapRecords(ids, shares, {
        occurredAt: scan.serverTime,
        operationScanId: scan.id,
        key: (itemId) => entryKeys.scanScrap(scan.id, itemId),
        reason: `${scan.scrapQuantity} garment(s) scrapped at operation ${operation?.seq ?? ''} ${operation?.code ?? ''}`.trim(),
        currency: workOrder.currency,
      }, (itemId) => standardRef(standardFor(standards, workOrder.companyId, itemId, romeDay(scan.serverTime), workOrder.currency)))) {
        add(draft)
      }
    }
  }

  // ---- reworks that ended in scrap -------------------------------------------------------------------------------------
  if (scope === undefined || scope.reworkIds !== undefined) {
    const only = scope?.reworkIds ? [...scope.reworkIds] : null
    const reworks = await db.reworkOrder.findMany({
      where: { workOrderId: workOrder.id, status: 'DONE', scrapQuantity: { gt: 0 }, ...(only ? { id: { in: only } } : {}) },
      select: { id: true, bundleId: true, workOrderSizeId: true, sourceScanId: true, scrapQuantity: true, doneAt: true, reworkAtOperationId: true },
      orderBy: { id: 'asc' },
    })
    const open = reworks.filter((rework) => ![...byKey.keys()].some((key) => key.startsWith(`rework-scrap:${rework.id}:`)))
    const BUNDLE = { id: true, workOrderId: true, workOrderSizeId: true, part: true, cutLogIds: true } as const
    const bundles = await db.bundle.findMany({ where: { id: { in: unique(open.map((rework) => rework.bundleId)) } }, select: BUNDLE })
    // B-W2b-22 (Z9:03): a rework not bundled apart (opened by hand on a cell) scraps whole garments of its cell: per part,
    // the leather of that part's bundles of the cell (a whole-garment bundle is the part null), read as one bundle each.
    const cellIds = unique(open.filter((rework) => rework.bundleId === null).map((rework) => rework.workOrderSizeId))
    const cellBundles = cellIds.length === 0 ? [] : await db.bundle.findMany({ where: { workOrderId: workOrder.id, workOrderSizeId: { in: cellIds } }, select: BUNDLE })
    const partsOfCell = (cellId: string) =>
      unique(cellBundles.filter((row) => row.workOrderSizeId === cellId).map((row) => row.part ?? '')).map((part) => {
        const mine = cellBundles.filter((row) => row.workOrderSizeId === cellId && (row.part ?? '') === part)
        return { id: mine[0]!.id, workOrderId: workOrder.id, workOrderSizeId: cellId, part: part === '' ? null : part, cutLogIds: unique(mine.flatMap((row) => row.cutLogIds)) }
      })
    const facts = bundles.length + cellBundles.length === 0 ? null : await scrapFactsOf(db, workOrder.id, [...bundles, ...cellBundles])
    const standards = facts ? await frozenStandards(db, [workOrder.companyId], [...facts.items.keys()]) : new Map()
    for (const rework of open) {
      const named = rework.bundleId ? bundles.filter((row) => row.id === rework.bundleId) : partsOfCell(rework.workOrderSizeId)
      const cut = named.filter((bundle) => bundle.cutLogIds.length > 0)
      if (cut.length === 0 || !facts) {
        wait('NO_SCAN', 'ReworkOrder', rework.id, "This rework's scrap has no cut leather to name: nothing of its garments' cell was cut into bundles yet, so the ledger cannot say which hides it lost (it is recorded once the cell is cut).")
        continue
      }
      const shares = cut.flatMap((bundle) => scrapMaterials(facts, bundle, rework.scrapQuantity))
      if (shares.some((share) => share.value === null)) {
        wait('NOT_VALUED', 'ReworkOrder', rework.id, 'The leather of the garments it scrapped was issued without a value yet: the scrap is recorded once the issue is valued.')
        continue
      }
      const at = rework.doneAt ?? new Date()
      for (const draft of scrapRecords(ids, shares, {
        occurredAt: at,
        // A rework opened by hand has no scan: the entry names its rework order (the …_w2b_guards cost-entry check).
        operationScanId: rework.sourceScanId,
        key: (itemId) => entryKeys.reworkScrap(rework.id, itemId),
        sourceType: 'ReworkOrder',
        sourceId: rework.id,
        reason: `${rework.scrapQuantity} garment(s) scrapped in rework`,
        currency: workOrder.currency,
      }, (itemId) => standardRef(standardFor(standards, workOrder.companyId, itemId, romeDay(at), workOrder.currency)))) {
        add(draft)
      }
    }
  }

  // ---- subcontract work (B-W2a-25): a workshop's fee for the pieces back good -------------------------------------------
  if (scope === undefined || scope.subcontractOrderIds !== undefined) {
    const planned = await subcontractCostPlan(db, workOrder, scope?.subcontractOrderIds ?? null, [...byKey.values()], ids)
    for (const draft of planned.drafts) if (!byKey.has(draft.idempotencyKey)) add(draft)
    waiting.push(...planned.waiting)
  }

  // ---- overhead, applied with what posts now (and reversed with it) -----------------------------------------------------
  if (drafts.length > 0) {
    const pct = await overheadPctOf(db, workOrder.companyId)
    for (const draft of [...drafts]) {
      if (draft.reversalOfId === null) {
        if (pct === null || !OVERHEAD_BASE_KINDS.includes(draft.kind)) continue
        const overhead = overheadEntry(ids(), draft, pct)
        if (overhead && !byKey.has(overhead.idempotencyKey)) add(overhead)
      } else {
        const applied = byKey.get(entryKeys.overhead(draft.reversalOfId))
        if (applied) reverse(applied, draft.occurredAt, `With the entry it was applied on: ${draft.reason ?? 'reversed'}`, { key: entryKeys.reversal(applied.id), sourceType: 'WorkOrderCostEntry', sourceId: draft.reversalOfId })
      }
    }
  }
  return { drafts, waiting }
}

/** A posted entry as a command answers it (plain JSON: its time as text). */
export interface PostedEntry extends Omit<EntryDraft, 'occurredAt'> {
  readonly occurredAt: string
  readonly workOrderId: string
  readonly currency: string
  readonly method: CostingMethod
}

export interface PostOutcome {
  readonly posted: PostedEntry[]
  readonly waiting: WaitingView[]
  readonly method: CostingMethod
}

/** Entries that name another draft go in after it: depth 0 first (the trigger reads an original or a source entry). */
function layers(drafts: readonly EntryDraft[]): EntryDraft[][] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]))
  const depth = (draft: EntryDraft): number => {
    const parent = draft.reversalOfId ?? (draft.sourceType === 'WorkOrderCostEntry' ? draft.sourceId : null)
    return parent && byId.has(parent) ? depth(byId.get(parent)!) + 1 : 0
  }
  const out: EntryDraft[][] = []
  for (const draft of drafts) (out[depth(draft)] ??= []).push(draft)
  return out.filter((layer) => layer !== undefined)
}

/**
 * Posts what the work order's sources lack, inside the caller's command (its audit row and event included). The
 * caller's permission is its own business (the handler is the system; the routes check costing.ledger.manage).
 */
export async function postCostsInCommand(tools: CommandTools, workOrderId: string, scope?: PostScope): Promise<PostOutcome> {
  const { tx, now } = tools
  if (!('tenantId' in tools.context)) throw new NotFoundError('Work order not found.')
  await lockWorkOrderCosts(tx, tools.context.tenantId, workOrderId)
  const workOrder = await readWorkOrder(tx, workOrderId)
  if (!workOrder) throw new NotFoundError('Work order not found.')
  const plan = await planCosts(tx, workOrder, scope)
  const waiting = [...plan.waiting]
  if (plan.drafts.length === 0) {
    tools.audit({ action: 'costing.postCosts', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { posted: 0, waiting: waiting.length } })
    return { posted: [], waiting, method: (await methodInForce(tx, workOrder.companyId)).method }
  }

  // Dating: an event of a locked month is posted now; while today is locked too it waits, with what names it.
  const locks = await lockedPeriods(tx, workOrder.companyId)
  const skipped = new Set<string>()
  const dated: EntryDraft[] = []
  for (const draft of plan.drafts) {
    const parent = draft.reversalOfId ?? (draft.sourceType === 'WorkOrderCostEntry' ? draft.sourceId : null)
    const when = datedFor(draft.occurredAt, now, locks)
    if (when === null || (parent !== null && skipped.has(parent))) {
      skipped.add(draft.id)
      if (when === null) waiting.push({ code: 'LOCKED', sourceType: draft.stockMoveId ? 'StockMove' : draft.operationScanId ? 'OperationScan' : 'WorkOrderCostEntry', sourceId: draft.stockMoveId ?? draft.operationScanId ?? draft.id, words: 'Its day and today are both in a locked period: it posts when the period opens.' })
      continue
    }
    dated.push(when.note ? { ...draft, occurredAt: when.at, reason: draft.reason ? `${draft.reason} ${when.note}` : when.note } : draft)
  }
  const method = dated.length > 0 ? await lockMethodInCommand(tools, workOrder.companyId) : (await methodInForce(tx, workOrder.companyId)).method
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  for (const layer of layers(dated)) {
    await tx.workOrderCostEntry.createMany({
      data: layer.map((draft) => ({
        ...draft,
        companyId: workOrder.companyId,
        siteId: workOrder.siteId,
        workOrderId: workOrder.id,
        currency: workOrder.currency,
        costingMethod: method,
        createdAt: now,
        createdById,
      })),
    })
  }
  tools.audit({
    action: 'costing.postCosts',
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: {
      posted: dated.length,
      waiting: waiting.length,
      method,
      provisional: isProvisional(method),
      entries: dated.map((draft) => ({ id: draft.id, kind: draft.kind, key: draft.idempotencyKey, reversalOfId: draft.reversalOfId, amount: markMoney('cost', draft.amount) })),
    },
  })
  if (dated.length > 0) {
    tools.emit({
      type: 'work_order_cost.posted',
      subject: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: { workOrderId: workOrder.id, number: workOrder.number, entryIds: dated.map((draft) => draft.id), kinds: unique(dated.map((draft) => draft.kind)), reversals: dated.filter((draft) => draft.reversalOfId !== null).length },
    })
  }
  return { posted: dated.map((draft) => ({ ...draft, occurredAt: toUtcIso(draft.occurredAt), workOrderId: workOrder.id, currency: workOrder.currency, method })), waiting, method }
}

/**
 * Posts the work order's ledger in a command of its own, when anything is to post: a dry plan first with the caller's
 * client (most events post nothing: a transfer, a scan posted already), so no empty command writes an audit row.
 */
export async function postWorkOrderCosts(
  caller: CommandCaller,
  workOrderId: string,
  options: { readonly idempotencyKey?: string | undefined; readonly causationId?: string; readonly scope?: PostScope } = {},
): Promise<PostOutcome & { readonly replayed: boolean }> {
  const dry = await caller.withClient(async (db) => {
    const workOrder = await readWorkOrder(db, workOrderId)
    return workOrder ? { workOrder, plan: await planCosts(db, workOrder, options.scope) } : null
  })
  if (!dry) throw new NotFoundError('Work order not found.')
  if (dry.plan.drafts.length === 0) {
    return { posted: [], waiting: dry.plan.waiting, method: await caller.withClient(async (db) => (await methodInForce(db, dry.workOrder.companyId)).method), replayed: false }
  }
  const { result, replayed } = await command(
    caller,
    { name: 'costing.postCosts', idempotencyKey: options.idempotencyKey, input: { workOrderId, scope: options.scope ?? null }, ...(options.causationId ? { causationId: options.causationId } : {}) },
    (tools) => postCostsInCommand(tools, workOrderId, options.scope),
  )
  return { ...result, replayed }
}

