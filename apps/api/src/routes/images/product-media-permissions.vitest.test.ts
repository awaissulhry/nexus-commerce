import { describe, expect, it } from 'vitest'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
describe('Product media permissions', () => {
  it('requires product view for media reads and media edit for draft saves and video uploads', () => {
    expect(permissionForRoute('GET', '/api/products/:productId/product-media')).toBe('products.view')
    expect(permissionForRoute('PUT', '/api/products/:productId/product-media')).toBe('products.images.edit')
    expect(permissionForRoute('POST', '/api/products/:id/videos')).toBe('products.images.edit')
  })
})
