/**
 * VT.4 — the plan modal's pure halves.
 *
 * `apps/web` vitest is `environment: 'node'`, so this file asserts the CLIENT CONTRACT and nothing about
 * the DOM: the request `fetchThemeChangePlan` sends (it must always carry `dryRun: true`), the refusal it
 * surfaces (the server's sentence, never a generic one), and that `Copy plan` copies the SERVER's lines
 * rather than re-worded ones. The rendering is measured on screen, in the ledger.
 *
 * The fixture plan is the LIVE response measured on 2026-09-13 from
 * `POST /api/products/cmokmy3a40078pm0p1fvnu523/studio/projection/theme-change?channel=EBAY&market=IT`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeChangePlanError, fetchThemeChangePlan, planAsText, type ThemeChangePlan } from './ThemeChangePlanModal'

const PLAN: ThemeChangePlan = {
  kind: 'ebay-relist',
  coordinate: { channel: 'EBAY', market: 'IT', accountId: 'cmr4aaqb00025nz016k18rup9', aliasKey: '', label: 'eBay · IT' },
  title: 'Change variation theme · eBay · IT',
  subline: 'GALE-JACKET · 20 variations · Colore · Taglia → Colore',
  from: 'Colore · Taglia',
  to: 'Colore',
  banner: 'Dry run — nothing is sent. eBay cannot change a variation set in place: the item is ended and relisted under a new ItemID. The live run is a separate approval and the Owner runs the first one.',
  steps: [
    { n: 1, verb: 'END', target: 'item 257584954808', detail: 'Ends the live IT listing. Its ItemID is not reusable.', reversible: false },
    { n: 2, verb: 'RELIST', target: 'Primary listing', detail: 'New item with the specifics Colore (was Colore · Taglia)', reversible: false, payload: { variesBy: { specifications: [{ name: 'Colore', values: ['Nero', 'Giallo'] }] } } },
    { n: 3, verb: 'WAIT 8 s', target: 'read-back', detail: 'The new ItemID is read back and stored on this coordinate before anything else runs', reversible: null },
    { n: 4, verb: 'PATCH', target: 'this listing record', detail: 'externalListingId → the new ItemID; the old one is kept in the listing history', reversible: true },
  ],
  keeps: ['SKUs and EANs', 'prices and stock, echoed onto the new item', 'the Nexus product and its children'],
  loses: ['the ItemID and its URL', 'watchers and the item’s sales history', 'best-match age'],
  warnings: [],
  dryRun: true,
  meta: { tookMs: 402, adapter: 'ebay-variation-push.service#resolveVariationAxes + buildVariesBySpecifications', providerCalls: 0 },
}

const REQUEST = {
  coordinate: { productId: 'p1', channel: 'EBAY', market: 'IT', accountId: 'acc1' },
  expectedVersion: 18,
  mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('VT.4 — fetchThemeChangePlan', () => {
  it('ALWAYS sends dryRun: true, and sends it explicitly', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => PLAN }
    })
    const plan = await fetchThemeChangePlan(REQUEST)
    expect(plan.title).toBe('Change variation theme · eBay · IT')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/studio/projection/theme-change?channel=EBAY&market=IT&accountId=acc1')
    // The one assertion that matters: there is no path through this client that omits the flag.
    expect(calls[0].body).toEqual({ dryRun: true, expectedVersion: 18, mapping: REQUEST.mapping })
  })

  it('surfaces the SERVER’s sentence on a refusal, not a generic one', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'bad_projection_request',
        message: 'Reordering an eBay listing’s specifics, or adding values to them, is a revise — not a relist. Save it through the mapping instead; this plan exists only for a change to the SET.',
      }),
    }))
    await expect(fetchThemeChangePlan(REQUEST)).rejects.toThrow('is a revise — not a relist')
    await expect(fetchThemeChangePlan(REQUEST)).rejects.toBeInstanceOf(ThemeChangePlanError)
  })

  it('names the status when the body says nothing at all', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, json: async () => null }))
    await expect(fetchThemeChangePlan(REQUEST)).rejects.toThrow('HTTP 502')
  })

  it('refuses a 200 that is not a plan rather than rendering an empty modal', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    await expect(fetchThemeChangePlan(REQUEST)).rejects.toThrow('The plan could not be built')
  })
})

describe('VT.4 — Copy plan copies the server’s lines', () => {
  it('carries every step, verb, target, detail and reversibility, verbatim', () => {
    const text = planAsText(PLAN)
    for (const step of PLAN.steps) {
      expect(text).toContain(step.verb)
      expect(text).toContain(step.target)
      expect(text).toContain(step.detail)
    }
    expect(text).toContain(PLAN.title)
    expect(text).toContain(PLAN.subline)
    expect(text).toContain(PLAN.banner)
    for (const item of [...PLAN.keeps, ...PLAN.loses]) expect(text).toContain(item)
    // The three reversibility states are distinguishable in the text, as they are on screen.
    expect(text).toContain('reversible: no')
    expect(text).toContain('reversible: yes')
    expect(text).toContain('reversible: —')
    // The evidence line: which composer, and that nothing was sent.
    expect(text).toContain('ebay-variation-push.service#resolveVariationAxes')
    expect(text).toContain('dry run · 0 provider calls')
  })

  it('includes the warnings when there are any, and adds no warning line when there are none', () => {
    expect(planAsText(PLAN)).not.toContain('!')
    const warned = planAsText({ ...PLAN, warnings: ['The live run would be REFUSED before the first child PUT: Taglia binds to no attribute.'] })
    expect(warned).toContain('! The live run would be REFUSED before the first child PUT')
  })
})
