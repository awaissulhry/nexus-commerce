import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Product links on the Products page stay inside the business they are opened in (audit C7, 2026-10-01): the grid's
 * cells link with `next/link` and plain `<a>`s, which drop `/w/<id>`, so the links carry it themselves.
 */
describe('product links keep the business', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

  const load = async (pathname: string) => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    vi.stubGlobal('window', { location: { pathname }, open: vi.fn() })
    vi.resetModules() // `WORKSPACES_ENABLED` is read when paths.ts loads
    return import('./columns')
  }
  const row = { id: 'prod_1', name: 'Gale', sku: 'GALE', parentId: null } as never

  it('prefixes the studio, new-tab and family links with the open business', async () => {
    const { familyHref, rowActions } = await load('/w/ws_motovento/products')
    expect(familyHref('prod_1')).toBe('/w/ws_motovento/products?parent=prod_1')
    const navigate = vi.fn()
    const actions = rowActions(row, { onDuplicate: () => {}, navigate })
    actions.find((a) => a.id === 'edit')!.onSelect!()
    expect(navigate).toHaveBeenCalledWith('/w/ws_motovento/products/prod_1/edit/studio')
    actions.find((a) => a.id === 'open-new')!.onSelect!()
    expect((window as unknown as { open: ReturnType<typeof vi.fn> }).open).toHaveBeenCalledWith('/w/ws_motovento/products/prod_1/edit/studio', '_blank')
  })

  it('leaves the links as they are outside a business URL', async () => {
    const { familyHref } = await load('/products')
    expect(familyHref('prod_1')).toBe('/products?parent=prod_1')
  })
})
