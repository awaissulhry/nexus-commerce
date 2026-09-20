/**
 * P4.3 — Etsy does not get to write our stock.
 *
 * ## What was measured (2026-09-20)
 *
 * `syncInventoryFromEtsy` read an Etsy listing and wrote Etsy's numbers straight
 * into our database: `ProductVariation.stock` per variation and
 * `Product.totalStock` for the parent, with `prisma.update`, bypassing
 *
 *   - the stock resolver, the one place a quantity is decided;
 *   - the shared-stock POOL, where a pooled product's own stock is deliberately
 *     0 and `StockLevel` holds the truth — so writing `totalStock` from a
 *     channel makes every screen that reads it lie;
 *   - any audit at all.
 *
 * ## Had it ever run?
 *
 * Almost certainly not. `etsy-sync` is registry-only — a manual trigger, never
 * scheduled — and both entry points need `ConfigManager.getConfig('ETSY')` while
 * production boots with `[ConfigManager] ⚠ Etsy configuration incomplete
 * (missing env vars)`. P2.5 separately measured that **no Etsy order had ever
 * entered Nexus by any route**.
 *
 * **That is what made it dangerous rather than harmless**: a manual trigger
 * nobody had pulled, one environment variable away from overwriting pooled stock
 * with no audit trail and no error. The P2.1–P2.5 shape — referenced by working
 * code, never once executed — except this one would have done damage when it
 * finally ran.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')
const service = readFileSync(join(SRC, 'services', 'sync', 'etsy-sync.service.ts'), 'utf8')

/** The file with comments stripped — a claim about what the code DOES. */
const code = service
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

/** Just the function under test, so a write elsewhere in the file is not blamed on it. */
const fn = code.slice(
  code.indexOf('async syncInventoryFromEtsy('),
  code.indexOf('async syncOrders('),
)

describe('the inbound stock write is gone', () => {
  it('writes nothing at all', () => {
    expect(fn.length).toBeGreaterThan(100) // positive control: we found the function
    for (const write of ['prisma', 'update(', 'upsert(', 'productVariation', 'totalStock', 'stock:']) {
      expect(fn, `syncInventoryFromEtsy must not ${write}`).not.toContain(write)
    }
  })

  it('does not read Etsy either — there is nothing to read it for', () => {
    expect(fn).not.toContain('getListing(')
    expect(fn).not.toContain('estyService')
  })

  it('still exists, so its two callers keep working', () => {
    const job = readFileSync(join(SRC, 'jobs', 'etsy-sync.job.ts'), 'utf8')
    const route = readFileSync(join(SRC, 'routes', 'etsy.ts'), 'utf8')
    expect(job).toContain('syncInventoryFromEtsy(')
    expect(route).toContain('syncInventoryFromEtsy(')
    expect(code).toContain('async syncInventoryFromEtsy(')
  })
})

describe('the refusal says what happened and what to do', () => {
  it('reports failure rather than a quiet success', () => {
    // `success: true, updated: 0` would read as "ran, nothing to do" — the false
    // green this programme keeps finding. It refused; it must say so.
    expect(fn).toContain('success: false')
    expect(fn).toContain('updated: 0')
  })

  it('names the reason and the alternative', () => {
    expect(fn).toContain('Etsy cannot write stock into Nexus')
    expect(fn).toContain('stock resolver')
    expect(fn).toContain('pooled stock')
    expect(fn).toContain('Set the quantity in Nexus instead')
  })

  it('leaves a log line, so a pulled trigger is visible', () => {
    expect(fn).toContain('Refused inbound Etsy stock write')
  })
})

describe('the refusal actually refuses', () => {
  it('returns the refusal and touches no database', async () => {
    // Behaviour, not shape: the module is imported with prisma stubbed to throw
    // on ANY access, so a single write would fail the test loudly.
    const trap: any = new Proxy({}, {
      get() { throw new Error('THE REFUSAL TOUCHED THE DATABASE') },
    })
    vi.doMock('../../db.js', () => ({ default: trap }))
    const mod: any = await import('./etsy-sync.service.js')
    const Svc = mod.EstySyncService ?? mod.EtsySyncService ?? mod.default
    expect(Svc, 'the service class must be exported').toBeTruthy()
    // The constructor validates credentials, so the fixture carries fake ones.
    // They are never used: the refusal returns before anything reaches Etsy.
    const instance = new Svc({
      channel: 'ETSY', isEnabled: true,
      accessToken: 'fake-token', shopId: 'fake-shop', apiVersion: '3.0.0',
    } as any)
    const result = await instance.syncInventoryFromEtsy('product-1')
    expect(result.success).toBe(false)
    expect(result.updated).toBe(0)
    expect(result.errors[0].error).toContain('Etsy cannot write stock into Nexus')
  })
})
