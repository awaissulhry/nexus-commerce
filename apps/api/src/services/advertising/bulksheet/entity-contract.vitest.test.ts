/**
 * The entity contract: what the grammar DECLARES it will apply must equal what
 * the apply path actually writes.
 *
 * This exists because those two drifted, in the dangerous direction. Three
 * entities — Campaign negative keyword, Product targeting, Negative product
 * targeting — declared `applySupported: false`, so import validation stamped
 * their rows PREVIEW_ONLY and told the operator nothing would be written. The
 * apply path wrote them anyway: it dispatched on entity name with a bare `else`
 * that swept all five AdTarget entities into `updateAdTargetWithSync`, and
 * nothing downstream of validation ever read the flag.
 *
 * Nothing caught it because `applySupported` had no test tying it to behaviour —
 * it was a comment that happened to compile. These are that tie.
 */
import { describe, it, expect } from 'vitest'
import {
  ENTITY_RULES, AD_TARGET_ENTITIES, isAdTargetEntity, entityRule, validateRow,
} from '@nexus/shared/ads-bulksheet'

/**
 * The entities `applyPlan` has a real branch for, transcribed from its dispatch.
 * The source ratchet at the bottom is what keeps this honest.
 */
const APPLY_BRANCHES = ['Campaign', 'Portfolio', 'Ad group', 'Product ad', ...AD_TARGET_ENTITIES]

const declaredApplied = ENTITY_RULES.filter((r) => r.applySupported).map((r) => r.entity)
const declaredUnapplied = ENTITY_RULES.filter((r) => !r.applySupported).map((r) => r.entity)

describe('declaration matches dispatch', () => {
  it('every entity apply can write declares applySupported: true', () => {
    for (const e of APPLY_BRANCHES) {
      expect(entityRule(e)?.applySupported, `${e} is written by apply but declares applySupported: false — validation will tell the operator it is PREVIEW_ONLY and then write it`).toBe(true)
    }
  })

  it('every entity declaring applySupported: true has an apply branch', () => {
    for (const e of declaredApplied) {
      expect(APPLY_BRANCHES, `${e} promises to apply but applyPlan has no branch for it`).toContain(e)
    }
  })

  it('the two sets are exactly equal — no entity in one and not the other', () => {
    expect([...declaredApplied].sort()).toEqual([...APPLY_BRANCHES].sort())
  })
})

describe('the regression itself', () => {
  const update = (entity: string, extra: Record<string, string> = {}) => {
    const v: Record<string, string> = { Product: 'Sponsored Products', Entity: entity, Operation: 'Update', State: 'paused', ...extra }
    return validateRow((h) => v[h] ?? '')
  }

  it('no AdTarget entity is reported PREVIEW_ONLY', () => {
    // Before the fix this returned previewOnly: true for the last three, which
    // is what the operator saw in the validation report.
    const ids: Record<string, Record<string, string>> = {
      'Keyword': { 'Keyword ID': '1' },
      'Negative keyword': { 'Keyword ID': '2' },
      'Campaign negative keyword': { 'Keyword ID': '3' },
      'Product targeting': { 'Product Targeting ID': '4' },
      'Negative product targeting': { 'Product Targeting ID': '5' },
    }
    for (const e of AD_TARGET_ENTITIES) {
      const v = update(e, ids[e])
      expect(v.ok, `${e}: ${v.issues.map((i) => i.message).join('; ')}`).toBe(true)
      expect(v.previewOnly, `${e} previews as "will not be applied" but apply writes it`).toBe(false)
    }
  })

  it('all five AdTarget entities share one write path, so they share one verdict', () => {
    // They are one Prisma model and one mutation function. Any split between
    // them is a declaration bug by construction, not a capability difference.
    const verdicts = new Set(AD_TARGET_ENTITIES.map((e) => entityRule(e)?.applySupported))
    expect(verdicts.size, 'AdTarget entities disagree about being applicable').toBe(1)
    expect([...verdicts][0]).toBe(true)
  })
})

describe('the entities that really are unwired stay honest', () => {
  it('Bidding adjustment is the only one left', () => {
    // Not a capability gap we forgot: a placement percentage lives inside
    // campaign.dynamicBidding, and its only write path pushes to Amazon inline —
    // no changeSetId, no queued mode. Applying one from a bulksheet would go
    // live on a non-live apply and survive the rollback of its own upload.
    expect([...declaredUnapplied].sort()).toEqual(['Bidding adjustment'])
  })

  it('preview explains that specific reason rather than a generic "not wired up"', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'preview.ts'), 'utf8')
    expect(src).toMatch(/Placement bid adjustments cannot be applied from a bulksheet yet/)
  })

  it('neither is an AdTarget entity, so preview cannot fall into that branch', () => {
    // This is the guard that makes their UNSUPPORTED status structural rather
    // than a happy accident of branch ordering.
    for (const e of declaredUnapplied) expect(isAdTargetEntity(e), `${e} would be treated as an AdTarget`).toBe(false)
  })

  it('isAdTargetEntity accepts Amazon’s casing, not just ours', () => {
    // Operators paste rows out of Amazon's own downloads.
    expect(isAdTargetEntity('keyword')).toBe(true)
    expect(isAdTargetEntity('Negative Product Targeting')).toBe(true)
    expect(isAdTargetEntity('')).toBe(false)
    expect(isAdTargetEntity('Nonsense')).toBe(false)
  })
})

describe('source ratchet — APPLY_BRANCHES above must still describe apply.ts', () => {
  const read = async (): Promise<string> => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'apply.ts'), 'utf8')
  }

  it('dispatches on exactly the entities this file lists', async () => {
    const src = await read()
    const branched = [...src.matchAll(/row\.entity === '([^']+)'/g)].map((m) => m[1])
    // The AdTarget five are covered by the helper, not by name.
    expect(src).toMatch(/isAdTargetEntity\(row\.entity\)/)
    expect(branched.sort()).toEqual(['Ad group', 'Campaign', 'Portfolio', 'Product ad'])
  })

  it('has no catch-all else that could write an unknown entity to AdTarget', async () => {
    const src = await read()
    // The shape that caused this: `} else {` immediately before the AdTarget
    // write. The final else must refuse, not write.
    expect(src).toMatch(/has no apply path/)
    const adTargetCall = src.indexOf('updateAdTargetWithSync({')
    const guard = src.indexOf('isAdTargetEntity(row.entity)')
    expect(guard, 'the AdTarget write is no longer behind an entity check').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(adTargetCall)
  })
})
