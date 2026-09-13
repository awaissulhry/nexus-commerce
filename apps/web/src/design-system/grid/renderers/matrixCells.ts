/**
 * MX.G — the eight Matrix cell kinds' DISPLAY RULES, pure.
 *
 * Design `docs/2026-09-13-matrix-page-design.md` §3.4 is the table this file implements and
 * Appendix A is the copy. Every word an operator reads in a Matrix cell, every tone it paints,
 * every `.nds-cell-is-*` class it wears and every tooltip sentence is decided HERE, once, and the
 * renderers in `MatrixCells.tsx` draw the answer. A page that wrote `sync.kind === 'PAUSED' ? …`
 * anywhere else would have forked the vocabulary — the failure
 * `reference_two_column_builders_drift` records.
 *
 * ## Three rules this file exists to keep
 *
 * 1. **No tone is CHOSEN.** Every tone below is READ from `readinessMeta()` or `projectionMeta()`
 *    and records where it came from in `matrixCellToneFrom`, exactly as `projection.ts` does (hub
 *    ruling #3). The one exception is stated the way `projection.ts` states its own: a cell at rest
 *    that paints NO status colour answers `null`, because there is no colour to delegate.
 * 2. **The page derives no number.** `SyncCell` is `resolveIntendedQuantity`'s verdict on the wire
 *    (contract §3.6) and `PriceCell.value` is the number the push reads. Nothing here recomputes a
 *    quantity from a pool; `intended` is quoted, never derived. The one arithmetic in the whole
 *    Matrix frontend is `preview.ts`'s `followQty`, and it is preview-mode only.
 * 3. **`null` is never `0`.** `intended: null`, `value: null` and an absent cell render the dash,
 *    with the reason on the tooltip where one exists — the rule `renderers/format.ts` already keeps
 *    for every other cell type.
 *
 * 🔴 **The signatures here are MX.P's, deliberately.** MX.P built the page against a local stub
 * (`_studio/matrix/gdsStub.tsx`) carrying these exact names and arities so that adopting the engine
 * is one changed import and a deleted file — never a second implementation. Where this file departs
 * from the stub it is because the stub had a defect, and each departure is named at its site.
 *
 * Pure `.ts`: no React, no AG, no CSS import, so every rule in it is reachable from this
 * workspace's node-only vitest (`matrixCells.vitest.test.ts`).
 */
import {
  MATRIX_CELL_KINDS,
  type FulfilmentMethod,
  type MatrixCellKind,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixCopy,
  type SaleCell,
  type SyncCell,
} from '../matrix/contract'
import { projectionMeta } from './projection'
import { readinessMeta, type ReadinessTone } from './readiness'

/** The em dash every empty Matrix cell draws — the sheet's own, not a second one. */
export const MATRIX_DASH = '—'

/* ── the copy the engine renders with ───────────────────────────────────────────────────────── */

/**
 * The engine's default copy table — design Appendix A, verbatim.
 *
 * 🔴 **A restatement of `_studio/matrix/contract.ts`'s `MATRIX_COPY`, gated rather than trusted.**
 * The engine has to be able to render a Matrix cell on its own: it is mirrored into `apps/factory`,
 * where no `_studio` tree exists, and the grid lab renders these cells with no page around them.
 * `matrix/contract.parity.vitest.test.ts` asserts every member of this table produces the SAME
 * string as the app's for the same arguments, so a reworded sentence is a red test and not a second
 * truth (`reference_two_column_builders_drift`: put the rule in the engine, assert parity in the
 * gate). The app may still pass its own table as the last argument — this is an injectable default,
 * which is what separates it from a fork.
 */
export const MATRIX_CELL_COPY: MatrixCopy = {
  amazonManaged: 'Amazon-managed',
  uncounted: 'Uncounted',
  closed: 'Closed',
  notListed: 'Not listed',
  sharedEu: (markets) => `Shared by ${markets.join(' ')} — one quantity per SKU on Amazon EU`,
  followsPool: (n, locations, buffer) => `Follows the pool · ${n} available at ${locations.join(', ') || 'no routed location'} − ${buffer} buffer`,
  pinnedAt: (n) => `Pinned at ${n}`,
  pausedBy: (via, would) => `Paused by ${via === 'POLICY' ? 'the channel policy' : 'this listing'} — would push ${would ?? MATRIX_DASH} · Resume to push`,
  uncountedHint: 'No routed location holds this SKU — nothing is pushed',
  closedHint: 'Offer closed — reopen in Sync Control',
  guardFba: 'Guard reads FBA — the quantity is not pushed',
  reported: (r) => `Amazon reports ${r} — differs from Nexus`,
  followsBase: (price) => `Follows the base price ${price}`,
  setHere: 'Set here',
  formula: (expr) => `Formula ${expr}`,
  clamped: (which) => `Clamped to the ${which}`,
}

/* ── the states §3.4 enumerates, named so a screenshot table and a gate row can address them ── */

/**
 * One name per row of the §3.4 table, so "every state rendered" is a SET CLAIM that can be checked
 * rather than an adjective. `MatrixScenario` builds one fixture per member and the ledger's
 * screenshot table is indexed by it.
 *
 * 🔴 Derived nowhere else. A lane that needs "is this cell paused" asks `matrixCellState`, so the
 * screenshot, the class, the tone, the tooltip and the gate row all answer from ONE discriminator.
 */
export type MatrixCellState =
  /* every kind */
  | 'absent'
  /* listing */
  | 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'suppressed' | 'closed' | 'error' | 'ended'
  /* fulfilment */
  | 'fulfilment-set' | 'fulfilment-derived' | 'fulfilment-guard-differs' | 'fulfilment-reported-differs'
  /* syncMode · syncQty · syncBuffer */
  | 'follow' | 'pinned' | 'paused-policy' | 'paused-listing' | 'amazon-managed' | 'uncounted' | 'offer-closed' | 'oversold'
  /* syncState */
  | 'queue-sent' | 'queue-queued' | 'queue-sending' | 'queue-failed' | 'queue-dead' | 'queue-paused' | 'queue-never'
  /* price */
  | 'price-master' | 'price-override' | 'price-formula' | 'price-clamped'
  /* salePrice */
  | 'sale-set' | 'sale-none'

const QUEUE_STATES: readonly string[] = ['sent', 'queued', 'sending', 'failed', 'dead', 'paused', 'never']

/** Is this kind one of ours? A read boundary should parse, not cast. */
export function isMatrixCellKind(value: unknown): value is MatrixCellKind {
  return typeof value === 'string' && (MATRIX_CELL_KINDS as readonly string[]).includes(value)
}

/** Amazon's own report and our method disagree. `MCF` is eBay's and the report never speaks to it. */
export const matrixReportedDiffers = (method: FulfilmentMethod | null, reported: 'AFN' | 'MFN' | null): boolean =>
  !!reported && method != null && method !== 'MCF' && (reported === 'AFN') !== (method === 'FBA')
const reportedDiffers = matrixReportedDiffers

/** The fail-closed guard and the typed column disagree (design M7 — two stores, one fact). */
export const matrixGuardDiffers = (method: FulfilmentMethod | null, guard: 'FBA' | 'FBM' | null): boolean =>
  !!guard && method != null && method !== 'MCF' && guard !== method
const guardDiffers = matrixGuardDiffers

/** The one oversold sentence — the ⚠ mark's title and the tooltip line are the same string. */
export const MATRIX_OVERSOLD_SENTENCE = 'The channel holds more than the pool can back'

/**
 * The §3.4 state of one cell.
 *
 * 🔴 The ORDER of the tests is the design's own precedence and is not cosmetic.
 * `resolveIntendedQuantity` resolves FBA_EXCLUDED → CLOSED → PAUSED → PINNED → FOLLOW → UNCOUNTED
 * (contract §3.6, quoting `sync-control-core.ts:146`), and `SyncCell.kind` already carries that
 * verdict — so this function READS the verdict rather than re-deriving it, and only the facts the
 * verdict does not carry (`oversold`, which is orthogonal) are tested after it.
 */
export function matrixCellState(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixCellState {
  if (!cells) return 'absent'
  switch (kind) {
    case 'listing':
      return (cells.listing?.state as MatrixCellState | undefined) ?? 'absent'
    case 'fulfilment': {
      const f = cells.fulfilment
      if (!f || f.method == null) return 'absent'
      if (guardDiffers(f.method, f.guard)) return 'fulfilment-guard-differs'
      if (reportedDiffers(f.method, f.reported)) return 'fulfilment-reported-differs'
      return f.source === 'set' ? 'fulfilment-set' : 'fulfilment-derived'
    }
    case 'syncMode':
    case 'syncQty':
    case 'syncBuffer': {
      const s = cells.sync
      if (!s) return 'absent'
      switch (s.kind) {
        case 'FBA_EXCLUDED': return 'amazon-managed'
        case 'CLOSED': return 'offer-closed'
        case 'PAUSED': return s.via === 'POLICY' ? 'paused-policy' : 'paused-listing'
        case 'UNCOUNTED': return 'uncounted'
        /* Oversold is orthogonal to the verdict — a PINNED row can be oversold too — so it is
           tested only once the verdict has said the row pushes a number at all, and only on the
           cell that SHOWS the number. On Mode and Buffer the verdict is what the operator reads. */
        case 'PINNED': return kind === 'syncQty' && s.oversold ? 'oversold' : 'pinned'
        case 'FOLLOW': return kind === 'syncQty' && s.oversold ? 'oversold' : 'follow'
      }
      return 'absent'
    }
    case 'syncState': {
      const q = cells.queue
      if (!q) return 'absent'
      /* Fail CLOSED on a state the contract does not name: the lab's coverage probe caught a
         `queue-undefined` key (a fixture row whose queue carried no `state`), and a discriminator that
         minted a member from whatever the wire said would have painted it as a real state. */
      return QUEUE_STATES.includes(q.state) ? (`queue-${q.state}` as MatrixCellState) : 'absent'
    }
    case 'price': {
      const p = cells.price
      if (!p) return 'absent'
      if (p.clamped) return 'price-clamped'
      return p.source === 'formula' ? 'price-formula' : p.source === 'override' ? 'price-override' : 'price-master'
    }
    case 'salePrice': {
      const s = cells.sale
      if (!s) return 'absent'
      return s.value == null ? 'sale-none' : 'sale-set'
    }
  }
}

/* ── text: what the screen, a copy, an export and a text filter all read ────────────────────── */

/**
 * Money in the COORDINATE's currency.
 *
 * 🔴 `formatGridValue('money')` could not do this, measured: `renderers/format.ts` routes `money`,
 * `money2` and `eur` through EUR-pinned formatters. The Matrix is a per-market grid and GBP markets
 * are in the contract (Amazon UK, design M17), so a EUR-pinned formatter prints `€` over a pound
 * price. `format.ts` is extended additively with a `currency` option in the same pass, and this
 * function is what the Matrix cells call — one formatter for the eight kinds, so a price cell and a
 * sale cell cannot round differently.
 *
 * `en-GB` fixes the grouping and symbol placement so SSR and client render identically — the same
 * reason `lib/format.ts` pins its locale.
 */
export function matrixMoney(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return MATRIX_DASH
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value)
  } catch {
    /* An unknown ISO code throws in `Intl`. The cell must still say the number rather than taking
       the row down — and must NOT silently print € for a currency it could not resolve. */
    return `${currency} ${value.toFixed(2)}`
  }
}

/**
 * `12 Sep` — the short form the §3.4 sale cell shows. UTC-pinned so a screenshot compares to itself.
 *
 * 🔴 A fixed month table, NOT `toLocaleDateString('en-GB', { month: 'short' })`: measured 2026-09-13
 * in this workspace's Node, that call prints `12 Sept` — CLDR changed en-GB's September abbreviation
 * to four letters, and Chrome ships the same data. Appendix A says `12 Sep`, and a copy table is
 * verbatim or it is not a copy table; the ICU version of whatever renders the cell must not decide
 * an operator-facing word.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
export function matrixDay(iso: string | null | undefined): string {
  if (!iso) return MATRIX_DASH
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return MATRIX_DASH
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`
}

/** `2 min` · `9 h` · `3 d` — the queue row's own AGE, never a wall clock the operator must subtract. */
export function matrixAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86_400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

/** `€89.00 · 12 Sep → 30 Sep` (Appendix A). An open-ended window prints only the side it has. */
export function matrixSaleText(sale: SaleCell | null | undefined, currency: string): string {
  if (!sale || sale.value == null) return MATRIX_DASH
  const window = sale.start || sale.end ? ` · ${matrixDay(sale.start)} → ${matrixDay(sale.end)}` : ''
  return `${matrixMoney(sale.value, currency)}${window}`
}

/** The Mode word — `Follow` · `Pinned` · `—` (Appendix A). */
export function matrixModeWord(sync: SyncCell | null | undefined): string {
  if (!sync) return MATRIX_DASH
  if (sync.kind === 'FBA_EXCLUDED' || sync.kind === 'CLOSED') return MATRIX_DASH
  return sync.mode === 'PINNED' ? 'Pinned' : 'Follow'
}

/**
 * The Sync word — `Sent <ago>` · `Queued` · `Sending` · `Failed` · `Dead` · `Paused · policy` ·
 * `Paused · listing` · `Never` (Appendix A, verbatim).
 */
export function matrixQueueWord(cells: MatrixCells | null | undefined, now: number = Date.now()): string {
  const q = cells?.queue
  if (!q) return MATRIX_DASH
  switch (q.state) {
    case 'sent': {
      const ago = matrixAgo(q.at, now)
      return ago ? `Sent ${ago}` : 'Sent'
    }
    case 'queued': return 'Queued'
    case 'sending': return 'Sending'
    case 'failed': return 'Failed'
    case 'dead': return 'Dead'
    case 'paused': return `Paused · ${q.via === 'POLICY' ? 'policy' : 'listing'}`
    case 'never': return 'Never'
  }
}

/**
 * The Sync cell AT REST — design §3.4's own column, verbatim: `✓ 2 min` · `Queued` · `Sending` ·
 * `✗ Failed` · `Dead` · `⏸ policy` / `⏸ listing` · `—` never.
 *
 * 🔴 Two forms, one fact, and the split is the design's: §3.4 draws the CELL (a glyph and a short
 * word, because the column is 96px and `Paused · listing` measured 94px against 63 available), and
 * Appendix A fixes the WORD an export, a filter and a tooltip carry (`matrixQueueWord`). The glyph
 * is the identity (`reference_tag_identity_is_glyph_not_colour`); the tone rides on it.
 */
export function matrixQueueGlyph(cells: MatrixCells | null | undefined, now: number = Date.now()): { glyph: string; word: string } | null {
  const q = cells?.queue
  if (!q) return null
  switch (q.state) {
    case 'sent': return { glyph: '✓', word: matrixAgo(q.at, now) ?? 'Sent' }
    case 'queued': return { glyph: '', word: 'Queued' }
    case 'sending': return { glyph: '', word: 'Sending' }
    case 'failed': return { glyph: '✗', word: 'Failed' }
    case 'dead': return { glyph: '✗', word: 'Dead' }
    case 'paused': return { glyph: '⏸', word: q.via === 'POLICY' ? 'policy' : 'listing' }
    case 'never': return { glyph: '—', word: '' }
    default: return null
  }
}

/**
 * The Qty word — `<n>` · `⏸ <n>` · `—` · `Uncounted` · `Closed` (Appendix A).
 *
 * The ⏸ belongs to the TEXT and not only to the renderer, because this same function feeds the
 * clipboard, the CSV export and the text filter (`valueFormatter` / `getQuickFilterText`), and a
 * paused row that exported as a bare number would read as a pushed quantity in a spreadsheet.
 */
export function matrixQtyText(cells: MatrixCells | null | undefined, copy: MatrixCopy = MATRIX_CELL_COPY): string {
  const s = cells?.sync
  if (!s) return MATRIX_DASH
  switch (s.kind) {
    case 'FBA_EXCLUDED': return MATRIX_DASH
    case 'CLOSED': return copy.closed
    case 'UNCOUNTED': return copy.uncounted
    case 'PAUSED': return `⏸ ${s.held ?? MATRIX_DASH}`
    case 'FOLLOW':
    case 'PINNED': return s.intended == null ? MATRIX_DASH : String(s.intended)
  }
}

/**
 * The ONE text of a Matrix cell: the word on screen, and the same string a copy, an export, a
 * quick filter and the comparator read.
 *
 * 🔴 It is the same function the renderer's own word comes from, so the clipboard and the screen
 * cannot disagree — the rule `variationThemeText` established for the variation-theme column and
 * the reason `shapeColumn.ts` routes `valueFormatter` and `filterValueGetter` through one place.
 */
export function matrixCellText(
  kind: MatrixCellKind,
  cells: MatrixCells | null | undefined,
  coord: Pick<MatrixCoordinate, 'currency'>,
  copy: MatrixCopy = MATRIX_CELL_COPY,
  now: number = Date.now(),
): string {
  if (!cells) return ''
  /* `||`, not `??`: an empty currency string is no currency, and `Intl` would throw on it. */
  const currency = cells.price?.currency || coord.currency
  switch (kind) {
    case 'listing':
      return cells.listing ? projectionMeta(cells.listing.state).label : ''
    case 'fulfilment':
      return cells.fulfilment?.method ?? MATRIX_DASH
    case 'syncMode':
      return matrixModeWord(cells.sync)
    case 'syncQty':
      return matrixQtyText(cells, copy)
    case 'syncBuffer': {
      const s = cells.sync
      /* `—` on Pinned and on FBA (§3.4): a pinned listing ignores its buffer and an Amazon-managed
         one has no merchant quantity to buffer. Printing `0` there would be a measured zero that
         was never measured. */
      if (!s || s.kind === 'FBA_EXCLUDED' || s.kind === 'CLOSED' || s.mode === 'PINNED') return MATRIX_DASH
      return String(s.buffer)
    }
    case 'syncState':
      return matrixQueueWord(cells, now)
    case 'price':
      return matrixMoney(cells.price?.value ?? null, currency)
    case 'salePrice':
      return matrixSaleText(cells.sale, currency)
  }
}

/* ── tone: READ, never chosen ───────────────────────────────────────────────────────────────── */

/** Where a tone was read from, as `"<vocabulary>:<state>"`, or `null` when nothing is painted. */
export type MatrixToneSource = `row:${string}` | `scope:${string}` | null

type RowState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

/**
 * The DECLARED counterpart for every non-listing Matrix state — the whole delegation, in one table
 * an auditor can read without running anything. `null` means the state paints no status colour, so
 * there is no colour decision to delegate (`projection.ts`'s `excluded` states the same thing).
 *
 * Each line is an argument someone can check:
 *   · `amazon-managed` / `offer-closed` / `paused-*` / `queue-paused` / `queue-never` → `unlisted`.
 *     Nothing is being pushed and nothing is wrong — exactly what `unlisted` means for a row.
 *   · `uncounted` → `missing`. A routed location is a required input that is not there; the row
 *     warning tone is precisely `needs-value`'s.
 *   · `oversold` / `queue-failed` / `queue-dead` / `fulfilment-guard-differs` → `errors`. The
 *     channel is holding, or would refuse, a number we cannot back: publishing state is wrong now.
 *   · `fulfilment-reported-differs` → `missing`. Amazon's own report disagrees with Nexus; the value
 *     is not refused, it is unverified. `⇄` is a DIFFERENT glyph from `⚠`, so the two are told apart
 *     by shape and not by colour (ruling #16, `reference_tag_identity_is_glyph_not_colour`).
 *   · `queue-sent` → `live`. It reached the channel.
 *   · `price-clamped` → `missing`. A floor or ceiling moved the number the operator asked for.
 */
const TONE_SOURCE: Partial<Record<MatrixCellState, RowState>> = {
  oversold: 'errors',
  'queue-failed': 'errors',
  'queue-dead': 'errors',
  'fulfilment-guard-differs': 'errors',
  uncounted: 'missing',
  'price-clamped': 'missing',
  'fulfilment-reported-differs': 'missing',
  'amazon-managed': 'unlisted',
  'offer-closed': 'unlisted',
  'paused-policy': 'unlisted',
  'paused-listing': 'unlisted',
  'queue-paused': 'unlisted',
  'queue-never': 'unlisted',
  'queue-sent': 'live',
}

/**
 * Which readiness/projection entry this cell's tone was read from. Exported so a test can assert
 * the delegation without re-deriving it, and so an auditor can check it by reading.
 */
export function matrixCellToneFrom(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixToneSource {
  if (kind === 'listing') return cells?.listing ? projectionMeta(cells.listing.state).from : null
  const source = TONE_SOURCE[matrixCellState(kind, cells)]
  return source ? `row:${source}` : null
}

/**
 * The tone of one Matrix cell, READ from the readiness/projection tables — `null` where the cell
 * paints no status colour, which is most cells at rest.
 *
 * `coord` is accepted and unused: the tone of a cell is a property of the CELL, never of the
 * coordinate it sits under, and taking the argument keeps MX.P's call sites unchanged while making
 * that fact explicit rather than implied by an absence.
 */
export function matrixCellTone(
  kind: MatrixCellKind,
  cells: MatrixCells | null | undefined,
  _coord?: Pick<MatrixCoordinate, 'key'>,
): ReadinessTone | null {
  if (kind === 'listing') {
    if (!cells?.listing) return null
    const meta = projectionMeta(cells.listing.state)
    /* `excluded` declares no counterpart and paints nothing — `from: null` is the discriminator,
       not the tone value, because `neutral` is also a real painted tone elsewhere. */
    return meta.from == null ? null : meta.tone
  }
  const source = TONE_SOURCE[matrixCellState(kind, cells)]
  return source ? readinessMeta(source, 'row').tone : null
}

/* ── classes: the cell tints, from the engine's existing vocabulary ─────────────────────────── */

/**
 * The `.nds-cell-is-*` classes one Matrix cell wears, in PRECEDENCE order — the first match wins
 * and the rest are not applied.
 *
 * 🔴 Precedence is behaviour, and §3.4's own words fix it: *"a paused listing's Mode · Qty · Buffer
 * · Sync cells share one muted tint"* and *"an FBA row's four inventory cells render `—`"*. So a
 * paused FOLLOW cell must NOT also wear `nds-cell-is-inherited`, or two tints fight over one cell
 * and the operator reads the weaker one. `locked` (nothing can be written here) beats `paused`
 * (nothing is being sent) beats `refused` (the last send failed) beats the provenance tints.
 *
 * 🔴 `nds-cell-is-refused` is ALSO `roundTripClassRules`'s class for a write the server refused, and
 * the two uses cannot collide: it is applied here ONLY on `syncState`, which is read-only on every
 * Matrix column (`WRITABLE_CELL_KINDS` excludes it and `matrixCellEditable` refuses it outright), so
 * no write can ever land on a cell this rule paints. Stated because `sheetColumn.ts` asserts its
 * rule sets disjoint and a future lane adding a `syncState` editor would break that silently.
 */
export function matrixCellClasses(
  kind: MatrixCellKind,
  cells: MatrixCells | null | undefined,
  _coord?: Pick<MatrixCoordinate, 'key'>,
): string[] {
  if (!cells) return ['nds-cell-is-locked']
  const state = matrixCellState(kind, cells)
  if (state === 'absent') return ['nds-cell-is-locked']
  if (state === 'amazon-managed' || state === 'offer-closed') return ['nds-cell-is-locked']
  /* §3.4: "a paused listing's Mode · Qty · Buffer · Sync cells share one muted tint" — so the Sync
     cell reads the LISTING's verdict too, not only its own queue row (a paused listing's queue is
     `paused` by construction, but the tint must not depend on the two agreeing). */
  const pausedListing = cells.sync?.kind === 'PAUSED' && (kind === 'syncMode' || kind === 'syncQty' || kind === 'syncBuffer' || kind === 'syncState')
  if (pausedListing || state === 'paused-policy' || state === 'paused-listing' || state === 'queue-paused') return ['nds-cell-is-paused']
  if (kind === 'syncState' && (state === 'queue-failed' || state === 'queue-dead')) return ['nds-cell-is-refused']
  /* A cell nobody may write wears the lock tint whatever its provenance — the parent row, an
     absent store, a formula-owned price. The REASON travels on the tooltip; the tint says "not
     here". `listing` and `syncState` are excluded: they are facts on EVERY row, and a grid whose
     two fact columns were locked-tinted end to end would say nothing by saying it everywhere. */
  if (cells.writable[kind] === false && kind !== 'listing' && kind !== 'syncState') return ['nds-cell-is-locked']
  /* The provenance tints, and ONLY on the kinds that have a layer above them: a quantity that
     follows the pool and a price that follows the base price. `fulfilment`'s `derived`/`set` carries
     its MARK (🔗 / ✎) and no tint — §3.4's tint rules name the paused row and the FBA row and
     nothing else, and tinting every fulfilment cell in the grid would drown both. */
  if (kind === 'syncQty' || kind === 'syncMode') {
    if (state === 'follow') return ['nds-cell-is-inherited']
    if (state === 'pinned') return ['nds-cell-is-pinned']
  }
  if (kind === 'price') {
    if (state === 'price-master') return ['nds-cell-is-inherited']
    if (state === 'price-override' || state === 'price-formula') return ['nds-cell-is-pinned']
  }
  return []
}

/** Every class `matrixCellClasses` can emit — the set a column builds its `cellClassRules` from. */
export const MATRIX_CELL_CLASSES: readonly string[] = [
  'nds-cell-is-inherited',
  'nds-cell-is-pinned',
  'nds-cell-is-locked',
  'nds-cell-is-paused',
  'nds-cell-is-refused',
]

/* ── tooltips: Appendix A's sentences ───────────────────────────────────────────────────────── */

/**
 * The ONE tooltip of a Matrix cell — Appendix A, verbatim, through the copy table.
 *
 * Composed from SERVER-STATED facts only. Where a cell has nothing to add beyond the word already
 * in it, the answer is `null` and no title is rendered: a sheet where every cell carries a hover is
 * the noise the DS spent a pass removing (`ProjectionCell`'s own note).
 *
 * A `writeBlockedReason` is appended for any cell the operator cannot write, whatever else it says
 * — a held control must carry its reason in the DOM (`scripts/check-silent-disabled.mjs`).
 */
export function matrixCellTooltip(
  kind: MatrixCellKind,
  cells: MatrixCells | null | undefined,
  coord: Pick<MatrixCoordinate, 'currency' | 'sharedInventoryWith'>,
  copy: MatrixCopy = MATRIX_CELL_COPY,
  now: number = Date.now(),
): string | null {
  if (!cells) return null
  const lines: string[] = []
  const s = cells.sync
  const region = coord.sharedInventoryWith?.length ? copy.sharedEu(coord.sharedInventoryWith) : null

  switch (kind) {
    case 'listing': {
      const l = cells.listing
      if (!l) break
      lines.push(projectionMeta(l.state).hint)
      if (l.externalId) lines.push(l.externalId)
      if (l.detail) lines.push(l.detail)
      break
    }
    case 'fulfilment': {
      const f = cells.fulfilment
      if (!f) break
      if (f.method) lines.push(f.source === 'set' ? copy.setHere : 'Derived — nothing is stored on this listing')
      if (guardDiffers(f.method, f.guard)) lines.push(copy.guardFba)
      if (reportedDiffers(f.method, f.reported)) lines.push(copy.reported(f.reported as 'AFN' | 'MFN'))
      /* §3.4's honesty clause, and the whole reason this cell is not a plain select: it re-points
         the pool behind the quantity; the OFFER is converted in Seller Central (design M7). */
      lines.push('Changing this re-points the pool behind the quantity — the offer itself is converted in Seller Central')
      if (region) lines.push(region)
      break
    }
    case 'syncMode':
    case 'syncQty':
    case 'syncBuffer': {
      if (!s) break
      switch (s.kind) {
        case 'FBA_EXCLUDED':
          lines.push(`${copy.amazonManaged}${s.fbaAtAmazon == null ? '' : ` · ${s.fbaAtAmazon} at Amazon`}`)
          break
        case 'CLOSED':
          lines.push(copy.closedHint)
          break
        case 'PAUSED':
          lines.push(copy.pausedBy(s.via === 'POLICY' ? 'POLICY' : 'LISTING', s.held))
          break
        case 'UNCOUNTED':
          lines.push(copy.uncountedHint)
          break
        case 'PINNED':
          /* `intended` and not `held`: the pinned number is what WOULD be pushed, which is the
             question the tooltip answers. A `null` there prints the dash rather than a zero. */
          lines.push(s.intended == null ? copy.uncountedHint : copy.pinnedAt(s.intended))
          break
        case 'FOLLOW':
          lines.push(s.poolAvailable == null ? copy.uncountedHint : copy.followsPool(s.poolAvailable, s.routedLocations, s.buffer))
          break
      }
      if (s.oversold) lines.push(MATRIX_OVERSOLD_SENTENCE)
      if (region) lines.push(region)
      break
    }
    case 'syncState': {
      const q = cells.queue
      if (!q) break
      lines.push(matrixQueueWord(cells, now))
      if (q.syncType) lines.push(q.syncType === 'PRICE_UPDATE' ? 'Price queue' : 'Quantity queue')
      if (q.reason) lines.push(q.reason)
      break
    }
    case 'price': {
      const p = cells.price
      if (!p) break
      const currency = p.currency || coord.currency
      if (p.source === 'formula' && p.formula) lines.push(copy.formula(p.formula))
      else if (p.source === 'override') lines.push(copy.setHere)
      else lines.push(copy.followsBase(matrixMoney(p.value, currency)))
      if (p.clamped) lines.push(copy.clamped(p.clamped))
      const sale = cells.sale
      if (sale?.value != null) lines.push(`Sale ${matrixMoney(sale.value, currency)}${sale.end ? ` until ${matrixDay(sale.end)}` : ''}`)
      break
    }
    case 'salePrice': {
      const sale = cells.sale
      if (!sale || sale.value == null) break
      lines.push(matrixSaleText(sale, cells.price?.currency || coord.currency))
      break
    }
  }

  const blocked = cells.writeBlockedReason[kind]
  if (blocked && cells.writable[kind] !== true) lines.push(blocked)
  const out = lines.filter(Boolean).join(' · ')
  return out === '' ? null : out
}

/* ── editability and the fill-safe value ────────────────────────────────────────────────────── */

export interface MatrixEditability {
  editable: boolean
  /** The sentence a held cell carries. `null` only when the cell IS editable. */
  reason: string | null
}

/**
 * May the operator write this cell here, and if not, WHY.
 *
 * `writable` is the SERVER's answer (contract §3.6 `writable` / `writeBlockedReason`) and the engine
 * never second-guesses it — except in one direction that costs nothing and closes a hole: a kind
 * that is not writable by DESIGN is never editable whatever the wire says. `listing` is the
 * projection PATCH's own control (the tick), `syncState` is a fact, and `fulfilment` never writes
 * inline — choosing a method opens the `set-fulfilment` preflight for that one row (§3.4).
 *
 * 🔴 `writable: undefined` is `false` with a sentence, never `true`. The contract says
 * "Absent = false", and an editor that opened on a cell the server never blessed would arm a write
 * the server will refuse — the same defect as a silently disabled control, one step later.
 */
export function matrixCellEditable(kind: MatrixCellKind, cells: MatrixCells | null | undefined): MatrixEditability {
  if (kind === 'listing') return { editable: false, reason: 'Inclusion is set with the tick, not by typing' }
  if (kind === 'syncState') return { editable: false, reason: 'The sync state is a fact — use Push quantity now, or Retry on a failure' }
  if (kind === 'fulfilment') {
    if (!cells) return { editable: false, reason: 'No listing on this coordinate' }
    /**
     * 🔴 EDITABLE, and the write still never happens inline — the two are different layers.
     *
     * The first version of this branch answered `editable: false` for a writable fulfilment cell,
     * with the sentence "choose a method to open Set fulfilment…". That was self-contradicting on
     * screen: with `editable: false` AG opens NO editor, so there was no list to choose from, and
     * the chevron the renderer draws promised a select that could never open — a dead control
     * wearing an affordance (`MX.P`'s stub had the same shape and the same defect).
     *
     * What §3.4 says is that the SELECT opens and its CHOICE opens the preflight. So the column IS
     * editable when the server says so, `selectEditor(coord.vocabulary.fulfilment)` mounts the DS
     * listbox, and the column's `valueSetter` (`matrixColumn.ts`) hands the chosen method to
     * `onPickFulfilment` and returns `false` — AG then fires no `cellValueChanged`, mutates nothing,
     * and the only consequence is the `set-fulfilment` dialog for that one row. The fill handle is
     * refused on this kind (`MATRIX_FILLABLE_KINDS`), and `matrixWrite` refuses the kind outright
     * as the last line, so no path from a grid gesture can reach a fulfilment write.
     */
    if (cells.writable.fulfilment === true) return { editable: true, reason: null }
    return { editable: false, reason: cells.writeBlockedReason.fulfilment ?? 'This cell cannot be changed here' }
  }
  if (!cells) return { editable: false, reason: 'No listing on this coordinate' }
  if (cells.writable[kind] === true) return { editable: true, reason: null }
  return { editable: false, reason: cells.writeBlockedReason[kind] ?? 'This cell cannot be changed here' }
}

/**
 * The cell's VALUE — what AG carries, compares and (where the handle is allowed) FILLS.
 *
 * 🔴 A SCALAR for every kind the fill handle may carry, and that is the design (`ProjectionCell`'s
 * own note says why a whole cell object as a value is a hazard: dragging one variant's ASIN onto
 * nineteen others):
 *   `syncQty` → the number, `syncBuffer` → the number, `price` → the number,
 *   `syncMode` → `'FOLLOW' | 'PINNED'`, `fulfilment` → the method.
 * `listing` and `syncState` answer `null` — they are facts, and there is nothing a fill could
 * honestly carry. Everything else a cell says is read from the ROW through `facts`.
 *
 * 🔴 `salePrice` is the ONE COMPOUND value — `{ value, start, end }` — and the reason is AG's own
 * commit path, not taste. `CellCtrl.saveNewValue` fires `cellValueChanged` only when the editor's
 * value `!==` the getter's, and `RowNode.setDataValue` re-reads the getter for the event's
 * `newValue`. With a scalar value here, a sale whose DATES moved and whose price did not would
 * re-read as the same number: the event would carry `oldValue === newValue`, the write gate's
 * `unchanged` rule would drop it, and the operator's edit would vanish with nothing on screen
 * saying so. The compound is safe precisely because this kind is NOT in `MATRIX_FILLABLE_KINDS` —
 * the hazard the scalar rule guards against cannot arise on a column whose handle is refused. The
 * setter REPLACES the object rather than mutating it in place, so the event's old and new
 * references differ and `sameValue` compares them structurally.
 *
 * 🔴 `syncQty` answers `intended`, NOT `held`, and the difference is measurable: `intended` is what
 * WOULD be pushed (`resolveIntendedQuantity`'s output) and `held` is what the channel currently has.
 * On a PAUSED row `intended` is `null` by contract — so the cell's value is `null` there, which is
 * correct: a fill from a paused cell must not stamp the stale channel number onto twenty rows.
 * MX.P's stub read `intended ?? held`, which would have done exactly that.
 */
export function matrixCellValue(kind: MatrixCellKind, cells: MatrixCells | null | undefined): unknown {
  if (!cells) return null
  switch (kind) {
    case 'syncQty': return cells.sync?.intended ?? null
    case 'syncBuffer': return cells.sync?.buffer ?? null
    case 'syncMode': return cells.sync?.mode ?? null
    case 'fulfilment': return cells.fulfilment?.method ?? null
    case 'price': return cells.price?.value ?? null
    case 'salePrice': return cells.sale ?? null
    case 'listing':
    case 'syncState': return null
  }
}

/**
 * The value the SALE editor edits and reports — the wire's own `SaleCell`, re-typed here so the
 * editor, the setter and the writer name one shape. An all-null compound means "no sale".
 */
export type SaleEditorValue = SaleCell

/** Is this a sale compound (the editor's report), rather than a bare number or nothing? */
export function isSaleEditorValue(v: unknown): v is SaleEditorValue {
  return !!v && typeof v === 'object' && 'value' in v && 'start' in v && 'end' in v
}

/**
 * Coerce what an editor, a paste or a fill handed the column into the value the kind stores, or
 * `undefined` when it cannot be stored — the setter then refuses (returns `false`) and AG keeps
 * the old value, which is the honest answer to `"abc"` in a quantity cell.
 *
 * Numbers arrive as numbers from AG's number editor and as STRINGS from a paste (`"5"`); both are
 * accepted. `''` on a number kind clears nothing here — a quantity has no "empty", so it refuses.
 * `syncQty` and `syncBuffer` are whole units; `price` keeps two decimals of intent as typed.
 */
export function matrixCoerceValue(kind: MatrixCellKind, value: unknown): unknown {
  switch (kind) {
    case 'syncQty':
    case 'syncBuffer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      return Number.isInteger(n) && n >= 0 ? n : undefined
    }
    case 'price': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      return Number.isFinite(n) && n >= 0 ? n : undefined
    }
    case 'syncMode':
      return value === 'FOLLOW' || value === 'PINNED' ? value : undefined
    case 'fulfilment':
      return value === 'FBA' || value === 'FBM' || value === 'MCF' ? value : undefined
    case 'salePrice': {
      if (value == null) return { value: null, start: null, end: null }
      if (isSaleEditorValue(value)) {
        const v = value.value == null ? null : Number(value.value)
        if (v != null && !(Number.isFinite(v) && v >= 0)) return undefined
        return { value: v, start: value.start || null, end: value.end || null }
      }
      return undefined
    }
    case 'listing':
    case 'syncState':
      return undefined
  }
}

/**
 * The DEFAULT `params.data` mutation — what the column's `valueSetter` does when the host supplies
 * no `applyValue` of its own. It writes into the `MatrixCells` object the host's `cells(data)`
 * reader returned, which is the row's own nested object: mutating it IS mutating `params.data`,
 * which AG requires (`reference_ag_value_setter_must_mutate_params_data`).
 *
 * 🔴 It moves the VALUE and nothing else. Typing a number into a Follow cell leaves `kind` and
 * `mode` as they were: D-MX3 says typing pins, and the STORE (preview) or the SERVICE (live) is
 * what turns the write into a pin and answers with the new read — the class stays untouched in
 * the browser so the sheet never claims a provenance the write has not yet earned (the mandate's
 * "the class stays untouched"). `salePrice` REPLACES the compound (see `matrixCellValue`).
 *
 * Returns `false` when there is nothing to write into or the value cannot be stored, so AG keeps
 * the old value and fires nothing.
 */
export function matrixApplyValue(cells: MatrixCells | null | undefined, kind: MatrixCellKind, value: unknown): boolean {
  if (!cells) return false
  const v = matrixCoerceValue(kind, value)
  if (v === undefined) return false
  switch (kind) {
    case 'syncQty':
      if (!cells.sync) return false
      cells.sync.intended = v as number
      return true
    case 'syncBuffer':
      if (!cells.sync) return false
      cells.sync.buffer = v as number
      return true
    case 'syncMode':
      if (!cells.sync) return false
      cells.sync.mode = v as SyncCell['mode']
      return true
    case 'price':
      if (!cells.price) return false
      cells.price.value = v as number
      return true
    case 'salePrice':
      cells.sale = v as SaleCell
      return true
    case 'fulfilment':
    case 'listing':
    case 'syncState':
      return false
  }
}

/**
 * The kinds AG's fill handle may carry.
 *
 * Design §3.1 rule 5, verbatim: *"the fill handle is disabled on `fulfilment`, `listing`,
 * `syncState`; it works on `price`, `syncQty`, `syncBuffer`"*. Two kinds the rule does not name are
 * decided here, each by the rule's own argument:
 *   · `syncMode` FILLS. It is a scalar with one meaning per cell, its write goes through the same
 *     one door as a quantity, and typing a number into a Follow cell ALREADY flips the mode
 *     (D-MX3) — so refusing the handle would forbid by drag what the keyboard does by design.
 *   · `salePrice` does NOT. Its value is a price but its meaning is a price AND a window; filling
 *     the number alone would set a sale with somebody else's dates, which is not what the operator
 *     dragged. The editor is the only honest way to set one.
 *
 * Written as an ALLOW-list. `variationThemeWrite`'s lock test was a deny-list first and let exactly
 * one case through; an allow-list fails closed when a ninth kind arrives.
 */
export const MATRIX_FILLABLE_KINDS: readonly MatrixCellKind[] = ['price', 'syncQty', 'syncBuffer', 'syncMode']

export function matrixFillAllowed(kind: MatrixCellKind): boolean {
  return (MATRIX_FILLABLE_KINDS as readonly string[]).includes(kind)
}

/**
 * The comparator a Matrix column sorts by.
 *
 * Numbers sort as numbers, everything else by its own text, and `null` sorts LAST in an ascending
 * sort rather than first — an operator sorting by Qty is looking for the rows that have one. The
 * same rule `formatGridValue` keeps for display: an absent value is not a zero.
 */
export function matrixCompare(kind: MatrixCellKind, a: unknown, b: unknown): number {
  if (kind === 'syncQty' || kind === 'syncBuffer' || kind === 'price' || kind === 'salePrice') {
    /* A sale's VALUE is the compound (see `matrixCellValue`); it sorts by its price. */
    const ua = isSaleEditorValue(a) ? a.value : a
    const ub = isSaleEditorValue(b) ? b.value : b
    const x = typeof ua === 'number' ? ua : null
    const y = typeof ub === 'number' ? ub : null
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return x - y
  }
  const x = a == null ? '' : String(a)
  const y = b == null ? '' : String(b)
  if (x === '' && y === '') return 0
  if (x === '') return 1
  if (y === '') return -1
  return x.localeCompare(y)
}

/** The fulfilment options a coordinate offers, or `null` where the channel has no such concept. */
export function matrixFulfilmentOptions(coord: Pick<MatrixCoordinate, 'vocabulary'>): readonly FulfilmentMethod[] | null {
  return coord.vocabulary.fulfilment ?? null
}
