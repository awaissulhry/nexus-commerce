/** READ-ONLY: reproduce the operator-reported broken preview from the exact
 *  mistake that shipped, and show why it destroyed the whole theme. */
const { BUILT_IN_THEMES, renderDescriptionTheme } = await import('../src/services/ebay-description-render.js')
const good = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!.html
const broken = good.replace('Mechanism deliberately matches the hero gallery token',
  'Mechanism deliberately matches {{gallery_hero}}')
const data: any = {
  market: 'IT', title: 'T', subtitle: '', body: '<p>b</p>', sku: 'S', brand: 'X', mode: 'group',
  sharedImages: ['https://x/1.jpg', 'https://x/2.jpg'], imagesByGroup: [], aspects: [],
}
for (const [label, html] of [['BROKEN', broken], ['FIXED', good]] as const) {
  const out = renderDescriptionTheme(html, data).html
  const opens = (out.match(/<style[^>]*>/g) ?? []).length
  const closes = (out.match(/<\/style>/g) ?? []).length
  // does the MAIN stylesheet get terminated before its own rules finish?
  const firstClose = out.indexOf('</style>')
  const cssAfterFirstClose = out.slice(firstClose).includes('.ebd .foot{')
  console.log(`${label.padEnd(7)} <style> opens=${opens} closes=${closes}  ` +
    `theme CSS orphaned outside a stylesheet: ${cssAfterFirstClose ? 'YES — theme is destroyed' : 'no'}`)
}
