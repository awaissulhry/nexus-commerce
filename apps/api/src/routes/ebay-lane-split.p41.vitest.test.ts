/**
 * P4.1e — eBay's Inventory / Trading split: keep it, and never GUESS it.
 *
 * ## The measurement, and most of it is a COUNTERWEIGHT
 *
 * The plan row says "keep the split (Inventory API for unique SKUs, Trading for
 * shared SKUs)". The split exists and is **deterministic**, which is better than
 * the row asks. Incident #23 replaced an `it_item_id` heuristic — which
 * *"misrouted Trading primaries into the Inventory lane"* — with a marker that
 * cannot be inferred wrongly: a ChannelListing carrying `__offerIds` was created
 * by OUR Inventory-API group publish, so offers exist and the family is
 * Inventory-managed. No `__offerIds` means Trading-managed.
 *
 * ## The one defect: the marker's FAILURE path guessed
 *
 * The prefetch that reads the marker was wrapped in a `try/catch` whose catch
 * logged *"lane-marker prefetch failed — **shared flag decides alone**"* and
 * carried on. With the marker set empty, `inventoryManagedFamily` is false, so a
 * shared-flagged family takes the **Trading** lane — which is exactly the
 * misrouting Incident #23 was introduced to stop, re-entering by the back door
 * whenever the database hiccups.
 *
 * The shared lane's adopt-don't-duplicate belt would catch many of those, but it
 * depends on a row carrying a live `{mp}_item_id`, and a family published through
 * the Inventory lane need not carry one. So the downside is not bounded to "an
 * eBay error": it can reach AddFixedPriceItem.
 *
 * This is the same shape as P4.1d, in a different file on the same day: a rule
 * learned from an incident, correct on the happy path, and quietly abandoned on
 * the failure path. **Refuse rather than guess.**
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const route = readFileSync(join(SRC, 'routes', 'ebay-flat-file.routes.ts'), 'utf8')

/**
 * The file with its comments stripped.
 *
 * 🔴 "A guard that counts comments can be silenced by one" — and the reverse
 * happened here: the first version of the test below asserted the old sentence
 * was absent, and it failed because the NEW code quotes it in a comment
 * explaining what it replaced. A claim about what the code DOES must be made
 * against the code.
 */
const routeCode = route
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join('\n')

describe('the split itself is deterministic (a result, not a gap)', () => {
  it('routes on __offerIds, not on a heuristic', () => {
    expect(route).toContain('__offerIds')
    expect(route).toContain('inventoryManagedProducts')
    // Incident #23's reason, kept in the file so the next reader sees it.
    expect(route).toContain('misrouted Trading primaries')
  })

  it('reads the marker from the ChannelListing, for the products being pushed', () => {
    expect(route).toMatch(/channelListing\.findMany\(\{[\s\S]{0,200}channel: 'EBAY'[\s\S]{0,200}platformAttributes/)
  })

  it('only a shared-flagged family consults the marker', () => {
    // The Inventory lane is the default; the marker exists to stop a
    // shared-FLAGGED family being sent to Trading when offers already exist.
    expect(route).toContain("sharedParent?.shared_sku_listing === true && inventoryManagedFamily")
    expect(route).toContain("sharedParent?.shared_sku_listing === true && !inventoryManagedFamily")
  })
})

describe('an unreadable marker REFUSES, it does not guess', () => {
  it('records that the marker could not be read', () => {
    expect(route).toContain('let laneMarkersUnavailable = false')
    expect(route).toContain('laneMarkersUnavailable = true')
  })

  it('no longer lets the shared flag decide alone', () => {
    // The old sentence was the marker of "guess the lane". Its absence is the
    // assertion; the new one names what happens instead.
    expect(routeCode).not.toContain('shared flag decides alone')
    expect(routeCode).toContain('shared families will be refused, not guessed')
    // Positive control: the stripper did not simply empty the file.
    expect(routeCode).toContain('laneMarkersUnavailable = true')
  })

  it('refuses the family and sends nothing', () => {
    // 🔴 These are SHAPE assertions, and the first version of them was defeatable.
    // `toContain('sharedParent?… && laneMarkersUnavailable')` still passes when
    // the condition is mutated to `if (false && sharedParent?… )` or
    // `… && Date.now() < 0`, because the substring survives. Two mutations
    // proved it: the rule was disabled and the test stayed green.
    //
    // So the WHOLE guard line is matched, trimmed, with its `if (` and its `) {`.
    // A prefix or an extra conjunct changes the line and fails here.
    const guardLines = route
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('laneMarkersUnavailable)') || l.includes('laneMarkersUnavailable &&') || l.includes('&& laneMarkersUnavailable'))
    expect(guardLines).toContain('if (sharedParent?.shared_sku_listing === true && laneMarkersUnavailable) {')
    expect(route).toContain("Could not read this listing's lane marker")
    expect(route).toContain('nothing was sent')
  })

  it('the guard condition has no extra conjunct that could switch it off', () => {
    // The companion to the line match: exactly ONE line tests the flag, and it
    // is the guard. A second one would mean the rule had been split or copied.
    const testing = route
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('if (') && l.includes('laneMarkersUnavailable'))
    expect(testing).toEqual(['if (sharedParent?.shared_sku_listing === true && laneMarkersUnavailable) {'])
  })

  it('refuses BEFORE either lane is entered', () => {
    const iRefusal = route.indexOf('sharedParent?.shared_sku_listing === true && laneMarkersUnavailable')
    const iTrading = route.indexOf('sharedParent?.shared_sku_listing === true && !inventoryManagedFamily')
    const iInventory = route.indexOf('sharedParent?.shared_sku_listing === true && inventoryManagedFamily')
    expect(iRefusal).toBeGreaterThan(0) // positive control
    expect(iRefusal).toBeLessThan(iTrading)
    expect(iRefusal).toBeLessThan(iInventory)
  })

  it('refuses per FAMILY, not per push', () => {
    // A family whose lane does not depend on the marker is unaffected: the
    // refusal is inside the family loop and ends with `continue`, not a return.
    const block = route.slice(
      route.indexOf('sharedParent?.shared_sku_listing === true && laneMarkersUnavailable'),
      route.indexOf('sharedParent?.shared_sku_listing === true && inventoryManagedFamily'),
    )
    expect(block).toContain('continue')
    expect(block).not.toContain('return reply')
  })

  it('tells the operator it is temporary', () => {
    // A database hiccup is not an operator error. The sentence has to say what
    // to do, or it reads as "your listing is broken".
    const i = route.indexOf("Could not read this listing's lane marker")
    expect(route.slice(i, i + 400)).toContain('Retry in a minute')
  })
})

describe('the adopt-don’t-duplicate belt is still there, and is not the answer', () => {
  const shared = readFileSync(join(SRC, 'services', 'ebay-shared-listing-push.service.ts'), 'utf8')

  it('the shared lane still refuses to re-list a live item', () => {
    expect(shared).toContain('Adopt-don\'t-duplicate belt')
    expect(shared).toContain('already live on eBay')
  })

  it('but it depends on the ROW carrying an item id, which is why it is not enough', () => {
    // The belt reads `{mp}_item_id` / `ebay_item_id` off the row. A family
    // published through the Inventory lane need not carry one, so a misroute
    // can still reach AddFixedPriceItem. The refusal above is the real guard.
    expect(shared).toMatch(/\$\{mpPrefix\}_item_id|ebay_item_id/)
  })
})
