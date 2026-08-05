/** READ-ONLY: prove the new guards FAIL on the broken shape (a token inside
 *  <style>, and a duplicated hero token) rather than merely passing now. */
const { BUILT_IN_THEMES } = await import('../src/services/ebay-description-render.js')
const good = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!.html
// reintroduce exactly the mistake that shipped
const broken = good.replace('Mechanism deliberately matches the hero gallery token',
  'Mechanism deliberately matches {{gallery_hero}}')

const heroCount = (h: string) => (h.match(/\{\{\s*gallery_hero\s*\}\}/g) ?? []).length
const strayInStyle = (h: string) =>
  (h.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).flatMap((s) => s.match(/\{\{\s*[a-z0-9_]+\s*\}\}/gi) ?? [])

for (const [label, html] of [['FIXED', good], ['BROKEN', broken]] as const) {
  console.log(`${label.padEnd(7)} heroTokens=${heroCount(html)}  tokensInsideStyle=[${strayInStyle(html).join(', ')}]`)
}
const ok = heroCount(broken) > 1 && strayInStyle(broken).length > 0
console.log('\nguards would have caught the regression:', ok ? 'YES ✓' : 'NO ✗')
