/**
 * PES.3 — phase 3.7, the part that does not need a browser.
 *
 * Runs THIS LANE'S real modules over the REAL `GET /api/products/:id/studio/sheet` payload from a
 * local API, and asserts the grid would group, identify and classify it correctly. It is the
 * end-to-end data path — everything except pixels.
 *
 * SKIPS (never fails) when no local API is reachable, so it is safe in CI and for a lane that has
 * not started one. Point it with `PES3_API` (default http://localhost:8090) and `PES3_SKU`.
 * Read-only: it issues one GET and writes nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { classifyProvenance } from '@/design-system/grid/renderers/provenance'

import { cascadeIntent, cascadeOf } from './provenance'
/* 🔴 The DEEP path, never the barrel: `@/design-system/grid` re-exports `.tsx`, and this suite is
   node-only — importing the barrel here dies at PARSE before a single case runs
   (reference_test_scoping_and_hidden_assertions). `readiness.ts` is plain TS. */
import { readyPillTone } from '@/design-system/grid/renderers/readiness'
import { dataPathFor, distinctVariantCount, orderRows, summariseAlias, withRowIdentity } from './rows'
import { buildChannelChips, rowsForChip } from './viewChips'
import { aliasKeyOf, type ChannelScopePage, type ChannelSheetRow } from './types'

// Port numbers in recipes are SNAPSHOTS — the shared stack moved 8080 → 8090 → 8091 in one
// session as lanes collided. Override with PES3_API rather than editing this line.
const API = process.env.PES3_API ?? 'http://localhost:8091'
const SKU = process.env.PES3_SKU ?? 'GALE-JACKET'
const CHANNEL = process.env.PES3_CHANNEL ?? 'EBAY'

let page: ChannelScopePage | null = null
let rows: ChannelSheetRow[] = []
/** Set when the API answered at all. Distinguishes "nothing to test against" from "it is broken". */
let apiReachable = false

beforeAll(async () => {
  // 1. Is there an API here at all? Short timeout, and the ONLY condition that may skip.
  try {
    // 10s, not 3s: this ping only decides SKIP vs RUN, and a slow answer is still an answer. At
    // 3s it lost under parallel suite load and the whole live suite reported "skipped" — the exact
    // silent-skip failure this file was hardened against, coming back through a tight timeout
    // instead of a collection-time gate. Erring long costs a few seconds; erring short costs the
    // verification and looks identical to a pass.
    const ping = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(10000) })
    apiReachable = ping.ok
  } catch {
    apiReachable = false
  }
  if (!apiReachable) {
    console.warn(`[pes3 live] no API at ${API} — skipping (start one with PORT=8091 NEXUS_DISABLE_BACKGROUND_JOBS=1 npm run dev)`)
    return
  }

  /**
   * 2. From here every failure THROWS and fails the suite.
   *
   * A reachable API that then refuses the read is a defect, not an absence — and skipping it would
   * report the same tidy green as a real pass. That is the lesson this file already learned once
   * (see the skip note below); a transient `tsx watch` restart made it skip silently and look
   * identical to success.
   */
  const look = await fetch(`${API}/api/products/search?q=${encodeURIComponent(SKU)}&limit=200&sort=sku`, {
    signal: AbortSignal.timeout(20000),
  })
  if (!look.ok) throw new Error(`product lookup failed: HTTP ${look.status}`)
  // `/api/products/search` answers `{items}`; `/api/products` answers `{products}`. Reading the
  // wrong key does not throw — it silently finds nothing, which used to read as "no local API"
  // (reference_products_search_contract_traps).
  const body = (await look.json()) as {
    items?: Array<{ id: string; sku: string }>
    products?: Array<{ id: string; sku: string }>
  }
  const list = body.items ?? body.products ?? []
  const hit = list.find((p) => p.sku === SKU)
  if (!hit) throw new Error(`${SKU} not found — got [${list.map((p) => p.sku).join(', ')}]`)

  const res = await fetch(
    `${API}/api/products/${hit.id}/studio/sheet?scope=channel&channel=${encodeURIComponent(CHANNEL)}&market=IT&locale=it`,
    { signal: AbortSignal.timeout(20000) },
  )
  if (!res.ok) throw new Error(`studio sheet read failed: HTTP ${res.status} ${await res.text()}`)
  page = (await res.json()) as ChannelScopePage
  rows = orderRows(withRowIdentity(page.rows, page.aliases))
}, 60_000)

/**
 * 🔴 Skip INSIDE the test, never at collection.
 *
 * `const live = () => (page ? it : it.skip)` reads correctly and cannot ever work: the factory runs
 * while the file is being COLLECTED, when `page` is still null, so every test registers as
 * `it.skip` — and vitest then skips `beforeAll` too, because nothing in the suite will run. The
 * result is a green "8 skipped" that is structurally incapable of testing anything, which looks
 * exactly like an honest "no API here" (reference_test_scoping_and_hidden_assertions).
 */
function live(name: string, fn: (ctx: import('vitest').TestContext) => void | Promise<void>) {
  it(name, (ctx) => {
    // Only a genuinely absent API skips. If the API answered but the read failed, `beforeAll`
    // already threw and this never runs — a broken read must never report as a tidy skip.
    if (!apiReachable) return ctx.skip(`No local API is reachable at ${API}`)
    return fn(ctx)
  })
}

describe('live channel scope (skips without a local API)', () => {
  live('serves the coordinate this lane asked for', () => {
    expect(page!.scope.kind).toBe('channel')
    expect(page!.scope.channel).toBe(CHANNEL)
    expect(page!.scope.marketplace).toBe('IT')
  })

  live('sends every cell field this lane consumes', () => {
    // A missing `writeField`/`writeTarget` would make an edit land somewhere unintended, and a
    // missing `layer` would silently drop the whole cascade onto the legacy `source` fallback.
    const column = page!.columns.find(c => c.kind !== 'variationTheme')!
    const cell = rows.find((r) => r.rowKind === 'variant')?.values[column.key]
    expect(cell).toBeDefined()
    for (const k of ['value', 'source', 'inherited', 'layer', 'pinned', 'editable', 'writeField', 'writeTarget']) {
      expect(cell).toHaveProperty(k)
    }
  })

  live('gives every row a unique grid id', () => {
    const ids = rows.map((r) => r.rowId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  live('groups every row under an alias the payload actually declares', () => {
    const declared = new Set(page!.aliases.map((a) => aliasKeyOf(a.id)))
    for (const r of rows) expect(declared).toContain(aliasKeyOf(r.aliasId))
  })

  live('paths each band as a group node and each variant beneath it', () => {
    for (const r of rows) {
      const path = dataPathFor(r)
      expect(path[0]).toBe(aliasKeyOf(r.aliasId))
      expect(path).toHaveLength(r.rowKind === 'parent' ? 1 : 2)
    }
  })

  live('summarises each alias from the SERVER readiness, and counts SKUs not units', () => {
    for (const a of page!.aliases) {
      const s = summariseAlias(rows, a)
      // null survives as null — the server means "nothing to be ready against" (#129 drift scan).
      expect(s.percent).toBe(a.readiness.percent === null ? null : Math.max(0, Math.min(100, Math.round(a.readiness.percent))))
      expect(s.variantSkus).toBeLessThanOrEqual(s.variantRows)
    }
    // The cross-alias count is SKUs — it must not scale with the alias list.
    expect(distinctVariantCount(rows)).toBeLessThanOrEqual(rows.filter((r) => r.rowKind === 'variant').length)
  })

  live('classifies every real cell into a state the sheet can paint, and routes its click', () => {
    let painted = 0
    for (const r of rows) {
      for (const c of Object.values(r.values)) {
        const layer = cascadeOf(c, r.rowKind)
        expect(['aliasVariant', 'alias', 'master', 'unset']).toContain(layer)
        // Whatever the substrate says, a click must route somewhere or be deliberately inert.
        const intent = cascadeIntent(layer, r.rowKind, c.value)
        if (layer !== 'unset') expect(intent).not.toBeNull()
        /**
         * The substrate must have an opinion we can render — and the set is asserted WITH its
         * invariant, never widened bare.
         *
         * §9.6 added `mapped` / `mappedShared`, and this list omitted both. It stayed green only
         * because no cell on THIS coordinate is resolver-derived (measured: eBay·IT has none; the
         * Amazon scope carries a non-null `mapped` on 15 of 21 value entries). A widened list alone
         * would keep it green for that same reason while letting a genuine leak through — PES.4's
         * point that a bare widening is how an unintended value becomes permanent.
         *
         * So the membership check is paired with an iff: a cell reads `mapped`/`mappedShared`
         * exactly when the resolver actually derived it, and never otherwise. A leak where `own` or
         * `inherited` was meant still fails here.
         */
        const state = classifyProvenance(c, 'channel')
        expect(['own', 'inherited', 'inheritedOverride', 'pinned', 'ai', 'aiStale', 'mapped', 'mappedShared'])
          .toContain(state)
        const derived = c.mapped?.status === 'mapped' && (c.mapped.derived ?? c.mapped.provenance !== 'override')
        expect(state === 'mapped' || state === 'mappedShared').toBe(derived)
        /**
         * 🔴 The `mappedShared` half is NOT asserted here, deliberately — it cannot currently be
         * true. `classifyProvenance` reads a per-cell `cell.mappedProductLevel`
         * (`provenance.ts:100,146`) that the server **never sends**: measured on Amazon·IT, 0 of 21
         * cells carry it while `meta.mapping.productLevelOnly` is `true` and 15 cells are mapped.
         * So every cell that should read `mappedShared` reads `mapped`. Asserting the branch here
         * would encode the defect as expected behaviour; it is filed against the substrate instead
         * (PES.3-38), and this line goes in the moment a host can supply the flag.
         */
        painted++
      }
    }
    expect(painted).toBeGreaterThan(0)
  })

  live('never claims a parent row inherits from itself (ruling #33 regression)', () => {
    for (const r of rows.filter((x) => x.rowKind === 'parent')) {
      for (const c of Object.values(r.values)) {
        if (c.inherited === false) {
          expect(classifyProvenance(c, 'channel')).not.toBe('inherited')
        }
      }
    }
  })
})

describe('live view chips — the honest-count rule on real data', () => {
  live('every Amazon sheet field is available in the same category’s mapping catalogue', async (ctx) => {
    if (CHANNEL !== 'AMAZON') return ctx.skip(`Amazon catalogue parity does not apply to ${CHANNEL}`)
    const productType = rows.find((r) => r.productType)?.productType
    expect(productType).toBeTruthy()
    const res = await fetch(`${API}/api/pim/channel-mapping/AMAZON/IT/fields?productType=${encodeURIComponent(productType!)}`)
    expect(res.ok).toBe(true)
    const catalogue = await res.json() as { fields: Array<{ fieldKey: string }> }
    const keys = new Set(catalogue.fields.map((f) => f.fieldKey))
    for (const column of page!.columns) {
      const facts = column.channels?.['Amazon · IT']
      if (facts) expect(keys.has(facts.key), column.key).toBe(true)
    }
  })

  live('counts CELLS from the same readiness the grid draws, never a second source', () => {
    const chips = buildChannelChips(rows, page!.columns)
    const warn = chips.find((c) => c.id === 'channel-warnings')!
    const req = chips.find((c) => c.id === 'missing-required')!

    // Counted, so both are numbers — a null here would mean a row arrived without readiness.
    expect(warn.count).not.toBeNull()
    expect(req.count).not.toBeNull()

    // Chips count unique cells, not validation messages; missing values use completeness.
    const colIds = new Set(page!.columns.map((c) => c.key))
    const serverWarnings = rows.reduce((n, r) => n + new Set(r.readiness.issues.filter((i) => i.severity === 'warn' && colIds.has(i.key)).map((i) => i.key)).size, 0)
    const serverMissing = rows.reduce((n, r) => n + new Set(r.completeness.required.missing.filter((m) => colIds.has(m.key)).map((m) => m.key)).size, 0)
    expect(warn.count).toEqual({ n: serverWarnings, unit: 'cells' })
    expect(req.count).toEqual({ n: serverMissing, unit: 'cells' })
  })

  live('every counted cell points at a real row AND a real column', () => {
    // A chip that counts a cell the filter cannot reach is the chip lying by another route.
    const rowIds = new Set(rows.map((r) => r.rowId))
    const colIds = new Set(page!.columns.map((c) => c.key))
    for (const chip of buildChannelChips(rows, page!.columns)) {
      for (const [rowId, cols] of Object.entries(chip.cells.byRow)) {
        expect(rowIds).toContain(rowId)
        for (const c of cols) expect(colIds).toContain(c)
      }
    }
  })

  live('filtering to a chip never orphans a row from its alias band', () => {
    for (const chip of buildChannelChips(rows, page!.columns)) {
      const kept = rowsForChip(rows, chip.cells)
      const bands = new Set(kept.filter((r) => r.rowKind === 'parent').map((r) => r.aliasId ?? 'primary'))
      for (const r of kept.filter((x) => x.rowKind === 'variant')) {
        expect(bands).toContain(r.aliasId ?? 'primary')
      }
    }
  })

  live('takes the band colour from state even when the percent is 100 (ruling #43)', () => {
    // GALE on eBay·IT is genuinely 100% AND `missing` — the case a percent threshold gets wrong.
    for (const a of page!.aliases) {
      expect(readyPillTone(a.readiness.state)).toBe(
        a.readiness.state === 'ready' || a.readiness.state === 'live'
          ? 'success'
          : a.readiness.state === 'missing'
            ? 'warning'
            : a.readiness.state === 'errors'
              ? 'danger'
              : 'neutral',
      )
    }
  })
})
