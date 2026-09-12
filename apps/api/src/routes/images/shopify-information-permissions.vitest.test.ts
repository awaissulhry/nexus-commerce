import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
const fixture = vi.hoisted(() => ({ permissions: [] as string[], draft: { mediaEdits: [] as unknown[], nativeEdits: [] as unknown[] }, saves: vi.fn(), sync: vi.fn(), cells: vi.fn() }))
vi.mock('../../services/shopify/content-workspace.service.js', () => ({ contentDestination: async (_: string, query: any) => ({ accountId: query.accountId }) }))
vi.mock('../../services/shopify/linked-products.service.js', () => ({ getLinkedWorkspace: async () => ({ draft: fixture.draft }), saveLinkedWorkspace: (...args: unknown[]) => fixture.saves(...args), beginLinkedSync: (...args: unknown[]) => fixture.sync(...args) }))
vi.mock('../../services/shopify/channel-sheet.service.js', async importOriginal => ({ ...await importOriginal<object>(), saveShopifySheetCells: (...args: unknown[]) => fixture.cells(...args) }))
import { shopifyLinkedProductsRoutes } from './shopify-linked-products.routes.js'
beforeEach(() => { fixture.permissions = []; fixture.draft = { mediaEdits: [], nativeEdits: [] }; fixture.saves.mockReset(); fixture.sync.mockReset(); fixture.cells.mockReset() })
async function call(method: 'PUT' | 'POST', suffix: string, payload: unknown) {
  const app = Fastify()
  app.addHook('preHandler', async request => { request.__rbacResolved = { isOwner: false, permissions: new Set(fixture.permissions) } })
  await app.register(shopifyLinkedProductsRoutes)
  try { return await app.inject({ method, url: `/products/product-1/shopify-linked${suffix}?accountId=store-b&market=GLOBAL&locale=it`, payload: payload as any }) } finally { await app.close() }
}
describe('Information route permissions and destination forwarding', () => {
  it('separates draft editing and Shopify publication permissions in the application manifest', () => {
    expect(permissionForRoute('PUT', '/api/products/product-1/shopify-linked')).toBe('products.edit')
    expect(permissionForRoute('POST', '/api/products/product-1/shopify-linked/synchronize')).toBe('products.publish')
    expect(permissionForRoute('POST', '/api/products/product-1/shopify-linked/advance')).toBe('products.publish')
  })
  it('authorizes common sheet cell writes and forwards their exact destination', async () => {
    expect(permissionForRoute('POST', '/api/products/product-1/shopify-linked/cells')).toBe('products.edit')
    const body = { cells: [{ colId: 'availableQuantity', ownerId: 'gid://shopify/ProductVariant/1', fieldId: 'inventory', token: 'observed', baseline: null, value: null, intent: 'set' }] }
    expect((await call('POST', '/cells', body)).statusCode).toBe(403)
    expect(fixture.cells).not.toHaveBeenCalled()
    fixture.permissions = ['inventory.adjust']; fixture.cells.mockResolvedValue({ ok: true, cells: {} })
    expect((await call('POST', '/cells', body)).statusCode).toBe(200)
    expect(fixture.cells.mock.calls[0][1]).toMatchObject({ accountId: 'store-b', locale: 'it', market: 'GLOBAL' })
  })
  it('rejects changed galleries without the additional media permission before saving', async () => {
    const result = await call('PUT', '', { draft: { mediaEdits: [{ productId: 'remote' }] } })
    expect(result.statusCode).toBe(403); expect(fixture.saves).not.toHaveBeenCalled()
  })
  it('forwards the exact account and language for an authorized draft', async () => {
    fixture.permissions = ['products.images.edit']; fixture.saves.mockResolvedValue({ revision: 'saved' })
    const result = await call('PUT', '', { draft: { mediaEdits: [{ productId: 'remote' }] } })
    expect(result.statusCode).toBe(200); expect(fixture.saves.mock.calls[0][1]).toMatchObject({ accountId: 'store-b', locale: 'it', market: 'GLOBAL' })
  })
  it('requires inventory adjustment access when synchronizing an inventory command', async () => {
    fixture.draft.nativeEdits = [{ field: 'inventory' }]
    const denied = await call('POST', '/synchronize', {})
    expect(denied.statusCode).toBe(403); expect(fixture.sync).not.toHaveBeenCalled()
    fixture.permissions = ['inventory.adjust']; fixture.sync.mockResolvedValue({ status: 'RUNNING' })
    expect((await call('POST', '/synchronize', {})).statusCode).toBe(200)
  })
})
