/**
 * MCP full control L8 — stock and price per listing and market (plan section 02, step 8), through the Matrix door, the
 * same door the Studio Matrix page uses (`runMatrixVerb`, `writeMatrixCells`, `revertMatrixOperation`):
 *
 *   set-listing-stock     pin a quantity, follow the stock again, set a buffer, hold or release the stock sync, push now,
 *                         retry a failed push (the Matrix's Sync › Retry), or set an Amazon listing's fulfilment to FBA or
 *                         FBM (the Matrix's Set fulfilment…: a real conversion SENT to Amazon per market and confirmed
 *                         from Amazon's merchant listings report — `fulfilment-conversion.service.ts`).
 *   set-listing-price     set a price, adjust prices by a percentage, copy prices from another market, or set a sale.
 *   revert-listing-change put back a Matrix operation one of them ran (the undo of both).
 *
 * Targets are the Matrix's own: a row (rowId) and a coordinate key (EBAY:IT, AMAZON:EU …) from listing-matrix. The door's
 * rules hold for Claude as for the page: an FBA quantity is never written (refused as Amazon-managed); Amazon's EU markets
 * share ONE merchant quantity, so an EU market's inventory verb lands on the AMAZON:EU cell; an eBay pin to 0 is refused
 * unless the account's out-of-stock option is ON (eBay would end the item); a listing whose selling is paused (Inactive: the
 * product sheet's Pause offer, or Amazon's market close) takes no quantity (build shape v2: the Matrix refuses every stock
 * verb on it but releasing the stock sync, and Push quantity now / Retry ask the store again where the push is written);
 * a price needs products.price.edit. The dry run
 * is the door's own preview; the run carries the approved changes and the door re-verifies each one, refusing any that
 * moved. Each run is one Matrix operation, and revert-listing-change puts it back while nothing changed it since.
 * The master stock count is not here (part S, set-stock).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { MATRIX_COPY, type MatrixVerbParams, type MatrixVerbTarget, type VerbChange, type VerbPreview, type VerbRefusal, type MatrixWriteOutcome } from '@nexus/shared/matrix-contract'
import prisma from '../../../db.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const matrixWrite = () => import('../../pim/matrix-write.service.js')
const matrixRead = () => import('../../pim/matrix.service.js')

const targetsInput = z.array(z.object({
  rowId: z.string().trim().min(1).max(64).describe('the row: a product id from listing-matrix (rowId)'),
  coordinateKey: z.string().trim().min(1).max(160).describe('the column: a coordinate key from listing-matrix, e.g. EBAY:IT, AMAZON:EU or EBAY:IT#<aliasId>'),
})).min(1).max(250).describe('where it applies: rows and coordinate keys from listing-matrix')

/** The family a Matrix call names: its root, the product the Matrix reads and stores its operations under. */
async function familyRoot(productId: string): Promise<{ id: string; sku: string } | null> {
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, sku: true, parentId: true } })
  if (!product) return null
  if (!product.parentId) return { id: product.id, sku: product.sku }
  return prisma.product.findFirst({ where: liveProduct(product.parentId), select: { id: true, sku: true } })
}

/** A refusal the door gives a person (an HTTP 4xx), as opposed to a fault. */
function personError(error: unknown): string | null {
  const status = (error as { statusCode?: unknown })?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500 ? (error instanceof Error ? error.message : String(error)) : null
}

const doorFor = (productId: string, ctx: ToolContext, actor?: string) => ({ productId, actor: actor ?? ctx.userId ?? 'claude', can: (permission: string) => ctx.can(permission as never) })

/** N4 — a hold of the stock sync also keeps price and sale changes in Nexus (follower-price `holdsCascadedPrice`). */
export const HOLD_HOLDS_PRICES = 'Holding the stock sync also holds price and sale changes on these listings: they are kept in Nexus and sent '
  + 'when the stock sync is released.'

/** Retry sends a push again; once it reached the channel it cannot be called back (the Matrix keeps nothing to put back). */
export const RETRY_SENDS_AGAIN = 'Retry sends the failed push to the channel again; what reaches the channel cannot be called back.'

/** Amazon fulfilment conversion (2026-10-07): set-fulfilment on Amazon is SENT to Amazon and confirmed from its report. */
export const FULFILMENT_SENT = 'This change is sent to Amazon: each market\'s offer is converted with a Listings Items patch (FBM: DEFAULT '
  + 'with the merchant quantity; FBA: AMAZON_EU, no quantity), then checked against Amazon\'s merchant listings report within minutes — '
  + 'the Matrix\'s Fulfilment cell shows when Amazon confirms it. Its revert is the opposite conversion, with fresh checks.'

/**
 * N4 — the Matrix preview in words for the Approvals card (which reads `summary` and `warning`, not a list of cells):
 * what it changes and where, how many targets were refused, Amazon's one EU quantity, what a hold also holds, that a
 * retry cannot be called back, and what a fulfilment change does on Amazon (`also`: the per-listing sentences).
 */
export function matrixStory(sku: string, preview: Pick<VerbPreview, 'verb' | 'changes' | 'refusals' | 'notices'>, also: readonly string[] = []) {
  const keys = [...new Set(preview.changes.map((c) => c.coordinateKey))]
  const summary = `${sku}: ${preview.verb} — ${preview.changes.length} change${preview.changes.length === 1 ? '' : 's'} on `
    + `${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ` and ${keys.length - 6} more` : ''}`
    + `${preview.refusals.length ? `; ${preview.refusals.length} refused (see refused)` : ''}.`
  const byVerb = preview.verb === 'pause-sync' ? [HOLD_HOLDS_PRICES] : preview.verb === 'retry-sync' ? [RETRY_SENDS_AGAIN]
    : preview.verb === 'set-fulfilment' ? [FULFILMENT_SENT] : []
  const warnings = [...preview.notices, ...byVerb, ...also]
  return { summary, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}

/** The Matrix preview, as a person reads it in Nexus: each change and each refusal, by SKU and coordinate. */
function previewOf(tool: string, family: { id: string; sku: string }, preview: VerbPreview, extra: Record<string, unknown>, also: readonly string[] = []) {
  return {
    action: tool,
    family: { productId: family.id, sku: family.sku },
    ...matrixStory(family.sku, preview, also),
    ...extra,
    verb: preview.verb,
    changes: preview.changes,
    ...(preview.refusals.length ? { refused: preview.refusals.map((r) => ({ sku: r.sku, coordinateKey: r.coordinateKey, kind: r.kind, reason: r.reason })) } : {}),
    ...(preview.notices.length ? { notices: preview.notices } : {}),
  }
}

type Family = { id: string; sku: string }
/**
 * A verb's own check after the door's preview, where the door decides more at commit than its preview says: each change
 * that would be refused moves to the refusals with the door's sentence, and `also` says what the rest does.
 */
type Vet = (family: Family, preview: VerbPreview, ctx: ToolContext) => Promise<{ preview: VerbPreview; also: string[] }>

/** The dry run of a Matrix verb: the door's own preview; refused when it changes nothing. */
async function previewVerbFor(tool: string, args: Record<string, unknown>, ctx: ToolContext, params: MatrixVerbParams | { error: string }, extra: Record<string, unknown> = {}, vet?: Vet): Promise<ToolResult> {
  const family = await familyRoot(String(args.productId))
  if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
  if ('error' in params) return { ok: false, error: `${family.sku}: ${params.error}` }
  const { runMatrixVerb } = await matrixWrite()
  let preview: VerbPreview
  try {
    preview = await runMatrixVerb(doorFor(family.id, ctx, 'preview'), { params, targets: args.targets as MatrixVerbTarget[], commit: false }) as VerbPreview
  } catch (error) {
    const sentence = personError(error) ?? ((error as { code?: unknown })?.code === 'unknown_product' ? PRODUCT_NOT_FOUND : null)
    if (sentence === null) throw error
    return { ok: false, error: sentence }
  }
  const vetted = vet && preview.changes.length ? await vet(family, preview, ctx) : { preview, also: [] }
  preview = vetted.preview
  if (!preview.changes.length) {
    const why = preview.refusals.slice(0, 10).map((r) => `${r.sku} ${r.coordinateKey}: ${r.reason}`).join(' · ')
    return { ok: false, error: `${family.sku}: nothing to change${why ? ` — ${why}` : ': every target already is as asked'}. Nothing was queued.` }
  }
  return { ok: true, preview: previewOf(tool, family, preview, extra, vetted.also) }
}

/** The run: the approved changes, carried to the door, which re-verifies each and refuses any that moved since. */
async function runVerbFor(args: Record<string, unknown>, ctx: ToolContext, params: MatrixVerbParams | { error: string }, vet?: Vet): Promise<ToolResult> {
  const family = await familyRoot(String(args.productId))
  if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
  if ('error' in params) return { ok: false, error: `${family.sku}: ${params.error}` }
  const approved = ctx.approvedPreview as { verb?: unknown; changes?: unknown } | undefined
  if (!Array.isArray(approved?.changes) || approved.verb !== params.verb) return { ok: false, error: 'A Matrix change runs only after a person approved its preview. Nothing changed.' }
  const { runMatrixVerb } = await matrixWrite()
  // What the person approved is each cell FROM its value then TO the new one. The door re-verifies the new value only, so
  // a cell someone changed in between (a buffer 0 → 1 while "0 → 2" waited) is refused here, before anything is written.
  const fresh = await runMatrixVerb(doorFor(family.id, ctx, 'preview'), { params, targets: args.targets as MatrixVerbTarget[], commit: false }) as VerbPreview
  const key = (c: { rowId: string; coordinateKey: string; cell: string; from: unknown; to: unknown }) => JSON.stringify([c.rowId, c.coordinateKey, c.cell, c.from, c.to])
  const now = new Set(fresh.changes.map(key))
  const moved = (approved.changes as VerbPreview['changes']).filter((c) => !now.has(key(c)))
  if (moved.length) {
    // The fresh preview's own sentence when it refuses the target now (a guard that closed meanwhile), by name.
    const why = (c: VerbChange) => fresh.refusals.find((r) => r.rowId === c.rowId && r.coordinateKey === c.coordinateKey)?.reason
    return { ok: false, error: `${family.sku}: ${moved.slice(0, 10).map((c) => `${c.sku} ${c.coordinateKey}${why(c) ? ` (${why(c)})` : ''}`).join(', ')} changed since it was approved. Nothing changed; ask Claude again.` }
  }
  const carried: VerbPreview = { verb: params.verb, changes: approved.changes as VerbPreview['changes'], refusals: [], notices: [], confirm: 'none', confirmWord: null, simulated: false }
  // The verb's own check again, on what was approved: a guard that closed meanwhile (FBA units arrived, the failed push
  // was sent by someone else) refuses the whole request before anything is written — never a part of an EU group.
  const recheck = vet ? (await vet(family, carried, ctx)).preview.refusals : []
  if (recheck.length) {
    return { ok: false, error: `${family.sku}: ${recheck.slice(0, 10).map((r) => `${r.sku} ${r.coordinateKey}: ${r.reason}`).join(' · ')}. Nothing changed; ask Claude again.` }
  }
  const out = await runMatrixVerb(doorFor(family.id, ctx), { params, targets: args.targets as MatrixVerbTarget[], commit: true, preview: carried }) as { operation: { id: string; applied: number; refused: number }; results: MatrixWriteOutcome[] }
  const refused = out.results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict')
  const summary = { operationId: out.operation.id, applied: out.operation.applied, refused: refused.map((r) => ({ rowId: r.rowId, coordinateKey: r.coordinateKey, reason: r.reason ?? r.outcome })) }
  if (!out.operation.applied) return { ok: false, error: `Nothing changed: ${refused.slice(0, 10).map((r) => `${r.coordinateKey}: ${r.reason ?? r.outcome}`).join(' · ')}` }
  return {
    ok: true,
    data: summary,
    // C1 — the Matrix operation: it holds every touched cell's value from before, and its revert puts them back.
    change: { before: { productId: family.id, operationId: out.operation.id, verb: params.verb, changes: approved.changes }, after: { productId: family.id, operationId: out.operation.id, reverted: false } },
  }
}

/** C2 — a Matrix operation, as stored now: reverted (or being reverted) or not. */
const MATRIX_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; operationId?: string }
    const op = after.operationId ? await prisma.bulkOperation.findFirst({ where: { id: after.operationId }, select: { status: true } }) : null
    return { productId: after.productId ?? null, operationId: after.operationId ?? null, reverted: !op || !['COMPLETED', 'PARTIAL'].includes(op.status) }
  },
  request(change) {
    const after = (change.after ?? {}) as { productId?: string; operationId?: string }
    if (!after.productId || !after.operationId) return { refusal: 'This change names no Matrix operation.' }
    // A push (push-now, retry-sync) changes no cell the Matrix could put back: what it sent stays sent.
    const verb = ((change.before ?? {}) as { verb?: unknown }).verb
    if (verb === 'push-now' || verb === 'retry-sync') return { refusal: 'A push that was sent cannot be called back: the channel keeps what it received. Set the quantity again instead.' }
    return { tool: 'revert-listing-change', args: { productId: after.productId, operationId: after.operationId } }
  },
}

// ── set-listing-stock ────────────────────────────────────────────────────────────────────────────────

const STOCK_ACTIONS = ['pin-quantity', 'set-follow', 'set-buffer', 'pause-sync', 'resume-sync', 'push-now', 'retry-sync', 'set-fulfilment'] as const
/** The methods Claude may set: Amazon's two. eBay's MCF stays with a person (the stock cascade then stops pushing that eBay listing). */
const FULFILMENT_METHODS = ['FBA', 'FBM'] as const

const stockInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations, as listing-matrix read it'),
  action: z.enum(STOCK_ACTIONS).describe('pin-quantity (a fixed quantity), set-follow (follow the stock again), set-buffer, pause-sync (hold the stock sync), '
    + 'resume-sync (release it), push-now, retry-sync (send a failed push again) or set-fulfilment (FBA or FBM, Amazon listings only)'),
  quantity: z.coerce.number().int().min(0).max(1_000_000).optional().describe('pin-quantity: the quantity to pin'),
  buffer: z.coerce.number().int().min(0).max(1_000_000).optional().describe('set-buffer: units held back from the stock the listing follows'),
  method: z.enum(FULFILMENT_METHODS).optional().describe('set-fulfilment: FBA (Amazon ships from its stock; the quantity is Amazon\'s) or FBM (the business ships; Nexus sends the stock)'),
  targets: targetsInput,
})

function stockParams(args: Record<string, unknown>): MatrixVerbParams | { error: string } {
  const action = String(args.action) as (typeof STOCK_ACTIONS)[number]
  if (args.method !== undefined && action !== 'set-fulfilment') return { error: 'A method is given with set-fulfilment only.' }
  if (action === 'pin-quantity') return typeof args.quantity === 'number' ? { verb: action, value: args.quantity } : { error: 'pin-quantity needs a quantity.' }
  if (action === 'set-buffer') return typeof args.buffer === 'number' ? { verb: action, value: args.buffer } : { error: 'set-buffer needs a buffer.' }
  if (action === 'set-fulfilment') {
    if (args.method !== 'FBA' && args.method !== 'FBM') return { error: 'set-fulfilment needs a method: FBA or FBM.' }
    const other = (args.targets as MatrixVerbTarget[]).filter((t) => !/^AMAZON:/i.test(t.coordinateKey))
    if (other.length) return { error: `set-fulfilment changes Amazon listings only (AMAZON:… coordinates), not ${[...new Set(other.map((t) => t.coordinateKey))].slice(0, 5).join(', ')}. eBay's MCF is set by a person in the Matrix.` }
    return { verb: 'set-fulfilment', method: args.method }
  }
  return { verb: action } as MatrixVerbParams
}

/** The Matrix read the door reads, and the listing rows one change lands on (an Amazon EU cell: every open EU row of the SKU). */
async function landingOf(familyId: string, ctx: ToolContext) {
  const [{ getMatrixRead }, { locate, targetsOf }] = await Promise.all([matrixRead(), matrixWrite()])
  const read = await getMatrixRead({ productId: familyId, accountId: null, canEditPrice: ctx.can(F.productsPriceEdit) })
  return {
    read,
    async of(change: Pick<VerbChange, 'rowId' | 'coordinateKey'>) {
      const hit = locate(read, change.rowId, change.coordinateKey)
      const landed = hit?.cells.listingId ? await targetsOf(read, hit, hit.cells.version) : null
      return hit && landed && !('conflict' in landed) ? { hit, targets: landed.targets } : null
    },
  }
}

const refusalOf = (c: VerbChange, reason: string): VerbRefusal => ({ rowId: c.rowId, sku: c.sku, coordinateKey: c.coordinateKey, kind: 'guard', reason })

/**
 * PURE — what a fulfilment change does, in words, for one change of the door's preview (its `note` says what is sent to
 * Amazon, where, and which markets are skipped). After Amazon accepts: FBM — Nexus manages the merchant quantity (the
 * stock it follows, or the pin), on every open EU market at once; FBA — Nexus sends no quantity, Amazon's FBA units are
 * the quantity and the offer shows out of stock until Amazon receives units.
 */
export function fulfilmentWords(input: { sku: string; coordinateKey: string; method: 'FBA' | 'FBM'; note?: string | null }): string {
  const sent = input.note ? `${input.note}.` : `Sends Amazon ${input.method}.`
  const after = input.method === 'FBM'
    ? 'Once Amazon accepts, Nexus manages the merchant quantity from then on.'
    : 'Once Amazon accepts, Nexus sends no quantity: the quantity is Amazon\'s FBA units, and the offer shows out of stock until Amazon receives units.'
  return `${input.sku} on ${input.coordinateKey}: ${sent} ${after}`
}

/**
 * set-fulfilment — the door's own preview carries every check now (on Amazon: the server's fresh facts — FBA units on
 * hand, reserved and inbound, an active FBA offer, an Amazon-only code, a draft, Inactive markets, the quantity); here
 * each change is checked to still land on the Matrix (else refused as changed elsewhere) and says what it does.
 */
function vetFulfilment(method: 'FBA' | 'FBM'): Vet {
  return async (family, preview, ctx) => {
    const landing = await landingOf(family.id, ctx)
    const changes: VerbChange[] = []
    const refusals = [...preview.refusals]
    const also: string[] = []
    for (const change of preview.changes) {
      if (!(await landing.of(change))) { refusals.push(refusalOf(change, MATRIX_COPY.changedElsewhere)); continue }
      changes.push(change)
      also.push(fulfilmentWords({ sku: change.sku, coordinateKey: change.coordinateKey, method, note: change.note }))
    }
    return { preview: { ...preview, changes, refusals }, also }
  }
}

/**
 * retry-sync — the Sync cell reads a skipped push as failed too, but Retry sends only a FAILED or dead row
 * (`newestFailedPush`, the door's own query). A change with no such row is refused here, as the door would at commit;
 * the rest say which push goes out again.
 */
const vetRetry: Vet = async (family, preview, ctx) => {
  const [landing, { newestFailedPush }] = await Promise.all([landingOf(family.id, ctx), matrixWrite()])
  const changes: VerbChange[] = []
  const refusals = [...preview.refusals]
  const also: string[] = []
  for (const change of preview.changes) {
    const landed = await landing.of(change)
    const row = landed ? await newestFailedPush(landed.targets.map((t) => t.id)) : null
    if (!row) { refusals.push(refusalOf(change, landed ? 'Nothing to retry on this coordinate' : MATRIX_COPY.changedElsewhere)); continue }
    changes.push(change)
    also.push(`${change.sku} on ${change.coordinateKey}: its failed ${row.syncType === 'PRICE_UPDATE' ? 'price' : 'quantity'} push is sent again.`)
  }
  return { preview: { ...preview, changes, refusals }, also }
}

function stockVet(args: Record<string, unknown>): Vet | undefined {
  if (args.action === 'retry-sync') return vetRetry
  if (args.action === 'set-fulfilment' && (args.method === 'FBA' || args.method === 'FBM')) return vetFulfilment(args.method)
  return undefined
}

const setListingStock: AgentTool = {
  name: 'set-listing-stock',
  title: 'Set listing stock',
  input: stockInput,
  requires: [F.inventoryAdjust, F.productsEdit],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: revert puts every cell back (a fulfilment method too), but a quantity already pushed was on the channel
  // meanwhile, and a push (push-now, retry-sync) cannot be called back at all.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: MATRIX_UNDO,
  description:
    'Change how listings take their stock, per listing and market, through the Nexus Matrix: pin a quantity, follow the '
    + 'stock again, set a buffer, hold or release the stock sync, push now, retry a failed push (retry-sync), or set an '
    + 'Amazon listing\'s fulfilment to FBA or FBM (set-fulfilment). Targets are rows and coordinate keys from '
    + 'listing-matrix. FBA quantities are never written; Amazon\'s EU markets share one quantity and one fulfilment '
    + '(AMAZON:EU); an eBay pin to 0 needs the account\'s out-of-stock option ON (else eBay ends the item); a listing whose '
    + 'selling is paused (Inactive) takes no quantity — resume it in the product sheet\'s Status column. set-fulfilment '
    + 'on Amazon is SENT to Amazon: each open market\'s offer is converted (FBM: DEFAULT with the merchant quantity the cell '
    + 'would push; FBA: AMAZON_EU, no quantity) and then confirmed from Amazon\'s merchant listings report; FBA → FBM is '
    + 'refused while FBA units are on hand, reserved or inbound, an active FBA offer or an Amazon-only code remains, and on '
    + 'a draft or Inactive market; eBay\'s MCF stays Nexus-only. '
    + 'The preview is the Matrix\'s own. Waits for a person to approve it in Nexus; a target that changed since is refused, '
    + 'and revert-listing-change puts it back (a push already sent cannot be called back).',
  handler: (args, ctx) => previewVerbFor('set-listing-stock', args, ctx, stockParams(args), {}, stockVet(args)),
  execute: (args, ctx) => runVerbFor(args, ctx, stockParams(args), stockVet(args)),
}

// ── set-listing-price ────────────────────────────────────────────────────────────────────────────────

const PRICE_ACTIONS = ['set-price', 'adjust-prices', 'copy-prices', 'sale'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

const priceInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations, as listing-matrix read it'),
  action: z.enum(PRICE_ACTIONS).describe('set-price, adjust-prices (by a percentage), copy-prices (from another market) or sale'),
  price: z.coerce.number().positive().max(1_000_000).optional().describe('set-price: the price, in the market\'s currency'),
  percent: z.coerce.number().min(-90).max(500).optional().describe('adjust-prices: the change in percent, e.g. -10 or 5'),
  fromCoordinateKey: z.string().trim().min(1).max(160).optional().describe('copy-prices: the coordinate key to copy from (same currency)'),
  sale: z.object({
    price: z.coerce.number().positive().max(1_000_000).nullable().describe('the sale price; null ends the sale'),
    start: z.string().regex(DAY).nullable().optional().describe('first day, YYYY-MM-DD'),
    end: z.string().regex(DAY).nullable().optional().describe('last day, YYYY-MM-DD'),
  }).optional().describe('sale: the sale price and its days'),
  targets: targetsInput,
})

function priceParams(args: Record<string, unknown>): MatrixVerbParams | { error: string } {
  const action = String(args.action)
  if (action === 'set-price') return typeof args.price === 'number' ? { verb: 'set-price', value: args.price } : { error: 'set-price needs a price.' }
  if (action === 'adjust-prices') return typeof args.percent === 'number' ? { verb: 'adjust-prices', percent: args.percent } : { error: 'adjust-prices needs a percent.' }
  if (action === 'copy-prices') return typeof args.fromCoordinateKey === 'string' ? { verb: 'copy-prices', fromCoordinateKey: args.fromCoordinateKey } : { error: 'copy-prices needs fromCoordinateKey.' }
  return { error: 'sale is not a Matrix verb.' }
}

type SaleValue = { value: number | null; start: string | null; end: string | null }

/** A sale, previewed: each target's sale now and after, at the version read (the run writes only at that version). */
async function planSale(args: Record<string, unknown>, ctx: ToolContext) {
  const family = await familyRoot(String(args.productId))
  if (!family) return { error: PRODUCT_NOT_FOUND }
  if (!args.sale) return { error: 'sale needs a sale price (null ends the sale).' }
  const s = args.sale as { price: number | null; start?: string | null; end?: string | null }
  const to: SaleValue = { value: s.price, start: s.price == null ? null : s.start ?? null, end: s.price == null ? null : s.end ?? null }
  if (to.start && to.end && to.start > to.end) return { error: 'The sale ends before it starts.' }
  if (!ctx.can(F.productsPriceEdit)) return { error: 'A sale price needs products.price.edit.' }
  const { getMatrixRead } = await matrixRead()
  const read = await getMatrixRead({ productId: family.id, canEditPrice: true })
  const cells: Array<{ rowId: string; sku: string; coordinateKey: string; from: SaleValue; to: SaleValue; version: number }> = []
  const refused: Array<{ sku: string; coordinateKey: string; reason: string }> = []
  for (const t of args.targets as MatrixVerbTarget[]) {
    const row = read.rows.find((r) => r.id === t.rowId)
    const cell = row?.cells[t.coordinateKey]
    if (!row || !cell?.sale || !cell.listingId) { refused.push({ sku: row?.sku ?? t.rowId, coordinateKey: t.coordinateKey, reason: 'No sale price on this coordinate' }); continue }
    if (cell.writable.salePrice === false) { refused.push({ sku: row.sku, coordinateKey: t.coordinateKey, reason: cell.writeBlockedReason.salePrice ?? 'This sale price cannot be changed here' }); continue }
    const from = { value: cell.sale.value, start: cell.sale.start, end: cell.sale.end }
    if (from.value === to.value && from.start === to.start && from.end === to.end) continue
    cells.push({ rowId: row.id, sku: row.sku, coordinateKey: t.coordinateKey, from, to, version: cell.version })
  }
  return { family, cells, refused }
}

const PRICE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { kind?: string; productId?: string; operationId?: string; sale?: Array<{ rowId: string; coordinateKey: string }> }
    if (after.kind !== 'sale') return MATRIX_UNDO.current(change)
    const { getMatrixRead } = await matrixRead()
    const read = await getMatrixRead({ productId: after.productId!, canEditPrice: true })
    return { kind: 'sale', productId: after.productId, sale: (after.sale ?? []).map((c) => {
      const sale = read.rows.find((r) => r.id === c.rowId)?.cells[c.coordinateKey]?.sale
      return { rowId: c.rowId, coordinateKey: c.coordinateKey, value: sale?.value ?? null, start: sale?.start ?? null, end: sale?.end ?? null }
    }) }
  },
  request(change) {
    const before = (change.before ?? {}) as { kind?: string; productId?: string; sale?: Array<{ rowId: string; coordinateKey: string } & SaleValue> }
    if (before.kind !== 'sale') return MATRIX_UNDO.request(change)
    const cells = before.sale ?? []
    const first = cells[0]
    if (!first || !before.productId) return { refusal: 'This change names no sale.' }
    if (cells.some((c) => c.value !== first.value || c.start !== first.start || c.end !== first.end)) {
      return { refusal: 'These listings had different sales before: set each one again with set-listing-price.' }
    }
    return { tool: 'set-listing-price', args: { productId: before.productId, action: 'sale', sale: { price: first.value, start: first.start, end: first.end },
      targets: cells.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })) } }
  },
}

const setListingPrice: AgentTool = {
  name: 'set-listing-price',
  title: 'Set listing price',
  input: priceInput,
  requires: [F.productsPriceEdit, F.productsEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: the prices come back, but orders taken at the new price stay.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: PRICE_UNDO,
  description:
    'Change the price of listings per market through the Nexus Matrix: set a price, adjust prices by a percentage, copy '
    + 'prices from another market in the same currency, or set (or end) a sale with its days. Targets are rows and '
    + 'coordinate keys from listing-matrix. A formula-owned price is refused. The preview is the Matrix\'s own. Waits for a '
    + 'person to approve it in Nexus; a target that changed since is refused, and it can be put back.',
  async handler(args, ctx) {
    if (args.action !== 'sale') return previewVerbFor('set-listing-price', args, ctx, priceParams(args))
    const plan = await planSale(args, ctx)
    if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing was queued.` }
    if (!plan.cells.length) return { ok: false, error: `${plan.family.sku}: nothing to change${plan.refused.length ? ` — ${plan.refused.slice(0, 10).map((r) => `${r.sku} ${r.coordinateKey}: ${r.reason}`).join(' · ')}` : ''}. Nothing was queued.` }
    return { ok: true, preview: { action: 'set-listing-price', family: { productId: plan.family.id, sku: plan.family.sku }, verb: 'sale', changes: plan.cells,
      ...(plan.refused.length ? { refused: plan.refused } : {}) } }
  },
  async execute(args, ctx) {
    if (args.action !== 'sale') return runVerbFor(args, ctx, priceParams(args))
    const approved = ctx.approvedPreview as { verb?: unknown; changes?: Array<{ rowId: string; coordinateKey: string; to: SaleValue; version: number; from: SaleValue }> } | undefined
    if (approved?.verb !== 'sale' || !Array.isArray(approved.changes)) return { ok: false, error: 'A sale is set only after a person approved its preview. Nothing changed.' }
    const family = await familyRoot(String(args.productId))
    if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
    const { writeMatrixCells } = await matrixWrite()
    // Each cell at the version the person saw: one that moved since is a conflict, never overwritten.
    const out = await writeMatrixCells(doorFor(family.id, ctx), approved.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: 'salePrice' as const, value: c.to, expectedVersion: c.version })))
    const applied = out.results.filter((r) => r.outcome === 'applied')
    const refused = out.results.filter((r) => r.outcome !== 'applied' && r.outcome !== 'noop')
    if (!applied.length) return { ok: false, error: `Nothing changed: ${refused.slice(0, 10).map((r) => `${r.coordinateKey}: ${r.reason ?? r.outcome}`).join(' · ')}` }
    const done = approved.changes.filter((c) => applied.some((r) => r.rowId === c.rowId && r.coordinateKey === c.coordinateKey))
    return {
      ok: true,
      data: { applied: applied.length, refused: refused.map((r) => ({ rowId: r.rowId, coordinateKey: r.coordinateKey, reason: r.reason ?? r.outcome })) },
      change: {
        before: { kind: 'sale', productId: family.id, sale: done.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, ...c.from })) },
        after: { kind: 'sale', productId: family.id, sale: done.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, ...c.to })) },
      },
    }
  },
}

// ── revert-listing-change ────────────────────────────────────────────────────────────────────────────

const revertListingChange: AgentTool = {
  name: 'revert-listing-change',
  title: 'Revert a listing change',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id of the family the change was made on'),
    operationId: z.string().trim().min(1).max(64).describe('the Matrix operation to put back (a set-listing-stock or set-listing-price change names it)'),
  }),
  requires: [F.inventoryAdjust, F.productsEdit],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — a Matrix operation is reverted once; the revert itself is not reverted (set the values again instead).
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Put back a stock or price change made through the Nexus Matrix (a set-listing-stock or set-listing-price change, or '
    + 'the Matrix page), within 24 hours: every cell it touched returns to its value from before, through the same door. '
    + 'A cell someone changed since is refused, not overwritten. A price restored needs products.price.edit. Waits for a '
    + 'person to approve it in Nexus.',
  async handler(args) {
    const family = await familyRoot(String(args.productId))
    if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
    const op = await prisma.bulkOperation.findFirst({ where: { id: String(args.operationId) }, select: { id: true, status: true, expiresAt: true, changes: true, createdAt: true } })
    const stored = (op?.changes ?? {}) as { kind?: string; productId?: string; verb?: string; before?: Array<{ rowId: string; coordinateKey: string }> }
    if (!op || stored.kind !== 'studio-matrix-verb' || stored.productId !== family.id) {
      return { ok: false, error: `${family.sku}: no Matrix operation with this id on this product (set-listing-stock and set-listing-price name theirs).` }
    }
    if (!['COMPLETED', 'PARTIAL'].includes(op.status)) return { ok: false, error: `This operation is ${op.status.toLowerCase()}: it can be reverted once, from completed or partial.` }
    if (op.expiresAt && op.expiresAt.getTime() <= Date.now()) return { ok: false, error: 'This operation is past its 24-hour revert window.' }
    return {
      ok: true,
      preview: { action: 'revert-listing-change', family: { productId: family.id, sku: family.sku }, operationId: op.id, verb: stored.verb ?? null, status: op.status,
        appliedAt: op.createdAt.toISOString(), cells: (stored.before ?? []).map((b) => ({ rowId: b.rowId, coordinateKey: b.coordinateKey })) },
    }
  },
  async execute(args, ctx) {
    const family = await familyRoot(String(args.productId))
    if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
    const { revertMatrixOperation } = await matrixWrite()
    try {
      const out = await revertMatrixOperation(doorFor(family.id, ctx), String(args.operationId))
      const refused = out.results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict')
      return { ok: true, data: { operationId: out.operation.id, applied: out.operation.applied, refused: refused.map((r) => ({ rowId: r.rowId, coordinateKey: r.coordinateKey, reason: r.reason ?? r.outcome })) } }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${sentence}. Nothing changed.` }
    }
  },
}

export const LISTING_STOCK_TOOLS: AgentTool[] = [setListingStock, setListingPrice, revertListingChange]
