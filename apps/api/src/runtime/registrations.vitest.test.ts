import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * After the process split, a registry filled only in the API was empty in the worker:
 * every outbound job there failed its token refresh with "No ChannelSpec registered".
 * This holds the shared registrations to every process entry point.
 */
describe('registries every process shares', () => {
  it('registers every channel spec and the cross-process automation actions', async () => {
    await import('./registrations.js')
    const { listChannelSpecs } = await import('../services/cx/catalog.js')
    const { ACTION_HANDLERS } = await import('../services/automation-rule.service.js')
    expect(listChannelSpecs().map(spec => spec.key).sort()).toEqual(['AMAZON_ADS', 'AMAZON_SP', 'EBAY', 'ETSY', 'SHOPIFY'])
    for (const action of ['create_bulk_job', 'apply_bulk_template', 'pause_schedules_matching',
      'update_product_bullets_from_review', 'create_aplus_module_from_review']) {
      expect(ACTION_HANDLERS[action], action).toBeTypeOf('function')
    }
  })

  it.each([
    ['API', '../index.ts', 'import "./runtime/registrations.js"'],
    ['worker', './worker.ts', "import './registrations.js'"],
    ['scheduler', './scheduler.ts', "import './registrations.js'"],
  ])('the %s process loads them', (_role, file, statement) => {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(statement)
  })
})
