/**
 * MCP full control L8 — stock and price per listing and market (plan section 02, step 8), through the Matrix door, the
 * same door the Studio Matrix page uses (`runMatrixVerb`, `writeMatrixCells`, `revertMatrixOperation`):
 *
 *   set-listing-stock     pin a quantity, follow the stock again, set a buffer, hold or release the stock sync, push now,
 *                         retry a failed push (the Matrix's Sync › Retry), or set an Amazon listing's fulfilment to FBA or
 *                         FBM (the Matrix's Set fulfilment…: a real conversion SENT to Amazon per market and confirmed
 *                         from Amazon's merchant listings report — `fulfilment-conversion.service.ts`).
 *   set-listing-price     set a price, adjust prices by a percentage or an amount, copy prices from another market, or set a sale;
 *                         or (action business, Amazon Business step 6) set, change or remove an Amazon listing's business
 *                         price and quantity tiers — the Matrix's own B2B write (`writeMatrixCells` → `writeBusinessPrices`),
 *                         previewed by the business price door's dry run (`business-price-plan.ts`) and put back by value.
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
import { adjustPricesProblem, PREVIEW_WORDS } from '@nexus/shared/matrix-preview'
import prisma from '../../../db.js'
import { approvedOnVersion, BASIS_ON_FIELDS, factHash, type AgentTool, type PlanFacts, type PlanWrite, type ToolContext, type ToolResult, type ToolUndo } from '../tool-types.js'
import { listingPlanFacts, listingPriceFacts, pinnedPrice, saleFact } from './listing-facts.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import {
  BUSINESS_INPUT, businessCardSummary, businessFromWords, businessSettingWords, businessUndoRequest, currentBusinessRecords, planBusinessPrices, sameSetting,
  type BusinessInput, type BusinessLine, type BusinessPlanItem, type BusinessPlanRefusal, type BusinessRecord,
} from './business-price-plan.js'

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

/** Amazon fulfilment conversion (2026-10-07; add + delete since 2026-10-08): SENT to Amazon, confirmed from its report. */
export const FULFILMENT_SENT = 'This change is sent to Amazon: each open market gets ONE Listings Items patch that adds the new fulfilment '
  + 'record and deletes the old one (FBM: add DEFAULT with the merchant quantity, delete AMAZON_EU; FBA: add AMAZON_EU with no quantity, '
  + 'delete DEFAULT). Amazon accepts a patch first and applies it later: the Matrix\'s Fulfilment cell says Confirmed only when Amazon\'s '
  + 'merchant listings report shows the new method (read every 15 minutes for 24 hours). Its revert is the opposite conversion, with fresh checks.'

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
  // 2.3 — the prices this run wrote, from the door's own answer: each listing a price write moved, pinned at its new price.
  const planWrites: PlanWrite[] = out.results.filter((r) => r.outcome === 'applied' && r.cell === 'price').flatMap((r) => {
    const change = carried.changes.find((c) => c.rowId === r.rowId && c.coordinateKey === r.coordinateKey && c.cell === 'price')
    return typeof change?.to === 'number' ? (r.listings ?? []).map((l) => ({ key: `listing:${l.listingId}:price` as const, after: pinnedPrice(change.to as number) })) : []
  })
  return {
    ok: true,
    data: summary,
    ...(planWrites.length ? { planWrites } : {}),
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
 * PURE — a money value typed once for many markets (a set price, a sale price, an exact business price or prices per
 * unit) is one number in ONE currency: €30 is not £30. With `currency`, a target in a market that sells in another is
 * refused with the Matrix's sentence (`This market sells in GBP`; for Set price the Matrix verb does it itself, #623).
 * Without it, targets in more than one currency refuse the request: the Matrix reads a bare number as each market's own
 * currency (#623), which a person typing in the grid sees, but a request Claude asks for must say its currency.
 */
export function moneyCurrencyGate(
  coordinates: ReadonlyArray<{ key: string; currency: string }>,
  targets: ReadonlyArray<{ coordinateKey: string }>,
  currency: string | null,
  what: string,
): { error: string } | { refuse: (coordinateKey: string) => string | null } {
  const of = (key: string) => coordinates.find((c) => c.key === key)?.currency ?? null
  const sold = [...new Set(targets.map((t) => of(t.coordinateKey)).filter((c): c is string => !!c))]
  if (!currency && sold.length > 1) {
    return { error: `${what} is one number in one currency, and these markets sell in ${sold.join(', ')}: name currency (for example ${sold[0]}); the markets that sell in another are then left out.` }
  }
  return { refuse: (key) => { const sells = of(key); return currency && sells && sells !== currency ? PREVIEW_WORDS.marketCurrency(sells) : null } }
}

const currencyArg = (args: Record<string, unknown>) => (typeof args.currency === 'string' ? args.currency.toUpperCase() : null)

/**
 * set-price without a currency: refused when its targets sell in more than one currency (`moneyCurrencyGate`); null when it
 * may go on. With a currency, the Matrix verb refuses the other markets itself (`priceParams` passes it on).
 */
async function setPriceCurrencyRefusal(args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> {
  if (currencyArg(args)) return null
  const family = await familyRoot(String(args.productId))
  if (!family) return null
  const { getMatrixRead } = await matrixRead()
  const read = await getMatrixRead({ productId: family.id, accountId: null, canEditPrice: ctx.can(F.productsPriceEdit) })
  const gate = moneyCurrencyGate(read.coordinates, args.targets as MatrixVerbTarget[], null, 'A price')
  return 'error' in gate ? `${family.sku}: ${gate.error}` : null
}

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
    if (!row) { refusals.push(refusalOf(change, landed ? PREVIEW_WORDS.nothingToRetry : MATRIX_COPY.changedElsewhere)); continue }
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

const PRICE_ACTIONS = ['set-price', 'adjust-prices', 'copy-prices', 'sale', 'business'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

const priceInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations, as listing-matrix read it'),
  action: z.enum(PRICE_ACTIONS).describe('set-price, adjust-prices (by a percentage or an amount), copy-prices (from another market), sale, or business '
    + '(Amazon Business: the business price and quantity discounts of Amazon listings)'),
  price: z.coerce.number().positive().max(1_000_000).optional().describe('set-price: the price, in the market\'s currency'),
  percent: z.coerce.number().min(-90).max(500).optional().describe('adjust-prices: the change in percent, e.g. -10 or 5'),
  amount: z.coerce.number().min(-1_000_000).max(1_000_000).optional().describe('adjust-prices instead of percent: the change in the market\'s currency, e.g. -2.5 or 3'),
  currency: z.string().trim().length(3).optional().describe('the currency of a money value, e.g. EUR: adjust-prices with amount (required), set-price, a sale price, '
    + 'or business with an exact price or prices per unit — a market selling in another currency is refused; needed when the targets sell in more than one currency'),
  fromCoordinateKey: z.string().trim().min(1).max(160).optional().describe('copy-prices: the coordinate key to copy from (same currency)'),
  sale: z.object({
    price: z.coerce.number().positive().max(1_000_000).nullable().describe('the sale price; null ends the sale'),
    start: z.string().regex(DAY).nullable().optional().describe('first day, YYYY-MM-DD'),
    end: z.string().regex(DAY).nullable().optional().describe('last day, YYYY-MM-DD'),
  }).optional().describe('sale: the sale price and its days'),
  businessPrice: BUSINESS_INPUT.optional().describe('business: the business price for business buyers on each Amazon market target — a rule (PERCENT_OFF '
    + 'with percent, FIXED with price) and quantity discounts (tiers), or remove: true; what is left out keeps what the listing has'),
  targets: targetsInput,
})

function priceParams(args: Record<string, unknown>): MatrixVerbParams | { error: string } {
  const action = String(args.action)
  // A price in its currency: the Matrix verb refuses a market that sells in another (#623).
  if (action === 'set-price') {
    const currency = currencyArg(args)
    return typeof args.price === 'number' ? { verb: 'set-price', value: args.price, ...(currency ? { currency } : {}) } : { error: 'set-price needs a price.' }
  }
  if (action === 'adjust-prices') {
    const currency = typeof args.currency === 'string' ? args.currency.toUpperCase() : args.currency
    const problem = adjustPricesProblem({ percent: args.percent, amount: args.amount, currency })
    if (problem) return { error: `${problem}.` }
    return typeof args.amount === 'number' ? { verb: 'adjust-prices', amount: args.amount, currency: String(currency) } : { verb: 'adjust-prices', percent: Number(args.percent) }
  }
  if (action === 'copy-prices') return typeof args.fromCoordinateKey === 'string' ? { verb: 'copy-prices', fromCoordinateKey: args.fromCoordinateKey } : { error: 'copy-prices needs fromCoordinateKey.' }
  return { error: `${action} is not a Matrix verb.` }
}

type SaleValue = { value: number | null; start: string | null; end: string | null }

/**
 * A sale, previewed: each target's sale now and after, and the version it was read at. 2.3 — the run checks the sale (not
 * the version: an order's stock cascade moves that) and writes at the version it reads then.
 */
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
  // A sale price is money in one currency too (ending a sale is not).
  const gate = to.value == null ? null : moneyCurrencyGate(read.coordinates, args.targets as MatrixVerbTarget[], currencyArg(args), 'A sale price')
  if (gate && 'error' in gate) return { error: gate.error }
  const cells: Array<{ rowId: string; sku: string; coordinateKey: string; from: SaleValue; to: SaleValue; version: number; listingId: string }> = []
  const refused: Array<{ sku: string; coordinateKey: string; reason: string }> = []
  for (const t of args.targets as MatrixVerbTarget[]) {
    const row = read.rows.find((r) => r.id === t.rowId)
    const cell = row?.cells[t.coordinateKey]
    const otherCurrency = gate && 'refuse' in gate ? gate.refuse(t.coordinateKey) : null
    if (otherCurrency) { refused.push({ sku: row?.sku ?? t.rowId, coordinateKey: t.coordinateKey, reason: otherCurrency }); continue }
    if (!row || !cell?.sale || !cell.listingId) { refused.push({ sku: row?.sku ?? t.rowId, coordinateKey: t.coordinateKey, reason: 'This market has no sale price here' }); continue }
    if (cell.writable.salePrice === false) { refused.push({ sku: row.sku, coordinateKey: t.coordinateKey, reason: cell.writeBlockedReason.salePrice ?? 'This sale price cannot be changed here' }); continue }
    const from = { value: cell.sale.value, start: cell.sale.start, end: cell.sale.end }
    if (from.value === to.value && from.start === to.start && from.end === to.end) continue
    cells.push({ rowId: row.id, sku: row.sku, coordinateKey: t.coordinateKey, from, to, version: cell.version, listingId: cell.listingId })
  }
  return { family, cells, refused }
}

/**
 * 2.3 — what a sale stands on (`planFacts`): each listing's sale AND the price it was planned against (its own price, and
 * under `context` its rule, master price and market), so a sale never runs above a price someone set since; and what it
 * sets. Never the listing's version: an order's stock cascade moves that.
 */
async function saleFacts(cells: Array<{ listingId: string; to: SaleValue }>): Promise<PlanFacts> {
  const facts = await listingPriceFacts(cells.map((c) => c.listingId))
  return listingPlanFacts(facts, Object.fromEntries(cells.map((c) => [`listing:${c.listingId}:sale`, saleFact(c.to)])))
}

/**
 * 2.3 — what a price verb stands on beyond its own from → to (`planFacts`): the sale of each listing it prices, so a new
 * price never runs past a sale someone set since; and what it sets. Each change's listing is the Matrix cell's.
 */
async function priceVerbFacts(familyId: string, changes: readonly VerbChange[], ctx: ToolContext): Promise<PlanFacts> {
  const [{ getMatrixRead }, { locate }] = await Promise.all([matrixRead(), matrixWrite()])
  const read = await getMatrixRead({ productId: familyId, accountId: null, canEditPrice: ctx.can(F.productsPriceEdit) })
  const listingOf = (c: VerbChange) => locate(read, c.rowId, c.coordinateKey)?.cells.listingId ?? null
  const ids = changes.map(listingOf).filter((id): id is string => !!id)
  const sets = Object.fromEntries(changes.map((c) => [`listing:${listingOf(c) ?? `${c.rowId}@${c.coordinateKey}`}:price`, c.to]))
  return listingPlanFacts(await listingPriceFacts(ids), sets, { keep: (key) => key.endsWith(':sale'), context: false })
}

type SaleCell = { rowId: string; sku: string; coordinateKey: string; from: SaleValue; to: SaleValue; version?: number }
type SalePreview = { verb?: unknown; changes?: SaleCell[]; basisOn?: unknown; planFacts?: PlanFacts }
const sameSale = (a: Partial<SaleValue> | undefined, b: Partial<SaleValue> | undefined) =>
  (a?.value ?? null) === (b?.value ?? null) && (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null)
const cellOf = (c: { rowId: string; coordinateKey: string }) => `${c.rowId}|${c.coordinateKey}`

/**
 * The cells an approved sale writes, each with the version to write at (and the listing, when known). 2.3: each cell as
 * the person saw it — its sale, and the price it was planned against — at the version it has now: an order that moved the
 * version moves nothing a sale stands on; a sale or a price someone else set since refuses the whole request. One
 * approved before 2.3 carried each cell's version and writes only at it, as approved.
 */
async function saleWrites(args: Record<string, unknown>, ctx: ToolContext, approved: SalePreview & { changes: SaleCell[] }, sku: string) {
  if (approvedOnVersion(approved)) return { writes: approved.changes.map((c) => ({ change: c, version: Number(c.version), listingId: null as string | null })) }
  const plan = await planSale(args, ctx)
  if ('error' in plan) return { error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing changed.` }
  const now = new Map(plan.cells.map((c) => [cellOf(c), c]))
  const moved = approved.changes.filter((c) => { const fresh = now.get(cellOf(c)); return !fresh || !sameSale(fresh.from, c.from) || !sameSale(fresh.to, c.to) })
  if (moved.length) return { error: `${sku}: ${moved.slice(0, 10).map((c) => `${c.sku} ${c.coordinateKey}`).join(', ')} changed since it was approved. Nothing changed; ask Claude again.` }
  if (approved.planFacts && factHash(approved.planFacts) !== factHash(await saleFacts(plan.cells))) {
    return { error: `${sku}: the price this sale was planned against changed since it was approved. Nothing changed; ask Claude again.` }
  }
  return { writes: approved.changes.map((c) => ({ change: c, version: now.get(cellOf(c))!.version, listingId: now.get(cellOf(c))!.listingId as string | null })) }
}

// ── set-listing-price, action business (Amazon Business step 6) ─────────────────────────────────────

/** The sentence for a coordinate with no business price: Amazon's own reason where the read gives one. */
function noBusinessHere(hit: { coord: { kind: string; absent: ReadonlyArray<{ cell: string; reason: string }> }; cells: { writeBlockedReason: Partial<Record<string, string>> } }): string {
  if (hit.coord.kind !== 'market') return 'A business price is set per Amazon market (for example AMAZON:IT), not on this column.'
  return hit.coord.absent.find((a) => a.cell === 'businessPrice')?.reason ?? hit.cells.writeBlockedReason.businessPrice
    ?? 'Amazon lists no Amazon Business for this account and market: there is no business price here.'
}

type BusinessTargetLine = BusinessLine & { rowId: string; coordinateKey: string }

/**
 * A business price change on Matrix targets, planned: each target's listing as the Matrix holds it — refused with the
 * Matrix's own sentence where it holds the B2B cells (the parent, no Amazon Business for the listing, no price permission,
 * a column that is not an Amazon market) — then the business price door's dry run on the rest (`planBusinessPrices`).
 */
async function planBusinessTargets(args: Record<string, unknown>, ctx: ToolContext) {
  const family = await familyRoot(String(args.productId))
  if (!family) return { error: PRODUCT_NOT_FOUND }
  if (!args.businessPrice) return { error: 'Action business needs businessPrice: a rule (PERCENT_OFF with percent, FIXED with price), tiers, or remove: true.' }
  if (!ctx.can(F.productsPriceEdit)) return { error: 'A business price needs products.price.edit.' }
  const [{ getMatrixRead }, { locate }] = await Promise.all([matrixRead(), matrixWrite()])
  const read = await getMatrixRead({ productId: family.id, accountId: null, canEditPrice: true })
  // An exact business price or prices per unit are money in one currency; a percent is not.
  const input = args.businessPrice as BusinessInput
  const money = input.price !== undefined || input.tiers?.type === 'fixed'
  const gate = money ? moneyCurrencyGate(read.coordinates, args.targets as MatrixVerbTarget[], currencyArg(args), 'An exact business price or a price per unit') : null
  if (gate && 'error' in gate) return { error: gate.error }
  const items: BusinessPlanItem[] = []
  const held: BusinessPlanRefusal[] = []
  const seen = new Set<string>()
  for (const t of args.targets as MatrixVerbTarget[]) {
    if (seen.has(`${t.rowId}|${t.coordinateKey}`)) continue
    seen.add(`${t.rowId}|${t.coordinateKey}`)
    const hit = locate(read, t.rowId, t.coordinateKey)
    const sku = hit?.row.sku ?? read.rows.find((r) => r.id === t.rowId)?.sku ?? t.rowId
    const refuse = (reason: string) => held.push({ listingId: hit?.cells.listingId ?? '', sku, marketplace: null, rowId: t.rowId, coordinateKey: t.coordinateKey, reason })
    if (!hit?.cells.listingId) { refuse(PREVIEW_WORDS.notOnMarket); continue }
    if (hit.cells.business === undefined) { refuse(noBusinessHere(hit)); continue }
    const otherCurrency = gate && 'refuse' in gate ? gate.refuse(t.coordinateKey) : null
    if (otherCurrency) { refuse(otherCurrency); continue }
    // Held by the Matrix (the parent, no B2B for this listing, no price permission): the same sentence as the cell.
    if (hit.cells.writable.businessPrice !== true || !hit.cells.business) { refuse(hit.cells.writeBlockedReason.businessPrice ?? noBusinessHere(hit)); continue }
    items.push({ listingId: hit.cells.listingId, rowId: t.rowId, coordinateKey: t.coordinateKey, input: args.businessPrice as BusinessInput })
  }
  const plan = await planBusinessPrices(items, ctx.userId ?? 'claude')
  return { family, lines: plan.lines as BusinessTargetLine[], unchanged: plan.unchanged, refused: [...held, ...plan.refused] }
}

const targetOf = (c: { rowId: string; coordinateKey: string }) => `${c.rowId}|${c.coordinateKey}`
const refusalLines = (refused: readonly BusinessPlanRefusal[]) => refused.slice(0, 10).map((r) => `${r.sku} ${r.coordinateKey ?? r.marketplace ?? ''}: ${r.reason}`).join(' · ')

/**
 * The preview of a business price change: each target's setting from → to (what it stands on; Amazon's own price as the
 * `from` where Nexus keeps none), the prices it gives now, and — in the summary, the one sentence the approval card shows —
 * what a person must know before approving (`businessCardSummary`).
 */
function businessPreview(plan: { family: Family; lines: BusinessTargetLine[]; unchanged: number; refused: BusinessPlanRefusal[] }) {
  const keys = [...new Set(plan.lines.map((l) => l.coordinateKey))]
  const warnings = plan.lines.flatMap((l) => l.warnings.map((w) => `${l.sku} on ${l.coordinateKey}: ${w}`))
  const head = `${plan.family.sku}: business price (Amazon Business) — ${plan.lines.length} change${plan.lines.length === 1 ? '' : 's'} on ${keys.slice(0, 6).join(', ')}`
    + `${keys.length > 6 ? ` and ${keys.length - 6} more` : ''}${plan.refused.length ? `; ${plan.refused.length} refused (see refused)` : ''}.`
  return {
    action: 'set-listing-price',
    family: { productId: plan.family.id, sku: plan.family.sku },
    // A long opening line (many markets, refusals) gives way to a short one before any warning would be cut.
    summary: businessCardSummary(head, plan.lines, (l) => `${l.sku} ${(l as BusinessTargetLine).coordinateKey}`,
      `${plan.family.sku}: business price — ${plan.lines.length} change${plan.lines.length === 1 ? '' : 's'} on ${keys.length} Amazon market${keys.length === 1 ? '' : 's'}`
        + `${plan.refused.length ? `; ${plan.refused.length} refused` : ''}.`),
    verb: 'business',
    // 2.3 — it stands on each listing's business setting as it is and as it gets, never the listing's version.
    basisOn: BASIS_ON_FIELDS,
    changes: plan.lines.map((l) => ({
      rowId: l.rowId, sku: l.sku, coordinateKey: l.coordinateKey, cell: 'businessPrice', from: l.from, to: l.to,
      fromLabel: businessFromWords(l), toLabel: businessSettingWords(l.to, l.currency),
    })),
    // What the settings give today (they follow the normal price; the door checks them again when it writes).
    prices: plan.lines.map((l) => ({ sku: l.sku, coordinateKey: l.coordinateKey, currency: l.currency, normalPrice: l.normalPrice, now: l.priceNow, after: l.priceAfter })),
    ...(plan.unchanged ? { unchanged: plan.unchanged } : {}),
    ...(plan.refused.length ? { refused: plan.refused.map((r) => ({ sku: r.sku, coordinateKey: r.coordinateKey, reason: r.reason })) } : {}),
    ...(warnings.length ? { warning: warnings.slice(0, 20).join(' ') } : {}),
    note: 'Nothing changes until a person approves this in Nexus. Each business price goes through the Matrix\'s business price door, '
      + 'as the person who approves it, and is then sent to Amazon (or kept in Nexus until the listing can be sent to).',
  }
}

async function previewBusiness(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const plan = await planBusinessTargets(args, ctx)
  if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing was queued.` }
  if (!plan.lines.length) {
    const why = refusalLines(plan.refused)
    return { ok: false, error: `${plan.family.sku}: nothing to change${why ? ` — ${why}` : ': every target already has that business price'}. Nothing was queued.` }
  }
  return { ok: true, preview: businessPreview(plan) }
}

type BusinessChange = { rowId: string; sku: string; coordinateKey: string; from: BusinessLine['from']; to: BusinessLine['to'] }

/**
 * The run of an approved business price change: each target as the person approved it (its setting then, and the one it
 * gets), planned again now — one that moved, or that the door would now refuse, refuses the whole request before anything
 * is written — and written through the Matrix door at the version it has now.
 */
async function runBusiness(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const approved = ctx.approvedPreview as { verb?: unknown; changes?: unknown } | undefined
  if (approved?.verb !== 'business' || !Array.isArray(approved.changes)) return { ok: false, error: 'A business price is set only after a person approved its preview. Nothing changed.' }
  const plan = await planBusinessTargets(args, ctx)
  if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing changed.` }
  const changes = approved.changes as BusinessChange[]
  const now = new Map(plan.lines.map((l) => [targetOf(l), l]))
  const moved = changes.filter((c) => { const fresh = now.get(targetOf(c)); return !fresh || !sameSetting(fresh.from, c.from) || !sameSetting(fresh.to, c.to) })
  if (moved.length) {
    const why = (c: BusinessChange) => plan.refused.find((r) => r.rowId === c.rowId && r.coordinateKey === c.coordinateKey)?.reason
    return { ok: false, error: `${plan.family.sku}: ${moved.slice(0, 10).map((c) => `${c.sku} ${c.coordinateKey}${why(c) ? ` (${why(c)})` : ''}`).join(', ')} changed since it was approved. Nothing changed; ask Claude again.` }
  }
  const lines = changes.map((c) => now.get(targetOf(c))!)
  const { writeMatrixCells } = await matrixWrite()
  const out = await writeMatrixCells(doorFor(plan.family.id, ctx), lines.map((l) => ({ rowId: l.rowId, coordinateKey: l.coordinateKey, cell: 'businessPrice' as const, value: l.to, expectedVersion: l.version, expectedListingId: l.listingId })))
  const applied = out.results.filter((r) => r.outcome === 'applied')
  const refused = out.results.filter((r) => r.outcome !== 'applied' && r.outcome !== 'noop')
  if (!applied.length) return { ok: false, error: `Nothing changed: ${refused.slice(0, 10).map((r) => `${r.coordinateKey}: ${r.reason ?? r.outcome}`).join(' · ')}` }
  const done = lines.filter((l) => applied.some((r) => r.rowId === l.rowId && r.coordinateKey === l.coordinateKey))
  const record = (l: BusinessTargetLine, setting: BusinessLine['from']): BusinessRecord => ({ listingId: l.listingId, rowId: l.rowId, coordinateKey: l.coordinateKey, setting })
  return {
    ok: true,
    data: {
      applied: applied.length,
      refused: refused.map((r) => ({ rowId: r.rowId, coordinateKey: r.coordinateKey, reason: r.reason ?? r.outcome })),
      // The door's own words on a saved change: not sent yet (and why), or worth a word.
      said: applied.filter((r) => r.reason).map((r) => ({ coordinateKey: r.coordinateKey, rowId: r.rowId, reason: r.reason })),
    },
    change: {
      before: { kind: 'business', productId: plan.family.id, businessPrices: done.map((l) => ({ ...record(l, l.from), sku: l.sku, ...(l.amazonOwn ? { amazonOwn: l.amazonOwn } : {}) })) },
      after: { kind: 'business', productId: plan.family.id, businessPrices: done.map((l) => record(l, l.to)) },
    },
  }
}

const PRICE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { kind?: string; productId?: string; operationId?: string; sale?: Array<{ rowId: string; coordinateKey: string }>; businessPrices?: BusinessRecord[] }
    // Amazon Business: each listing's setting as it is stored now.
    if (after.kind === 'business') return { kind: 'business', productId: after.productId, businessPrices: await currentBusinessRecords(after.businessPrices ?? []) }
    if (after.kind !== 'sale') return MATRIX_UNDO.current(change)
    const { getMatrixRead } = await matrixRead()
    const read = await getMatrixRead({ productId: after.productId!, canEditPrice: true })
    return { kind: 'sale', productId: after.productId, sale: (after.sale ?? []).map((c) => {
      const sale = read.rows.find((r) => r.id === c.rowId)?.cells[c.coordinateKey]?.sale
      return { rowId: c.rowId, coordinateKey: c.coordinateKey, value: sale?.value ?? null, start: sale?.start ?? null, end: sale?.end ?? null }
    }) }
  },
  request(change) {
    const before = (change.before ?? {}) as { kind?: string; productId?: string; sale?: Array<{ rowId: string; coordinateKey: string } & SaleValue>; businessPrices?: BusinessRecord[] }
    // Amazon Business: each listing back to its setting by value, in one request (never a removal over Amazon's own price).
    if (before.kind === 'business') return businessUndoRequest(before.businessPrices ?? [])
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
  // 2.3 — a later step of a plan re-based on an earlier step's own write: a sale's lines follow the facts it stands on
  // (`planFacts`, checked one by one); a price verb's lines, and a business price's, must not move at all.
  planRebase: (preview) => ((preview as { verb?: unknown } | null)?.verb === 'sale' ? ['changes'] : []),
  description:
    'Change the price of listings per market through the Nexus Matrix: set a price, adjust prices by a percentage or an amount, copy '
    + 'prices from another market in the same currency, or set (or end) a sale with its days. Action business (Amazon '
    + 'Business, businessPrice): set, change or remove the business price for business buyers on Amazon market targets — PERCENT_OFF '
    + '(the normal price minus percent, following it) or FIXED (exact), with up to 5 quantity discounts — refused with the '
    + 'Matrix\'s reason where Amazon lists no Amazon Business, on a parent, or where Amazon would refuse or hide it (above the '
    + 'normal price, outside the minimum or maximum price); only remove: true removes one, and a business price Amazon shows '
    + 'that Nexus never kept is never removed from here; a change on a paused, draft or Inactive listing is kept in Nexus '
    + 'until it can be sent, and a first one waits while Amazon\'s shopper price is not Nexus\'s. Targets are rows and '
    + 'coordinate keys from listing-matrix. A typed price (set-price, a sale price, an exact business price or prices per '
    + 'unit) is one number in one currency: with currency, a market that sells in another is refused; targets in more than '
    + 'one currency need it. A formula-owned price is refused. The preview is the Matrix\'s own. Waits for a '
    + 'person to approve it in Nexus; a target that changed since is refused, and it can be put back.',
  async handler(args, ctx) {
    if (args.action === 'business') return previewBusiness(args, ctx)
    if (args.action !== 'sale') {
      // Set price: one number in one currency (moneyCurrencyGate); with a currency the verb refuses the other markets.
      const mixed = args.action === 'set-price' ? await setPriceCurrencyRefusal(args, ctx) : null
      if (mixed) return { ok: false, error: `${mixed} Nothing was queued.` }
      const out = await previewVerbFor('set-listing-price', args, ctx, priceParams(args))
      if (!out.ok) return out
      const preview = out.preview as { family: { productId: string }; changes: VerbChange[] }
      return { ...out, preview: { ...preview, planFacts: await priceVerbFacts(preview.family.productId, preview.changes, ctx) } }
    }
    const plan = await planSale(args, ctx)
    if ('error' in plan) return { ok: false, error: plan.error === PRODUCT_NOT_FOUND ? plan.error : `${plan.error} Nothing was queued.` }
    if (!plan.cells.length) return { ok: false, error: `${plan.family.sku}: nothing to change${plan.refused.length ? ` — ${plan.refused.slice(0, 10).map((r) => `${r.sku} ${r.coordinateKey}: ${r.reason}`).join(' · ')}` : ''}. Nothing was queued.` }
    // 2.3 — each sale as it is and as it gets, never the listing's version (an order's stock cascade moves that). The
    // versions read are kept beside, one per change, only to check a request approved before on them, as approved.
    return { ok: true, preview: { action: 'set-listing-price', family: { productId: plan.family.id, sku: plan.family.sku }, verb: 'sale', basisOn: BASIS_ON_FIELDS,
      changes: plan.cells.map(({ version: _version, listingId: _listing, ...cell }) => cell), versions: plan.cells.map((c) => c.version),
      planFacts: await saleFacts(plan.cells),
      ...(plan.refused.length ? { refused: plan.refused } : {}) } }
  },
  async execute(args, ctx) {
    if (args.action === 'business') return runBusiness(args, ctx)
    if (args.action !== 'sale') {
      // 2.3 — a new price never runs past a sale someone set since it was approved (a request approved before 2.3 has
      // no facts to check: it runs as approved).
      const approved = ctx.approvedPreview as { changes?: unknown; planFacts?: PlanFacts } | undefined
      const family = approved?.planFacts && Array.isArray(approved.changes) ? await familyRoot(String(args.productId)) : null
      if (family && factHash(approved!.planFacts) !== factHash(await priceVerbFacts(family.id, approved!.changes as VerbChange[], ctx))) {
        return { ok: false, error: `${family.sku}: a sale on these listings changed since this price was approved. Nothing changed; ask Claude again.` }
      }
      const mixed = args.action === 'set-price' ? await setPriceCurrencyRefusal(args, ctx) : null
      if (mixed) return { ok: false, error: `${mixed} Nothing changed.` }
      return runVerbFor(args, ctx, priceParams(args))
    }
    const approved = ctx.approvedPreview as SalePreview | undefined
    if (approved?.verb !== 'sale' || !Array.isArray(approved.changes)) return { ok: false, error: 'A sale is set only after a person approved its preview. Nothing changed.' }
    const family = await familyRoot(String(args.productId))
    if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
    const cells = await saleWrites(args, ctx, { ...approved, changes: approved.changes }, family.sku)
    if ('error' in cells) return { ok: false, error: cells.error ?? 'Nothing changed.' }
    const { writeMatrixCells } = await matrixWrite()
    // Each cell at its version: one that moved in between is a conflict, never overwritten.
    const out = await writeMatrixCells(doorFor(family.id, ctx), cells.writes.map(({ change: c, version }) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: 'salePrice' as const, value: c.to, expectedVersion: version })))
    const applied = out.results.filter((r) => r.outcome === 'applied')
    const refused = out.results.filter((r) => r.outcome !== 'applied' && r.outcome !== 'noop')
    if (!applied.length) return { ok: false, error: `Nothing changed: ${refused.slice(0, 10).map((r) => `${r.coordinateKey}: ${r.reason ?? r.outcome}`).join(' · ')}` }
    const done = approved.changes.filter((c) => applied.some((r) => r.rowId === c.rowId && r.coordinateKey === c.coordinateKey))
    // 2.3 — the sales this run wrote, from the door's own answer.
    const planWrites: PlanWrite[] = cells.writes.flatMap(({ change, listingId }) => {
      const hit = applied.find((r) => r.rowId === change.rowId && r.coordinateKey === change.coordinateKey)
      const ids = hit?.listings?.length ? hit.listings.map((l) => l.listingId) : hit && listingId ? [listingId] : []
      return ids.map((id) => ({ key: `listing:${id}:sale` as const, after: saleFact(change.to) }))
    })
    return {
      ok: true,
      ...(planWrites.length ? { planWrites } : {}),
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
