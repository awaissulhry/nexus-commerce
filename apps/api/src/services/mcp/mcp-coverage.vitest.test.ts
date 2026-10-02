/**
 * MCP full control P1 — every API route file has an owner in the plan, or a reason it is kept from Claude.
 *
 * The coverage map (docs/mcp-full-control/sections/09-platform-and-coverage.md §1) lives in code as
 * ROUTE_COVERAGE (mcp-coverage.ts). This file walks apps/api/src/routes and fails:
 *   · when a route file has no row  — a new feature nobody decided about (give it a part, or a reasoned exclusion)
 *   · when a row names no route file — a stale row
 *   · when a row names an unknown part, or excludes without a reason
 */
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coverageGaps, PLAN_PARTS, ROUTE_COVERAGE, routeKeyOf } from './mcp-coverage.js'

const ROUTES = fileURLToPath(new URL('../../routes/', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [relative(ROUTES, join(dir, entry.name))],
  )
}

const routeKeys = () => files(ROUTES).map(routeKeyOf).filter((key): key is string => key !== null)

describe('P1 — the coverage map holds every route file', () => {
  it('reads the real route folder (199 files on 2026-10-01, images/ included)', () => {
    const keys = routeKeys()
    expect(keys.length).toBeGreaterThanOrEqual(199)
    expect(keys).toContain('products')
    expect(keys).toContain('images/media-plan')
    expect(keys).toContain('health') // a route file without the .routes.ts suffix
    expect(keys.every((key) => !/test|__tests__/.test(key))).toBe(true)
  })

  it('every route file has a row, and every row names a route file', () => {
    expect(coverageGaps(routeKeys())).toEqual({ missing: [], stale: [] })
  })

  it('every row names a part of the plan, or says why Claude is kept from it', () => {
    const bad = Object.entries(ROUTE_COVERAGE).filter(([, row]) =>
      'part' in row ? !(row.part in PLAN_PARTS) : !(typeof row.excluded === 'string' && row.excluded.trim().length >= 12),
    )
    expect(bad.map(([key]) => key)).toEqual([])
  })

  it('the parts the map gives the most features to are the ones the plan says (09 §1 totals)', () => {
    const parts = new Set(Object.values(ROUTE_COVERAGE).flatMap((row) => ('part' in row ? [row.part] : [])))
    expect([...parts].sort()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09'])
    const excluded = Object.values(ROUTE_COVERAGE).filter((row) => 'excluded' in row).length
    expect(excluded).toBeGreaterThanOrEqual(30)
  })
})

describe('P1 — the check can fail', () => {
  it('a new route file without a row is named', () => {
    expect(coverageGaps([...routeKeys(), 'brand-new-feature']).missing).toEqual(['brand-new-feature'])
  })

  it('a row whose route file is gone is named', () => {
    expect(coverageGaps(routeKeys().filter((key) => key !== 'reviews')).stale).toEqual(['reviews'])
  })

  it('test files and helpers outside the naming are read as they are', () => {
    expect(routeKeyOf('mcp.routes.vitest.test.ts')).toBeNull()
    expect(routeKeyOf('__tests__/products-sync-queue-rollup.test.ts')).toBeNull()
    expect(routeKeyOf('images/product-media.routes.ts')).toBe('images/product-media')
    expect(routeKeyOf('ai.ts')).toBe('ai')
    expect(routeKeyOf('validation.ts')).toBe('validation')
  })
})
