/**
 * VT.1 — the eBay declared-axis CHARACTERISATION test (VX D1 / M3, design D-VT5).
 *
 * The claim this test exists to hold: unifying the three readers on `ebayDeclaredAxes` changes NOTHING that ships.
 * It re-derives, for every eBay PARENT listing row in the catalogue, what the push service computed before the
 * change and what it computes after, and fails on any row where they differ.
 *
 * Why it is written this way:
 *  - The BEFORE rule is spelled out here verbatim from the code it replaced (`ebay-variation-push.service.ts:904`
 *    `parseThemeAxes(Product.variationTheme)` then the coordinate's `_variationAxes`), because a characterisation
 *    test that called the new function for both arms would prove only that a function equals itself.
 *  - It reads the real rows rather than a fixture: a fixture PINS a dimension, and the dimension that matters here
 *    is "how many rows in this catalogue carry BOTH stores" — which no fixture I write can tell me.
 *  - It asserts a POSITIVE CONTROL first (rows > 0, and at least one row carrying each store), so a database that
 *    answers with nothing cannot pass as agreement.
 *
 * Measured when it was written (local Docker `nexus_development`, 2026-09-13): 38 eBay parent listing rows; the
 * PUSH's declared axes identical on 38 of 38; the FAMILY-AXES read changes on exactly 1 — GALE-JACKET eBay·IT
 * (ACTIVE, item 257584954808), which read `["Color","Size"]` off the retired listing COLUMN while the push has been
 * sending `["Colore","Taglia"]`. That one row is the Appendix C disagreement, and the change closes it by making
 * the read agree with what ships.
 */

import { afterAll, describe, expect, it } from 'vitest'
import prisma from '../../db.js'
import { parseThemeAxes } from '../ebay-theme-axes.js'
import { ebayDeclaredAxes } from './variation-rules.service.js'

interface Row {
  sku: string
  marketplace: string
  listingStatus: string
  externalListingId: string | null
  productTheme: string | null
  listingTheme: string | null
  ownAxes: unknown
}

/** The push rule as it stood BEFORE VT.1, transcribed from the code it replaced. */
function pushRuleBefore(row: Row): string[] | null {
  const themeAxes = parseThemeAxes(row.productTheme)
  const stored = Array.isArray(row.ownAxes)
    ? (row.ownAxes as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return themeAxes.length > 0 ? themeAxes : stored.length > 0 ? stored.slice() : null
}

/** The family-axes rule as it stood BEFORE VT.1 (`ebay-family-axes.service.ts:232`). */
function familyAxesRuleBefore(row: Row): string[] | null {
  const themeAxes = parseThemeAxes(row.listingTheme ?? row.productTheme)
  const stored = Array.isArray(row.ownAxes)
    ? (row.ownAxes as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return themeAxes.length > 0 ? themeAxes : stored.length > 0 ? stored.slice() : null
}

function ruleAfter(row: Row): string[] | null {
  const stored = Array.isArray(row.ownAxes)
    ? (row.ownAxes as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return ebayDeclaredAxes({ _variationAxes: stored }, row.productTheme) ?? (stored.length > 0 ? stored.slice() : null)
}

let rows: Row[] | null = null
let unreachable: string | null = null

async function load(): Promise<Row[]> {
  if (rows) return rows
  try {
    rows = await prisma.$queryRawUnsafe<Row[]>(`
      SELECT pr.sku, cl."marketplace", cl."listingStatus", cl."externalListingId",
             pr."variationTheme" AS "productTheme", cl."variationTheme" AS "listingTheme",
             cl."platformAttributes"->'_variationAxes' AS "ownAxes"
      FROM "ChannelListing" cl JOIN "Product" pr ON pr.id = cl."productId"
      WHERE cl.channel = 'EBAY' AND pr."parentId" IS NULL
      ORDER BY pr.sku, cl."marketplace"`)
  } catch (err) {
    unreachable = err instanceof Error ? err.message : String(err)
    rows = []
  }
  return rows
}

afterAll(async () => { await prisma.$disconnect().catch(() => {}) })

describe('eBay declared axes — characterisation over every parent listing', () => {
  it('POSITIVE CONTROL: the catalogue answers, and it carries both stores', async () => {
    const all = await load()
    if (unreachable) {
      // A database that cannot be reached is NOT agreement. Say so loudly and let the reader decide.
      expect.soft(unreachable, 'no database — this suite proves nothing in this run').toBeNull()
      return
    }
    expect(all.length).toBeGreaterThan(0)
    expect(all.some((r) => !!r.productTheme), 'at least one row carries Product.variationTheme').toBe(true)
    expect(all.some((r) => Array.isArray(r.ownAxes) && (r.ownAxes as unknown[]).length > 0),
      'at least one row carries the coordinate\'s own _variationAxes — otherwise the flip has nothing to flip').toBe(true)
  })

  it('the PUSH sends exactly what it sent before, on every row', async () => {
    const all = await load()
    if (unreachable) return
    const diffs = all
      .map((r) => ({ r, before: pushRuleBefore(r), after: ruleAfter(r) }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after))
      .map(({ r, before, after }) => `${r.sku} ${r.marketplace} (${r.listingStatus}, ${r.externalListingId ?? 'no id'}): ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    expect(diffs, 'rows whose PUSHED axis set would change').toEqual([])
  })

  it('the FAMILY-AXES read changes only where it disagreed with the push, and then it agrees with it', async () => {
    const all = await load()
    if (unreachable) return
    const changed = all.filter((r) => JSON.stringify(familyAxesRuleBefore(r)) !== JSON.stringify(ruleAfter(r)))
    for (const r of changed) {
      // Every row whose READ moves must land on what the PUSH was already sending — never somewhere new.
      expect(JSON.stringify(ruleAfter(r)), `${r.sku} ${r.marketplace}`).toBe(JSON.stringify(pushRuleBefore(r)))
      // And it can only move where the retired listing COLUMN was the thing being read.
      expect(!!r.listingTheme, `${r.sku} ${r.marketplace} moved without a listing-column theme`).toBe(true)
    }
  })
})
