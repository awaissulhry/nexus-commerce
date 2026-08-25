/**
 * SCT.1/SCT.2 — every control on Sync Control must explain itself, and the
 * page-size ladder must reach 500.
 *
 * These buttons move live marketplace quantity (Zero & Pin makes a listing
 * unbuyable in seconds), so an unlabelled one is a real hazard, not a polish
 * gap. The static assertions are a ratchet: adding a bulk action without help
 * text, or rendering it outside a <Tip>, fails here instead of on the page.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTION_HELP, COLUMN_HELP, CONTROL_HELP, MODE_HELP, MODE_LABEL, PAGE_SIZES } from './sync-control-shared'

// Resolved from THIS file, not cwd: the suite runs from the repo root and from
// apps/web, and a cwd-relative path silently fails in one of them.
const DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(DIR, '../../../../../../..')
const read = (rel: string) => readFileSync(join(DIR, rel), 'utf8')
const readApi = () => readFileSync(join(REPO, 'apps/api/src/routes/sync-control.routes.ts'), 'utf8')

const SURFACES = [
  'SyncControlClient.tsx',
  'SyncProductsGrid.tsx',
  'product/[masterId]/ProductDetailClient.tsx',
]
const ACTIONS = ['FOLLOW', 'PIN', 'PAUSE', 'RESUME', 'ZERO_PIN', 'EXCLUDE', 'INCLUDE', 'BUFFER', 'CLOSE_OFFER', 'REOPEN_OFFER']

describe('SCT.1 — action help', () => {
  it('covers every bulk action on every surface', () => {
    for (const a of ACTIONS) {
      expect(ACTION_HELP[a], `ACTION_HELP.${a} missing`).toBeTruthy()
      // "Very detailed": a one-liner is not enough for something that writes live qty.
      expect(ACTION_HELP[a].length, `ACTION_HELP.${a} too terse`).toBeGreaterThan(120)
    }
  })

  it('tells the operator how to undo the destructive ones', () => {
    expect(ACTION_HELP.ZERO_PIN).toMatch(/Set Follow/)
    expect(ACTION_HELP.PIN).toMatch(/Set Follow/)
    expect(ACTION_HELP.PAUSE).toMatch(/Resume/)
  })

  it('Close offer states the reviews/ASIN/other-markets safety + FBA refusal (SCT.6)', () => {
    expect(ACTION_HELP.CLOSE_OFFER).toMatch(/reviews/i)
    expect(ACTION_HELP.CLOSE_OFFER).toMatch(/FBA/)
    expect(ACTION_HELP.CLOSE_OFFER).toMatch(/Reopen offer/)
    expect(ACTION_HELP.REOPEN_OFFER).toMatch(/Follow/)
  })

  it('states what Zero & Pin does NOT touch, so it is not mistaken for a delist', () => {
    expect(ACTION_HELP.ZERO_PIN).toMatch(/does not delist/i)
    expect(ACTION_HELP.ZERO_PIN).toMatch(/warehouse stock/i)
  })

  it('says FBA is never written where that is the surprising part', () => {
    expect(ACTION_HELP.FOLLOW).toMatch(/FBA/)
    expect(CONTROL_HELP.selectAll).toMatch(/FBA/)
  })

  it('scopes the shared-lane actions to shared eBay rows', () => {
    expect(ACTION_HELP.EXCLUDE).toMatch(/shared/i)
    expect(ACTION_HELP.INCLUDE).toMatch(/shared/i)
  })

  it('renders every bulk-action button inside a <Tip>', () => {
    for (const f of SURFACES) {
      const src = read(f)
      expect(src, `${f}: bulk actions not wrapped`).toMatch(/<Tip[^>]*help=\{[^}]*ACTION_HELP/)
      // a Button rendered by the bulk-action map must be inside the Tip
      const bare = /\{BULK_ACTIONS\.map\(\(\[a, label\]\) => <Button/.test(src)
      expect(bare, `${f}: BULK_ACTIONS maps straight to a bare <Button>`).toBe(false)
    }
  })
})

describe('SCT.1 — control + column help', () => {
  it('explains every mode chip', () => {
    for (const m of Object.keys(MODE_LABEL)) {
      expect(MODE_HELP[m as keyof typeof MODE_HELP], `MODE_HELP.${m} missing`).toBeTruthy()
    }
  })

  it('explains every column referenced by a header', () => {
    const keys = ['product', 'scope', 'sync', 'intended', 'live', 'stock', 'drift', 'buffer',
      'sku', 'variant', 'channel', 'market', 'lane', 'mode', 'routedFrom']
    for (const k of keys) expect(COLUMN_HELP[k], `COLUMN_HELP.${k} missing`).toBeTruthy()
  })

  it('explains every toolbar, filter, Excel, policy and route control', () => {
    const keys = ['bufferInput', 'bufferApply', 'clearSelection', 'clearFilters', 'searchRows',
      'searchProducts', 'density', 'pageSize', 'pagination', 'viewToggle', 'selectAll',
      'filterChannel', 'filterMarket', 'filterMode', 'filterLane', 'filterFamily', 'driftOnly',
      'exportXlsx', 'importXlsx', 'importApply', 'importCancel', 'importClose',
      'expandRow', 'openProductTab', 'openFamilyTab', 'openAllListings',
      'showAllRows', 'showFewerRows', 'productLink', 'historyLink', 'backToFamilies',
      'policyPause', 'policyResume', 'policyNewDefault', 'policyChannelSelect',
      'policyMarketSelect', 'policyAddPause', 'policyAddBornPaused',
      'routeEdit', 'routeSave', 'routeCancel', 'routeInput']
    for (const k of keys) {
      expect(CONTROL_HELP[k], `CONTROL_HELP.${k} missing`).toBeTruthy()
      expect(CONTROL_HELP[k].length, `CONTROL_HELP.${k} too terse`).toBeGreaterThan(30)
    }
  })

  it('warns that a policy pause is a whole channel/market kill-switch', () => {
    expect(CONTROL_HELP.policyPause).toMatch(/kill-switch/i)
    expect(CONTROL_HELP.policyPause).toMatch(/nothing is delisted/i)
  })

  it('wires Export/Import help in the Excel bar', () => {
    const src = read('SyncExcelBar.tsx')
    expect(src).toMatch(/CONTROL_HELP\.exportXlsx/)
    expect(src).toMatch(/CONTROL_HELP\.importXlsx/)
    expect(src).toMatch(/CONTROL_HELP\.importApply/)
  })
})

describe('SCT.2 — page sizes', () => {
  it('offers 500 per page so a bulk edit needs one Select all, not ten pages', () => {
    expect(PAGE_SIZES).toContain(500)
  })

  it('is ascending and starts small enough to stay fast', () => {
    expect([...PAGE_SIZES]).toEqual([...PAGE_SIZES].sort((a, b) => a - b))
    expect(PAGE_SIZES[0]).toBeLessThanOrEqual(50)
  })

  it('is the single source of truth — no surface hard-codes its own ladder', () => {
    for (const f of SURFACES) {
      const src = read(f)
      expect(src, `${f} still hard-codes page sizes`).not.toMatch(/\[(25|50), 100, 200\]\.map/)
      expect(src, `${f} does not use PAGE_SIZES`).toMatch(/PAGE_SIZES\.map/)
    }
  })

  it('is inside the API clamp, so the biggest page is not silently truncated', () => {
    const api = readApi()
    const clamps = [...api.matchAll(/Math\.min\((\d+), Math\.max\(10, Number\.parseInt\(q\.pageSize/g)]
    expect(clamps.length, 'pageSize clamps not found').toBeGreaterThan(0)
    for (const c of clamps) {
      expect(Number(c[1]), 'a pageSize clamp is below the largest offered page').toBeGreaterThanOrEqual(
        Math.max(...PAGE_SIZES),
      )
    }
  })

  it('beats the DS card rule on specificity, not on stylesheet order', () => {
    // .sc-card-pop alone TIES .nds-gridcard, and the prod bundle loads
    // patterns.css last — the un-compounded selector shipped as a no-op.
    const css = readFileSync(join(DIR, 'styles.module.css'), 'utf8')
    expect(css).toMatch(/:global\(\.nds-gridcard\.sc-card-pop\)/)
    expect(css, 'un-compounded .sc-card-pop loses to the DS rule in prod')
      .not.toMatch(/:global\(\.sc-card-pop\)/)
  })

  it('lets a full 500-row page be acted on in one call', () => {
    const api = readApi()
    const m = api.match(/const cap = body\.masterIds\?\.length \? \d+ : (\d+)/)
    expect(m, 'target cap not found').toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(Math.max(...PAGE_SIZES))
  })
})
