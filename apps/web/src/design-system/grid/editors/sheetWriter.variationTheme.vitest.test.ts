/**
 * VT.2 — the SheetWriter's `variationTheme` routing branch (design §3.6, contract §3).
 *
 * Fixtures are VT.1's, imported not copied. The bodies asserted here are the ones VT.1 MEASURED the
 * routes to require, not the ones the design table sketched: `variation-axes` refuses a request
 * missing any of `version · axes · childIds · market`, and its `axes` are the family's own spellings.
 * That asymmetry is the single most likely thing for a later hand to "tidy" into symmetry, so it is
 * asserted field by field.
 */
import { describe, expect, it } from 'vitest'

import {
  GALE_MASTER,
  GALE_AMAZON_DE_DERIVED,
  GALE_EBAY_IT_OVERRIDDEN,
  GALE_SHOPIFY_DROPPED,
} from '../../../../../../docs/fixtures/vt1/fixtures'
import { variationThemeChange, variationThemeWrite, type VariationThemeWriteFacts } from './sheetWriter'

const COL = { kind: 'variationTheme' }

/** The cell as the editor reports it: the wire cell plus the editor-only `resetRequested`. */
const facts = (cell: unknown, patch: Partial<VariationThemeWriteFacts> = {}): VariationThemeWriteFacts => ({
  ...(cell as VariationThemeWriteFacts),
  ...patch,
})

/** The family-key index the editor relays off `axes[].familyKey` (contract §3.1). */
const familyKeys = (cell: { axes: Array<{ axisKey: string; familyKey: string }> }) =>
  Object.fromEntries(cell.axes.map((a) => [a.axisKey, a.familyKey]))

describe('variationThemeChange — what moved', () => {
  it('reports `none` for an identical pair, so an unchanged edit sends NOTHING', () => {
    const c = variationThemeChange(facts(GALE_MASTER), facts(GALE_MASTER))
    expect(c.kind).toBe('none')
    expect(c.setChanged).toBe(false)
    expect(c.orderOnly).toBe(false)
  })

  it('separates an ORDER-only move from a SET move — the distinction the locked rule turns on', () => {
    const reordered = facts(GALE_EBAY_IT_OVERRIDDEN, { axes: [...GALE_EBAY_IT_OVERRIDDEN.axes].reverse() })
    const order = variationThemeChange(facts(GALE_EBAY_IT_OVERRIDDEN), reordered)
    expect(order.kind).toBe('order')
    expect(order.orderOnly).toBe(true)
    expect(order.setChanged).toBe(false)
    expect(order.before).toEqual(['color', 'size'])
    expect(order.after).toEqual(['size', 'color'])

    const dropped = facts(GALE_EBAY_IT_OVERRIDDEN, {
      axes: GALE_EBAY_IT_OVERRIDDEN.axes.map((a) => (a.axisKey === 'size' ? { ...a, included: false } : a)),
    })
    const set = variationThemeChange(facts(GALE_EBAY_IT_OVERRIDDEN), dropped)
    expect(set.kind).toBe('set')
    expect(set.setChanged).toBe(true)
    expect(set.orderOnly).toBe(false)
  })

  it('counts a RE-POINTED target as a set change — the delivered name is what a buyer picks from', () => {
    const repointed = facts(GALE_EBAY_IT_OVERRIDDEN, {
      axes: GALE_EBAY_IT_OVERRIDDEN.axes.map((a) => (a.axisKey === 'color' ? { ...a, target: 'Scollatura' } : a)),
    })
    const c = variationThemeChange(facts(GALE_EBAY_IT_OVERRIDDEN), repointed)
    expect(c.setChanged).toBe(true)
    /* The axis KEYS are untouched — a comparison on keys alone would have called this `none`. */
    expect(c.before).toEqual(c.after)
  })

  it('reports a theme swap as `theme` when nothing else moved', () => {
    const swapped = facts(GALE_AMAZON_DE_DERIVED, { theme: { code: 'SIZE/COLOR', label: 'Größe / Farbe', deprecated: false } as never })
    const c = variationThemeChange(facts(GALE_AMAZON_DE_DERIVED), swapped)
    expect(c.kind).toBe('theme')
    expect([c.themeBefore, c.themeAfter]).toEqual(['COLOR/SIZE', 'SIZE/COLOR'])
  })
})

describe('the branch routes on the KIND and then on `cell.write`', () => {
  it('refuses a column that is not a variation-theme column', () => {
    const out = variationThemeWrite({ kind: 'select' }, facts(GALE_MASTER), facts(GALE_MASTER, { theme: null }))
    expect(out.send).toBe(false)
    expect(out).toHaveProperty('reason', 'Not a variation-theme column')
  })

  it('sends nothing when nothing changed', () => {
    const out = variationThemeWrite(COL, facts(GALE_MASTER), facts(GALE_MASTER))
    expect(out).toMatchObject({ send: false, reason: 'Nothing changed' })
  })

  it('sends nothing for a CHILD row and says why', () => {
    const out = variationThemeWrite(COL, null, null)
    expect(out).toMatchObject({ send: false, reason: 'Set on the parent' })
  })

  it('sends nothing when the server said the coordinate is not writable, using ITS reason', () => {
    const blocked = facts(GALE_SHOPIFY_DROPPED, { writable: false, writeBlockedReason: 'No listing on Shopify yet', axes: [] })
    const out = variationThemeWrite(COL, facts(GALE_SHOPIFY_DROPPED), blocked)
    expect(out).toMatchObject({ send: false, reason: 'No listing on Shopify yet' })
  })
})

describe('master → PATCH /studio/variation-axes', () => {
  it('sends the FOUR fields the validator requires, with the FAMILY spellings', () => {
    const before = facts(GALE_MASTER, { axisFamilyKeys: familyKeys(GALE_MASTER) })
    const after = facts(GALE_MASTER, {
      axisFamilyKeys: familyKeys(GALE_MASTER),
      axes: [...GALE_MASTER.axes].reverse(),
    })
    const out = variationThemeWrite(COL, before, after)
    expect(out.send).toBe(true)
    if (!out.send) throw new Error('unreachable')
    expect(out.endpoint).toBe('variation-axes')
    /* Field by field, because the refusal is field by field:
       400 "Supply a family version, unique axes, reviewed childIds and market." */
    expect(Object.keys(out.body).sort()).toEqual(['axes', 'childIds', 'market', 'version'])
    expect(out.body.version).toBe(59)
    expect(out.body.market).toBe('IT')
    expect(out.body.axes).toEqual(['Taglia', 'Colore'])
    expect((out.body.childIds as string[]).length).toBe(20)
  })

  it('never sends a CANONICAL key, even when NO caller relays an index', () => {
    /* 🔴 This assertion is inverted from what it said before, and a witnessed write is why.
       It used to pin the canonical-key FALLBACK as "what happens if a host forgets" — and the host
       that forgot turned out to be the sheet's own commit path, so the first real request carried
       `["color","size","fittype"]` and came back `400 PRODUCT_RELATIONSHIP_CONFLICT "An axis is no
       longer available in the attribute dictionary."` A test that documents a defect as acceptable
       is how the defect ships. The spelling now comes off the CELL (`axes[].familyKey`), which every
       payload carries, so there is nothing for a host to forget. */
    const after = facts(GALE_MASTER, { axes: [...GALE_MASTER.axes].reverse() })
    const out = variationThemeWrite(COL, facts(GALE_MASTER), after)
    if (!out.send) throw new Error('unreachable')
    expect(out.body.axes).toEqual(['Taglia', 'Colore'])
    /* The canonical keys, for contrast — these are what the route refuses. */
    expect(GALE_MASTER.axes.map((a) => a.axisKey)).toEqual(['color', 'size'])
  })

  it('lets an explicit `axisFamilyKeys` override the cell, for a host that knows better', () => {
    const after = facts(GALE_MASTER, { axisFamilyKeys: { color: 'Farbe', size: 'Größe' } })
    const reordered = facts(after, { axes: [...GALE_MASTER.axes].reverse() })
    const out = variationThemeWrite(COL, after, reordered)
    if (!out.send) throw new Error('unreachable')
    expect(out.body.axes).toEqual(['Größe', 'Farbe'])
  })
})

describe('channel → PATCH /studio/projection', () => {
  it('sends the WHOLE mapping list with explicit order, and the coordinate VERBATIM', () => {
    const after = facts(GALE_SHOPIFY_DROPPED, { axes: [...GALE_SHOPIFY_DROPPED.axes].reverse() })
    const out = variationThemeWrite(COL, facts(GALE_SHOPIFY_DROPPED), after)
    expect(out.send).toBe(true)
    if (!out.send) throw new Error('unreachable')
    expect(out.endpoint).toBe('projection')
    expect(out.query).toEqual({ channel: 'SHOPIFY', market: 'GLOBAL', accountId: null, aliasKey: '' })
    expect(out.body.expectedVersion).toBe(4)
    /* `style` is excluded, so it is NOT in the mapping — a partial patch cannot express a removal,
       which is why the list is whole and why order is stated per entry.
       🔴 VT.F2: these two arms PINNED the canonical key (`size`), and the route refuses it. Measured on screen
       on `VTF2-TEST-3AX` EBAY·IT: `400 bad_projection_request "\"color\" is not one of this family's axes. Add
       it on the shared product first." axes:["Colore","Taglia","Fit Type"]` — the route's known set is
       `readStoredMapping`'s `axis.key`, the family's DECLARED spelling, and a hand-written probe that sent
       `Colore/Taglia/Fit Type` was answered 200 and stored. So the expectation is corrected, not the code's
       new behaviour: the body carries `familyKey`, exactly as the `variation-axes` body already did. */
    expect(out.body.mapping).toEqual([
      { axisKey: 'Taglia', target: 'Size', order: 0 },
      { axisKey: 'Colore', target: 'Color', order: 1 },
    ])
  })

  it('does NOT send `theme` on a coordinate that has none', () => {
    const after = facts(GALE_SHOPIFY_DROPPED, { axes: [...GALE_SHOPIFY_DROPPED.axes].reverse() })
    const out = variationThemeWrite(COL, facts(GALE_SHOPIFY_DROPPED), after)
    if (!out.send) throw new Error('unreachable')
    /* `theme: null` CLEARS it (§3.2), so sending it here would be a write nobody asked for. */
    expect('theme' in out.body).toBe(false)
  })

  it('DOES send `theme` when the coordinate has one — including a deliberate clear', () => {
    const unlocked = facts(GALE_AMAZON_DE_DERIVED, { locked: null })
    const swapped = facts(unlocked, { theme: { code: 'SIZE/COLOR', label: 'Größe / Farbe', deprecated: false } as never })
    const out = variationThemeWrite(COL, unlocked, swapped)
    if (!out.send) throw new Error('unreachable')
    expect(out.body.theme).toBe('SIZE/COLOR')

    const cleared = variationThemeWrite(COL, unlocked, facts(unlocked, { theme: null }))
    if (!cleared.send) throw new Error('unreachable')
    expect(cleared.body.theme).toBeNull()
  })

  it('sends `reset` ALONE — combining it with theme or mapping is a 400', () => {
    /* On an UNLOCKED override. eBay·IT is the only override fixture and it is LIVE, so the lock has
       to be lifted to exercise the body — and the locked arm is asserted below, deliberately. */
    const unlocked = facts(GALE_EBAY_IT_OVERRIDDEN, { locked: null })
    const out = variationThemeWrite(COL, unlocked, facts(unlocked, { resetRequested: true }))
    expect(out.send).toBe(true)
    if (!out.send) throw new Error('unreachable')
    expect(out.body).toEqual({ expectedVersion: 18, reset: true })
    expect(Object.keys(out.body).sort()).toEqual(['expectedVersion', 'reset'])
  })

  it('takes the PLAN path for a reset on a LIVE coordinate — the client cannot know the resulting set', () => {
    /* ASSUMED (ledger): dropping an override hands the coordinate back to the rule/derived tier, so
       the resulting axis set is the SERVER's answer, not the client's. D-VT6 says a set change on a
       live coordinate is a dry-run plan, and failing OPEN here would relist a live eBay item on a
       click labelled `Reset to rule`. */
    expect(GALE_EBAY_IT_OVERRIDDEN.locked).not.toBeNull()
    const out = variationThemeWrite(COL, facts(GALE_EBAY_IT_OVERRIDDEN), facts(GALE_EBAY_IT_OVERRIDDEN, { resetRequested: true }))
    expect(out.send).toBe(false)
    expect(out).toHaveProperty('plan')
  })
})

describe('§3.5 — a locked coordinate', () => {
  it('opens the PLAN instead of writing when the axis SET moves', () => {
    const dropped = facts(GALE_AMAZON_DE_DERIVED, {
      axes: GALE_AMAZON_DE_DERIVED.axes.map((a) => (a.axisKey === 'size' ? { ...a, included: false } : a)),
    })
    const out = variationThemeWrite(COL, facts(GALE_AMAZON_DE_DERIVED), dropped)
    expect(out.send).toBe(false)
    expect(out).toHaveProperty('plan')
    if (!('plan' in out)) throw new Error('unreachable')
    expect(out.plan.setChangeIs).toBe('new-parent')
    expect(out.plan.reason).toBe(GALE_AMAZON_DE_DERIVED.locked!.reason)
  })

  it('opens the plan for a THEME change on a live Amazon parent', () => {
    const swapped = facts(GALE_AMAZON_DE_DERIVED, { theme: { code: 'SIZE/COLOR', label: 'Größe / Farbe', deprecated: false } as never })
    const out = variationThemeWrite(COL, facts(GALE_AMAZON_DE_DERIVED), swapped)
    expect(out.send).toBe(false)
    expect(out).toHaveProperty('plan')
  })

  it('ALLOWS an order-only change on a live eBay listing — a revise, not a relist', () => {
    expect(GALE_EBAY_IT_OVERRIDDEN.locked!.orderChangeAllowed).toBe(true)
    const reordered = facts(GALE_EBAY_IT_OVERRIDDEN, { axes: [...GALE_EBAY_IT_OVERRIDDEN.axes].reverse() })
    const out = variationThemeWrite(COL, facts(GALE_EBAY_IT_OVERRIDDEN), reordered)
    expect(out.send).toBe(true)
    if (!out.send) throw new Error('unreachable')
    /* VT.F2 — family spellings here too (see the note above): one rule for both endpoints. */
    expect(out.body.mapping).toEqual([
      { axisKey: 'Taglia', target: 'Taglia', order: 0 },
      { axisKey: 'Colore', target: 'Colore', order: 1 },
    ])
  })

  it('REFUSES the same reorder when the coordinate says reordering is not allowed', () => {
    /* The discriminating control for the assertion above: Amazon·DE carries
       `orderChangeAllowed: false`, so the identical gesture takes the plan path. Without this, a
       reorder passing on eBay would say nothing about whether the flag is read at all. */
    expect(GALE_AMAZON_DE_DERIVED.locked!.orderChangeAllowed).toBe(false)
    const reordered = facts(GALE_AMAZON_DE_DERIVED, { axes: [...GALE_AMAZON_DE_DERIVED.axes].reverse() })
    const out = variationThemeWrite(COL, facts(GALE_AMAZON_DE_DERIVED), reordered)
    expect(out.send).toBe(false)
    expect(out).toHaveProperty('plan')
  })

  it('writes normally on an UNLOCKED coordinate — the arm that proves the lock is what refused', () => {
    expect(GALE_SHOPIFY_DROPPED.locked).toBeNull()
    const dropped = facts(GALE_SHOPIFY_DROPPED, {
      axes: GALE_SHOPIFY_DROPPED.axes.map((a) => (a.axisKey === 'size' ? { ...a, included: false } : a)),
    })
    expect(variationThemeWrite(COL, facts(GALE_SHOPIFY_DROPPED), dropped).send).toBe(true)
  })
})

describe('🔴 VT.F2 · an axis with NO target must be ABSENT from the body (witnessed on screen)', () => {
  /**
   * Measured through the real cell on `VTF2-TEST-3AX` EBAY·IT (1440×900, through the gate wrapper): a mouse
   * re-point of `Color` → `Scollatura` committed the body
   * `{"mapping":[{"axisKey":"color","target":"Scollatura","order":0},{"axisKey":"size","target":"Taglia","order":1},
   * {"axisKey":"fittype","target":null,"order":2}]}` and the route answered **400 `bad_projection_request`
   * "Map each shared axis once to a nonempty channel specific."** — that coordinate's third axis has no eBay
   * specific, and sending it as `target: null` made every re-point on it unsaveable.
   *
   * The fixture is the UNLOCKED one (`GALE_SHOPIFY_DROPPED.locked === null`): on a locked coordinate a target
   * change takes the plan path and this branch is never reached, which is what my first version of these arms
   * measured instead of the body.
   */
  const base = facts(GALE_SHOPIFY_DROPPED, { axisFamilyKeys: familyKeys(GALE_SHOPIFY_DROPPED) })
  const bodyOf = (out: ReturnType<typeof variationThemeWrite>) => {
    expect(out.send).toBe(true)
    return (out as unknown as { body: { mapping: Array<{ axisKey: string; target: string; order: number }> } }).body.mapping
  }

  it('drops the null-target axis and re-densifies `order`', () => {
    expect(GALE_SHOPIFY_DROPPED.locked).toBeNull()
    const included = base.axes.filter((a) => a.included)
    expect(included.length).toBeGreaterThan(1)
    const before = facts(base, { axes: base.axes.map((a) => (a.axisKey === included[included.length - 1].axisKey ? { ...a, target: null } : a)) })
    const after = facts(before, { axes: before.axes.map((a) => (a.axisKey === included[0].axisKey ? { ...a, target: 'Scollatura' } : a)) })
    const mapping = bodyOf(variationThemeWrite(COL, before, after))
    expect(mapping.every((m) => typeof m.target === 'string' && m.target.trim() !== '')).toBe(true)
    expect(mapping.map((m) => m.order)).toEqual(mapping.map((_, i) => i))
    expect(mapping.map((m) => m.axisKey)).not.toContain(included[included.length - 1].axisKey)
    expect(mapping[0].target).toBe('Scollatura')
  })

  it('POSITIVE CONTROL — with every included axis carrying a target, every one of them is sent', () => {
    const all = facts(base, { axes: base.axes.map((a) => (a.included ? { ...a, target: a.target ?? 'Some specific' } : a)) })
    const after = facts(all, { axes: all.axes.map((a, i) => (i === 0 ? { ...a, target: 'Scollatura' } : a)) })
    expect(bodyOf(variationThemeWrite(COL, all, after))).toHaveLength(all.axes.filter((a) => a.included).length)
  })

  it('an EMPTY-STRING target is treated as absent too, never sent as a blank', () => {
    const included = base.axes.filter((a) => a.included)
    const before = facts(base, { axes: base.axes.map((a) => (a.axisKey === included[0].axisKey ? { ...a, target: '  ' } : a)) })
    const after = facts(before, { axes: before.axes.map((a) => (a.axisKey === included[1].axisKey ? { ...a, target: 'Scollatura' } : a)) })
    const mapping = bodyOf(variationThemeWrite(COL, before, after))
    expect(mapping.some((m) => m.target.trim() === '')).toBe(false)
    expect(mapping.map((m) => m.axisKey)).not.toContain(included[0].axisKey)
  })
})
