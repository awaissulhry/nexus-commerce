/** Amazon sheet gaps — one EU-target rule for the Matrix door and the listings screens, keyed on any primary listing. */
import { describe, expect, it } from 'vitest'
import { pickSharedInventoryTargets, sharesAmazonEuInventory } from './shared-inventory-targets.js'

const primary = (over: Record<string, unknown> = {}) => ({ id: 'it', productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '', version: 3, ...over })
const rows = [
  { id: 'fr', marketplace: 'FR', version: 1, offerClosedAt: null },
  { id: 'it', marketplace: 'IT', version: 3, offerClosedAt: null },
  { id: 'de', marketplace: 'DE', version: 7, offerClosedAt: null },
  { id: 'es', marketplace: 'ES', version: 2, offerClosedAt: new Date() },
]

describe('pickSharedInventoryTargets', () => {
  it('an Amazon EU listing reaches every open EU row of the SKU, in the Matrix\'s market order', () => {
    expect(pickSharedInventoryTargets(primary(), rows)).toEqual({
      targets: [{ id: 'it', marketplace: 'IT', version: 3 }, { id: 'de', marketplace: 'DE', version: 7 }, { id: 'fr', marketplace: 'FR', version: 1 }],
      expandedTo: ['IT', 'DE', 'FR'],
    })
  })

  it('the primary moved → conflict with its version; gone → conflict 0', () => {
    expect(pickSharedInventoryTargets(primary({ version: 2 }), rows)).toEqual({ conflict: 3 })
    expect(pickSharedInventoryTargets(primary({ id: 'gone' }), rows)).toEqual({ conflict: 0 })
  })

  it('a closed primary is left out by the Matrix rule and kept with primary: "always"', () => {
    const es = primary({ id: 'es', marketplace: 'ES', version: 2 })
    expect((pickSharedInventoryTargets(es, rows) as any).targets.map((t: any) => t.id)).toEqual(['it', 'de', 'fr'])
    expect((pickSharedInventoryTargets(es, rows, { primary: 'always' }) as any).targets.map((t: any) => t.id)).toEqual(['it', 'de', 'fr', 'es'])
  })

  it('a non-EU market, another channel or an alias is its own only target', () => {
    for (const p of [primary({ marketplace: 'UK' }), primary({ channel: 'EBAY' }), primary({ aliasKey: 'a1' })]) {
      expect(sharesAmazonEuInventory(p)).toBe(false)
      expect(pickSharedInventoryTargets(p, rows)).toEqual({ targets: [{ id: p.id, marketplace: p.marketplace, version: 3 }] })
    }
  })
})
