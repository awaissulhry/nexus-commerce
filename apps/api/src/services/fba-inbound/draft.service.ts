/**
 * FBA shipment drafts (Owner 2026-10-08) — the Matrix "Send to FBA" dialog and Claude's plan tool fill ONE open draft per
 * business + From warehouse + Amazon market; the FBA shipments page (Fulfillment › Outbound) edits it, deletes it, and
 * sends it ("Send to Amazon"). Signatures: `contract.ts`. Wire shapes and words: `@nexus/shared/fba-send`.
 *
 * A draft is a FbaInboundPlanV2 row with status DRAFT AND a source ('matrix' | 'claude'); an older wizard row that
 * defaults to 'DRAFT' has no source and is never read here. A draft lives only in Nexus: no Amazon call, no hold (a
 * forgotten draft never blocks a sale — Owner D3). Its lines keep the SKU, the sealed cases per size and the loose units;
 * the Amazon SKU and the owners are read again at "Send to Amazon", which runs the same checks, holds and job as a plan
 * made at once (`prepareSend` / `commitSend`, send.service.ts).
 *
 * One open draft per From + To: every "add" and every From / To change takes a transaction-scoped advisory lock on that
 * key and reads the open draft inside it. Every change publishes `fba.plan_changed` (status DRAFT; a delete says
 * CANCELLED) so the page, the Matrix drawer and the Matrix footer re-read.
 */
import { Prisma } from '@prisma/client'
import { workspaceIdForQuery, workspaceKey } from '@nexus/database/workspace-context'
import {
  FBA_SEND_COPY, FBA_SEND_MAX_SKUS, FBA_SEND_MAX_UNITS_PER_SKU, lineCases, lineUnits, nextWorkingDay,
  type FbaCreateAnswer, type FbaDraftAddRequest, type FbaDraftSendRequest, type FbaDraftUpdateRequest, type FbaMixedBox,
  type FbaPlanView, type FbaSendLine, type FbaSendOwners,
} from '@nexus/shared/fba-send'
import { MAX_CASE_SIZES, MAX_UNITS_PER_CASE } from '@nexus/shared/stock-cases'
import prisma from '../../db.js'
import { amazonAccountIdFor } from '../listings/reported-sku.js'
import { setFbaOwnersIfUnset } from '../stock/stock-cases.service.js'
import { lineCaseCounts, openDraftOf, planViewIn } from './read.service.js'
import {
  afterSend, auditOwners, commitSend, draftLineOf, lockPlan, parseMixedBox, parseOwners, prepareSend, publishPlanChanged,
  romeToday, sendRefusal, words,
} from './send.service.js'
import { FbaSendError, type FbaActor, type FbaPlanSource } from './contract.js'

type Tx = Prisma.TransactionClient
type OwnersChanged = Awaited<ReturnType<typeof setFbaOwnersIfUnset>>

const TX_OPTIONS = { isolationLevel: 'ReadCommitted' as const, maxWait: 5_000, timeout: 30_000 }
const refused = (message: string) => new FbaSendError('REFUSED', message)

/* ── where a draft goes ───────────────────────────────────────────────────────────────────────── */

interface Target {
  location: { id: string; code: string }
  market: { code: string; marketplaceId: string; accountId: string }
}

/** From = an active WAREHOUSE by its code; To = an Amazon market of the business's Amazon account. */
async function resolveTarget(fromCode: unknown, marketCode: unknown): Promise<Target> {
  if (typeof fromCode !== 'string' || !fromCode.trim()) throw refused('`from` must name one of your warehouses (its code)')
  if (typeof marketCode !== 'string' || !marketCode.trim()) throw refused('`market` must name an Amazon market, e.g. IT')
  const code = marketCode.trim().toUpperCase()
  const [location, accountId, market] = await Promise.all([
    prisma.stockLocation.findFirst({ where: { code: fromCode.trim(), type: 'WAREHOUSE', isActive: true }, select: { id: true, code: true } }),
    amazonAccountIdFor(),
    prisma.marketplace.findFirst({ where: { channel: 'AMAZON', isActive: true, code, marketplaceId: { not: null } }, select: { code: true, marketplaceId: true } }),
  ])
  if (!location) throw refused(FBA_SEND_COPY.problem.notWarehouse)
  if (!accountId || !market?.marketplaceId) throw refused(FBA_SEND_COPY.problem.noAccount(code))
  return { location, market: { code: market.code, marketplaceId: market.marketplaceId, accountId } }
}

/** One open draft per business + From + To: two "add to draft" at once wait for each other here. */
async function lockDraftKey(tx: Tx, locationId: string, marketplaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-fba-draft', workspaceIdForQuery(), locationId, marketplaceId])}, 0))`
}

const draftName = (target: Target) => `Draft ${target.location.code} → Amazon ${target.market.code}`

/* ── the lines as sent ────────────────────────────────────────────────────────────────────────── */

const whole = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max

/**
 * The lines as sent, checked for shape only (stock is checked at "Send to Amazon"): each names a product of this business,
 * sealed cases per size `[{ unitsPerCase, cases }]` (each size once) and loose units, whole numbers. A parent with no
 * units stands for its variations (each with no units); a parent with units is refused (name its variations).
 */
async function checkedLines(raw: unknown): Promise<FbaSendLine[]> {
  if (!Array.isArray(raw)) throw refused('`lines` must be a list of { productId, cases, looseUnits }')
  const asked = raw.map((line) => {
    const l = line as { productId?: unknown; cases?: unknown; looseUnits?: unknown } | null
    if (!l || typeof l !== 'object' || typeof l.productId !== 'string' || !l.productId.trim()) throw refused('Every line names a productId')
    return { productId: l.productId.trim(), cases: l.cases, looseUnits: l.looseUnits }
  })
  const ids = [...new Set(asked.map((line) => line.productId))]
  if (ids.length !== asked.length) {
    const twice = asked.find((line, k) => asked.findIndex((other) => other.productId === line.productId) !== k)!
    throw refused(FBA_SEND_COPY.problem.listedTwice(twice.productId))
  }
  const [products, children] = ids.length === 0 ? [[], []] : await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true, isParent: true } }),
    prisma.product.findMany({ where: { parentId: { in: ids }, deletedAt: null }, select: { id: true, parentId: true }, orderBy: [{ sku: 'asc' }, { id: 'asc' }] }),
  ])
  const productOf = new Map(products.map((product) => [product.id, product]))
  const out: FbaSendLine[] = []
  const expanded: FbaSendLine[] = []
  for (const line of asked) {
    const product = productOf.get(line.productId)
    if (!product) throw new FbaSendError('NOT_FOUND', `Product not found: ${line.productId}`)
    const sku = product.sku
    let cases: FbaSendLine['cases'] = []
    if (line.cases != null) {
      if (!Array.isArray(line.cases) || line.cases.length > MAX_CASE_SIZES) throw refused(FBA_SEND_COPY.problem.invalidQuantity(sku))
      const seen = new Set<number>()
      cases = line.cases.map((c) => {
        const count = c as { unitsPerCase?: unknown; cases?: unknown } | null
        const units = count?.unitsPerCase
        if (!count || typeof units !== 'number' || !Number.isInteger(units) || units < 1 || units > MAX_UNITS_PER_CASE || seen.has(units) || !whole(count.cases, MAX_UNITS_PER_CASE)) {
          throw refused(FBA_SEND_COPY.problem.invalidQuantity(sku))
        }
        seen.add(units)
        return { unitsPerCase: units, cases: count.cases }
      })
    }
    const looseUnits = line.looseUnits == null ? 0 : line.looseUnits
    if (!whole(looseUnits, FBA_SEND_MAX_UNITS_PER_SKU)) throw refused(FBA_SEND_COPY.problem.invalidQuantity(sku))
    const checked: FbaSendLine = { productId: product.id, cases, looseUnits }
    if (lineUnits(checked) > FBA_SEND_MAX_UNITS_PER_SKU) throw refused(FBA_SEND_COPY.problem.tooManyUnits(sku))
    const own = children.filter((child) => child.parentId === product.id)
    if (product.isParent || own.length > 0) {
      if (lineUnits(checked) > 0) throw refused(`${sku}: a parent is never sent — name its variations`)
      for (const child of own) expanded.push({ productId: child.id, cases: [], looseUnits: 0 })
      continue
    }
    out.push(checked)
  }
  // A variation named itself keeps its own numbers; one only reached through its parent comes in with none.
  const named = new Set(out.map((line) => line.productId))
  for (const line of expanded) if (!named.has(line.productId)) { named.add(line.productId); out.push(line) }
  return out
}

/** A day as sent: YYYY-MM-DD (the shared rule refuses a day in the past at "Send to Amazon"). */
function parseDay(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value) return value
  }
  throw refused('`readyToShipOn` must be a day, YYYY-MM-DD')
}

/** Put one line in the draft (0 units allowed: the page keeps a SKU whose numbers are to come). */
async function putLine(tx: Tx, planRowId: string, line: FbaSendLine): Promise<void> {
  const data = {
    quantity: lineUnits(line),
    caseCounts: line.cases.filter((c) => c.cases > 0).sort((a, b) => b.unitsPerCase - a.unitsPerCase) as unknown as Prisma.InputJsonValue,
    looseUnits: line.looseUnits,
    msku: null, prepOwner: null, labelOwner: null, reservationId: null,
  }
  await tx.fbaInboundPlanLine.upsert({
    where: { planRowId_productId: workspaceKey({ planRowId, productId: line.productId }) },
    create: { planRowId, productId: line.productId, ...data },
    update: data,
  })
}

/** At most FBA_SEND_MAX_SKUS SKUs in one draft. */
async function checkSkuCount(tx: Tx, planRowId: string): Promise<void> {
  const count = await tx.fbaInboundPlanLine.count({ where: { planRowId } })
  if (count > FBA_SEND_MAX_SKUS) {
    throw new FbaSendError('REFUSED', FBA_SEND_COPY.problem.tooManySkus, [{ code: 'TOO_MANY_SKUS', message: FBA_SEND_COPY.problem.tooManySkus, productId: null, blocking: true }])
  }
}

/** Prep by / Labels by the person chose, remembered at once for the SKUs that had none (owners only). */
async function saveOwners(tx: Tx, owners: FbaSendOwners | null, productIds: readonly string[], who: FbaActor): Promise<OwnersChanged> {
  if (!owners || productIds.length === 0) return []
  return setFbaOwnersIfUnset(tx, { productIds: [...productIds], prepOwner: owners.prepOwner, labelOwner: owners.labelOwner, actor: who.actor })
}

/* ── add to draft ─────────────────────────────────────────────────────────────────────────────── */

/**
 * "Add to draft" (the Matrix dialog, Claude's tool): these lines go into the ONE open draft for this From + To, made
 * when none. A SKU already in it takes the new numbers; a line with 0 units takes the SKU out; `lines: []` only makes or
 * finds the draft (the page's "New draft"). No Amazon call, no hold. → the draft's planId.
 */
export async function addToDraft(req: FbaDraftAddRequest, who: FbaActor, source: FbaPlanSource): Promise<FbaCreateAnswer> {
  if (source !== 'matrix' && source !== 'claude') throw refused('Unknown plan source')
  if (!req || typeof req !== 'object') throw refused('Send the draft: from, market and lines')
  const target = await resolveTarget(req.from, req.market)
  const lines = await checkedLines(req.lines ?? [])
  const readyToShipOn = req.readyToShipOn == null ? null : parseDay(req.readyToShipOn)
  const mixedBox: FbaMixedBox | null = req.mixedBox == null ? null : parseMixedBox(req.mixedBox)
  const owners = req.owners == null ? null : parseOwners(req.owners)

  const outcome = await prisma.$transaction(async (tx) => {
    await lockDraftKey(tx, target.location.id, target.market.marketplaceId)
    let planId = await openDraftOf(tx, target.location.id, target.market.marketplaceId)
    const set: Prisma.FbaInboundPlanV2UpdateInput = { updatedAt: new Date() }
    if (readyToShipOn) set.readyToShipOn = new Date(`${readyToShipOn}T00:00:00.000Z`)
    if (mixedBox) set.mixedBox = mixedBox as unknown as Prisma.InputJsonValue
    if (!planId) {
      planId = (await tx.fbaInboundPlanV2.create({
        data: {
          status: 'DRAFT', currentStep: 'CREATE', source, createdBy: who.actor, name: draftName(target),
          channelConnectionId: target.market.accountId, marketplaceId: target.market.marketplaceId, sourceLocationId: target.location.id,
          steps: [] as unknown as Prisma.InputJsonValue,
          ...(readyToShipOn ? { readyToShipOn: new Date(`${readyToShipOn}T00:00:00.000Z`) } : {}),
          ...(mixedBox ? { mixedBox: mixedBox as unknown as Prisma.InputJsonValue } : {}),
        },
        select: { id: true },
      })).id
    } else {
      await tx.fbaInboundPlanV2.update({ where: { id: planId }, data: set })
    }
    for (const line of lines) {
      if (lineUnits(line) > 0) await putLine(tx, planId, line)
      else await tx.fbaInboundPlanLine.deleteMany({ where: { planRowId: planId, productId: line.productId } })
    }
    await checkSkuCount(tx, planId)
    const changed = await saveOwners(tx, owners, lines.filter((line) => lineUnits(line) > 0).map((line) => line.productId), who)
    await publishPlanChanged(tx, planId, 'DRAFT', null, lines.map((line) => line.productId))
    return { planId, owners: changed }
  }, TX_OPTIONS)
  await auditOwners(outcome.owners, who, outcome.planId)
  return { planId: outcome.planId }
}

/* ── edit a draft ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The FBA shipments page edits a DRAFT (it saves as the person types). Each field absent = keep. `lines` replaces every
 * line; a 0-unit line stays (a SKU added, its numbers to come). A From + To that already has another open draft →
 * DRAFT_EXISTS. Anything but a DRAFT → WRONG_STATE.
 */
export async function updateDraft(planId: string, req: FbaDraftUpdateRequest, who: FbaActor): Promise<FbaPlanView> {
  if (!req || typeof req !== 'object') throw refused('Send what changes: from, market, readyToShipOn, mixedBox, lines or owners')
  const current = await prisma.fbaInboundPlanV2.findFirst({ where: { id: planId, source: { not: null } }, select: { sourceLocationId: true, marketplaceId: true } })
  if (!current) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
  let target: Target | null = null
  if (req.from !== undefined || req.market !== undefined) {
    const [location, market] = await Promise.all([
      current.sourceLocationId ? prisma.stockLocation.findUnique({ where: { id: current.sourceLocationId }, select: { code: true } }) : null,
      current.marketplaceId ? prisma.marketplace.findFirst({ where: { channel: 'AMAZON', marketplaceId: current.marketplaceId }, select: { code: true } }) : null,
    ])
    target = await resolveTarget(req.from ?? location?.code, req.market ?? market?.code)
  }
  const lines = req.lines === undefined ? undefined : await checkedLines(req.lines)
  const readyToShipOn = req.readyToShipOn === undefined ? undefined : parseDay(req.readyToShipOn)
  const mixedBox = req.mixedBox === undefined ? undefined : req.mixedBox === null ? null : parseMixedBox(req.mixedBox)
  const owners = req.owners == null ? null : parseOwners(req.owners)

  const outcome = await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, planId)
    if (plan.status !== 'DRAFT') throw new FbaSendError('WRONG_STATE', `The plan is "${words(plan.status)}": only a draft can be changed.`)
    const data: Prisma.FbaInboundPlanV2UpdateInput = { updatedAt: new Date() }
    if (target && (target.location.id !== plan.sourceLocationId || target.market.marketplaceId !== plan.marketplaceId)) {
      await lockDraftKey(tx, target.location.id, target.market.marketplaceId)
      const other = await openDraftOf(tx, target.location.id, target.market.marketplaceId)
      if (other && other !== planId) throw new FbaSendError('DRAFT_EXISTS', FBA_SEND_COPY.draftExists(target.location.code, target.market.code))
      Object.assign(data, {
        sourceLocationId: target.location.id, marketplaceId: target.market.marketplaceId, channelConnectionId: target.market.accountId,
        name: draftName(target),
      })
    }
    if (readyToShipOn !== undefined) data.readyToShipOn = new Date(`${readyToShipOn}T00:00:00.000Z`)
    // null = back to the default box (MIXED_BOX_DEFAULT, read at Send).
    if (mixedBox !== undefined) data.mixedBox = mixedBox === null ? Prisma.DbNull : (mixedBox as unknown as Prisma.InputJsonValue)
    await tx.fbaInboundPlanV2.update({ where: { id: planId }, data })
    const before = plan.lines.map((line) => line.productId)
    if (lines !== undefined) {
      const keep = lines.map((line) => line.productId)
      await tx.fbaInboundPlanLine.deleteMany({ where: { planRowId: planId, productId: { notIn: keep } } })
      for (const line of lines) await putLine(tx, planId, line)
      await checkSkuCount(tx, planId)
    }
    const after = lines !== undefined ? lines.map((line) => line.productId) : before
    const changed = await saveOwners(tx, owners, after, who)
    await publishPlanChanged(tx, planId, 'DRAFT', null, [...before, ...after])
    return { view: await planViewIn(tx, planId), owners: changed }
  }, TX_OPTIONS)
  await auditOwners(outcome.owners, who, planId)
  return outcome.view!
}

/* ── delete a draft ───────────────────────────────────────────────────────────────────────────── */

/** "Delete draft": a DRAFT only (nothing at Amazon, no hold); a plan under way is cancelled instead. */
export async function deleteDraft(planId: string, _who: FbaActor): Promise<{ planId: string; deleted: true }> {
  await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, planId)
    if (plan.status !== 'DRAFT') throw new FbaSendError('WRONG_STATE', `The plan is "${words(plan.status)}": only a draft can be deleted — cancel the plan instead.`)
    await tx.fbaInboundPlanV2.delete({ where: { id: planId } }) // its lines go with it (ON DELETE CASCADE)
    await publishPlanChanged(tx, planId, 'CANCELLED', null, plan.lines.map((line) => line.productId))
  }, TX_OPTIONS)
  return { planId, deleted: true }
}

/* ── send a draft ─────────────────────────────────────────────────────────────────────────────── */

/**
 * "Send to Amazon": the draft's lines with units, checked again by the shared rule (free units, cases per size, the
 * Amazon listing, owners, boxes, the ship-from address), then ONE transaction on the locked draft (owners, holds, lines
 * with the Amazon SKU and owners, QUEUED, the frozen name, the event), then the job. A draft that is no longer a DRAFT
 * (sent by a second click) answers its planId and holds nothing again. A draft changed between the check and the lock
 * → WRONG_STATE (read it again).
 */
export async function sendDraft(planId: string, req: FbaDraftSendRequest | null | undefined, who: FbaActor): Promise<FbaCreateAnswer> {
  if (typeof planId !== 'string' || !planId.trim()) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
  const row = await prisma.fbaInboundPlanV2.findFirst({
    where: { id: planId, source: { not: null } },
    select: {
      id: true, status: true, sourceLocationId: true, marketplaceId: true, readyToShipOn: true, mixedBox: true,
      lines: { select: { productId: true, quantity: true, caseCounts: true, looseUnits: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!row) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
  if (row.status !== 'DRAFT') return { planId: row.id }
  const lines = row.lines.map(draftLineOf).filter((line) => lineCases(line) > 0 || line.looseUnits > 0)
  if (lines.length === 0) throw new FbaSendError('REFUSED', FBA_SEND_COPY.problem.noUnits, [{ code: 'NO_UNITS', message: FBA_SEND_COPY.problem.noUnits, productId: null, blocking: true }])
  const [location, market] = await Promise.all([
    row.sourceLocationId ? prisma.stockLocation.findUnique({ where: { id: row.sourceLocationId }, select: { code: true } }) : null,
    row.marketplaceId ? prisma.marketplace.findFirst({ where: { channel: 'AMAZON', marketplaceId: row.marketplaceId }, select: { code: true } }) : null,
  ])
  const asked = req && typeof req === 'object' ? req : {}
  const readyToShipOn = asked.readyToShipOn != null ? parseDay(asked.readyToShipOn)
    : row.readyToShipOn ? row.readyToShipOn.toISOString().slice(0, 10) : nextWorkingDay(romeToday())
  const storedBox = row.mixedBox && typeof row.mixedBox === 'object' && !Array.isArray(row.mixedBox) ? (row.mixedBox as unknown as FbaMixedBox) : null
  const mixedBox = asked.mixedBox != null ? parseMixedBox(asked.mixedBox) : storedBox
  const owners = asked.owners != null ? parseOwners(asked.owners) : null
  // A From or market that is gone names nothing: the shared rule refuses it (never the default warehouse).
  const prepared = await prepareSend({ lines, from: location?.code ?? '-', market: market?.code ?? '-', readyToShipOn, mixedBox, owners })

  const checked = JSON.stringify(row.lines.map((line) => [line.productId, line.quantity, lineCaseCounts(line.caseCounts)]))
  let outcome: { owners: OwnersChanged; sent: boolean }
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const plan = await lockPlan(tx, planId)
      if (plan.status !== 'DRAFT') return { owners: [], sent: false }
      const now = JSON.stringify(plan.lines
        .slice()
        .sort((a, b) => row.lines.findIndex((l) => l.productId === a.productId) - row.lines.findIndex((l) => l.productId === b.productId))
        .map((line) => [line.productId, line.quantity, lineCaseCounts(line.caseCounts)]))
      if (now !== checked) throw new FbaSendError('WRONG_STATE', 'The draft changed meanwhile: read it again.')
      const source = plan.source === 'claude' ? 'claude' : 'matrix'
      return { owners: await commitSend(tx, planId, prepared, who, source, row.lines.map((line) => line.productId)), sent: true }
    }, TX_OPTIONS)
  } catch (error) {
    throw sendRefusal(error, prepared)
  }
  if (outcome.sent) await afterSend(planId, outcome.owners, prepared, who)
  return { planId }
}
