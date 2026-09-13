import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], send: vi.fn() }))
vi.mock('../db.js', () => ({ default: { productVariation: { findUnique: async () => ({ woocommerceVariationId: 2, product: { id: 'product', woocommerceProductId: 1 } }) }, channelListing: { findMany: async () => s.controls } } }))
vi.mock('./marketplaces/woocommerce.service.js', () => ({ WooCommerceService: class { updateVariationStock = s.send } }))
vi.mock('./sales-aggregate.service.js', () => ({ recordOrderItem: vi.fn() }))
import { WooCommerceSyncService } from './sync/woocommerce-sync.service.js'
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.controls = [{}] })
it.each(locks)('contains the legacy Woo quantity writer for %j', async lock => {
 s.controls = [lock]
 await expect(new WooCommerceSyncService({} as any).syncInventoryToWooCommerce('variant', 4)).rejects.toThrow(/^PUSH_/)
 expect(s.send).not.toHaveBeenCalled()
})
it('refuses absent controls and lets the unlocked control reach one mocked update', async () => {
 s.controls = []; await expect(new WooCommerceSyncService({} as any).syncInventoryToWooCommerce('variant', 4)).rejects.toThrow('PUSH_CONTROL_UNAVAILABLE')
 expect(s.send).not.toHaveBeenCalled(); s.controls = [{}]
 await new WooCommerceSyncService({} as any).syncInventoryToWooCommerce('variant', 4)
 expect(s.send).toHaveBeenCalledWith(1, 2, 4)
})
