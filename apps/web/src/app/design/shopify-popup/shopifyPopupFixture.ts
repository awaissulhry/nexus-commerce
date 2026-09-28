/**
 * A made-up Shopify store for the pop-up lab (/design/shopify-popup). Every name, id, handle and picture is invented:
 * the repository is public, so no real store id, handle or product may appear here. Ids use the `gid://shopify/…`
 * shape so the real validation code accepts them; the numbers are small and fake.
 */
import type { ShopifyFieldDefinition, ShopifyReference, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

/** A drawn picture (a garment outline) — no text inside, so it never falls back to a system font. */
export const drawn = (seed: string, ink = 'black') => {
  const n = [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3 + 1
  const stripes = Array.from({ length: n }, (_, i) => `<rect x="70" y="${90 + i * 40}" width="60" height="14" rx="7" fill="${ink}"/>`).join('')
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><path d="M60 40 L140 40 L170 80 L150 90 L150 170 L50 170 L50 90 L30 80 Z" fill="none" stroke="${ink}" stroke-width="6"/>${stripes}</svg>`)}`
}
/** A drawn icon: a circle with a mark. */
const icon = (seed: string) => {
  const r = 20 + ([...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 30)
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="40" fill="none" stroke="black" stroke-width="6"/><circle cx="50" cy="50" r="${r / 2}" fill="black"/></svg>`)}`
}

const def = (id: number, key: string, name: string, type: string, validations: ShopifyFieldDefinition['validations'] = []): ShopifyFieldDefinition => ({
  id: `gid://shopify/MetafieldDefinition/${id}`, name, description: null, namespace: 'custom', key, ownerType: 'PRODUCT', type, validations,
  access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
})
const entryDef = (id: number, type: string, name: string) => ({ id: `gid://shopify/MetaobjectDefinition/${id}`, name, type, description: null, access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' }, fields: [] })

export const LAB_FIELDS = {
  colour: def(1, 'color_pattern', 'Color', 'list.metaobject_reference', [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/1' }]),
  icons: def(2, 'text_with_icon', 'Text with icon', 'list.metaobject_reference', [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/2' }]),
  concise: def(3, 'concise_description', 'Concise description', 'metaobject_reference', [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/3' }]),
  products: def(4, 'variation_products', 'Variation products', 'list.product_reference'),
  sizeChart: def(5, 'size_chart', 'Size chart', 'file_reference', [{ name: 'file_type_options', value: '["Image"]' }]),
  swatch: def(6, 'swatch_color', 'Swatch colour', 'color'),
}

export const LAB_SCHEMA: ShopifyStoreSchema = {
  definitions: Object.values(LAB_FIELDS),
  metaobjectDefinitions: [entryDef(1, 'shopify--color-pattern', 'Color'), entryDef(2, 'text_with_icon', 'Text with icon'), entryDef(3, 'concise_description', 'Concise description')],
  types: [], locales: [{ locale: 'en', primary: true, published: true }], revision: 'lab', currency: 'EUR',
}

const entry = (n: number, type: string, label: string, extra: Partial<ShopifyReference>): ShopifyReference => ({ id: `gid://shopify/Metaobject/${n}`, label, image: null, type, handle: label.toLowerCase().replace(/\W+/g, '-'), available: true, ...extra })

export const LAB_REFERENCES: ShopifyReference[] = [
  ...[['Green', '#3c9a4b'], ['Black', '#111111'], ['Beige', '#e6d8b0'], ['Blue', '#2458d6'], ['Bronze', '#b8733a'], ['Brown', '#7a4a2a'], ['Clear', '#ffffff'],
    ['Gold', '#caa03a'], ['Gray', '#8a8a8a'], ['Navy', '#232a8f'], ['Orange', '#e8742a'], ['Pink', '#e58fb3'], ['Purple', '#7a3fb0'], ['Red', '#c8312f'],
    ['White', '#fafafa'], ['Yellow', '#e9c92e']].map(([label, hex], i) => entry(100 + i, 'shopify--color-pattern', label, { swatch: hex })),
  ...['Water-repellent', 'Regular fit', 'Air vents', 'Tough fabric'].map((label, i) => entry(200 + i, 'text_with_icon', label, { image: icon(label) })),
  ...['Moss', 'Airmesh', 'Ventra', 'Classic'].map((label, i) => entry(300 + i, 'concise_description', label, {})),
  ...['Sample Jacket', 'Sample Jacket · Grey', 'Sample Jacket · Olive', 'Sample Pant', 'Sample Vest', 'Sample Gloves', 'Sample Boots', 'Sample Suit']
    .map((label, i) => ({ id: `gid://shopify/Product/${900 + i}`, label, image: drawn(label, i % 2 ? 'dimgray' : 'black'), type: 'Product', handle: label.toLowerCase().replace(/\W+/g, '-'), available: true })),
  ...['Size chart (IT)', 'Size chart (DE)', 'Care label'].map((label, i) => ({ id: `gid://shopify/MediaImage/${700 + i}`, label, image: drawn(label, 'navy'), type: 'MediaImage', available: true })),
]

/** The lab's starting values — one per field. */
export const LAB_START: Record<keyof typeof LAB_FIELDS, string | null> = {
  colour: JSON.stringify(['gid://shopify/Metaobject/101']),
  icons: JSON.stringify(['gid://shopify/Metaobject/200', 'gid://shopify/Metaobject/201', 'gid://shopify/Metaobject/202']),
  concise: 'gid://shopify/Metaobject/300',
  products: JSON.stringify(['gid://shopify/Product/900', 'gid://shopify/Product/901', 'gid://shopify/Product/902']),
  sizeChart: 'gid://shopify/MediaImage/700',
  swatch: '#2458d6',
}

/** The lab's product id. Only calls addressed to it are answered by the lab (see `installLabShopify`). */
export const LAB_PRODUCT = 'design-lab-product'

const kindOf: Record<string, (r: ShopifyReference) => boolean> = {
  metaobject_reference: r => r.id.includes('/Metaobject/'),
  product_reference: r => r.id.includes('/Product/'),
  file_reference: r => r.id.includes('/MediaImage/'),
}

/**
 * Answer the Shopify reference reads for the LAB PRODUCT only, from the made-up store above. Installed once, on the
 * lab page. Every other request goes to the real API untouched.
 */
let installed = false
export function installLabShopify() {
  if (typeof window === 'undefined' || installed) return
  installed = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (!url.pathname.includes(`/api/products/${LAB_PRODUCT}/shopify-linked/`)) return real(input, init)
    await new Promise(resolve => setTimeout(resolve, 150))
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname.endsWith('/reference-names')) {
      const ids: string[] = JSON.parse(String(init?.body ?? '{}')).ids ?? []
      return json(ids.map(id => LAB_REFERENCES.find(r => r.id === id) ?? { id, label: 'Unavailable reference', image: null, available: false }))
    }
    if (url.pathname.endsWith('/references')) {
      const type = (url.searchParams.get('type') ?? '').replace(/^list\./, '')
      const entryType = url.searchParams.get('metaobjectType')
      const query = (url.searchParams.get('query') ?? '').toLowerCase()
      const items = LAB_REFERENCES.filter(r => (kindOf[type]?.(r) ?? false) && (!entryType || r.type === entryType) && (!query || r.label.toLowerCase().includes(query)))
      return json({ items, cursor: null })
    }
    return new Response(JSON.stringify({ error: 'Not available in the lab' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
}
