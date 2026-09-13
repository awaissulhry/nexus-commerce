/**
 * VT.2c item 2b — the locked-commit path opens VT.4's dry-run plan, and writes NOTHING.
 *
 * VT.4 built the plan route and the Modal and could not verify either through the DOCK, because no
 * coordinate in this catalogue can express a SET change there. The designed opener is the SHEET
 * cell's `outcome: plan`, and until now nothing consumed it: `commitVariationTheme` carried the lock
 * sentence into the cell's result and the Modal stayed dark.
 *
 * These arms are the ones a browser cannot settle cheaply and a reading of the source cannot settle
 * at all: WHICH commits ask for a plan, and that the asking commit issues ZERO requests. The Modal's
 * rendered anatomy is measured on screen and its numbers are in `docs/pes-claims.md`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commitVariationTheme } from '../../sheet/master/masterWrite'
import { lockedSetChangeOf } from './MappingDock'
import { askForThemeChangePlan, onThemeChangePlanAsked, type ThemeChangePlanAsk } from './themePlanAsk'
import type { ProjectionDraft, ProjectionPage } from './types'
import type { SheetWriteRequest } from '@/design-system/grid'
import type { VariationThemeCell } from '@/design-system/grid/renderers/variationTheme'

const axis = (axisKey: string, familyKey: string, target: string, included = true) =>
  ({ axisKey, familyKey, label: axisKey, channelName: target, target, included })

/** An eBay·IT-shaped channel cell: live, both axes published, a reorder IS a revise. */
const ebayLive = (over: Partial<VariationThemeCell> = {}): VariationThemeCell => ({
  axes: [axis('Colore', 'Colore', 'Colore'), axis('Taglia', 'Taglia', 'Taglia')],
  theme: null,
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
  candidates: { kind: 'aspects', items: [], limit: 5, schemaFetchedAt: null, state: 'ok' },
  masterCandidates: null,
  dropped: [],
  collisions: null,
  locked: {
    reason: 'Item 257584954808 is live with Colore and Taglia. Adding or removing a specific relists it; reordering and adding values do not.',
    externalId: '257584954808',
    setChangeIs: 'relist',
    orderChangeAllowed: true,
  },
  write: { endpoint: 'projection', expectedVersion: 18, aliasKey: '', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'acc1' } },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  separator: ' · ',
  ...over,
})

/** An Amazon·IT-shaped channel cell: live, and a set change needs a NEW PARENT — never a revise. */
const amazonLive = (over: Partial<VariationThemeCell> = {}): VariationThemeCell => ({
  ...ebayLive(),
  theme: { code: 'COLOR_NAME/SIZE_NAME', label: 'Colore / Taglia', deprecated: false },
  candidates: { kind: 'theme-enum', items: [], limit: 2, schemaFetchedAt: null, state: 'ok' },
  locked: {
    reason: 'ASIN B0F7J163XJ is live on Amazon · IT with 20 children. Changing the theme needs a new parent.',
    externalId: 'B0F7J163XJ',
    setChangeIs: 'new-parent',
    orderChangeAllowed: false,
  },
  write: { endpoint: 'projection', expectedVersion: 5, aliasKey: '', coordinate: { channel: 'AMAZON', market: 'IT', accountId: 'acc1' } },
  ...over,
})

/** The reported value as the editor hands it over: the edited cell, carrying its own BASELINE. */
const reported = (before: VariationThemeCell, after: VariationThemeCell) => ({ ...after, baseline: before })

const request = (value: unknown): SheetWriteRequest<unknown> =>
  ({ rowId: 'p1', row: {}, cells: [{ colId: 'variation_theme', value }] }) as unknown as SheetWriteRequest<unknown>

let fetchMock: ReturnType<typeof vi.fn>
let asks: ThemeChangePlanAsk[]
let stop: () => void
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 19 }) })
  vi.stubGlobal('fetch', fetchMock)
  asks = []
  stop = onThemeChangePlanAsked((ask) => asks.push(ask))
})
afterEach(() => { stop(); vi.unstubAllGlobals() })

describe('VT.2c 2b — which commits open the plan, and which ones write', () => {
  it('locked AMAZON + SET change → the plan is asked for, and ZERO requests are issued', async () => {
    const before = amazonLive()
    const after = amazonLive({ theme: { code: 'COLOR_NAME', label: 'Colore', deprecated: false }, axes: [before.axes[0], { ...before.axes[1], included: false }] })
    const result = await commitVariationTheme(request(reported(before, after)), 'prod1')

    /* 🔴 The whole point: a live SET change is an operation, so nothing is sent. */
    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(asks).toHaveLength(1)
    expect(asks[0].setChangeIs).toBe('new-parent')
    expect(asks[0].reason).toBe(before.locked!.reason)
    /* The coordinate travels VERBATIM from the cell, with the product id the caller was given. */
    expect(asks[0].request.coordinate).toEqual({ productId: 'prod1', channel: 'AMAZON', market: 'IT', accountId: 'acc1', aliasKey: '' })
    expect(asks[0].request.expectedVersion).toBe(5)
    expect(asks[0].request.theme).toBe('COLOR_NAME')
    /* The mapping is the DELIVERED axes only — a dropped axis is not part of the plan's target state —
       and each key is the FAMILY's own spelling. Measured: a request carrying the canonical `color`
       answered 400 `bad_projection_request` naming `axes: ["Colore","Taglia"]`. */
    expect(asks[0].request.mapping).toEqual([{ axisKey: 'Colore', target: 'Colore', order: 0 }])
    /* And the cell is `ok` with the server's sentence: held, never painted as a failure. */
    expect(result.cells!.variation_theme).toEqual({ ok: true, reason: before.locked!.reason })
  })

  it('locked EBAY + ORDER-only change → the PATCH is sent and NO plan is asked for', async () => {
    const before = ebayLive()
    const after = ebayLive({ axes: [before.axes[1], before.axes[0]] })
    const result = await commitVariationTheme(request(reported(before, after)), 'prod1')

    expect(asks).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/studio/projection')
    expect(String(url)).toContain('channel=EBAY')
    expect(JSON.parse(String((init as { body: string }).body)).expectedVersion).toBe(18)
    expect(result.ok).toBe(true)
  })

  it('locked EBAY + a SET change (an axis re-pointed) → the plan, not the 409', async () => {
    /* VT.1b's route answers 409 `axes_locked` for this, and a 409 surfaces as a conflict. The client
       refuses it first, with the SAME rule (`variationThemeChange`'s `setChanged` counts a target
       change), which is why the dock's own gate was moved onto that function too. */
    const before = ebayLive()
    const after = ebayLive({ axes: [{ ...before.axes[0], target: 'Scollatura' }, before.axes[1]] })
    await commitVariationTheme(request(reported(before, after)), 'prod1')
    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(asks).toHaveLength(1)
    expect(asks[0].setChangeIs).toBe('relist')
  })

  it('an UNLOCKED coordinate writes, whatever moved — the discriminating arm', async () => {
    const before = ebayLive({ locked: null })
    const after = ebayLive({ locked: null, axes: [before.axes[0]] })
    await commitVariationTheme(request(reported(before, after)), 'prod1')
    expect(asks).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the FAMILY spelling in the plan mapping, never the canonical key', async () => {
    const before = ebayLive({ axes: [{ ...axis('color', 'Colore', 'Colore') }, { ...axis('size', 'Taglia', 'Taglia') }] })
    const after = { ...before, axes: [before.axes[0], { ...before.axes[1], target: 'Scollatura' }] }
    await commitVariationTheme(request(reported(before, after)), 'prod1')
    expect(asks[0].request.mapping!.map((m) => m.axisKey)).toEqual(['Colore', 'Taglia'])
    expect(asks[0].request.mapping!.map((m) => m.axisKey)).not.toContain('color')
  })

  it('an UNCHANGED editor sends nothing and asks for nothing', async () => {
    const before = ebayLive()
    await commitVariationTheme(request(reported(before, ebayLive())), 'prod1')
    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(asks).toHaveLength(0)
  })
})

describe('VT.2c 2b — the ask channel itself', () => {
  it('degrades to `false` when no host is mounted, so the reason is still the cell own', () => {
    stop()
    expect(askForThemeChangePlan({ reason: 'r', setChangeIs: 'relist', request: { coordinate: { productId: 'p', channel: 'EBAY', market: 'IT' }, expectedVersion: 1 } })).toBe(false)
    /* Re-registering is what a remount does, and the ask must reach the NEW host. */
    stop = onThemeChangePlanAsked((ask) => asks.push(ask))
    expect(askForThemeChangePlan({ reason: 'r', setChangeIs: 'relist', request: { coordinate: { productId: 'p', channel: 'EBAY', market: 'IT' }, expectedVersion: 1 } })).toBe(true)
    expect(asks).toHaveLength(1)
  })

  it('a STALE unsubscribe does not unmount the live host (React 18 remount order)', () => {
    const first = stop
    stop = onThemeChangePlanAsked((ask) => asks.push(ask))
    first()                                     // the old cleanup, running after the new mount
    expect(askForThemeChangePlan({ reason: 'r', setChangeIs: 'relist', request: { coordinate: { productId: 'p', channel: 'EBAY', market: 'IT' }, expectedVersion: 1 } })).toBe(true)
  })
})


/* ── the DOCK host of the same rule (the orchestrator's arm) ───────────────────────────────── */

/**
 * `Save mapping` on a locked coordinate must take the SAME branch the cell's `outcome: plan` takes,
 * and VT.1b's **409 `axes_locked`** must never be how an operator finds out. The dock's gate is now
 * `lockedSetChangeOf`, which is `variationThemeChange` — the cell's own rule — so these four arms and
 * the cell's four above are the same predicate seen from two hosts.
 */
const DOCK_EBAY: ProjectionPage = {
  version: 18,
  coordinate: { channel: 'EBAY', market: 'IT', accountId: 'acc1', aliasKey: '', label: 'eBay · IT' },
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  limits: { axes: 5, variants: 250, source: { axes: null, variants: null } },
  mapping: [
    { axisKey: 'Colore', axisLabel: 'Colore', target: 'Colore', order: 0 },
    { axisKey: 'Taglia', axisLabel: 'Taglia', target: 'Taglia', order: 1 },
  ],
  targetOptions: [{ code: 'Colore', label: 'Colore' }, { code: 'Taglia', label: 'Taglia' }, { code: 'Scollatura', label: 'Scollatura' }],
  freeform: false,
  theme: null,
  split: { mode: 'single' as const, listings: [], creatable: false },
  locked: { reason: 'live', lockedAxisKeys: ['Colore', 'Taglia'], setChangeIs: 'relist' as const, orderChangeAllowed: true, externalId: '257584954808' },
  children: [],
  axes: [{ key: 'Colore', label: 'Colore', values: [] }, { key: 'Taglia', label: 'Taglia', values: [] }],
  order: { axes: ['Colore', 'Taglia'], valueOrder: {}, editorUrl: '/x', writableHere: false, reason: 'own editor' },
}
const DOCK_AMAZON: ProjectionPage = {
  ...DOCK_EBAY,
  coordinate: { ...DOCK_EBAY.coordinate, channel: 'AMAZON', label: 'Amazon · IT' },
  theme: { value: 'COLOR_NAME/SIZE_NAME', options: [{ code: 'COLOR_NAME/SIZE_NAME', label: 'Colore / Taglia' }] },
  locked: { reason: 'live', lockedAxisKeys: ['Colore', 'Taglia'], setChangeIs: 'new-parent', orderChangeAllowed: false, externalId: 'B0F7J163XJ' },
}
const draftOf = (page: ProjectionPage): ProjectionDraft => ({ mapping: page.mapping, split: { mode: 'single' } })
/** The dock's own reorder RENUMBERS `order`; the adapter sorts by it, so a swap that does not is a no-op. */
const reorder = (page: ProjectionPage): ProjectionDraft =>
  ({ ...draftOf(page), mapping: [page.mapping[1], page.mapping[0]].map((m, order) => ({ ...m, order })) })
const dock = (page: ProjectionPage, draft: ProjectionDraft) => lockedSetChangeOf(page, draft)

describe('VT.2c 2b — the dock takes the same branch as the cell', () => {
  it('locked AMAZON + a SET change → the plan (the button reads `Change variation theme…`, 0 PATCH)', () => {
    const draft = { ...draftOf(DOCK_AMAZON), mapping: [DOCK_AMAZON.mapping[0]] }
    expect(dock(DOCK_AMAZON, draft)).toBe(true)
  })

  it('locked AMAZON + an ORDER-only change → STILL the plan: Amazon cannot revise its order', () => {
    /* The arm a single `orderOnly` check would get wrong. `orderChangeAllowed` is the discriminator,
       and on Amazon it is `false` because the set change is a NEW PARENT. */
    expect(dock(DOCK_AMAZON, reorder(DOCK_AMAZON))).toBe(true)
  })

  it('locked EBAY + an ORDER-only change → a normal save (a reorder is a revise)', () => {
    expect(dock(DOCK_EBAY, reorder(DOCK_EBAY))).toBe(false)
    /* 🔴 The arm that pins the ADAPTER's own rule: a swap that does not RENUMBER `order` is sorted
       straight back, so it is not a change at all — measured here rather than trusted. */
    expect(dock(DOCK_EBAY, { ...draftOf(DOCK_EBAY), mapping: [DOCK_EBAY.mapping[1], DOCK_EBAY.mapping[0]] })).toBe(false)
  })

  it('locked EBAY + a RE-POINTED axis → the plan, which the old axisKey-set comparison called a save', () => {
    const draft = { ...draftOf(DOCK_EBAY), mapping: [{ ...DOCK_EBAY.mapping[0], target: 'Scollatura' }, DOCK_EBAY.mapping[1]] }
    expect(dock(DOCK_EBAY, draft)).toBe(true)
    /* The old rule, re-derived here ONLY to show what changed: the axisKey sets are equal, so it
       answered `false` and the PATCH went out — into VT.1b's 409. */
    const before = new Set(DOCK_EBAY.mapping.filter(m => m.target !== null).map(m => m.axisKey))
    const after = new Set(draft.mapping.filter(m => m.target !== null).map(m => m.axisKey))
    expect(before.size === after.size && [...after].every(k => before.has(k))).toBe(true)
  })

  it('an UNLOCKED page never takes the plan branch, whatever moved', () => {
    const page = { ...DOCK_EBAY, locked: null }
    expect(dock(page, { ...draftOf(DOCK_EBAY), mapping: [DOCK_EBAY.mapping[0]] })).toBe(false)
  })

  it('nothing moved → not a plan and not a write', () => {
    expect(dock(DOCK_EBAY, draftOf(DOCK_EBAY))).toBe(false)
    expect(dock(DOCK_AMAZON, draftOf(DOCK_AMAZON))).toBe(false)
  })
})
