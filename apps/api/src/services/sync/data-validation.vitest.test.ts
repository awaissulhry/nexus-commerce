/**
 * The product check behind the PUBLIC /admin/health and /monitoring routes.
 *
 * Measured 2026-09-16: inside a profile every run failed ("Argument `product` must not be null" — an
 * invalid orphan query), and with no profile it failed with "Select a business profile." The catch
 * turned both into a report the health routes printed as "healthy, 0 issues".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const SECOND = 'ws_validation_second'
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('product validation across business profiles', () => {
  let service: InstanceType<typeof import('./data-validation.service.js').DataValidationService>
  let validationDidNotRun: typeof import('./data-validation.service.js').validationDidNotRun

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    const mod = await import('./data-validation.service.js')
    service = new mod.DataValidationService()
    validationDidNotRun = mod.validationDidNotRun
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
      VALUES ($1, 'Second business', 'active', false, 'test', 'test-second', CURRENT_TIMESTAMP)`, [SECOND])
    // Legacy profile: a product with variants but no variation theme.
    await inProfile(LEGACY_WORKSPACE_ID, async () => {
      const product = await database.client.product.create({ data: { sku: 'NO-THEME', name: 'No theme', basePrice: 10 } })
      await database.client.productVariation.create({ data: { productId: product.id, sku: 'NO-THEME-1', price: 10, variationAttributes: { size: 'M' } } })
    })
    // Second profile: a variant with no attributes, and a listing with no product.
    await inProfile(SECOND, async () => {
      const product = await database.client.product.create({ data: { sku: 'THEMED', name: 'Themed', basePrice: 10, variationTheme: 'Size' } })
      await database.client.productVariation.create({ data: { productId: product.id, sku: 'THEMED-1', price: 10 } })
      const channel = await database.client.channel.create({ data: { type: 'EBAY', name: 'eBay' } })
      await database.client.listing.create({ data: { channelId: channel.id, channelPrice: 5 } })
    })
    // PGlite starts in-process; ~2 s alone, starved past the 10 s default under the full hook suite
    // (profiles-ON ratchet, 2026-09-22). The same load budget the other PGlite suites set.
  }, 120_000)
  afterAll(async () => { process.env.NEXUS_WORKSPACES_ENABLED = flagBefore; await database.close() })

  it('with no profile in scope (the PUBLIC health routes), checks every active profile and sums the findings', async () => {
    const report = await service.validateAllProducts()
    expect(validationDidNotRun(report)).toBe(false)
    expect(report).toMatchObject({ isValid: false, orphanedVariants: 0, inconsistentThemes: 1, missingAttributes: 1, invalidChannelListings: 1 })
  })

  it('inside one profile, checks only that profile', async () => {
    const report = await inProfile(SECOND, () => service.validateAllProducts())
    expect(validationDidNotRun(report)).toBe(false)
    expect(report).toMatchObject({ inconsistentThemes: 0, missingAttributes: 1, invalidChannelListings: 1 })
  })

  it('names a check that could not run, so no caller can print it as healthy', () => {
    expect(validationDidNotRun({ isValid: false, orphanedVariants: 0, inconsistentThemes: 0, missingAttributes: 0, invalidChannelListings: 0, issues: [{ type: 'VALIDATION_ERROR', severity: 'ERROR', message: 'Select a business profile.' }] })).toBe(true)
    expect(validationDidNotRun({ isValid: true, orphanedVariants: 0, inconsistentThemes: 0, missingAttributes: 0, invalidChannelListings: 0, issues: [] })).toBe(false)
  })
})
