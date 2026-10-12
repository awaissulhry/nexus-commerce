/**
 * MX — the VERB PREVIEW engine, pure, ONE implementation for both apps (`@nexus/shared/matrix-preview`).
 *
 * MX.1 (2026-09-13) moved this here from `apps/web/src/app/products/[id]/edit/_studio/matrix/preview.ts` (now a
 * one-line re-export). In preview mode the page runs THIS on its fixture read; in live mode the server runs THE SAME
 * FUNCTION on the live read (`POST …/studio/matrix/verbs` with `commit:false`) — identical output by construction,
 * pinned by `apps/api/src/services/pim/matrix-write.service.vitest.test.ts`, which feeds one read to both. Every
 * refusal names its cause; every change carries an operator-facing `fromLabel → toLabel`; the confirm level follows
 * the registry's impact rules (design §3.8). No arithmetic happens anywhere else in the frontend.
 *
 * The price verbs check `products.price.edit` — the financial permission Add 4(d) enforces on the price cells
 * server-side — so the page's `can` and the server's `can` ask the same question.
 */
import {
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentCell,
  type FulfilmentConversionStatus,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixLocation,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixVerbId,
  type MatrixVerbParams,
  type MatrixVerbRequest,
  type QueueCell,
  type SourceCell,
  type SyncCell,
  type VerbChange,
  type VerbPreview,
  type VerbRefusal,
} from './matrix-contract.js'

export interface PreviewContext {
  /** `has('products.edit')`-style permission check. */
  can: (permission: string) => boolean
  /** `true` when the read is a preview fixture. */
  simulated: boolean
  /**
   * MCP full control L8 — eBay ENDS a listing pinned at 0 unless the account's out-of-stock option is ON. Asked only for
   * a pin to 0 on an eBay coordinate: true = ON (allowed), false = OFF, null = could not be read (both refused). The
   * server reads the option from eBay; a context without it previews as before, and the server's re-check refuses.
   */
  ebayZeroAllowed?: (accountId: string | null, market: string) => boolean | null
  /**
   * Amazon fulfilment conversion (2026-10-07) — the server's facts for a set-fulfilment target on an Amazon coordinate
   * (`fulfilment-conversion.service.ts` `amazonFulfilmentFacts`), by row and INVENTORY coordinate. Given = the run sends
   * the change to Amazon, so the preview refuses and tells by these facts; a target with no facts is refused (never sent
   * unchecked). Absent (the page's own fixture preview) = the cell facts alone, as before.
   */
  amazonFulfilment?: (rowId: string, coordinateKey: CoordinateKey) => AmazonFulfilmentFacts | null | undefined
}

/** What the server read for one Amazon set-fulfilment target, fresh, before anything is sent. */
export interface AmazonFulfilmentFacts {
  /** The open markets the patch goes to (one listing row each), in market order. */
  markets: readonly string[]
  /** Markets of the coordinate skipped: selling is paused there (Inactive), or the listing is not live on Amazon yet. */
  skipped: ReadonlyArray<{ market: string; why: 'inactive' | 'not-listed' }>
  /** FBM: the merchant quantity that will be sent — the cell's intended quantity (Follow: pool − buffer; Pinned: the number). */
  quantity: number | null
  /** Why no merchant quantity could be worked out (an FBM change is refused then). */
  quantityRefusal: string | null
  /** The SKU's FBA units Nexus mirrors: on hand at Amazon, reserved, inbound. */
  fbaUnits: { onHand: number; reserved: number; inbound: number }
  /** An active FBA offer on one of these listings. */
  activeFbaOffer: boolean
  /** An Amazon-only fulfilment code (Remote Fulfilment, VCS) on one of the listings: its sentence. */
  keptCodeReason: string | null
  /** No listing here is live on Amazon yet (a draft): there is no offer to convert. */
  notListed: boolean
  /** A lock that refuses any send to these listings (stock sync held, ended, two seller SKUs …): its sentence. */
  locked: string | null
  /** The newest conversion sent for these listings. */
  latest: FulfilmentConversionStatus | null
}

/** Facts the server could not read for an Amazon target: refused, never sent unchecked. */
export const AMAZON_FULFILMENT_FACTS_UNREAD = 'Refused — the Amazon facts for this listing (FBA units, markets, quantity) could not be read, so nothing is sent'

const methodOfReported = (r: 'AFN' | 'MFN' | null): 'FBA' | 'FBM' | null => (r === 'AFN' ? 'FBA' : r === 'MFN' ? 'FBM' : null)
const timeOf = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/**
 * PURE — why an Amazon set-fulfilment target is not sent (`kind` + the operator's sentence), `'noop'` when Amazon and
 * Nexus already agree on `method`, or null = it is sent. The refusals, by name: an Amazon-only code; not listed (a draft);
 * every market Inactive; a send lock; FBA → FBM while FBA units are on hand, reserved or inbound, or an FBA offer is
 * active (the guard Nexus has always held, kept); no merchant quantity to send; a change already on its way.
 */
export function amazonConversionRefusal(facts: AmazonFulfilmentFacts, method: 'FBA' | 'FBM', f: Pick<FulfilmentCell, 'method' | 'source' | 'guard' | 'reported'>):
  { kind: VerbRefusal['kind']; reason: string } | 'noop' | null {
  const latest = facts.latest
  if (latest && latest.to === method && (latest.status === 'SENDING' || latest.status === 'SENT')) {
    return { kind: 'not-applicable', reason: `Already sent to Amazon ${timeOf(latest.at)} — waiting for Amazon's report` }
  }
  const reported = methodOfReported(f.reported)
  const confirmed = latest?.to === method && latest.status === 'CONFIRMED'
  const unresolved = latest?.to === method && (latest.status === 'STILL_OLD' || latest.status === 'NOT_IN_REPORT' || latest.status === 'REFUSED')
  if (f.method === method && f.source === 'set' && f.guard === method && !unresolved && (confirmed || reported == null || reported === method)) return 'noop'
  if (facts.notListed) return { kind: 'no-listing', reason: 'Not listed on Amazon yet — there is no offer to convert. Set the method in the product sheet; Publish sends it' }
  if (facts.keptCodeReason) return { kind: 'guard', reason: `Refused — ${facts.keptCodeReason}` }
  if (facts.markets.length === 0) return { kind: 'not-applicable', reason: `No open offer to convert here: ${skippedWords(facts.skipped) || 'no market is live'}` }
  if (facts.locked) return { kind: 'guard', reason: facts.locked }
  if (method === 'FBM') {
    const u = facts.fbaUnits
    const tail = 'Amazon must hold no FBA units of this SKU before its offer is converted to FBM'
    if (u.onHand > 0) return { kind: 'guard', reason: `Refused — ${u.onHand} units of FBA stock on hand keep the guard closed; ${tail}` }
    if (u.reserved > 0) return { kind: 'guard', reason: `Refused — ${u.reserved} FBA units reserved at Amazon keep the guard closed; ${tail}` }
    if (u.inbound > 0) return { kind: 'guard', reason: `Refused — ${u.inbound} FBA units inbound to Amazon keep the guard closed; ${tail}` }
    if (facts.activeFbaOffer) return { kind: 'guard', reason: 'Refused — an active FBA offer keeps the guard closed; convert the offer in Seller Central first' }
    if (facts.quantity == null) return { kind: 'guard', reason: `Refused — ${facts.quantityRefusal ?? 'no merchant quantity could be worked out'}; an FBM offer needs one` }
  }
  return null
}

/** "FR ES (Inactive), DE (not listed)". */
const skippedWords = (skipped: AmazonFulfilmentFacts['skipped']): string => {
  const of = (why: 'inactive' | 'not-listed') => skipped.filter((x) => x.why === why).map((x) => x.market)
  const inactive = of('inactive'), draft = of('not-listed')
  return [inactive.length ? `${inactive.join(' ')} (Inactive)` : '', draft.length ? `${draft.join(' ')} (not listed)` : ''].filter(Boolean).join(', ')
}

/** PURE — the change's note: what is sent to Amazon, where, and what Amazon reports now when it differs. */
export function amazonConversionNote(facts: AmazonFulfilmentFacts, method: 'FBA' | 'FBM', reported: 'AFN' | 'MFN' | null): string {
  const was = methodOfReported(reported)
  const lead = was && was !== method ? `Amazon reports ${reported}. ` : ''
  const where = facts.markets.join(' ')
  const skips = facts.skipped.length ? ` — skips ${skippedWords(facts.skipped)}` : ''
  return method === 'FBM'
    ? `${lead}Sends Amazon FBM (adds DEFAULT, quantity ${facts.quantity ?? '—'}; removes AMAZON_EU) on ${where}${skips}`
    : `${lead}Sends Amazon FBA (adds AMAZON_EU, no quantity; removes DEFAULT) on ${where} — out of stock until Amazon receives units${skips}`
}

export const EBAY_ZERO_REFUSAL = 'Refused — eBay ends a listing pinned at 0 unless the account\'s out-of-stock option is ON, and it is OFF '
  + 'or could not be read. Turn the out-of-stock option on in eBay first, or hold this listing\'s stock sync instead.'

/** A held listing's note and refusal (build shape v2: "Pause sync" is "Hold stock sync"; selling words live in the sheet). */
export const STILL_HELD = 'Stock sync held — release it to push'

const money = (v: number | null | undefined, currency: string): string =>
  v == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(v)
const round2 = (n: number) => Math.round(n * 100) / 100
const cents = (n: number) => Math.round(n * 100)

/* ── the grid's own words (Matrix bulk Edit v2, 2026-10-12) ─────────────────────────────────────────────────────────
   A preview line's `fromLabel → toLabel` says what the Matrix cell says now and will say, in the GRID's words. These
   mirror the design system's cell texts (`apps/web/src/design-system/grid/renderers/matrixCells.ts`: `matrixModeWord`,
   `matrixQtyText`, the Buffer text of `matrixCellText`, `matrixQueueWord`). That file is mirrored byte-for-byte into
   `apps/factory`, which has no `@nexus/shared`, so the words are restated here and held equal by
   `apps/web/src/app/products/[id]/edit/_studio/matrix/preview-words.vitest.test.ts`. */

const DASH = '—'

/** The grid's Mode word (`matrixModeWord`): `Follow` · `Pinned` · `—` (Amazon-managed, Inactive). */
export function syncModeWord(s: SyncCell | null | undefined): string {
  if (!s || s.kind === 'FBA_EXCLUDED' || s.kind === 'CLOSED') return DASH
  return s.mode === 'PINNED' ? 'Pinned' : 'Follow'
}

/** The grid's Qty text (`matrixQtyText`): `<n>` · `⏸ <n>` (sync held: what the market keeps) · `—` · `Uncounted` · `Inactive`. */
export function syncQtyText(s: SyncCell | null | undefined): string {
  if (!s) return DASH
  switch (s.kind) {
    case 'FBA_EXCLUDED': return DASH
    case 'CLOSED': return MATRIX_COPY.closed
    case 'UNCOUNTED': return MATRIX_COPY.uncounted
    case 'PAUSED': return `⏸ ${s.held ?? DASH}`
    case 'FOLLOW':
    case 'PINNED': return s.intended == null ? DASH : String(s.intended)
  }
}

/** The grid's Buffer text: the number; `—` where the buffer is not used (a fixed quantity, Amazon-managed, Inactive). */
export function syncBufferText(s: SyncCell | null | undefined): string {
  if (!s || s.kind === 'FBA_EXCLUDED' || s.kind === 'CLOSED' || s.mode === 'PINNED') return DASH
  return String(s.buffer)
}

/** A quantity as the grid's Mode and Qty cells say it together: `Follow · 10` · `Pinned · 5` · `Follow · ⏸ 4` · `Inactive`. */
export const syncLabel = (s: SyncCell | null | undefined): string => {
  const mode = syncModeWord(s)
  return mode === DASH ? syncQtyText(s) : `${mode} · ${syncQtyText(s)}`
}

/** `2 min` · `9 h` · `3 d` — the grid's age of a queue row (`matrixAgo`). */
function ageOf(iso: string | null, now: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86_400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

/**
 * The grid's Sync word (`matrixQueueWord`): `Sent` · `Queued` · `Sending` · `Failed` · `Dead` · `Sync held · listing` ·
 * `Sync held · policy` · `Never` · `—`. With `now`, a sent push says its age as the grid does (`Sent 2 min`); the preview
 * passes none, so the same read gives the same words on the page and on the server.
 */
export function queueStateWord(q: QueueCell | null | undefined, now?: number): string {
  if (!q) return DASH
  switch (q.state) {
    case 'sent': { const ago = now == null ? null : ageOf(q.at, now); return ago ? `Sent ${ago}` : 'Sent' }
    case 'queued': return 'Queued'
    case 'sending': return 'Sending'
    case 'failed': return 'Failed'
    case 'dead': return 'Dead'
    case 'paused': return `Sync held · ${q.via === 'POLICY' ? 'policy' : 'listing'}`
    case 'never': return 'Never'
  }
}

/* ── refusal sentences: plain words, no "coordinate" (bulk Edit v2) ───────────────────────────────────────────────── */

export const PREVIEW_WORDS = {
  notOnMarket: 'Not on this market',
  noPriceHere: 'This market has no price here',
  noStockHere: MATRIX_COPY.sourceNone,
  formulaPrice: 'A formula sets this price — edit the formula instead',
  priceAboveZero: 'A price must be more than 0',
  noPriceToChange: 'No price to change',
  noSourcePrice: 'No price on the market you copy from',
  marketCurrency: (currency: string) => `This market sells in ${currency}`,
  ownPrice: 'Own price (was the base price)',
  nothingToRetry: 'Nothing to retry here — the last push did not fail',
  bufferUnused: 'Used when the market follows your stock',
} as const

/**
 * PURE — why `adjust-prices` params cannot run, or null: a percent OR an amount (never both); a finite percent; an amount
 * other than 0 with its 3-letter currency (`EUR`). The route and the agent tool ask this before the preview.
 */
export function adjustPricesProblem(p: { percent?: unknown; amount?: unknown; currency?: unknown }): string | null {
  const percent = p.percent !== undefined && p.percent !== null
  const amount = p.amount !== undefined && p.amount !== null
  if (percent && amount) return 'Adjust prices by a percent or by an amount, not both'
  if (amount) {
    if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount === 0) return 'The amount must be a number other than 0'
    return typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? null : 'An amount needs its currency as a 3-letter code (EUR, GBP …)'
  }
  if (p.currency !== undefined && p.currency !== null) return 'A currency goes with an amount, not with a percent'
  if (!percent) return 'Adjust prices needs a percent or an amount'
  return typeof p.percent === 'number' && Number.isFinite(p.percent) ? null : 'The percent must be a number'
}

/** An amount cut of this share of the old price, or more, asks for the typed word (as a percent cut of 30 % does). */
const BIG_CUT_PERCENT = 30
const bigAmountCut = (params: MatrixVerbParams, changes: readonly VerbChange[]): boolean =>
  params.verb === 'adjust-prices' && typeof params.amount === 'number' && changes.some((c) =>
    typeof c.from === 'number' && typeof c.to === 'number' && c.from > 0 && (cents(c.from) - cents(c.to)) * 100 >= cents(c.from) * BIG_CUT_PERCENT)

/** The FOLLOW number: pool − buffer, floored at 0; null when the pool is uncounted. Mirrors the resolver (preview only). */
export const followQty = (s: Pick<SyncCell, 'poolAvailable' | 'buffer'>): number | null =>
  s.poolAvailable == null ? null : Math.max(0, s.poolAvailable - Math.max(0, s.buffer))

/* ── "Sells from" (Step 2, Owner 2026-10-07) ─────────────────────────────────────────────────── */

/** The permission a "Sells from" change needs — the same one the stock pages ask (`inventory.adjust`). */
export const SOURCE_PERMISSION = 'inventory.adjust'
/** At most this many locations in one list. */
export const MAX_SOURCE_CODES = 20

const codeKey = (c: string): string => c.trim().toUpperCase()

/** Two "Sells from" lists are the same list: the same codes in the same order (order = sale order). */
export const sameSourceCodes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((c, i) => codeKey(c) === codeKey(b[i]!))

/**
 * PURE — the list a listing STORES for a chosen "Sells from": `[]` when it equals the market default (an exception exists
 * only when it differs — Owner 2026-10-07), else the chosen codes, trimmed, in the chosen order. `[]` chosen = the default.
 * One normaliser for the page and the server.
 */
export function sellsFromCodes(chosen: readonly string[], marketDefault: readonly string[]): string[] {
  const codes = chosen.map((c) => c.trim()).filter(Boolean)
  return codes.length === 0 || sameSourceCodes(codes, marketDefault) ? [] : codes
}

/**
 * PURE — why a chosen list cannot be stored, or null: more than 20, a code twice, a code that is not one of this business's
 * warehouses, a warehouse that is switched off. `locations` absent (an older server's read) = only the shape is checked;
 * the server checks the codes against the database again.
 */
export function sourceCodesProblem(codes: readonly string[], locations: ReadonlyArray<MatrixLocation> | undefined): string | null {
  if (codes.length > MAX_SOURCE_CODES) return MATRIX_COPY.sourceTooMany
  const seen = new Set<string>()
  for (const raw of codes) {
    const k = codeKey(raw)
    if (!k) continue
    if (seen.has(k)) return MATRIX_COPY.sourceTwice(raw.trim())
    seen.add(k)
    if (!locations) continue
    const loc = locations.find((l) => codeKey(l.code) === k)
    if (!loc) return MATRIX_COPY.sourceUnknown(raw.trim())
    if (!loc.active) return MATRIX_COPY.sourceInactive(loc.code)
  }
  return null
}

/** The units a Follow listing would show selling from `codes`: the SKU's available there, summed, minus the buffer; null = none of them holds a row (Uncounted). */
export function followFromCodes(codes: readonly string[], locations: ReadonlyArray<{ code: string; available: number }>, buffer: number): number | null {
  const wanted = new Set(codes.map(codeKey))
  const hits = locations.filter((l) => wanted.has(codeKey(l.code)))
  if (hits.length === 0) return null
  return Math.max(0, hits.reduce((n, l) => n + l.available, 0) - Math.max(0, buffer))
}

/** The note a set-source change carries: what Follow would show after it. */
function sourceNote(row: MatrixRowRead, src: SourceCell, to: readonly string[], sync: SyncCell | null): string {
  const n = followFromCodes(to.length ? to : src.marketDefault, row.stock.locations, sync?.buffer ?? 0)
  const shows = n == null ? MATRIX_COPY.uncounted : String(n)
  return sync?.mode === 'PINNED' ? `Pinned — the quantity stays; Follow would show ${shows}` : `Follow shows ${shows}`
}

function target(read: MatrixRead, t: { rowId: string; coordinateKey: CoordinateKey }): { row: MatrixRowRead; coord: MatrixCoordinate; cells: MatrixCells } | null {
  const row = read.rows.find(r => r.id === t.rowId)
  const coord = read.coordinates.find(c => c.key === t.coordinateKey)
  const cells = row?.cells[t.coordinateKey]
  if (!row || !coord || !cells) return null
  return { row, coord, cells }
}

/** Which coordinate carries a target's INVENTORY cells (a market in a shared region points at its region group). */
export function inventoryCoordinate(read: MatrixRead, key: CoordinateKey): CoordinateKey {
  const c = read.coordinates.find(x => x.key === key)
  return c?.inventoryOn ?? key
}

export function previewVerb(read: MatrixRead, req: MatrixVerbRequest, ctx: PreviewContext): VerbPreview {
  const verb: MatrixVerbId = req.params.verb
  const changes: VerbChange[] = []
  const refusals: VerbRefusal[] = []
  const notices = new Set<string>()
  const seen = new Set<string>()
  const refuse = (row: MatrixRowRead, key: CoordinateKey, kind: VerbRefusal['kind'], reason: string) => refusals.push({ rowId: row.id, sku: row.sku, coordinateKey: key, kind, reason })

  for (const t of req.targets) {
    /* Inventory verbs act on the coordinate that CARRIES the inventory — the region group for an EU market. */
    const inventoryVerb = ['pin-quantity', 'set-follow', 'set-buffer', 'pause-sync', 'resume-sync', 'push-now', 'set-fulfilment', 'retry-sync', 'set-source'].includes(verb)
    const key = inventoryVerb ? inventoryCoordinate(read, t.coordinateKey) : t.coordinateKey
    const dedupe = `${t.rowId}|${key}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const hit = target(read, { rowId: t.rowId, coordinateKey: key })
    if (!hit) { const row = read.rows.find(r => r.id === t.rowId); if (row) refuse(row, key, 'no-listing', PREVIEW_WORDS.notOnMarket); continue }
    const { row, coord, cells } = hit
    if (row.role === 'parent') { refuse(row, key, 'not-applicable', 'The parent row has no listing of its own'); continue }
    if (coord.sharedInventoryWith) notices.add(MATRIX_COPY.euNotice(coord.sharedInventoryWith))
    const p = req.params
    const cur = money(cells.price?.value ?? null, coord.currency)

    switch (p.verb) {
      case 'set-price':
      case 'adjust-prices':
      case 'copy-prices': {
        if (!ctx.can('products.price.edit')) { refuse(row, key, 'permission', 'You do not have permission to change prices (products.price.edit)'); break }
        if (!cells.price) { refuse(row, key, 'not-applicable', PREVIEW_WORDS.noPriceHere); break }
        if (cells.price.source === 'formula') { refuse(row, key, 'formula', PREVIEW_WORDS.formulaPrice); break }
        if (cells.writable.price === false) { refuse(row, key, 'not-applicable', cells.writeBlockedReason.price ?? 'This price cannot be changed here'); break }
        let to: number | null = null
        if (p.verb === 'set-price') to = round2(p.value)
        else if (p.verb === 'adjust-prices') {
          const old = cells.price.value
          if (old == null) { refuse(row, key, 'not-applicable', PREVIEW_WORDS.noPriceToChange); break }
          /* By an amount (bulk Edit v2): only in the market's own currency — €2 is not £2. */
          if (typeof p.amount === 'number') {
            if (p.currency !== coord.currency) { refuse(row, key, 'currency', PREVIEW_WORDS.marketCurrency(coord.currency)); break }
            to = round2(old + p.amount)
          } else to = round2(old * (1 + (p.percent ?? NaN) / 100))
        } else {
          const src = row.cells[p.fromCoordinateKey]
          const srcCoord = read.coordinates.find(c => c.key === p.fromCoordinateKey)
          if (!src?.price || src.price.value == null) { refuse(row, key, 'no-listing', PREVIEW_WORDS.noSourcePrice); break }
          if (srcCoord && srcCoord.currency !== coord.currency) { refuse(row, key, 'currency', `${PREVIEW_WORDS.marketCurrency(coord.currency)}, not ${srcCoord.currency} — set the price instead`); break }
          to = src.price.value
        }
        /* Every channel refuses a price of 0, and the door refuses it (above 0): refused here, before Apply. */
        if (to == null || !Number.isFinite(to) || to <= 0) { refuse(row, key, 'not-applicable', PREVIEW_WORDS.priceAboveZero); break }
        if (to === cells.price.value) break
        const note = cells.price.source === 'master' ? PREVIEW_WORDS.ownPrice : undefined
        changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'price', from: cells.price.value, to, fromLabel: cur, toLabel: money(to, coord.currency), note })
        break
      }
      case 'pin-quantity':
      case 'set-follow':
      case 'set-buffer':
      case 'pause-sync':
      case 'resume-sync':
      case 'push-now':
      case 'retry-sync': {
        const s = cells.sync
        if (!s) { refuse(row, key, 'not-applicable', PREVIEW_WORDS.noStockHere); break }
        if (s.kind === 'FBA_EXCLUDED') { refuse(row, key, 'amazon-managed', `${MATRIX_COPY.amazonManaged} — the quantity is never written`); break }
        if (s.kind === 'CLOSED' && p.verb !== 'resume-sync') { refuse(row, key, 'not-applicable', MATRIX_COPY.closedHint); break }
        const from = syncLabel(s)
        if (p.verb === 'pin-quantity') {
          if (!Number.isInteger(p.value) || p.value < 0) { refuse(row, key, 'not-applicable', 'A pinned quantity is a whole number, zero or more'); break }
          if (s.mode === 'PINNED' && s.intended === p.value && s.kind === 'PINNED') break
          if (p.value === 0 && coord.channel === 'EBAY' && ctx.ebayZeroAllowed && ctx.ebayZeroAllowed(coord.accountId, coord.market) !== true) { refuse(row, key, 'guard', EBAY_ZERO_REFUSAL); break }
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncQty', from: s.intended, to: p.value, fromLabel: from, toLabel: `Pinned · ${p.value}`, note: s.kind === 'PAUSED' ? STILL_HELD : undefined })
        } else if (p.verb === 'set-follow') {
          if (s.mode === 'FOLLOW') break /* already following — paused or not, nothing to change (resume is its own verb) */
          const to = followQty(s)
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncMode', from: s.mode, to: 'FOLLOW', fromLabel: from, toLabel: `Follow · ${to ?? MATRIX_COPY.uncounted}`, note: s.kind === 'PAUSED' ? STILL_HELD : undefined })
        } else if (p.verb === 'set-buffer') {
          if (!Number.isInteger(p.value) || p.value < 0) { refuse(row, key, 'not-applicable', 'A buffer is a whole number, zero or more'); break }
          if (s.buffer === p.value) break
          const after = followQty({ poolAvailable: s.poolAvailable, buffer: p.value })
          /* A fixed quantity ignores its buffer (the grid shows `—`): the number is kept, for when the market follows again.
             The labels name the field: an approval card with one line shows only `from → to`. */
          const note = s.mode === 'FOLLOW' ? (after == null ? MATRIX_COPY.uncounted : `The market shows ${after}`) : PREVIEW_WORDS.bufferUnused
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncBuffer', from: s.buffer, to: p.value, fromLabel: `Buffer ${syncBufferText(s)}`, toLabel: `Buffer ${p.value}`, note })
        } else if (p.verb === 'pause-sync') {
          if (s.kind === 'PAUSED' && s.via === 'POLICY') { refuse(row, key, 'not-applicable', 'Stock sync is already held by the channel policy — manage it in Sync Control'); break }
          if (s.kind === 'PAUSED') break
          /* The stock-sync verbs speak the grid's Sync words (`queueStateWord`): the Sync cell is the one that changes. */
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: s.kind, to: 'PAUSED', fromLabel: queueStateWord(cells.queue), toLabel: queueStateWord({ state: 'paused', at: null, reason: null, syncType: null, via: 'LISTING' }), note: `The channel keeps ${s.held ?? '—'} until the stock sync is released` })
        } else if (p.verb === 'resume-sync') {
          if (s.kind !== 'PAUSED') break
          if (s.via === 'POLICY') { refuse(row, key, 'not-applicable', 'Held by the channel policy — releasing here changes nothing; release it in Sync Control'); break }
          const pushes = s.mode === 'PINNED' ? s.held ?? DASH : followQty(s) ?? MATRIX_COPY.uncounted
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: 'PAUSED', to: s.mode, fromLabel: queueStateWord(cells.queue), toLabel: `Queued · ${pushes}`, note: 'Releasing recalculates the quantity and pushes it at once' })
        } else if (p.verb === 'push-now') {
          if (s.kind === 'PAUSED') { refuse(row, key, 'not-applicable', STILL_HELD); break }
          if (s.kind === 'UNCOUNTED') { refuse(row, key, 'not-applicable', MATRIX_COPY.uncountedHint); break }
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: cells.queue?.state ?? 'never', to: 'queued', fromLabel: queueStateWord(cells.queue), toLabel: `Queued · ${s.intended ?? '—'}`, note: 'A fresh quantity push' })
        } else if (p.verb === 'retry-sync') {
          const q = cells.queue
          if (!q || (q.state !== 'failed' && q.state !== 'dead')) { refuse(row, key, 'not-applicable', PREVIEW_WORDS.nothingToRetry); break }
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'syncState', from: q.state, to: 'queued', fromLabel: queueStateWord(q), toLabel: 'Queued', note: q.reason ?? undefined })
        }
        break
      }
      case 'set-fulfilment': {
        const f = cells.fulfilment
        if (!f) { refuse(row, key, 'not-applicable', 'This channel has no fulfilment method'); break }
        if (!coord.vocabulary.fulfilment?.includes(p.method)) { refuse(row, key, 'not-applicable', `${p.method} is not a method on ${coord.label}`); break }
        /* Amazon (2026-10-07): the run SENDS the conversion to Amazon — refused and told by the server's fresh facts. */
        if (coord.channel === 'AMAZON' && ctx.amazonFulfilment && (p.method === 'FBA' || p.method === 'FBM')) {
          const facts = ctx.amazonFulfilment(row.id, key)
          if (!facts) { refuse(row, key, 'guard', AMAZON_FULFILMENT_FACTS_UNREAD); break }
          const verdict = amazonConversionRefusal(facts, p.method, f)
          if (verdict === 'noop') break
          if (verdict) { refuse(row, key, verdict.kind, verdict.reason); break }
          notices.add(MATRIX_COPY.fulfilmentSent(facts.markets))
          if (p.method === 'FBM' && coord.sharedInventoryWith) notices.add(MATRIX_COPY.fulfilmentEuQuantity)
          if (p.method === 'FBA') notices.add(MATRIX_COPY.fulfilmentFbaOutOfStock)
          changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'fulfilment', from: f.method, to: p.method, fromLabel: f.method ?? '—', toLabel: p.method, note: amazonConversionNote(facts, p.method, f.reported) })
          break
        }
        if (f.method === p.method && f.source === 'set') break
        const s = cells.sync
        if (f.method === 'FBA' && p.method === 'FBM' && s?.fbaAtAmazon != null && s.fbaAtAmazon > 0) { refuse(row, key, 'guard', `Refused — ${s.fbaAtAmazon} units of FBA stock on hand keep the guard closed; convert the offer in Seller Central first`); break }
        const pool = s?.poolAvailable ?? null
        const after = p.method === 'FBA' ? 'Amazon-managed · no merchant quantity is pushed' : pool == null ? `Follow → ${MATRIX_COPY.uncounted}` : `Follow → ${Math.max(0, pool - (s?.buffer ?? 0))} pushed from ${s?.routedLocations.join(', ') || 'no routed location'}`
        /* eBay (MCF) stays Nexus's own and says so; the page's fixture preview keeps the cell facts it has. */
        if (coord.channel !== 'AMAZON') notices.add(MATRIX_COPY.fulfilmentNexusOnly)
        changes.push({ rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'fulfilment', from: f.method, to: p.method, fromLabel: f.method ?? '—', toLabel: p.method, note: after })
        break
      }
      case 'set-source': {
        /* "Sells from" — on Amazon EU the region group's ONE choice (the door writes it on every EU row, closed ones too). */
        if (!ctx.can(SOURCE_PERMISSION)) { refuse(row, key, 'permission', MATRIX_COPY.sourcePermission); break }
        const src = cells.source
        if (!src) { refuse(row, key, 'not-applicable', MATRIX_COPY.sourceNone); break }
        if (cells.sync?.kind === 'FBA_EXCLUDED') { refuse(row, key, 'amazon-managed', MATRIX_COPY.sourceFba); break }
        if (!src.writable) { refuse(row, key, 'not-applicable', src.blockedReason ?? MATRIX_COPY.sourceNone); break }
        if (!Array.isArray(p.codes) || p.codes.some((c) => typeof c !== 'string')) { refuse(row, key, 'not-applicable', 'Sells from is a list of location codes'); break }
        const problem = sourceCodesProblem(p.codes, read.locations)
        if (problem) { refuse(row, key, 'not-applicable', problem); break }
        const to = sellsFromCodes(p.codes, src.marketDefault)
        if (sameSourceCodes(to, src.own)) break
        /* The grid's From words: what it sells from now (the server's own choice first) → the new list, or the default's. */
        const now = src.effective.length ? src.effective.map((e) => e.code) : src.own
        changes.push({
          rowId: row.id, sku: row.sku, coordinateKey: key, cell: 'source', from: [...src.own], to,
          fromLabel: MATRIX_COPY.sourceLabel(now, src.marketDefault), toLabel: MATRIX_COPY.sourceLabel(to, src.marketDefault),
          note: to.length ? sourceNote(row, src, to, cells.sync) : `${MATRIX_COPY.sourceDefault} · ${sourceNote(row, src, to, cells.sync)}`,
        })
        break
      }
    }
  }

  const p = req.params
  const big = changes.length >= 100 || (p.verb === 'adjust-prices' && typeof p.percent === 'number' && p.percent <= -BIG_CUT_PERCENT) || bigAmountCut(p, changes)
  /* Typed confirmation (Owner 2026-10-08), the only level besides none: an AMAZON fulfilment change (it converts the offer
     on Amazon — the method is the word), and a big change (100 changes or more, or a price cut of 30 % or more — by a
     percent, or by an amount that takes any line down 30 % or more — APPLY). An eBay fulfilment change is Nexus only,
     with this preview and Undo: no word to type. */
  const amazonFulfilment = req.params.verb === 'set-fulfilment' && changes.some((c) => read.coordinates.find((x) => x.key === c.coordinateKey)?.channel === 'AMAZON')
  const confirm: VerbPreview['confirm'] = amazonFulfilment || big ? 'type-to-confirm' : 'none'
  const confirmWord = confirm === 'type-to-confirm' ? (amazonFulfilment && req.params.verb === 'set-fulfilment' ? req.params.method : 'APPLY') : null
  if (ctx.simulated) notices.add(MATRIX_COPY.simulated)
  return { verb, changes, refusals, notices: [...notices], confirm, confirmWord, simulated: ctx.simulated }
}
