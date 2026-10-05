/**
 * MCP full control 08 S6 — stock changes in Nexus: set a count, move units between warehouses, run a stock count and
 * reconcile it, hold units, and keep the list of own warehouses.
 *
 * Every tool here is a change: its handler is a dry run (it reads, it never writes), and `execute` runs only after a
 * person approved it in Nexus (approval-gate.service.ts), through the services the stock page uses
 * (services/stock/*, stock-level, cycle-count). Each preview names what it would do row by row (20 rows, then
 * totals) and a fingerprint of every row (`basis`), and the gate refuses an approval whose rows moved since — stock
 * moves with every sale.
 *
 * Never: an Amazon FBA location (Amazon's number; only the FBA inventory sync writes it) or a Shopify location
 * (Shopify's own number) is changed, counted or held here. A product that sells from another business's shared stock
 * is never held on own stock. Nothing names another business: the business is the caller's (call-tool.ts).
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { computeLocationAdjustment, LocationAdjustmentError } from '../../location-adjustment.js'
import { adjustOneLocation, ALLOWED_ADJUST_REASONS, type AdjustReason } from '../../stock/location-adjust.service.js'
import { placeHold, PooledHoldRefusal, releaseHold } from '../../stock/stock-hold.service.js'
import { createStockLocation, deactivateStockLocation, LOCATION_CODE, LocationWriteError, updateStockLocation } from '../../stock/location-write.service.js'
import { transferStock } from '../../stock-level.service.js'
import { cancelCycleCount, completeCycleCount, createCycleCount, ignoreItem, reconcileItem, recordCount, startCycleCount } from '../../cycle-count.service.js'
import { isProtectedStockLocation } from '../../default-stock-location.js'
import { pooledNow } from '../../stock-pool/pool-guard.js'
import { previewSwitch, switchProducts } from '../../stock-pool/pool-links.service.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../../lib/workspace-context.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'

const PREVIEW_LINES = 20
const DAY_MS = 86_400_000
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const listed = (lines: string[]) => (lines.length > 5 ? `${lines.slice(0, 5).join('; ')}; and ${lines.length - 5} more` : lines.join('; '))

type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

const LOCATION_NOT_FOUND = 'Location not found: see stock-locations for this business\'s location codes'
const LOCATION_ARG = z.string().trim().min(1).max(30)

interface LocationRow { id: string; code: string; name: string; type: string; isActive: boolean; warehouseId: string | null }

/**
 * The locations a request names, by code, in the caller's business — as typed, or in upper case (codes are created
 * upper case). Keyed by the code as the request wrote it. One unknown code refuses the request.
 */
async function locationsByCode(codes: string[]): Promise<Map<string, LocationRow> | Refusal> {
  const wanted = [...new Set(codes)]
  const rows = await prisma.stockLocation.findMany({
    where: { code: { in: [...new Set([...wanted, ...wanted.map((c) => c.toUpperCase())])] } },
    select: { id: true, code: true, name: true, type: true, isActive: true, warehouseId: true },
  })
  const exact = new Map(rows.map((r) => [r.code, r]))
  const byCode = new Map<string, LocationRow>()
  for (const code of wanted) {
    const row = exact.get(code) ?? exact.get(code.toUpperCase())
    if (!row) return { error: LOCATION_NOT_FOUND }
    byCode.set(code, row)
  }
  return byCode
}

/** Why a person's change may not touch this location, or null. FBA is Amazon's number; a Shopify location is Shopify's. */
export function readOnlyLocation(location: { code: string; type: string }): string | null {
  if (location.type === 'AMAZON_FBA') return `${location.code} is Amazon FBA stock: Amazon owns that number and only the FBA inventory sync writes it`
  if (location.type === 'SHOPIFY_LOCATION') return `${location.code} is a Shopify location: its number is Shopify's own`
  if (location.type !== 'WAREHOUSE') return `${location.code} is not one of this business's own warehouses`
  return null
}

interface ProductRow { id: string; sku: string; name: string }

/** The live (not deleted) products a request names, by id. One not found refuses the request. */
async function productsById(ids: string[]): Promise<Map<string, ProductRow> | Refusal> {
  const wanted = [...new Set(ids)]
  const rows = await prisma.product.findMany({ where: { id: { in: wanted }, deletedAt: null }, select: { id: true, sku: true, name: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  if (wanted.some((id) => !byId.has(id))) return { error: PRODUCT_NOT_FOUND }
  return byId
}

/** A product's own level at a location (the master row: no variation). */
export async function levelOf(productId: string, locationId: string) {
  const row = await prisma.stockLevel.findFirst({ where: { productId, locationId, variationId: null }, select: { quantity: true, reserved: true, available: true } })
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0, available: row?.available ?? 0 }
}

const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const CASCADE = 'Listings that follow stock are updated and queued to their channels (FBA listings never are).'

// ── set-stock ─────────────────────────────────────────────────────────────────────────────────────────

const SET_STOCK_MAX = 250

interface SetStockLine { productId: string; sku: string; name: string; locationId: string; location: string; locationName: string; from: number; reserved: number; to: number; pooled: boolean }

async function planSetStock(args: Record<string, unknown>): Promise<{ lines: SetStockLine[]; unchanged: SetStockLine[]; reason: AdjustReason; note: string | null } | Refusal> {
  const items = (args.items ?? []) as Array<{ productId: string; location: string; quantity: number }>
  const keys = items.map((i) => `${i.productId}@${i.location}`)
  if (new Set(keys).size !== keys.length) return { error: 'A product is named twice at one location. Name each product and location once.' }
  const products = await productsById(items.map((i) => i.productId))
  if (refused(products)) return products
  const locations = await locationsByCode(items.map((i) => i.location))
  if (refused(locations)) return locations
  const pooled = await pooledNow(prisma, [...products.keys()])
  const lines: SetStockLine[] = []
  const unchanged: SetStockLine[] = []
  const problems: string[] = []
  for (const item of items) {
    const product = products.get(item.productId)!
    const location = locations.get(item.location)!
    const level = await levelOf(product.id, location.id)
    try {
      const adj = computeLocationAdjustment({ locationType: location.type, currentQuantity: level.quantity, currentReserved: level.reserved, value: item.quantity })
      const line = { productId: product.id, sku: product.sku, name: product.name, locationId: location.id, location: location.code, locationName: location.name, from: level.quantity, reserved: level.reserved, to: item.quantity, pooled: pooled.has(product.id) }
      ;(adj.noop ? unchanged : lines).push(line)
    } catch (error) {
      if (error instanceof LocationAdjustmentError) problems.push(`${product.sku} at ${location.code}: ${error.message}`)
      else throw error
    }
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}` }
  if (!lines.length) return { error: `Every product already has that count there. Nothing to change.` }
  const reason = (ALLOWED_ADJUST_REASONS as readonly string[]).includes(String(args.reason)) ? (args.reason as AdjustReason) : 'MANUAL_ADJUSTMENT'
  return { lines, unchanged, reason, note: typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null }
}

function previewSetStock(plan: Exclude<Awaited<ReturnType<typeof planSetStock>>, Refusal>) {
  const up = plan.lines.filter((l) => l.to > l.from).reduce((s, l) => s + (l.to - l.from), 0)
  const down = plan.lines.filter((l) => l.to < l.from).reduce((s, l) => s + (l.from - l.to), 0)
  return {
    action: 'set-stock',
    effect: `On-hand set on ${plural(plan.lines.length, 'row')}${plan.unchanged.length ? ` (${plan.unchanged.length} already at that count)` : ''}: ${up} units up, ${down} down. ${CASCADE}`,
    reason: plan.reason,
    changes: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({
      sku: l.sku, name: l.name, location: l.location, locationName: l.locationName, from: l.from, to: l.to, delta: l.to - l.from, reserved: l.reserved,
      ...(l.pooled ? { note: 'sells from shared stock: its listings follow that stock, not this count' } : {}),
    })),
    ...(plan.lines.length > PREVIEW_LINES ? { moreChanges: plan.lines.length - PREVIEW_LINES } : {}),
    totals: { rows: plan.lines.length, unchanged: plan.unchanged.length, unitsUp: up, unitsDown: down },
    basis: basisOf(plan.lines.map((l) => [l.productId, l.locationId, l.from, l.to])),
    note: `${NOT_YET} Each row is one audited movement (${plan.reason}) to exactly the count shown; a row whose count moved since you approved it stops the run. ${CASCADE} Amazon FBA and Shopify locations are never changed here.`,
  }
}

/** C2 — undo of set-stock: set the counts it replaced, through set-stock itself. Refused while a count moved since. */
export const SET_STOCK_UNDO: ToolUndo = {
  async current(change) {
    const items = ((change.after as { items?: Array<{ productId: string; location: string }> } | null)?.items ?? [])
    const now: Array<{ productId: string; location: string; quantity: number }> = []
    for (const item of items) {
      const location = await prisma.stockLocation.findFirst({ where: { code: item.location }, select: { id: true } })
      now.push({ productId: item.productId, location: item.location, quantity: location ? (await levelOf(item.productId, location.id)).quantity : 0 })
    }
    return { items: now }
  },
  request(change) {
    const before = (change.before ?? {}) as { items?: Array<{ productId: string; location: string; quantity: number }> }
    if (!before.items?.length) return { refusal: 'This change does not name the counts it replaced.' }
    return {
      tool: 'set-stock',
      args: { items: before.items.map(({ productId, location, quantity }) => ({ productId, location, quantity })), reason: 'MANUAL_ADJUSTMENT', note: 'Undo of an earlier set-stock' },
    }
  },
}

const setStock: AgentTool = {
  name: 'set-stock',
  title: 'Set stock counts',
  input: z.object({
    items: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      location: LOCATION_ARG.describe('the location code, e.g. IT-MAIN (see stock-locations); an own warehouse'),
      quantity: z.coerce.number().int().min(0).max(1_000_000).describe('the new on-hand count there: a whole number, 0 or more'),
    })).min(1).max(SET_STOCK_MAX).describe(`the counts to set, 1 to ${SET_STOCK_MAX} rows`),
    reason: z.preprocess(upper, z.enum(ALLOWED_ADJUST_REASONS)).optional()
      .describe('MANUAL_ADJUSTMENT (default), INVENTORY_COUNT (a count) or WRITE_OFF (damaged, lost)'),
    note: z.string().trim().min(1).max(200).optional().describe('a note kept on each movement'),
  }),
  requires: [F.inventoryAdjust],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SET_STOCK_UNDO,
  description:
    `Set the on-hand count of up to ${SET_STOCK_MAX} products at their own warehouses (the absolute number, not a +/-). `
    + 'Each row becomes one audited stock movement, and every listing that follows stock is updated and sent to its '
    + 'channel. Amazon FBA and Shopify locations are refused. A row whose count moved after the approval stops the run. '
    + 'Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planSetStock(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: previewSetStock(plan) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planSetStock(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const done: SetStockLine[] = []
    const failed: string[] = []
    for (const line of plan.lines) {
      try {
        await adjustOneLocation({ productId: line.productId, locationId: line.locationId, value: line.to, reason: plan.reason, notes: plan.note ?? undefined, actor: ctx.userId ?? 'agent:set-stock' })
        done.push(line)
      } catch (error) {
        failed.push(`${line.sku} at ${line.location}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!done.length) return { ok: false, error: `Nothing changed: ${listed(failed)}` }
    return {
      ok: true,
      data: { set: done.length, failed, rows: done.map((l) => ({ sku: l.sku, location: l.location, from: l.from, to: l.to })) },
      change: {
        before: { items: done.map((l) => ({ productId: l.productId, sku: l.sku, location: l.location, quantity: l.from })) },
        after: { items: done.map((l) => ({ productId: l.productId, location: l.location, quantity: l.to })) },
      },
    }
  },
}

// ── transfer-stock ────────────────────────────────────────────────────────────────────────────────────

const TRANSFER_MAX_ROWS = 100

export const TRANSFER_LIMITS = z.object({
  maxUnits: z.number().int().positive().max(100_000).default(500).describe('the most units one request moves in all'),
  maxRows: z.number().int().positive().max(TRANSFER_MAX_ROWS).default(100).describe('the most product rows one request moves'),
})

export function transferWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const totals = (preview as { totals?: { rows?: unknown; units?: unknown } } | null)?.totals
  if (typeof totals?.units !== 'number' || typeof totals?.rows !== 'number') return 'the request does not say how many units it moves'
  if (totals.units > Number(limits.maxUnits)) return `it moves ${totals.units} units, more than the ${limits.maxUnits} allowed without a person`
  if (totals.rows > Number(limits.maxRows)) return `it moves ${totals.rows} rows, more than the ${limits.maxRows} allowed without a person`
  return null
}

interface TransferLine { productId: string; sku: string; name: string; fromId: string; from: string; toId: string; to: string; quantity: number; fromAvailable: number; toQuantity: number }

async function planTransfer(args: Record<string, unknown>): Promise<{ lines: TransferLine[]; note: string | null } | Refusal> {
  const items = (args.items ?? []) as Array<{ productId: string; fromLocation: string; toLocation: string; quantity: number }>
  const products = await productsById(items.map((i) => i.productId))
  if (refused(products)) return products
  const locations = await locationsByCode(items.flatMap((i) => [i.fromLocation, i.toLocation]))
  if (refused(locations)) return locations
  const problems: string[] = []
  const lines: TransferLine[] = []
  const asked = new Map<string, number>()
  for (const item of items) {
    const product = products.get(item.productId)!
    const from = locations.get(item.fromLocation)!
    const to = locations.get(item.toLocation)!
    if (from.id === to.id) { problems.push(`${product.sku}: from and to are the same location`); continue }
    const readOnly = readOnlyLocation(from) ?? readOnlyLocation(to)
    if (readOnly) { problems.push(`${product.sku}: ${readOnly}`); continue }
    if (!to.isActive) { problems.push(`${product.sku}: ${to.code} is switched off`); continue }
    const key = `${product.id}@${from.id}`
    asked.set(key, (asked.get(key) ?? 0) + item.quantity)
    const source = await levelOf(product.id, from.id)
    if (source.available < asked.get(key)!) {
      problems.push(`${product.sku}: only ${source.available} available at ${from.code} (${source.quantity} on hand, ${source.reserved} held); ${asked.get(key)} asked`)
      continue
    }
    lines.push({ productId: product.id, sku: product.sku, name: product.name, fromId: from.id, from: from.code, toId: to.id, to: to.code, quantity: item.quantity, fromAvailable: source.available, toQuantity: (await levelOf(product.id, to.id)).quantity })
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}` }
  return { lines, note: typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null }
}

const TRANSFER_UNDO: ToolUndo = {
  async current(change) {
    const transfers = ((change.after as { transfers?: Array<{ productId: string; from: string; to: string; quantity: number }> } | null)?.transfers ?? [])
    const now = []
    for (const t of transfers) {
      const to = await prisma.stockLocation.findFirst({ where: { code: t.to }, select: { id: true } })
      const available = to ? (await levelOf(t.productId, to.id)).available : 0
      now.push({ ...t, quantity: Math.min(t.quantity, available) })
    }
    return { transfers: now }
  },
  request(change) {
    const transfers = ((change.after as { transfers?: Array<{ productId: string; from: string; to: string; quantity: number }> } | null)?.transfers ?? [])
    if (!transfers.length) return { refusal: 'This change does not name its transfers.' }
    return { tool: 'transfer-stock', args: { items: transfers.map((t) => ({ productId: t.productId, fromLocation: t.to, toLocation: t.from, quantity: t.quantity })), note: 'Undo of an earlier transfer' } }
  },
}

const transferStockTool: AgentTool = {
  name: 'transfer-stock',
  title: 'Move stock between warehouses',
  input: z.object({
    items: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      fromLocation: LOCATION_ARG.describe('the warehouse code the units leave'),
      toLocation: LOCATION_ARG.describe('the warehouse code they arrive at'),
      quantity: z.coerce.number().int().min(1).max(100_000).describe('how many units, 1 or more'),
    })).min(1).max(TRANSFER_MAX_ROWS).describe(`the moves, 1 to ${TRANSFER_MAX_ROWS} rows`),
    note: z.string().trim().min(1).max(200).optional().describe('a note kept on both movements'),
  }),
  requires: [F.inventoryAdjust, F.stockTransfer],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: TRANSFER_LIMITS,
  withinLimits: transferWithinLimits,
  undo: TRANSFER_UNDO,
  description:
    `Move units of up to ${TRANSFER_MAX_ROWS} products from one own warehouse to another. Each move is one transaction `
    + '(out and in together, never half). Only available units move (held units stay). A warehouse that feeds other '
    + 'channels than the other changes what those listings show. Amazon FBA and Shopify locations are refused. Waits '
    + 'for a person to approve it in Nexus unless the business lets Claude move small amounts itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planTransfer(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const units = plan.lines.reduce((s, l) => s + l.quantity, 0)
    return {
      ok: true,
      preview: {
        action: 'transfer-stock',
        effect: `${units} units move in ${plural(plan.lines.length, 'row')}. ${CASCADE}`,
        changes: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, name: l.name, from: l.from, to: l.to, quantity: l.quantity, availableAtFrom: l.fromAvailable, onHandAtTo: l.toQuantity })),
        ...(plan.lines.length > PREVIEW_LINES ? { moreChanges: plan.lines.length - PREVIEW_LINES } : {}),
        totals: { rows: plan.lines.length, units },
        basis: basisOf(plan.lines.map((l) => [l.productId, l.fromId, l.toId, l.quantity, l.fromAvailable, l.toQuantity])),
        note: `${NOT_YET} Each row is one transfer (TRANSFER_OUT and TRANSFER_IN in one transaction). A row whose stock moved since you approved it stops the run.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planTransfer(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const done: TransferLine[] = []
    const failed: string[] = []
    for (const line of plan.lines) {
      try {
        await transferStock({ productId: line.productId, fromLocationId: line.fromId, toLocationId: line.toId, quantity: line.quantity, notes: plan.note ?? undefined, actor: ctx.userId ?? 'agent:transfer-stock' })
        done.push(line)
      } catch (error) {
        failed.push(`${line.sku} ${line.from} → ${line.to}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!done.length) return { ok: false, error: `Nothing moved: ${listed(failed)}` }
    return {
      ok: true,
      data: { moved: done.length, failed, units: done.reduce((s, l) => s + l.quantity, 0) },
      change: {
        before: { items: done.map((l) => ({ productId: l.productId, sku: l.sku, from: l.from, to: l.to, quantity: l.quantity })) },
        after: { transfers: done.map((l) => ({ productId: l.productId, from: l.from, to: l.to, quantity: l.quantity })) },
      },
    }
  },
}

// ── stock-count ───────────────────────────────────────────────────────────────────────────────────────

const COUNT_ACTIONS = ['record', 'create', 'start', 'ignore', 'complete', 'cancel'] as const
type CountAction = (typeof COUNT_ACTIONS)[number]
const COUNT_MAX = 250

export const COUNT_LIMITS = z.object({
  maxItems: z.number().int().positive().max(COUNT_MAX).default(COUNT_MAX).describe('the most items one request records or ignores'),
})
export function countWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const items = (preview as { totals?: { items?: unknown } } | null)?.totals?.items
  if (typeof items !== 'number') return 'the request does not say how many items it touches'
  return items > Number(limits.maxItems) ? `it touches ${items} items, more than the ${limits.maxItems} allowed without a person` : null
}

interface CountRow { id: string; status: string; notes: string | null; location: { id: string; code: string; name: string; type: string } }

async function countById(id: string | undefined): Promise<CountRow | Refusal> {
  if (!id) return { error: 'countId is required for this action' }
  const count = await prisma.cycleCount.findUnique({ where: { id }, select: { id: true, status: true, notes: true, location: { select: { id: true, code: true, name: true, type: true } } } })
  return count ?? { error: 'Cycle count not found' }
}

interface CountPlan {
  action: CountAction
  count: { id: string | null; status: string | null; location: string; locationName: string }
  locationId: string
  /** record: each item with its count before and the new one; ignore: the items ignored. */
  items: Array<{ itemId: string; productId: string; sku: string; expected: number; countedBefore: number | null; counted: number | null; status: string }>
  /** create: how many items the count will hold. */
  willHold?: number
  note: string | null
}

async function planCount(args: Record<string, unknown>): Promise<CountPlan | Refusal> {
  const action = args.action as CountAction
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null
  if (action === 'create') {
    const code = args.location as string | undefined
    if (!code) return { error: 'location is required to create a count' }
    const locations = await locationsByCode([code])
    if (refused(locations)) return locations
    const location = locations.get(code)!
    const readOnly = readOnlyLocation(location)
    if (readOnly) return { error: `A count is for an own warehouse: ${readOnly}` }
    const willHold = await prisma.stockLevel.count({ where: { locationId: location.id } })
    if (!willHold) return { error: `There is no stock at ${location.code} to count.` }
    return { action, count: { id: null, status: null, location: location.code, locationName: location.name }, locationId: location.id, items: [], willHold, note }
  }
  const count = await countById(args.countId as string | undefined)
  if (refused(count)) return count
  const base = { action, count: { id: count.id, status: count.status, location: count.location.code, locationName: count.location.name }, locationId: count.location.id, note }
  const allItems = await prisma.cycleCountItem.findMany({ where: { cycleCountId: count.id }, orderBy: { sku: 'asc' }, select: { id: true, productId: true, variationId: true, sku: true, expectedQuantity: true, countedQuantity: true, status: true } })
  const itemOf = (productId: string): (typeof allItems)[number] | Refusal => {
    const matches = allItems.filter((i) => i.productId === productId && !i.variationId)
    if (matches.length !== 1) return { error: 'A product named is not on this count' }
    return matches[0]
  }
  if (action === 'start') {
    if (count.status !== 'DRAFT') return { error: `Only a DRAFT count can start; this one is ${count.status}.` }
    return { ...base, items: [] }
  }
  if (action === 'complete') {
    if (count.status !== 'IN_PROGRESS') return { error: `Only an IN_PROGRESS count can complete; this one is ${count.status}.` }
    const open = allItems.filter((i) => i.status !== 'RECONCILED' && i.status !== 'IGNORED')
    if (open.length) return { error: `${plural(open.length, 'item')} still open (${listed(open.map((i) => `${i.sku} ${i.status}`))}): reconcile or ignore each first.` }
    return { ...base, items: [] }
  }
  if (action === 'cancel') {
    if (count.status === 'COMPLETED' || count.status === 'CANCELLED') return { error: `A ${count.status} count cannot be cancelled.` }
    return { ...base, items: [] }
  }
  if (count.status !== 'IN_PROGRESS') return { error: `Items are counted on an IN_PROGRESS count; this one is ${count.status}.` }
  if (action === 'record') {
    const counts = (args.items ?? []) as Array<{ productId: string; counted: number }>
    if (!counts.length) return { error: `items is required to record on the count at ${count.location.code} (${count.location.name})` }
    const items: CountPlan['items'] = []
    for (const c of counts) {
      const item = itemOf(c.productId)
      if (refused(item)) return item
      if (item.status === 'RECONCILED') return { error: `${item.sku} is already reconciled; its count cannot change.` }
      items.push({ itemId: item.id, productId: item.productId, sku: item.sku, expected: item.expectedQuantity, countedBefore: item.countedQuantity, counted: c.counted, status: item.status })
    }
    return { ...base, items }
  }
  // ignore
  const productIds = (args.productIds ?? []) as string[]
  if (!productIds.length) return { error: `productIds is required to ignore items of the count at ${count.location.code} (${count.location.name})` }
  const items: CountPlan['items'] = []
  for (const productId of productIds) {
    const item = itemOf(productId)
    if (refused(item)) return item
    if (item.status === 'RECONCILED') return { error: `${item.sku} is already reconciled; it cannot be ignored.` }
    items.push({ itemId: item.id, productId: item.productId, sku: item.sku, expected: item.expectedQuantity, countedBefore: item.countedQuantity, counted: item.countedQuantity, status: item.status })
  }
  return { ...base, items }
}

const COUNT_WORDS: Record<CountAction, string> = {
  create: 'Creates a DRAFT count of every product with stock at the location (the expected numbers are taken when it is created).',
  start: 'Starts the count: items can be counted from now on.',
  record: 'Records what was counted. Stock does not change until the count is reconciled (reconcile-stock-count).',
  ignore: 'Leaves these items out of the count: their stock is not changed by it.',
  complete: 'Closes the count; every item is reconciled or ignored.',
  cancel: 'Cancels the count. Stock already reconciled stays as it is.',
}

const COUNT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { countId?: string; status?: string; counts?: Array<{ productId: string; counted: number | null }> }
    if (!after.countId) return null
    if (after.counts) {
      const items = await prisma.cycleCountItem.findMany({ where: { cycleCountId: after.countId, productId: { in: after.counts.map((c) => c.productId) }, variationId: null }, select: { productId: true, countedQuantity: true } })
      const byProduct = new Map(items.map((i) => [i.productId, i.countedQuantity]))
      return { countId: after.countId, counts: after.counts.map((c) => ({ productId: c.productId, counted: byProduct.get(c.productId) ?? null })) }
    }
    const count = await prisma.cycleCount.findUnique({ where: { id: after.countId }, select: { status: true } })
    return { countId: after.countId, status: count?.status ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: CountAction; countId?: string | null; counts?: Array<{ productId: string; counted: number | null }> }
    const after = (change.after ?? {}) as { countId?: string }
    if (before.action === 'create' && after.countId) return { tool: 'stock-count', args: { action: 'cancel', countId: after.countId } }
    if (before.action === 'record' && before.countId && before.counts?.length) {
      if (before.counts.some((c) => c.counted == null)) return { refusal: 'An item had no count before this one, and a count cannot be taken back to none. Record the right number instead.' }
      return { tool: 'stock-count', args: { action: 'record', countId: before.countId, items: before.counts.map((c) => ({ productId: c.productId, counted: c.counted })) } }
    }
    return { refusal: `A count that was ${before.action === 'start' ? 'started' : before.action === 'complete' ? 'completed' : before.action === 'cancel' ? 'cancelled' : 'ignored'} cannot be put back.` }
  },
}

const stockCount: AgentTool = {
  name: 'stock-count',
  title: 'Run a stock count',
  input: z.object({
    action: z.preprocess(lower, z.enum(COUNT_ACTIONS)).describe('record (counted numbers), create, start, ignore (items), complete or cancel'),
    countId: z.string().trim().min(1).max(64).optional().describe('the count (cycle-counts lists them); every action but create'),
    location: LOCATION_ARG.optional().describe('create: the own warehouse to count'),
    items: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id, an item of the count'),
      counted: z.coerce.number().int().min(0).max(1_000_000).describe('the number counted on the shelf'),
    })).min(1).max(COUNT_MAX).optional().describe(`record: what was counted, 1 to ${COUNT_MAX} items`),
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(COUNT_MAX).optional().describe(`ignore: the products to leave out, 1 to ${COUNT_MAX}`),
    note: z.string().trim().min(1).max(200).optional().describe('create: a note on the count; record and ignore: a note on each item'),
  }),
  requires: [F.inventoryAdjust, F.stockCount],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: COUNT_LIMITS,
  withinLimits: countWithinLimits,
  undo: COUNT_UNDO,
  description:
    'Work on a stock count of an own warehouse: create it (expected numbers taken then), start it, record what was '
    + 'counted, leave items out, complete or cancel it. Records only: stock changes when the count is reconciled '
    + '(reconcile-stock-count). Amazon FBA and Shopify locations are never counted here. Waits for a person to approve '
    + 'it in Nexus unless the business lets Claude do it itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planCount(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: plan.action,
        count: { ...plan.count, ...(plan.willHold !== undefined ? { items: plan.willHold } : {}) },
        effect: COUNT_WORDS[plan.action],
        changes: plan.items.slice(0, PREVIEW_LINES).map((i) => ({ sku: i.sku, expected: i.expected, countedBefore: i.countedBefore, ...(plan.action === 'record' ? { counted: i.counted, variance: (i.counted ?? 0) - i.expected } : { status: 'IGNORED' }) })),
        ...(plan.items.length > PREVIEW_LINES ? { moreChanges: plan.items.length - PREVIEW_LINES } : {}),
        totals: { items: plan.items.length },
        note: `${NOT_YET} ${COUNT_WORDS[plan.action]}`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planCount(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const userId = ctx.userId ?? undefined
    const statusChange = (countId: string, from: string | null, to: string) => ({
      ok: true as const,
      data: { countId, status: to },
      change: { before: { action: plan.action, countId: plan.action === 'create' ? null : countId, status: from, location: plan.count.location }, after: { countId, status: to } },
    })
    if (plan.action === 'create') {
      const created = await createCycleCount({ locationId: plan.locationId, notes: plan.note ?? undefined, createdBy: userId })
      return statusChange(created.id, null, 'DRAFT')
    }
    const id = plan.count.id!
    if (plan.action === 'start') { await startCycleCount(id, userId); return statusChange(id, plan.count.status, 'IN_PROGRESS') }
    if (plan.action === 'complete') { await completeCycleCount(id, userId); return statusChange(id, plan.count.status, 'COMPLETED') }
    if (plan.action === 'cancel') { await cancelCycleCount({ id, reason: plan.note ?? undefined }); return statusChange(id, plan.count.status, 'CANCELLED') }
    if (plan.action === 'record') {
      for (const item of plan.items) await recordCount({ itemId: item.itemId, countedQuantity: item.counted!, countedByUserId: userId, notes: plan.note ?? undefined })
      return {
        ok: true,
        data: { countId: id, recorded: plan.items.length },
        change: {
          before: { action: 'record', countId: id, counts: plan.items.map((i) => ({ productId: i.productId, sku: i.sku, counted: i.countedBefore })) },
          after: { countId: id, counts: plan.items.map((i) => ({ productId: i.productId, counted: i.counted })) },
        },
      }
    }
    for (const item of plan.items) await ignoreItem({ itemId: item.itemId, reconciledByUserId: userId, notes: plan.note ?? undefined })
    return {
      ok: true,
      data: { countId: id, ignored: plan.items.length },
      change: { before: { action: 'ignore', countId: id, items: plan.items.map((i) => ({ productId: i.productId, sku: i.sku, status: i.status })) }, after: { countId: id, status: plan.count.status } },
    }
  },
}

// ── reconcile-stock-count ─────────────────────────────────────────────────────────────────────────────

export const RECONCILE_LIMITS = z.object({
  maxVarianceUnits: z.number().int().min(0).max(100_000).default(5).describe('the most units one item may move'),
  maxVariancePercent: z.number().min(0).max(100).default(10).describe('the most one item may move, in percent of what was expected'),
})
export function reconcileWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const lines = (preview as { variances?: unknown } | null)?.variances
  if (!Array.isArray(lines) || !lines.length) return 'the request does not list its variances'
  for (const line of lines as Array<{ sku: string; expected: number; variance: number }>) {
    const units = Math.abs(line.variance)
    if (units > Number(limits.maxVarianceUnits)) return `${line.sku} moves ${units} units, more than the ${limits.maxVarianceUnits} allowed without a person`
    const pct = line.expected > 0 ? (units / line.expected) * 100 : units > 0 ? Infinity : 0
    if (pct > Number(limits.maxVariancePercent)) return `${line.sku} moves ${line.expected > 0 ? `${Math.round(pct)} %` : `from 0`}, more than the ${limits.maxVariancePercent} % allowed without a person`
  }
  return null
}

interface ReconcileLine { itemId: string; productId: string; sku: string; expected: number; counted: number; variance: number; stockNow: number; after: number }

async function planReconcile(args: Record<string, unknown>): Promise<{ countId: string; location: LocationRow; lines: ReconcileLine[] } | Refusal> {
  const count = await countById(args.countId as string | undefined)
  if (refused(count)) return count
  if (count.status !== 'IN_PROGRESS') return { error: `Only an IN_PROGRESS count is reconciled; this one is ${count.status}.` }
  const location = await prisma.stockLocation.findUniqueOrThrow({ where: { id: count.location.id }, select: { id: true, code: true, name: true, type: true, isActive: true, warehouseId: true } })
  const readOnly = readOnlyLocation(location)
  if (readOnly) return { error: `Not reconciled: ${readOnly}` }
  const named = args.productIds as string[] | undefined
  const items = await prisma.cycleCountItem.findMany({
    where: { cycleCountId: count.id, ...(named ? { productId: { in: named } } : { status: 'COUNTED' }) },
    orderBy: { sku: 'asc' },
    select: { id: true, productId: true, variationId: true, sku: true, expectedQuantity: true, countedQuantity: true, status: true },
  })
  if (named && named.some((id) => !items.some((i) => i.productId === id))) return { error: 'A product named is not on this count' }
  if (!items.length) return { error: 'No counted item waits to be reconciled on this count.' }
  const lines: ReconcileLine[] = []
  const problems: string[] = []
  for (const item of items) {
    if (item.status !== 'COUNTED' || item.countedQuantity == null) { problems.push(`${item.sku} is ${item.status === 'PENDING' ? 'not counted yet' : item.status}`); continue }
    if (item.variationId) { problems.push(`${item.sku} is a variation row: reconcile it in Nexus`); continue }
    const variance = item.countedQuantity - item.expectedQuantity
    const stockNow = (await levelOf(item.productId, location.id)).quantity
    if (stockNow + variance < 0) { problems.push(`${item.sku}: ${stockNow} on hand now, so ${variance} would go below 0`); continue }
    lines.push({ itemId: item.id, productId: item.productId, sku: item.sku, expected: item.expectedQuantity, counted: item.countedQuantity, variance, stockNow, after: stockNow + variance })
  }
  if (problems.length) return { error: `Not reconciled: ${listed(problems)}` }
  return { countId: count.id, location, lines }
}

const RECONCILE_UNDO: ToolUndo = {
  current: SET_STOCK_UNDO.current,
  request(change) {
    const before = (change.before ?? {}) as { items?: Array<{ productId: string; location: string; quantity: number }> }
    if (!before.items?.length) return { refusal: 'This change does not name the stock it changed.' }
    return {
      tool: 'set-stock',
      args: { items: before.items.map(({ productId, location, quantity }) => ({ productId, location, quantity })), reason: 'INVENTORY_COUNT', note: 'Undo of a count reconcile' },
    }
  },
}

const reconcileStockCount: AgentTool = {
  name: 'reconcile-stock-count',
  title: 'Reconcile a stock count',
  input: z.object({
    countId: z.string().trim().min(1).max(64).describe('the count (cycle-counts lists them)'),
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(COUNT_MAX).optional()
      .describe(`only these counted items, 1 to ${COUNT_MAX} (default: every counted item)`),
  }),
  requires: [F.inventoryAdjust, F.stockCount],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  limits: RECONCILE_LIMITS,
  withinLimits: reconcileWithinLimits,
  undo: RECONCILE_UNDO,
  description:
    'Apply a count: for each counted item, stock at the count\'s warehouse moves by counted − expected (one audited '
    + 'movement), and the listings that follow stock show the new number. The preview shows each item\'s stock now and '
    + 'after; a sale between the approval and the run stops it (ask again). Undo sets the old numbers back; the items '
    + 'stay reconciled. Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planReconcile(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const up = plan.lines.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance, 0)
    const down = plan.lines.filter((l) => l.variance < 0).reduce((s, l) => s - l.variance, 0)
    return {
      ok: true,
      preview: {
        action: 'reconcile-stock-count',
        count: { id: plan.countId, location: plan.location.code, locationName: plan.location.name },
        effect: `${plural(plan.lines.length, 'item')} reconciled at ${plan.location.code}: ${up} units up, ${down} down. ${CASCADE}`,
        variances: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, expected: l.expected, counted: l.counted, variance: l.variance, stockNow: l.stockNow, stockAfter: l.after })),
        ...(plan.lines.length > PREVIEW_LINES ? { moreItems: plan.lines.length - PREVIEW_LINES } : {}),
        totals: { items: plan.lines.length, unitsUp: up, unitsDown: down },
        basis: basisOf(plan.lines.map((l) => [l.itemId, l.counted, l.expected, l.stockNow])),
        note: `${NOT_YET} Each item moves by counted − expected. A count expects the stock it saw when it was created: units sold since then are counted again, so check them before you approve.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planReconcile(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const done: Array<ReconcileLine & { stockAfter: number }> = []
    const failed: string[] = []
    for (const line of plan.lines) {
      try {
        await reconcileItem({ itemId: line.itemId, reconciledByUserId: ctx.userId ?? undefined })
        done.push({ ...line, stockAfter: (await levelOf(line.productId, plan.location.id)).quantity })
      } catch (error) {
        failed.push(`${line.sku}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!done.length) return { ok: false, error: `Nothing reconciled: ${listed(failed)}` }
    return {
      ok: true,
      data: { countId: plan.countId, reconciled: done.length, failed },
      change: {
        before: { countId: plan.countId, items: done.map((l) => ({ productId: l.productId, sku: l.sku, location: plan.location.code, quantity: l.stockAfter - l.variance })) },
        after: { items: done.map((l) => ({ productId: l.productId, location: plan.location.code, quantity: l.stockAfter })) },
      },
    }
  },
}

// ── reserve-stock ─────────────────────────────────────────────────────────────────────────────────────

const HOLD_REASONS = ['MANUAL_HOLD', 'PROMOTION'] as const

interface HoldPlan {
  action: 'reserve' | 'release'
  product: ProductRow
  location: LocationRow
  quantity: number
  reason: string
  days: number
  reservationId: string | null
  level: { quantity: number; reserved: number; available: number }
}

async function planHold(args: Record<string, unknown>): Promise<HoldPlan | Refusal> {
  const products = await productsById([String(args.productId ?? '')])
  if (refused(products)) return products
  const product = [...products.values()][0]
  if (args.action === 'release') {
    const id = args.reservationId as string | undefined
    if (!id) return { error: 'reservationId is required to release a hold (stock-reservations lists them)' }
    const hold = await prisma.stockReservation.findUnique({
      where: { id },
      select: { id: true, quantity: true, reason: true, releasedAt: true, consumedAt: true, consumerWorkspaceId: true, stockLevel: { select: { productId: true, locationId: true } } },
    })
    if (!hold || hold.stockLevel.productId !== product.id) return { error: 'Hold not found for this product' }
    if (hold.consumerWorkspaceId) return { error: `${product.sku}: this hold is for another business's order; it is settled in Nexus.` }
    if (!(HOLD_REASONS as readonly string[]).includes(hold.reason)) return { error: `${product.sku}: this hold is an order's (${hold.reason}); the order releases it.` }
    if (hold.releasedAt || hold.consumedAt) return { error: `${product.sku}: this hold is already ${hold.releasedAt ? 'released' : 'used by its order'}.` }
    const location = await prisma.stockLocation.findUniqueOrThrow({ where: { id: hold.stockLevel.locationId }, select: { id: true, code: true, name: true, type: true, isActive: true, warehouseId: true } })
    return { action: 'release', product, location, quantity: hold.quantity, reason: hold.reason, days: 0, reservationId: hold.id, level: await levelOf(product.id, location.id) }
  }
  const code = args.location as string | undefined
  const quantity = Number(args.quantity)
  if (!code || !Number.isInteger(quantity) || quantity < 1) return { error: `${product.sku}: location and a quantity of 1 or more are required to place a hold` }
  const locations = await locationsByCode([code])
  if (refused(locations)) return locations
  const location = locations.get(code)!
  const readOnly = readOnlyLocation(location)
  if (readOnly) return { error: `${product.sku}: ${readOnly}` }
  if ((await pooledNow(prisma, [product.id])).has(product.id)) return { error: `${product.sku}: ${new PooledHoldRefusal().message}` }
  const level = await levelOf(product.id, location.id)
  if (level.available < quantity) return { error: `${product.sku}: only ${level.available} available at ${location.code} (${level.quantity} on hand, ${level.reserved} held); ${quantity} asked` }
  const reason = (HOLD_REASONS as readonly string[]).includes(String(args.reason)) ? String(args.reason) : 'MANUAL_HOLD'
  const days = Number.isInteger(Number(args.days)) && Number(args.days) > 0 ? Number(args.days) : 7
  return { action: 'reserve', product, location, quantity, reason, days, reservationId: null, level }
}

const HOLD_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { reservationId?: string }
    if (!after.reservationId) return null
    const hold = await prisma.stockReservation.findUnique({ where: { id: after.reservationId }, select: { releasedAt: true, consumedAt: true } })
    return { reservationId: after.reservationId, active: !!hold && !hold.releasedAt && !hold.consumedAt }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; productId?: string; location?: string; quantity?: number; reason?: string }
    const after = (change.after ?? {}) as { reservationId?: string }
    if (!before.productId) return { refusal: 'This change does not name its product.' }
    if (before.action === 'reserve' && after.reservationId) {
      return { tool: 'reserve-stock', args: { action: 'release', productId: before.productId, reservationId: after.reservationId } }
    }
    if (before.action === 'release' && before.location && before.quantity) {
      return { tool: 'reserve-stock', args: { action: 'reserve', productId: before.productId, location: before.location, quantity: before.quantity, reason: before.reason ?? 'MANUAL_HOLD' } }
    }
    return { refusal: 'This change does not say what to put back.' }
  },
}

const reserveStock: AgentTool = {
  name: 'reserve-stock',
  title: 'Hold or release stock',
  input: z.object({
    action: z.preprocess(lower, z.enum(['reserve', 'release'])).describe('reserve (hold units) or release (give a hold back)'),
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    location: LOCATION_ARG.optional().describe('reserve: the own warehouse to hold units at'),
    quantity: z.coerce.number().int().min(1).max(100_000).optional().describe('reserve: how many units, at most what is available'),
    reason: z.preprocess(upper, z.enum(HOLD_REASONS)).optional().describe('reserve: MANUAL_HOLD (default) or PROMOTION'),
    days: z.coerce.number().int().min(1).max(90).optional().describe('reserve: how many days the hold lasts (default 7)'),
    reservationId: z.string().trim().min(1).max(64).optional().describe('release: the hold (stock-reservations lists them)'),
  }),
  requires: [F.inventoryAdjust],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: HOLD_UNDO,
  description:
    'Hold units of a product at an own warehouse (for a promotion, a customer, a check) so channels stop selling them, '
    + 'or release such a hold. Holds for orders are made and released by their orders, and holds for another '
    + 'business are settled in Nexus: both are refused. Amazon FBA and Shopify locations, and products that sell from '
    + 'shared stock, are refused. Listings that follow stock show the change. '
    + 'Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planHold(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const after = plan.action === 'reserve' ? plan.level.available - plan.quantity : plan.level.available + plan.quantity
    return {
      ok: true,
      preview: {
        action: plan.action,
        hold: {
          sku: plan.product.sku, name: plan.product.name, location: plan.location.code, locationName: plan.location.name, quantity: plan.quantity, reason: plan.reason,
          ...(plan.action === 'reserve' ? { lastsDays: plan.days } : { reservationId: plan.reservationId }),
        },
        stock: { onHand: plan.level.quantity, held: plan.level.reserved, available: plan.level.available, availableAfter: after },
        note: `${NOT_YET} ${plan.action === 'reserve' ? `Holds ${plan.quantity} units for ${plural(plan.days, 'day')}` : `Gives ${plan.quantity} held units back`}: listings that follow stock then show ${after} available here.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planHold(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const actor = ctx.userId ?? 'agent:reserve-stock'
    if (plan.action === 'reserve') {
      const hold = await placeHold({ productId: plan.product.id, locationId: plan.location.id, quantity: plan.quantity, reason: plan.reason as 'MANUAL_HOLD', ttlMs: plan.days * DAY_MS, actor })
      return {
        ok: true,
        data: { reservationId: hold.id, quantity: hold.quantity, expiresAt: hold.expiresAt },
        change: {
          before: { action: 'reserve', productId: plan.product.id, sku: plan.product.sku, location: plan.location.code, quantity: plan.quantity, reason: plan.reason },
          after: { reservationId: hold.id, active: true },
        },
      }
    }
    await releaseHold(plan.reservationId!, { actor })
    return {
      ok: true,
      data: { reservationId: plan.reservationId, released: plan.quantity },
      change: {
        before: { action: 'release', productId: plan.product.id, sku: plan.product.sku, location: plan.location.code, quantity: plan.quantity, reason: plan.reason, reservationId: plan.reservationId },
        after: { reservationId: plan.reservationId, active: false },
      },
    }
  },
}

// ── set-stock-location ────────────────────────────────────────────────────────────────────────────────

const LOCATION_ACTIONS = ['rename', 'create', 'archive', 'restore'] as const
type LocationAction = (typeof LOCATION_ACTIONS)[number]

interface LocationPlan { action: LocationAction; code: string; location: LocationRow | null; name: string | null; servesMarketplaces: string[] | null; onHand: number }

async function planLocation(args: Record<string, unknown>): Promise<LocationPlan | Refusal> {
  const action = args.action as LocationAction
  const typed = String(args.location ?? '')
  const code = action === 'create' ? typed.toUpperCase() : typed
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null
  const serves = Array.isArray(args.servesMarketplaces) ? (args.servesMarketplaces as string[]) : null
  const found = await locationsByCode([typed])
  const location = refused(found) ? null : found.get(typed)!
  if (action === 'create') {
    if (!LOCATION_CODE.test(code)) return { error: 'A location code is upper case letters, digits and hyphens, 1 to 30 characters.' }
    if (location) return { error: 'That location code is taken in this business: choose another.' }
    if (!name) return { error: 'name is required to create a location' }
    return { action, code, location: null, name, servesMarketplaces: serves ?? [], onHand: 0 }
  }
  if (!location) return { error: LOCATION_NOT_FOUND }
  const readOnly = readOnlyLocation(location)
  if (readOnly) return { error: `Not changed: ${readOnly}` }
  const onHand = (await prisma.stockLevel.aggregate({ where: { locationId: location.id }, _sum: { quantity: true, reserved: true } }))._sum
  if (action === 'rename') {
    if (!name) return { error: `name is required to rename ${location.code} (now "${location.name}")` }
    if (name === location.name) return { error: `${location.code} is already called "${location.name}".` }
    return { action, code: location.code, location, name, servesMarketplaces: null, onHand: onHand.quantity ?? 0 }
  }
  if (action === 'archive') {
    if (!location.isActive) return { error: `${location.code} is already switched off.` }
    if (await isProtectedStockLocation(location)) return { error: `${location.code} is a built-in location (the default warehouse): choose another default first.` }
    if ((onHand.quantity ?? 0) > 0 || (onHand.reserved ?? 0) > 0) return { error: `${location.code} still holds ${onHand.quantity ?? 0} units: move or count them out first. A location is switched off only at 0.` }
    return { action, code: location.code, location, name: null, servesMarketplaces: null, onHand: 0 }
  }
  if (location.isActive) return { error: `${location.code} is already on.` }
  return { action, code: location.code, location, name: null, servesMarketplaces: null, onHand: onHand.quantity ?? 0 }
}

const LOCATION_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { code?: string; name?: string; isActive?: boolean }
    if (!after.code) return null
    const location = await prisma.stockLocation.findFirst({ where: { code: after.code }, select: { name: true, isActive: true } })
    return 'name' in after ? { code: after.code, name: location?.name ?? null } : { code: after.code, isActive: location?.isActive ?? false }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: LocationAction; code?: string; name?: string }
    if (!before.code) return { refusal: 'This change does not name its location.' }
    if (before.action === 'rename' && before.name) return { tool: 'set-stock-location', args: { action: 'rename', location: before.code, name: before.name } }
    if (before.action === 'create' || before.action === 'restore') return { tool: 'set-stock-location', args: { action: 'archive', location: before.code } }
    if (before.action === 'archive') return { tool: 'set-stock-location', args: { action: 'restore', location: before.code } }
    return { refusal: 'This change does not say what to put back.' }
  },
}

const setStockLocation: AgentTool = {
  name: 'set-stock-location',
  title: 'Keep own warehouses',
  input: z.object({
    action: z.preprocess(lower, z.enum(LOCATION_ACTIONS)).describe('rename, create (a new own warehouse), archive (switch off, only at 0 units) or restore'),
    location: LOCATION_ARG.describe('the location code; create: the new code (upper case letters, digits, hyphens)'),
    name: z.string().trim().min(1).max(100).optional().describe('rename and create: the name'),
    servesMarketplaces: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(30).optional().describe('create: the markets it can ship to, e.g. IT, DE'),
  }),
  requires: [F.inventoryAdjust],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: LOCATION_UNDO,
  description:
    'Keep the list of own warehouses: create one, rename one, switch one off (only when it holds no units, and never '
    + 'the default warehouse) or back on. Amazon FBA and Shopify locations come from those channels and are refused. '
    + 'Stock is moved with transfer-stock, not here. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planLocation(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const changes = plan.action === 'rename' ? { name: { from: plan.location!.name, to: plan.name } }
      : plan.action === 'create' ? { created: { code: plan.code, name: plan.name, type: 'WAREHOUSE', servesMarketplaces: plan.servesMarketplaces } }
        : { active: { from: plan.action === 'restore' ? false : true, to: plan.action === 'restore' } }
    return {
      ok: true,
      preview: {
        action: plan.action,
        location: { code: plan.code, name: plan.location?.name ?? plan.name },
        onHand: plan.onHand,
        changes,
        note: `${NOT_YET} ${plan.action === 'archive' ? 'A switched-off warehouse keeps its history; it can be switched back on.' : 'No stock moves.'}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planLocation(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      if (plan.action === 'create') {
        const created = await createStockLocation({ name: plan.name!, code: plan.code, type: 'WAREHOUSE', servesMarketplaces: plan.servesMarketplaces ?? [] })
        return { ok: true, data: { code: created.code, id: created.id }, change: { before: { action: 'create', code: plan.code }, after: { code: plan.code, isActive: true } } }
      }
      if (plan.action === 'rename') {
        await updateStockLocation(plan.location!.id, { name: plan.name! })
        return { ok: true, data: { code: plan.code, name: plan.name }, change: { before: { action: 'rename', code: plan.code, name: plan.location!.name }, after: { code: plan.code, name: plan.name } } }
      }
      if (plan.action === 'archive') {
        await deactivateStockLocation(plan.location!.id)
        return { ok: true, data: { code: plan.code, isActive: false }, change: { before: { action: 'archive', code: plan.code }, after: { code: plan.code, isActive: false } } }
      }
      await updateStockLocation(plan.location!.id, { isActive: true })
      return { ok: true, data: { code: plan.code, isActive: true }, change: { before: { action: 'restore', code: plan.code }, after: { code: plan.code, isActive: true } } }
    } catch (error) {
      if (error instanceof LocationWriteError) return { ok: false, error: error.message }
      throw error
    }
  },
}

// ── set-stock-source ──────────────────────────────────────────────────────────────────────────────────

const STOCK_SOURCE_MAX = 50

interface SourcePlan {
  to: 'own' | 'pool'
  grantId: string | null
  lender: string | null
  ids: string[]
  products: Awaited<ReturnType<typeof previewSwitch>>['products']
  /** The business each product that sells from shared stock now borrows from. */
  lenderNow: Map<string, string>
}

async function planStockSource(args: Record<string, unknown>): Promise<SourcePlan | Refusal> {
  const named = [...new Set((args.productIds ?? []) as string[])]
  const products = await productsById(named)
  if (refused(products)) return products
  const to = args.to === 'pool' ? 'pool' : 'own'
  let grantId: string | null = null
  let lender: string | null = null
  if (to === 'pool') {
    const wanted = typeof args.lender === 'string' ? args.lender.trim() : ''
    if (!wanted) return { error: 'lender is required to use shared stock: the business that lends it, as shared-stock shows it' }
    const { workspaceId } = requireWorkspace()
    const grants = await prisma.stockPoolGrant.findMany({ where: { workspaceId, status: 'active' }, select: { id: true, ownerWorkspace: { select: { name: true } } } })
    const grant = grants.find((g) => g.ownerWorkspace.name.trim().toLowerCase() === wanted.toLowerCase())
    if (!grant) return { error: `No shared stock from "${wanted}" is on for this business: see shared-stock (borrowing).` }
    grantId = grant.id
    lender = grant.ownerWorkspace.name
  }
  let preview: Awaited<ReturnType<typeof previewSwitch>>
  try {
    preview = await previewSwitch({ productIds: named, to, grantId, withVariations: args.withVariations !== false })
  } catch (error) {
    if (error instanceof WorkspaceError) return { error: error.message }
    throw error
  }
  const problems = preview.products.filter((p) => p.refusal).map((p) => `${p.sku}: ${p.refusal}`)
  if (problems.length) return { error: `Not switched (all or none): ${listed(problems)}` }
  const moving = preview.products.filter((p) => p.from !== to || to === 'pool')
  const already = to === 'own' ? preview.products.filter((p) => p.from === 'own') : []
  if (to === 'own' && already.length === preview.products.length) {
    return { error: `${listed(already.map((p) => p.sku))}: already sell${already.length === 1 ? 's' : ''} from this business's own stock.` }
  }
  const pooled = preview.products.filter((p) => p.from === 'pool').map((p) => p.productId)
  const links = pooled.length ? await prisma.stockPoolLink.findMany({ where: { productId: { in: pooled }, status: 'active' }, select: { productId: true, grant: { select: { ownerWorkspace: { select: { name: true } } } } } }) : []
  return { to, grantId, lender, ids: moving.map((p) => p.productId), products: preview.products, lenderNow: new Map(links.map((l) => [l.productId, l.grant.ownerWorkspace.name])) }
}

const SOURCE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { products?: Array<{ productId: string }> }
    const ids = (after.products ?? []).map((p) => p.productId)
    const links = ids.length ? await prisma.stockPoolLink.findMany({ where: { productId: { in: ids }, status: 'active' }, select: { productId: true, grant: { select: { ownerWorkspace: { select: { name: true } } } } } }) : []
    const byProduct = new Map(links.map((l) => [l.productId, l.grant.ownerWorkspace.name]))
    return { products: ids.map((productId) => ({ productId, source: byProduct.has(productId) ? 'pool' : 'own', lender: byProduct.get(productId) ?? null })) }
  },
  request(change) {
    const before = (change.before ?? {}) as { products?: Array<{ productId: string; source: string; lender: string | null }> }
    const rows = before.products ?? []
    if (!rows.length) return { refusal: 'This change does not name its products.' }
    const sources = new Set(rows.map((r) => `${r.source}|${r.lender ?? ''}`))
    if (sources.size > 1) return { refusal: 'These products took their stock from different places before: switch them back in Nexus, or one source at a time.' }
    const [first] = rows
    return {
      tool: 'set-stock-source',
      args: { productIds: rows.map((r) => r.productId), to: first.source === 'pool' ? 'pool' : 'own', ...(first.source === 'pool' ? { lender: first.lender } : {}), withVariations: false },
    }
  },
}

const setStockSource: AgentTool = {
  name: 'set-stock-source',
  title: 'Set where stock comes from',
  input: z.object({
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(STOCK_SOURCE_MAX).describe(`the products, 1 to ${STOCK_SOURCE_MAX} (a parent brings its variations)`),
    to: z.preprocess(lower, z.enum(['own', 'pool'])).describe('own (this business\'s own stock) or pool (shared stock another business lends, by the same SKU)'),
    lender: z.string().trim().min(1).max(100).optional().describe('pool: the business that lends the stock, as shared-stock names it'),
    withVariations: flag.optional().describe('false: only the products named, not their variations (default: with variations)'),
  }),
  requires: [F.inventoryAdjust],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SOURCE_UNDO,
  description:
    'Switch products between this business\'s own stock and the shared stock another business lends (matched by '
    + 'the same SKU). The preview shows, for every listing, what it shows now and what it will show after; a listing '
    + 'with a fixed number turns back to follow the shared stock (a fixed 0 stays). All or none. Only an owner of this '
    + 'business can approve it, in Nexus; sharing itself (offering, accepting, ending) is never done here.',
  async handler(args): Promise<ToolResult> {
    const plan = await planStockSource(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const rows = plan.products.flatMap((p) => p.listings)
    return {
      ok: true,
      preview: {
        action: 'set-stock-source',
        to: plan.to === 'pool' ? { source: 'pool', lender: plan.lender } : { source: 'own' },
        products: plan.products.slice(0, PREVIEW_LINES).map((p) => ({
          sku: p.sku, from: p.from, to: p.to,
          listings: p.listings.slice(0, 10).map((l) => ({
            channel: l.channel, marketplace: l.marketplace, account: l.accountLabel, ...(l.aliasLabel ? { alias: l.aliasLabel } : {}),
            showsNow: l.showsNow, willShow: l.willShow, rule: l.rule, ...(l.wasFixed ? { fixedTurnsToFollow: true } : {}),
          })),
          ...(p.listings.length > 10 ? { moreListings: p.listings.length - 10 } : {}),
        })),
        ...(plan.products.length > PREVIEW_LINES ? { moreProducts: plan.products.length - PREVIEW_LINES } : {}),
        totals: { products: plan.products.length, switching: plan.ids.length, listings: rows.length, fixedTurnsToFollow: rows.filter((l) => l.wasFixed).length },
        ...(plan.products.some((p) => p.costPriceMissing) ? { costPriceMissing: plan.products.filter((p) => p.costPriceMissing).map((p) => p.sku) } : {}),
        note: `${NOT_YET} Only an owner of this business can approve it. ${plan.to === 'pool' ? `Listings then follow ${plan.lender}'s lent stock; ${plan.lender} counts it.` : 'Listings then follow this business\'s own stock again.'} Undo switches back; a fixed number that turned to follow stays following.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planStockSource(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const context = requireWorkspace()
    try {
      // switchProducts checks that the person running it (the approver) is an owner of this business.
      const result = await withWorkspace({ ...context, actorUserId: ctx.userId ?? context.actorUserId }, () =>
        switchProducts({ productIds: plan.products.map((p) => p.productId), to: plan.to, grantId: plan.grantId, withVariations: false }))
      return {
        ok: true,
        data: result,
        change: {
          before: { products: plan.products.map((p) => ({ productId: p.productId, sku: p.sku, source: p.from, lender: plan.lenderNow.get(p.productId) ?? null })) },
          after: { products: plan.products.map((p) => ({ productId: p.productId, source: plan.to, lender: plan.to === 'pool' ? plan.lender : null })) },
        },
      }
    } catch (error) {
      if (error instanceof WorkspaceError) return { ok: false, error: error.message }
      throw error
    }
  },
}

export const STOCK_CHANGE_TOOLS: AgentTool[] = [setStock, transferStockTool, stockCount, reconcileStockCount, reserveStock, setStockLocation, setStockSource]
