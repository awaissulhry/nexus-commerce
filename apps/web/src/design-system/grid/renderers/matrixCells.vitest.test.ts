/**
 * MX.G — the eight Matrix cell kinds' display rules, held to design §3.4 and Appendix A.
 *
 * Two kinds of claim, and each is a SET CLAIM rather than a sample:
 *   · every member of `MatrixCellState` has a fixture that PRODUCES it (the table below is typed
 *     `Record<MatrixCellState, …>`, so a state added to the union without a fixture fails `tsc`);
 *   · every tone is READ from `readinessMeta` / `projectionMeta` — asserted against the source, not
 *     against a colour name, so a local copy would not pass (the rule `projection.vitest.test.ts` keeps).
 *
 * The renderers are rendered for real in Node (`react-dom/server`), which is how this workspace
 * tests a `.tsx` from a `.ts` suite — the claims are about the MARKUP a cell emits (the word, the
 * glyph, the mark, the chevron), never about a colour.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICellRendererParams } from 'ag-grid-community'

import type { MatrixCellKind, MatrixCells, MatrixCoordinate } from '../matrix/contract'
import { MATRIX_CELL_KINDS } from '../matrix/contract'
import {
  MATRIX_CELL_CLASSES,
  MATRIX_CELL_COPY,
  MATRIX_DASH,
  MATRIX_FILLABLE_KINDS,
  MATRIX_OVERSOLD_SENTENCE,
  isSaleEditorValue,
  matrixApplyValue,
  matrixCellClasses,
  matrixCellEditable,
  matrixCellState,
  matrixCellText,
  matrixCellTone,
  matrixCellToneFrom,
  matrixCellTooltip,
  matrixCellValue,
  matrixCoerceValue,
  matrixCompare,
  matrixFillAllowed,
  matrixMoney,
  matrixQueueGlyph,
  type MatrixCellState,
} from './matrixCells'
import { MATRIX_CELL_RENDERERS, type MatrixCellParams } from './MatrixCellViews'
import { projectionMeta } from './projection'
import { readinessMeta } from './readiness'

/* ── fixtures ───────────────────────────────────────────────────────────────────────────── */

const COORD: MatrixCoordinate = {
  key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', alias: null,
  accountId: 'acc', currency: 'EUR', connected: true, listed: 5, draft: 1, cells: MATRIX_CELL_KINDS, absent: [],
  sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: ['FBA', 'FBM'] },
}
const EU: MatrixCoordinate = { ...COORD, key: 'AMAZON:EU', kind: 'region-inventory', market: 'EU', label: 'Amazon EU · Inventory · IT DE', sharedInventoryWith: ['IT', 'DE'] }
const UK: MatrixCoordinate = { ...COORD, key: 'AMAZON:UK', market: 'UK', label: 'Amazon · UK', region: 'UK', currency: 'GBP' }

type Deep = { [K in keyof MatrixCells]?: MatrixCells[K] extends object | null ? Partial<NonNullable<MatrixCells[K]>> | null : MatrixCells[K] }

/** A writable, following, sent, master-priced cell — every fixture starts here and moves ONE thing. */
function cells(over: Deep = {}): MatrixCells {
  const base: MatrixCells = {
    listingId: 'L1', version: 3,
    listing: { state: 'listed', externalId: 'B0F7J163XJ', detail: null, published: true },
    fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 403, held: 403, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: { state: 'sent', at: '2026-09-13T05:00:00.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null },
    price: { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null },
    sale: { value: null, start: null, end: null },
    writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true, price: true, salePrice: true },
    writeBlockedReason: {},
  }
  const out = { ...base } as unknown as Record<string, unknown>
  const baseRec = base as unknown as Record<string, unknown>
  for (const k of Object.keys(over) as (keyof MatrixCells)[]) {
    const v = over[k]
    /* `writable` / `writeBlockedReason` REPLACE (an empty map must mean "nothing writable"); the
       cell objects MERGE so a fixture moves one fact. */
    const replace = k === 'writable' || k === 'writeBlockedReason'
    if (v === null) out[k] = null
    else if (!replace && typeof v === 'object' && baseRec[k] && typeof baseRec[k] === 'object') out[k] = { ...(baseRec[k] as object), ...(v as object) }
    else out[k] = v
  }
  return out as unknown as MatrixCells
}

const NOW = Date.parse('2026-09-13T05:02:00.000Z') // 2 min after the fixture's `sent`

/**
 * ONE fixture per state — the set claim. `absent` is any kind on a `null` cells object.
 * Typed as a full record so a new `MatrixCellState` member without a row here is a compile error.
 */
const STATE_FIXTURES: Record<MatrixCellState, { kind: MatrixCellKind; c: MatrixCells | null }> = {
  absent: { kind: 'syncQty', c: null },
  listed: { kind: 'listing', c: cells() },
  draft: { kind: 'listing', c: cells({ listing: { state: 'draft' } }) },
  excluded: { kind: 'listing', c: cells({ listing: { state: 'excluded' } }) },
  'not-set-up': { kind: 'listing', c: cells({ listing: { state: 'not-set-up' } }) },
  'needs-value': { kind: 'listing', c: cells({ listing: { state: 'needs-value' } }) },
  suppressed: { kind: 'listing', c: cells({ listing: { state: 'suppressed' } }) },
  closed: { kind: 'listing', c: cells({ listing: { state: 'closed' } }) },
  error: { kind: 'listing', c: cells({ listing: { state: 'error' } }) },
  ended: { kind: 'listing', c: cells({ listing: { state: 'ended' } }) },
  'fulfilment-set': { kind: 'fulfilment', c: cells() },
  'fulfilment-derived': { kind: 'fulfilment', c: cells({ fulfilment: { source: 'derived' } }) },
  'fulfilment-guard-differs': { kind: 'fulfilment', c: cells({ fulfilment: { method: 'FBM', guard: 'FBA' } }) },
  'fulfilment-reported-differs': { kind: 'fulfilment', c: cells({ fulfilment: { method: 'FBM', guard: 'FBM', reported: 'AFN' } }) },
  follow: { kind: 'syncQty', c: cells() },
  pinned: { kind: 'syncQty', c: cells({ sync: { kind: 'PINNED', mode: 'PINNED', intended: 10, held: 10 } }) },
  'paused-policy': { kind: 'syncQty', c: cells({ sync: { kind: 'PAUSED', via: 'POLICY', intended: null, held: 7 } }) },
  'paused-listing': { kind: 'syncQty', c: cells({ sync: { kind: 'PAUSED', via: 'LISTING', intended: null, held: 7 } }) },
  'amazon-managed': { kind: 'syncQty', c: cells({ sync: { kind: 'FBA_EXCLUDED', intended: null, held: null, fbaAtAmazon: 49 } }) },
  uncounted: { kind: 'syncQty', c: cells({ sync: { kind: 'UNCOUNTED', intended: null, poolAvailable: null, routedLocations: [] } }) },
  'offer-closed': { kind: 'syncQty', c: cells({ sync: { kind: 'CLOSED', intended: null } }) },
  oversold: { kind: 'syncQty', c: cells({ sync: { oversold: true, held: 500 } }) },
  'queue-sent': { kind: 'syncState', c: cells() },
  'queue-queued': { kind: 'syncState', c: cells({ queue: { state: 'queued' } }) },
  'queue-sending': { kind: 'syncState', c: cells({ queue: { state: 'sending' } }) },
  'queue-failed': { kind: 'syncState', c: cells({ queue: { state: 'failed', reason: 'eBay: 25002 — the item is not active on this site' } }) },
  'queue-dead': { kind: 'syncState', c: cells({ queue: { state: 'dead', reason: 'MAX_RETRIES_EXCEEDED after 3 attempts' } }) },
  'queue-paused': { kind: 'syncState', c: cells({ queue: { state: 'paused', via: 'POLICY', at: null } }) },
  'queue-never': { kind: 'syncState', c: cells({ queue: { state: 'never', at: null } }) },
  'price-master': { kind: 'price', c: cells() },
  'price-override': { kind: 'price', c: cells({ price: { value: 99, source: 'override' } }) },
  'price-formula': { kind: 'price', c: cells({ price: { value: 99.75, source: 'formula', formula: '= $basePrice * 0.95' }, writable: { price: false }, writeBlockedReason: { price: 'A formula owns this cell — edit the formula' } }) },
  'price-clamped': { kind: 'price', c: cells({ price: { value: 80, source: 'override', clamped: 'floor' } }) },
  'sale-set': { kind: 'salePrice', c: cells({ sale: { value: 89, start: '2026-09-12', end: '2026-09-30' } }) },
  'sale-none': { kind: 'salePrice', c: cells() },
}
const STATES = Object.keys(STATE_FIXTURES) as MatrixCellState[]

/* ── the state discriminator: every member produced, in precedence ──────────────────────── */

describe('matrixCellState — every §3.4 state is produced by exactly its fixture', () => {
  it('produces every member of MatrixCellState (a set claim, counted)', () => {
    let arms = 0
    for (const state of STATES) {
      const { kind, c } = STATE_FIXTURES[state]
      expect(matrixCellState(kind, c)).toBe(state)
      arms++
    }
    expect(arms).toBe(STATES.length)
    expect(STATES.length).toBe(35)
  })

  it('reads the resolver verdict in its own precedence: FBA beats CLOSED beats PAUSED beats PINNED', () => {
    /* A cell whose facts would satisfy several states — `kind` is the verdict and wins. */
    expect(matrixCellState('syncQty', cells({ sync: { kind: 'FBA_EXCLUDED', mode: 'PINNED', oversold: true } }))).toBe('amazon-managed')
    expect(matrixCellState('syncQty', cells({ sync: { kind: 'CLOSED', mode: 'PINNED', oversold: true } }))).toBe('offer-closed')
    expect(matrixCellState('syncQty', cells({ sync: { kind: 'PAUSED', via: 'LISTING', mode: 'PINNED', oversold: true } }))).toBe('paused-listing')
    /* Oversold is orthogonal and shows ONLY on the cell that shows the number. */
    expect(matrixCellState('syncQty', cells({ sync: { kind: 'PINNED', mode: 'PINNED', oversold: true } }))).toBe('oversold')
    expect(matrixCellState('syncMode', cells({ sync: { kind: 'PINNED', mode: 'PINNED', oversold: true } }))).toBe('pinned')
    expect(matrixCellState('syncBuffer', cells({ sync: { oversold: true } }))).toBe('follow')
  })

  it('the guard beats the report on fulfilment, and MCF never disagrees with an Amazon report', () => {
    expect(matrixCellState('fulfilment', cells({ fulfilment: { method: 'FBM', guard: 'FBA', reported: 'AFN' } }))).toBe('fulfilment-guard-differs')
    expect(matrixCellState('fulfilment', cells({ fulfilment: { method: 'MCF', guard: 'FBM', reported: 'AFN' } }))).toBe('fulfilment-set')
    expect(matrixCellState('fulfilment', cells({ fulfilment: { method: null } }))).toBe('absent')
  })
})

/* ── text: Appendix A, verbatim ─────────────────────────────────────────────────────────── */

describe('matrixCellText — the word on screen is the word in the export', () => {
  it('Listing says projectionMeta’s own label for all nine words', () => {
    for (const s of ['listed', 'draft', 'excluded', 'not-set-up', 'needs-value', 'suppressed', 'closed', 'error', 'ended'] as const) {
      expect(matrixCellText('listing', cells({ listing: { state: s } }), COORD)).toBe(projectionMeta(s).label)
    }
  })
  it('Mode: Follow · Pinned · —', () => {
    expect(matrixCellText('syncMode', STATE_FIXTURES.follow.c, COORD)).toBe('Follow')
    expect(matrixCellText('syncMode', STATE_FIXTURES.pinned.c, COORD)).toBe('Pinned')
    expect(matrixCellText('syncMode', STATE_FIXTURES['amazon-managed'].c, COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('syncMode', STATE_FIXTURES['offer-closed'].c, COORD)).toBe(MATRIX_DASH)
    /* Paused keeps the stored mode word — the ⏸ and the lever are the renderer's and the tint's. */
    expect(matrixCellText('syncMode', STATE_FIXTURES['paused-policy'].c, COORD)).toBe('Follow')
  })
  it('Qty: <n> · ⏸ <n> · — · Uncounted · Closed, and null is never 0', () => {
    expect(matrixCellText('syncQty', STATE_FIXTURES.follow.c, COORD)).toBe('403')
    expect(matrixCellText('syncQty', STATE_FIXTURES.pinned.c, COORD)).toBe('10')
    expect(matrixCellText('syncQty', STATE_FIXTURES['paused-listing'].c, COORD)).toBe('⏸ 7')
    expect(matrixCellText('syncQty', STATE_FIXTURES['amazon-managed'].c, COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('syncQty', STATE_FIXTURES.uncounted.c, COORD)).toBe(MATRIX_CELL_COPY.uncounted)
    expect(matrixCellText('syncQty', STATE_FIXTURES['offer-closed'].c, COORD)).toBe(MATRIX_CELL_COPY.closed)
    expect(matrixCellText('syncQty', cells({ sync: { intended: null } }), COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('syncQty', cells({ sync: { kind: 'PAUSED', via: 'LISTING', held: null } }), COORD)).toBe('⏸ —')
  })
  it('Buffer: the number on Follow, — on Pinned / FBA / closed', () => {
    expect(matrixCellText('syncBuffer', cells({ sync: { buffer: 3 } }), COORD)).toBe('3')
    expect(matrixCellText('syncBuffer', cells({ sync: { buffer: 0 } }), COORD)).toBe('0')
    expect(matrixCellText('syncBuffer', STATE_FIXTURES.pinned.c, COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('syncBuffer', STATE_FIXTURES['amazon-managed'].c, COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('syncBuffer', STATE_FIXTURES['offer-closed'].c, COORD)).toBe(MATRIX_DASH)
  })
  it('Sync: Sent <ago> · Queued · Sending · Failed · Dead · Paused · policy/listing · Never', () => {
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-sent'].c, COORD, undefined, NOW)).toBe('Sent 2 min')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-queued'].c, COORD)).toBe('Queued')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-sending'].c, COORD)).toBe('Sending')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-failed'].c, COORD)).toBe('Failed')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-dead'].c, COORD)).toBe('Dead')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-paused'].c, COORD)).toBe('Paused · policy')
    expect(matrixCellText('syncState', cells({ queue: { state: 'paused', via: 'LISTING' } }), COORD)).toBe('Paused · listing')
    expect(matrixCellText('syncState', STATE_FIXTURES['queue-never'].c, COORD)).toBe('Never')
  })
  it('Price and Sale are money in the COORDINATE currency — GBP prints £, never €', () => {
    expect(matrixCellText('price', STATE_FIXTURES['price-master'].c, COORD)).toBe('€105.00')
    expect(matrixCellText('price', cells({ price: { value: 80, currency: 'GBP' } }), UK)).toBe('£80.00')
    expect(matrixCellText('price', cells({ price: { value: 80, currency: '' } }), UK)).toBe('£80.00')
    expect(matrixCellText('price', cells({ price: { value: null } }), COORD)).toBe(MATRIX_DASH)
    expect(matrixCellText('salePrice', STATE_FIXTURES['sale-set'].c, COORD)).toBe('€89.00 · 12 Sep → 30 Sep')
    expect(matrixCellText('salePrice', cells({ sale: { value: 89 } }), COORD)).toBe('€89.00')
    expect(matrixCellText('salePrice', STATE_FIXTURES['sale-none'].c, COORD)).toBe(MATRIX_DASH)
    /* `XXX` is a VALID ISO code ("no currency", prints ¤) — the fallback arm needs an INVALID one. */
    expect(matrixMoney(12, 'EURO')).toBe('EURO 12.00')
    expect(matrixMoney(12, 'XXX')).toBe('¤12.00')
    expect(matrixMoney(NaN, 'EUR')).toBe(MATRIX_DASH)
  })
  it('an absent cell has EMPTY text (a filter must not match the dash)', () => {
    for (const k of MATRIX_CELL_KINDS) expect(matrixCellText(k, null, COORD)).toBe('')
  })
})

/* ── tone: READ, never chosen ───────────────────────────────────────────────────────────── */

describe('matrixCellTone — every painted tone is readinessMeta’s / projectionMeta’s', () => {
  it('delegates every non-null tone to its declared source (counted)', () => {
    let delegated = 0
    let unpainted = 0
    for (const state of STATES) {
      const { kind, c } = STATE_FIXTURES[state]
      const tone = matrixCellTone(kind, c, COORD)
      const from = matrixCellToneFrom(kind, c)
      if (tone === null) { expect(from).toBeNull(); unpainted++; continue }
      expect(from).not.toBeNull()
      const [vocab, name] = (from as string).split(':') as ['row' | 'scope', string]
      expect(tone).toBe(vocab === 'row' ? readinessMeta(name as 'ready', 'row').tone : readinessMeta(name as 'ready', 'scope').tone)
      delegated++
    }
    expect(delegated + unpainted).toBe(STATES.length)
    expect(delegated).toBeGreaterThan(15)
  })
  it('the four Matrix listing words read the tones §3.4 names', () => {
    expect(matrixCellToneFrom('listing', STATE_FIXTURES.suppressed.c)).toBe('row:errors')
    expect(matrixCellToneFrom('listing', STATE_FIXTURES.error.c)).toBe('row:errors')
    expect(matrixCellToneFrom('listing', STATE_FIXTURES.closed.c)).toBe('row:unlisted')
    expect(matrixCellToneFrom('listing', STATE_FIXTURES.ended.c)).toBe('row:unlisted')
    expect(matrixCellTone('listing', STATE_FIXTURES.excluded.c, COORD)).toBeNull()
  })
  it('errors for oversold / failed / dead / guard; missing for uncounted / clamped / reported; live for sent', () => {
    for (const s of ['oversold', 'queue-failed', 'queue-dead', 'fulfilment-guard-differs'] as const) expect(matrixCellToneFrom(STATE_FIXTURES[s].kind, STATE_FIXTURES[s].c)).toBe('row:errors')
    for (const s of ['uncounted', 'price-clamped', 'fulfilment-reported-differs'] as const) expect(matrixCellToneFrom(STATE_FIXTURES[s].kind, STATE_FIXTURES[s].c)).toBe('row:missing')
    expect(matrixCellToneFrom('syncState', STATE_FIXTURES['queue-sent'].c)).toBe('row:live')
    for (const s of ['follow', 'pinned', 'price-master', 'price-override', 'sale-set', 'fulfilment-set'] as const) expect(matrixCellTone(STATE_FIXTURES[s].kind, STATE_FIXTURES[s].c, COORD)).toBeNull()
  })
})

/* ── classes: precedence, and only the five ─────────────────────────────────────────────── */

describe('matrixCellClasses — one tint per cell, in §3.4 precedence', () => {
  it('emits only members of MATRIX_CELL_CLASSES, at most one, for every state × kind', () => {
    let arms = 0
    for (const state of STATES) for (const kind of MATRIX_CELL_KINDS) {
      const out = matrixCellClasses(kind, STATE_FIXTURES[state].c, COORD)
      expect(out.length).toBeLessThanOrEqual(1)
      for (const cls of out) expect(MATRIX_CELL_CLASSES).toContain(cls)
      arms++
    }
    expect(arms).toBe(STATES.length * MATRIX_CELL_KINDS.length)
  })
  it('paused cells wear ONLY nds-cell-is-paused on Mode · Qty · Buffer · Sync — never inherited too', () => {
    for (const kind of ['syncMode', 'syncQty', 'syncBuffer', 'syncState'] as const) {
      expect(matrixCellClasses(kind, STATE_FIXTURES['paused-policy'].c, COORD)).toEqual(['nds-cell-is-paused'])
      expect(matrixCellClasses(kind, STATE_FIXTURES['paused-listing'].c, COORD)).toEqual(['nds-cell-is-paused'])
    }
    expect(matrixCellClasses('syncState', STATE_FIXTURES['queue-paused'].c, COORD)).toEqual(['nds-cell-is-paused'])
  })
  it('FBA and closed rows are locked; a follow is inherited; a pin / override / formula is pinned', () => {
    expect(matrixCellClasses('syncQty', STATE_FIXTURES['amazon-managed'].c, COORD)).toEqual(['nds-cell-is-locked'])
    expect(matrixCellClasses('syncMode', STATE_FIXTURES['offer-closed'].c, COORD)).toEqual(['nds-cell-is-locked'])
    expect(matrixCellClasses('syncQty', STATE_FIXTURES.follow.c, COORD)).toEqual(['nds-cell-is-inherited'])
    expect(matrixCellClasses('syncMode', STATE_FIXTURES.pinned.c, COORD)).toEqual(['nds-cell-is-pinned'])
    expect(matrixCellClasses('price', STATE_FIXTURES['price-master'].c, COORD)).toEqual(['nds-cell-is-inherited'])
    expect(matrixCellClasses('price', STATE_FIXTURES['price-override'].c, COORD)).toEqual(['nds-cell-is-pinned'])
    /* A formula-owned price is `writable: false` on the wire → locked beats the pinned tint. */
    expect(matrixCellClasses('price', STATE_FIXTURES['price-formula'].c, COORD)).toEqual(['nds-cell-is-locked'])
    expect(matrixCellClasses('price', cells({ price: { source: 'formula', formula: '= $x' } }), COORD)).toEqual(['nds-cell-is-pinned'])
  })
  it('a failed or dead queue paints refused on the Sync cell only', () => {
    expect(matrixCellClasses('syncState', STATE_FIXTURES['queue-failed'].c, COORD)).toEqual(['nds-cell-is-refused'])
    expect(matrixCellClasses('syncState', STATE_FIXTURES['queue-dead'].c, COORD)).toEqual(['nds-cell-is-refused'])
    expect(matrixCellClasses('syncQty', STATE_FIXTURES['queue-dead'].c, COORD)).toEqual(['nds-cell-is-inherited'])
  })
  it('a non-writable cell is locked, except the two fact columns and an absent cell', () => {
    const parent = cells({ writable: { syncQty: false }, writeBlockedReason: { syncQty: 'Set on the variants' } })
    expect(matrixCellClasses('syncQty', parent, COORD)).toEqual(['nds-cell-is-locked'])
    /* Positive control: the same cell with the flag back on is inherited, not locked. */
    expect(matrixCellClasses('syncQty', cells({ writable: { syncQty: true } }), COORD)).toEqual(['nds-cell-is-inherited'])
    expect(matrixCellClasses('listing', cells({ writable: {} }), COORD)).toEqual([])
    expect(matrixCellClasses('syncState', cells({ writable: {} }), COORD)).toEqual([])
    expect(matrixCellClasses('syncQty', null, COORD)).toEqual(['nds-cell-is-locked'])
  })
})

/* ── tooltips: Appendix A sentences through the copy table ──────────────────────────────── */

describe('matrixCellTooltip — Appendix A through MATRIX_COPY, plus the blocked reason', () => {
  it('Follow · Pinned · Paused · Amazon-managed · Uncounted · Closed', () => {
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES.follow.c, COORD)).toBe('Follows the pool · 403 available at IT-MAIN − 0 buffer')
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES.pinned.c, COORD)).toBe('Pinned at 10')
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES['paused-policy'].c, COORD)).toBe('Paused by the channel policy — would push 7 · Resume to push')
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES['paused-listing'].c, COORD)).toBe('Paused by this listing — would push 7 · Resume to push')
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES['amazon-managed'].c, COORD)).toBe('Amazon-managed · 49 at Amazon')
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES.uncounted.c, COORD)).toBe(MATRIX_CELL_COPY.uncountedHint)
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES['offer-closed'].c, COORD)).toBe(MATRIX_CELL_COPY.closedHint)
    expect(matrixCellTooltip('syncQty', STATE_FIXTURES.oversold.c, COORD)).toContain(MATRIX_OVERSOLD_SENTENCE)
  })
  it('the EU region sentence rides on the inventory kinds of a region coordinate and nowhere else', () => {
    const eu = MATRIX_CELL_COPY.sharedEu(['IT', 'DE'])
    for (const kind of ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer'] as const) expect(matrixCellTooltip(kind, cells(), EU)).toContain(eu)
    expect(matrixCellTooltip('price', cells(), EU)).not.toContain(eu)
    expect(matrixCellTooltip('syncQty', cells(), COORD)).not.toContain(eu)
  })
  it('Price: Set here · Follows the base price · Formula · Clamped · the sale line', () => {
    expect(matrixCellTooltip('price', STATE_FIXTURES['price-master'].c, COORD)).toBe('Follows the base price €105.00')
    expect(matrixCellTooltip('price', STATE_FIXTURES['price-override'].c, COORD)).toBe('Set here')
    expect(matrixCellTooltip('price', STATE_FIXTURES['price-formula'].c, COORD)).toBe('Formula = $basePrice * 0.95 · A formula owns this cell — edit the formula')
    expect(matrixCellTooltip('price', STATE_FIXTURES['price-clamped'].c, COORD)).toBe('Set here · Clamped to the floor')
    expect(matrixCellTooltip('price', STATE_FIXTURES['sale-set'].c, COORD)).toBe('Follows the base price €105.00 · Sale €89.00 until 30 Sep')
  })
  it('Fulfilment: the guard and the report sentences, and the Seller Central clause', () => {
    const t = matrixCellTooltip('fulfilment', cells({ fulfilment: { method: 'FBM', guard: 'FBA', reported: 'AFN' } }), COORD)!
    expect(t).toContain(MATRIX_CELL_COPY.guardFba)
    expect(t).toContain(MATRIX_CELL_COPY.reported('AFN'))
    expect(t).toContain('Seller Central')
  })
  it('Sync: the word, the lane and the server’s reason; Listing: the hint, the id, the detail', () => {
    expect(matrixCellTooltip('syncState', STATE_FIXTURES['queue-failed'].c, COORD)).toBe('Failed · Quantity queue · eBay: 25002 — the item is not active on this site')
    expect(matrixCellTooltip('listing', cells({ listing: { detail: 'not buyable' } }), COORD)).toBe(`${projectionMeta('listed').hint} · B0F7J163XJ · not buyable`)
  })
  it('a blocked reason is appended for a held cell; nothing is invented for an absent one', () => {
    const parent = cells({ writable: { syncQty: false }, writeBlockedReason: { syncQty: 'Set on the variants — the parent has no listing of its own' } })
    expect(matrixCellTooltip('syncQty', parent, COORD)).toBe('Follows the pool · 403 available at IT-MAIN − 0 buffer · Set on the variants — the parent has no listing of its own')
    expect(matrixCellTooltip('syncQty', null, COORD)).toBeNull()
    expect(matrixCellTooltip('salePrice', STATE_FIXTURES['sale-none'].c, COORD)).toBeNull()
  })
})

/* ── editability, values, fills ─────────────────────────────────────────────────────────── */

describe('editability, the fill-safe value and the default mutation', () => {
  it('facts are never editable and say why; a writable cell is; a held one carries the wire’s sentence', () => {
    expect(matrixCellEditable('listing', cells())).toEqual({ editable: false, reason: expect.stringContaining('tick') })
    expect(matrixCellEditable('syncState', cells())).toEqual({ editable: false, reason: expect.stringContaining('fact') })
    expect(matrixCellEditable('syncQty', cells())).toEqual({ editable: true, reason: null })
    expect(matrixCellEditable('fulfilment', cells())).toEqual({ editable: true, reason: null })
    expect(matrixCellEditable('syncQty', cells({ writable: { syncQty: false }, writeBlockedReason: { syncQty: 'Amazon-managed' } }))).toEqual({ editable: false, reason: 'Amazon-managed' })
    /* `writable: undefined` is false with a sentence, never true. */
    expect(matrixCellEditable('syncBuffer', cells({ writable: {} })).editable).toBe(false)
    expect(matrixCellEditable('syncQty', null)).toEqual({ editable: false, reason: 'No listing on this coordinate' })
  })
  it('the value is a scalar for the fillable kinds, the compound for the sale, null for the facts', () => {
    expect(matrixCellValue('syncQty', STATE_FIXTURES.follow.c)).toBe(403)
    /* `intended`, NOT `held`: a paused row’s value is null, so a fill cannot stamp a stale channel number. */
    expect(matrixCellValue('syncQty', STATE_FIXTURES['paused-listing'].c)).toBeNull()
    expect(matrixCellValue('syncBuffer', cells({ sync: { buffer: 2 } }))).toBe(2)
    expect(matrixCellValue('syncMode', STATE_FIXTURES.pinned.c)).toBe('PINNED')
    expect(matrixCellValue('fulfilment', cells())).toBe('FBM')
    expect(matrixCellValue('price', cells())).toBe(105)
    expect(isSaleEditorValue(matrixCellValue('salePrice', STATE_FIXTURES['sale-set'].c))).toBe(true)
    expect(matrixCellValue('listing', cells())).toBeNull()
    expect(matrixCellValue('syncState', cells())).toBeNull()
    expect(matrixCellValue('price', null)).toBeNull()
  })
  it('the fill handle is allowed on exactly price · syncQty · syncBuffer · syncMode', () => {
    expect([...MATRIX_FILLABLE_KINDS].sort()).toEqual(['price', 'syncBuffer', 'syncMode', 'syncQty'])
    for (const k of MATRIX_CELL_KINDS) expect(matrixFillAllowed(k)).toBe(MATRIX_FILLABLE_KINDS.includes(k))
    expect(matrixFillAllowed('fulfilment')).toBe(false)
    expect(matrixFillAllowed('salePrice')).toBe(false)
  })
  it('coercion: numbers and numeric strings pass, junk and negatives refuse, a sale compound is normalised', () => {
    expect(matrixCoerceValue('syncQty', 5)).toBe(5)
    expect(matrixCoerceValue('syncQty', '5')).toBe(5)
    expect(matrixCoerceValue('syncQty', 5.5)).toBeUndefined()
    expect(matrixCoerceValue('syncQty', -1)).toBeUndefined()
    expect(matrixCoerceValue('syncQty', '')).toBeUndefined()
    expect(matrixCoerceValue('price', '99.75')).toBe(99.75)
    expect(matrixCoerceValue('price', 'abc')).toBeUndefined()
    expect(matrixCoerceValue('syncMode', 'PINNED')).toBe('PINNED')
    expect(matrixCoerceValue('syncMode', 'Pinned')).toBeUndefined()
    expect(matrixCoerceValue('fulfilment', 'MCF')).toBe('MCF')
    expect(matrixCoerceValue('salePrice', null)).toEqual({ value: null, start: null, end: null })
    expect(matrixCoerceValue('salePrice', { value: '89', start: '', end: '2026-09-30' })).toEqual({ value: 89, start: null, end: '2026-09-30' })
    expect(matrixCoerceValue('salePrice', { value: -1, start: null, end: null })).toBeUndefined()
    expect(matrixCoerceValue('salePrice', 89)).toBeUndefined()
    expect(matrixCoerceValue('listing', 'listed')).toBeUndefined()
  })
  it('the default mutation moves the VALUE only — a typed number on a Follow cell leaves mode and kind alone', () => {
    const c = cells()
    expect(matrixApplyValue(c, 'syncQty', 10)).toBe(true)
    expect(c.sync!.intended).toBe(10)
    expect(c.sync!.mode).toBe('FOLLOW')
    expect(c.sync!.kind).toBe('FOLLOW')
    expect(matrixCellClasses('syncQty', c, COORD)).toEqual(['nds-cell-is-inherited'])
    expect(matrixApplyValue(c, 'syncBuffer', '3')).toBe(true)
    expect(c.sync!.buffer).toBe(3)
    expect(matrixApplyValue(c, 'syncMode', 'PINNED')).toBe(true)
    expect(c.sync!.mode).toBe('PINNED')
    expect(matrixApplyValue(c, 'price', 99)).toBe(true)
    expect(c.price!.value).toBe(99)
    expect(c.price!.source).toBe('master')
    const before = c.sale
    expect(matrixApplyValue(c, 'salePrice', { value: 89, start: '2026-09-12', end: null })).toBe(true)
    expect(c.sale).toEqual({ value: 89, start: '2026-09-12', end: null })
    expect(c.sale).not.toBe(before) // replaced, not mutated in place — the event must see two references
  })
  it('the default mutation REFUSES junk, facts, fulfilment and an absent cell (negative controls)', () => {
    const c = cells()
    expect(matrixApplyValue(c, 'syncQty', 'abc')).toBe(false)
    expect(c.sync!.intended).toBe(403)
    expect(matrixApplyValue(c, 'fulfilment', 'FBA')).toBe(false)
    expect(c.fulfilment!.method).toBe('FBM')
    expect(matrixApplyValue(c, 'listing', 'draft')).toBe(false)
    expect(matrixApplyValue(c, 'syncState', 'sent')).toBe(false)
    expect(matrixApplyValue(null, 'syncQty', 1)).toBe(false)
    expect(matrixApplyValue(cells({ sync: null }), 'syncQty', 1)).toBe(false)
  })
  it('sorting: numbers as numbers with null LAST ascending, sales by price, words by text', () => {
    expect(matrixCompare('syncQty', 3, 10)).toBeLessThan(0)
    expect(matrixCompare('syncQty', null, 0)).toBeGreaterThan(0)
    expect(matrixCompare('syncQty', 0, null)).toBeLessThan(0)
    expect(matrixCompare('salePrice', { value: 5, start: null, end: null }, { value: 9, start: null, end: null })).toBeLessThan(0)
    expect(matrixCompare('syncMode', 'FOLLOW', 'PINNED')).toBeLessThan(0)
    expect(matrixCompare('syncMode', null, 'PINNED')).toBeGreaterThan(0)
  })
})

/* ── the renderers: the markup a cell emits ─────────────────────────────────────────────── */

const paramsFor = (kind: MatrixCellKind, c: MatrixCells | null, coord: MatrixCoordinate = COORD, extra: Partial<MatrixCellParams> = {}) =>
  ({ kind, coordinate: coord, facts: () => c, value: matrixCellValue(kind, c), now: () => NOW, ...extra }) as unknown as ICellRendererParams & MatrixCellParams
const html = (kind: MatrixCellKind, c: MatrixCells | null, coord: MatrixCoordinate = COORD, extra: Partial<MatrixCellParams> = {}) =>
  renderToStaticMarkup(createElement(MATRIX_CELL_RENDERERS[kind], paramsFor(kind, c, coord, extra)))

describe('the eight renderers draw what the rules decided', () => {
  it('Listing is ProjectionCell with the tick ABSENT: the word, the dot tone, the mono id — and no checkbox', () => {
    const h = html('listing', STATE_FIXTURES.suppressed.c)
    expect(h).toContain('nds-projcell')
    expect(h).toContain('>Suppressed<')
    expect(h).toContain(`data-tone="${readinessMeta('errors', 'row').tone}"`)
    expect(h).toContain('B0F7J163XJ')
    expect(h).not.toContain('type="checkbox"')
    expect(html('listing', STATE_FIXTURES.excluded.c)).toContain('muted')
    expect(html('listing', cells({ listing: null }))).toBe('')
  })
  it('Fulfilment: the method, 🔗/✎ by source, ⚠ on the guard, ⇄ on the report, a chevron when writable', () => {
    expect(html('fulfilment', STATE_FIXTURES['fulfilment-set'].c)).toMatch(/>FBM<.*nds-cell-prov-pinned.*nds-ag-chev/s)
    expect(html('fulfilment', STATE_FIXTURES['fulfilment-derived'].c)).toContain('nds-cell-prov-inherited')
    expect(html('fulfilment', STATE_FIXTURES['fulfilment-guard-differs'].c)).toContain('nds-matrix-warn')
    expect(html('fulfilment', STATE_FIXTURES['fulfilment-reported-differs'].c)).toContain('nds-matrix-reported')
    expect(html('fulfilment', cells({ fulfilment: { method: 'FBM', guard: 'FBA', reported: 'AFN' } }))).toMatch(/nds-matrix-warn.*nds-matrix-reported/s)
    expect(html('fulfilment', cells({ writable: { fulfilment: false } }))).not.toContain('nds-ag-chev')
    expect(html('fulfilment', cells({ fulfilment: null }))).toContain(MATRIX_DASH)
  })
  it('Mode: Follow 🔗 · Pinned ✎ · — on FBA · the ⏸ (lever on its title) and NO provenance mark when paused', () => {
    expect(html('syncMode', STATE_FIXTURES.follow.c)).toMatch(/>Follow<.*nds-cell-prov-inherited/s)
    expect(html('syncMode', STATE_FIXTURES.pinned.c)).toMatch(/>Pinned<.*nds-cell-prov-pinned/s)
    const paused = html('syncMode', STATE_FIXTURES['paused-listing'].c)
    expect(paused).toContain('nds-matrix-pause')
    expect(paused).toContain('title="Paused by this listing"')
    expect(paused).not.toContain('nds-cell-prov-')
    expect(paused).toContain('nds-ag-chev')
    expect(html('syncMode', STATE_FIXTURES['paused-policy'].c)).toContain('title="Paused by the channel policy"')
    const fba = html('syncMode', STATE_FIXTURES['amazon-managed'].c)
    expect(fba).toContain(MATRIX_DASH)
    expect(fba).not.toContain('nds-cell-prov')
  })
  it('Qty: muted 🔗 number on Follow · ✎ on Pinned · ⏸ n paused · — FBA · Uncounted as a warning WORD · oversold ⚠', () => {
    expect(html('syncQty', STATE_FIXTURES.follow.c)).toMatch(/nds-cell-muted.*>403<.*nds-cell-prov-inherited/s)
    expect(html('syncQty', STATE_FIXTURES.follow.c)).toContain('data-matrix-version="3"')
    expect(html('syncQty', STATE_FIXTURES.pinned.c)).toMatch(/>10<.*nds-cell-prov-pinned/s)
    expect(html('syncQty', STATE_FIXTURES['paused-listing'].c)).toContain('⏸ 7')
    expect(html('syncQty', STATE_FIXTURES['amazon-managed'].c)).toContain(MATRIX_DASH)
    expect(html('syncQty', STATE_FIXTURES.uncounted.c)).toMatch(/nds-matrix-word-warn.*Uncounted/s)
    expect(html('syncQty', STATE_FIXTURES.uncounted.c)).not.toContain('nds-matrix-warn"')
    expect(html('syncQty', STATE_FIXTURES.oversold.c)).toMatch(/nds-matrix-warn/)
    expect(html('syncQty', STATE_FIXTURES.oversold.c)).toContain(MATRIX_OVERSOLD_SENTENCE)
  })
  it('Buffer: the number, muted dash on Pinned', () => {
    expect(html('syncBuffer', cells({ sync: { buffer: 3 } }))).toContain('>3<')
    expect(html('syncBuffer', STATE_FIXTURES.pinned.c)).toMatch(/nds-cell-muted.*—/s)
  })
  it('Sync is a button: Appendix A’s word on the aria-label, §3.4’s glyph + short word on screen, the tone on the glyph', () => {
    const sent = html('syncState', STATE_FIXTURES['queue-sent'].c)
    expect(sent).toContain('<button type="button" class="nds-matrix-syncbtn"')
    expect(sent).toContain('aria-label="Sent 2 min — open Needs attention for this listing"')
    expect(sent).toContain(`data-tone="${readinessMeta('live', 'row').tone}"`)
    expect(sent).not.toContain('nds-projcell-dot')
    expect(sent).toMatch(/✓<\/span><span class="nds-cell-value-text">2 min</)
    expect(html('syncState', STATE_FIXTURES['queue-failed'].c)).toMatch(/✗.*>Failed</s)
    expect(html('syncState', STATE_FIXTURES['queue-dead'].c)).toMatch(/✗.*>Dead</s)
    expect(html('syncState', STATE_FIXTURES['queue-paused'].c)).toMatch(/⏸.*>policy</s)
    expect(html('syncState', cells({ queue: { state: 'paused', via: 'LISTING' } }))).toMatch(/⏸.*>listing</s)
    const never = html('syncState', STATE_FIXTURES['queue-never'].c)
    expect(never).toContain('aria-label="Never — open Needs attention for this listing"')
    expect(never).toMatch(/>—<\/span><\/button>/) // the dash alone on screen, no word span
    expect(html('syncState', STATE_FIXTURES['queue-queued'].c)).not.toContain('nds-matrix-syncglyph')
    expect(html('syncState', STATE_FIXTURES['queue-queued'].c)).toContain('>Queued<')
  })
  it('matrixQueueGlyph is §3.4’s at-rest form and fails closed on an unknown queue state', () => {
    expect(matrixQueueGlyph(STATE_FIXTURES['queue-sent'].c, NOW)).toEqual({ glyph: '✓', word: '2 min' })
    expect(matrixQueueGlyph(STATE_FIXTURES['queue-paused'].c)).toEqual({ glyph: '⏸', word: 'policy' })
    expect(matrixQueueGlyph(STATE_FIXTURES['queue-never'].c)).toEqual({ glyph: '—', word: '' })
    expect(matrixQueueGlyph(cells({ queue: null }))).toBeNull()
    const junk = cells({ queue: { state: 'exploded' as never } })
    expect(matrixQueueGlyph(junk)).toBeNull()
    expect(matrixCellState('syncState', junk)).toBe('absent')
  })
  it('Price: money with 🔗 / ✎ / ƒ by source and ⚠ when clamped; £ on a GBP coordinate', () => {
    expect(html('price', STATE_FIXTURES['price-master'].c)).toMatch(/€105\.00.*nds-cell-prov-inherited/s)
    expect(html('price', STATE_FIXTURES['price-override'].c)).toMatch(/€99\.00.*nds-cell-prov-pinned/s)
    expect(html('price', STATE_FIXTURES['price-formula'].c)).toMatch(/€99\.75.*nds-cell-prov-formula/s)
    expect(html('price', STATE_FIXTURES['price-clamped'].c)).toContain('nds-matrix-warn')
    expect(html('price', cells({ price: { value: 80, currency: 'GBP' } }), UK)).toContain('£80.00')
  })
  it('Sale: the compound text, or a muted dash', () => {
    expect(html('salePrice', STATE_FIXTURES['sale-set'].c)).toContain('€89.00 · 12 Sep → 30 Sep')
    expect(html('salePrice', STATE_FIXTURES['sale-none'].c)).toMatch(/nds-cell-muted.*—/s)
  })
  it('every renderer renders NOTHING for an absent cell (the honest-absence rule)', () => {
    let arms = 0
    for (const kind of MATRIX_CELL_KINDS) { expect(html(kind, null)).toBe(''); arms++ }
    expect(arms).toBe(8)
  })
})
