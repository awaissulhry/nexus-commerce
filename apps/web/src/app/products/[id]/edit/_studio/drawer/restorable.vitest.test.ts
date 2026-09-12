/**
 * PES.4.10 — `RESTORABLE_FIELDS` must equal the route's own ALLOWED set.
 *
 * This lane has shipped the same bug three times (rulings #46, #57): a hand-written mirror of an
 * API shape that `apps/web` cannot import, which type-checked perfectly against a contract the
 * server never had. This mirror is the fourth candidate, and it fails in a nastier way than the
 * others — a field missing here is silently NOT OFFERED for restore (the operator never learns it
 * could have been recovered), and a field extra here is offered, ticked, sent, and dropped by the
 * server's own filter with no error, so the pane reports a restore of N fields and N-1 happen.
 *
 * Pinned against the API's own definition, both directions: no drift either way.
 *
 * 🔴 It stopped checking anything for a while, and that is the lesson. PES.5 extracted the list to
 * `restorable-fields.ts` (#364), so `products.routes.ts` went from `const ALLOWED: Set<string> =
 * new Set([…])` to `const ALLOWED = RESTORABLE_MASTER_FIELDS`. The extractor threw, as designed —
 * but a throw at module scope means vitest collects NO tests from this file, and the suite total
 * reported them as SKIPPED rather than failed. A loud failure became a quieter one at exactly the
 * moment the thing it guards moved. So the marker check now runs as an assertion INSIDE a test,
 * where a failure is a failure.
 *
 * The subject is the shared module now: one definition, which is the point of #364 — the restore
 * route and the restore-points read filter against the same set, so a moment the drawer offers
 * cannot be one the endpoint silently declines.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RESTORABLE_FIELDS, notRestorableReason } from './useRecordState'
import { PIM_DIR } from './api-source.testutil'

const ROUTES = join(PIM_DIR, '..', '..', 'routes', 'products.routes.ts')
const SHARED = join(PIM_DIR, 'restorable-fields.ts')

/** Returns the field names, or a REASON it could not — never a throw at module scope. */
function sharedAllowedSet(): { fields: string[]; problem: string | null } {
  // Every failure path RETURNS. `readFileSync` on a renamed file throws, and a throw out here is
  // collected as "no tests" rather than as a failure — which is exactly how this suite went quiet.
  let src: string
  try {
    src = readFileSync(SHARED, 'utf8')
  } catch (e) {
    return { fields: [], problem: `restorable-fields.ts could not be read: ${(e as Error).message}` }
  }
  const marker = src.indexOf('export const RESTORABLE_MASTER_FIELDS')
  if (marker === -1) {
    return { fields: [], problem: 'restorable-fields.ts no longer exports RESTORABLE_MASTER_FIELDS' }
  }
  const open = src.indexOf('new Set([', marker)
  if (open === -1) return { fields: [], problem: 'RESTORABLE_MASTER_FIELDS is no longer a `new Set([…])` literal' }
  const end = src.indexOf('])', open)
  const block = src.slice(open, end)
  return { fields: [...block.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]), problem: null }
}

describe('RESTORABLE_FIELDS mirrors the restore allow-list', () => {
  const { fields: allowed, problem } = sharedAllowedSet()

  it('the extractor actually read something', () => {
    // Guard the tool before trusting it — a silently-empty extractor is a green test that checked
    // nothing (#60). Asserted here rather than thrown at import, so it FAILS instead of skipping.
    expect(problem).toBeNull()
    expect(allowed.length).toBeGreaterThan(10)
    expect(allowed).toContain('name')
  })

  it('the restore route still filters against that shared set, not a second copy', () => {
    // The mirror is only meaningful if the ROUTE actually honours this module. If the route grows
    // its own literal again, this mirror is pinned to the wrong thing and says nothing.
    let src = ''
    try {
      src = readFileSync(ROUTES, 'utf8')
    } catch (e) {
      expect.fail(`products.routes.ts could not be read: ${(e as Error).message}`)
    }
    const at = src.indexOf("'/products/:id/restore'")
    expect(at, 'the /products/:id/restore handler moved or was renamed').toBeGreaterThan(-1)
    expect(src).toContain('RESTORABLE_MASTER_FIELDS')
    expect(src.slice(at, at + 4000)).toContain('const ALLOWED = RESTORABLE_MASTER_FIELDS')
  })

  it('every field the route accepts is offered by the pane', () => {
    const notOffered = allowed.filter((f) => !RESTORABLE_FIELDS.has(f))
    expect(notOffered, `route accepts these but the pane hides them: ${notOffered.join(', ')}`).toEqual([])
  })

  it('the pane offers nothing the route would silently drop', () => {
    const wouldBeDropped = [...RESTORABLE_FIELDS].filter((f) => !allowed.includes(f))
    expect(
      wouldBeDropped,
      `pane offers these but the route filters them out — a restore would under-apply: ${wouldBeDropped.join(', ')}`,
    ).toEqual([])
  })

  it('excludes attributes, which the route cannot restore', () => {
    expect(RESTORABLE_FIELDS.has('attr_material')).toBe(false)
    expect(notRestorableReason('attr_material', 'unchanged')).toMatch(/Schema attribute/)
  })
})

describe('notRestorableReason', () => {
  it('🔴 an `uncertain` field is refused whatever else is true of it', () => {
    // Owner decision: uncertain fields are EXCLUDED, not defaulted off. The server graded them
    // uncertain because no prior value was recorded — restoring writes a value nobody has.
    expect(notRestorableReason('name', 'uncertain')).toMatch(/never recorded/)
    // Uncertainty outranks restorability: `name` IS in the allow-list and still refused.
    expect(RESTORABLE_FIELDS.has('name')).toBe(true)
  })

  it('lets a recoverable field through', () => {
    expect(notRestorableReason('name', 'reconstructed')).toBeNull()
    expect(notRestorableReason('basePrice', 'unchanged')).toBeNull()
  })
})
