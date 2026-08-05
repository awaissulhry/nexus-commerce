/** READ-ONLY: render Xavia Modernist to a file so the policy tabs can be
 *  eyeballed at mobile width. No DB, no eBay. */
import { writeFileSync } from 'node:fs'
const { BUILT_IN_THEMES, renderDescriptionTheme } = await import('../src/services/ebay-description-render.js')

const theme = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!
const { html, warnings } = renderDescriptionTheme(theme.html, {
  market: 'IT',
  title: 'XAVIA AIRMESH Giacca Moto Estiva Uomo Rete Traspirante CE',
  subtitle: 'Giacca estiva in rete',
  body: '<p>Corpo descrizione di esempio.</p>',
  sku: 'AIRMESH-JACKET',
  brand: 'Xavia',
  mode: 'group',
  // WITH images — an empty gallery masked the duplicate-hero regression.
  sharedImages: [
    'https://picsum.photos/seed/a/600', 'https://picsum.photos/seed/b/600',
    'https://picsum.photos/seed/c/600', 'https://picsum.photos/seed/d/600',
  ],
  imagesByGroup: [{ value: 'Nero', urls: ['https://picsum.photos/seed/e/600'] }],
  aspects: [{ name: 'Marca', value: 'Xavia' }, { name: 'Colore', value: 'Nero' }],
  policies: { shipping: 'Spedizione 24h', returns: 'Resi 30 giorni', payment: 'Pagamento eBay' },
})

const out = process.argv[2] ?? '/tmp/modernist-tabs.html'
writeFileSync(out, html)
console.log(`wrote ${out} (${html.length} chars); warnings: ${warnings.length ? warnings.join(' | ') : 'none'}`)
