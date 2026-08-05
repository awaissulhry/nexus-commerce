/** READ-ONLY: does the LIVE prod Modernist row match a registered predecessor?
 *  If yes, ensureBuiltInThemes will upgrade it once Railway ships the new code. */
import { createHash } from 'node:crypto'
const m = await import('../src/services/ebay-description-render.js')
const LIVE = '283dcb56bb58de8eb903b3fa059d121881429cfe0a9e7b009dc13ffb2f579cc8'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const prev = m.BUILT_IN_PREVIOUS['Xavia Modernist']
const cur = m.BUILT_IN_THEMES.find((t) => t.name === 'Xavia Modernist')!.html
prev.forEach((h, i) => console.log(`V${i + 1}`.padEnd(8), String(h.length).padStart(6), sha(h), sha(h) === LIVE ? '  <== MATCHES LIVE PROD ROW' : ''))
console.log('CURRENT '.padEnd(8), String(cur.length).padStart(6), sha(cur), sha(cur) === LIVE ? '  (already current)' : '')
console.log('\nverdict:', prev.some((h) => sha(h) === LIVE) ? 'UPGRADE WILL APPLY ✓' : 'NO MATCH — the guard would treat prod as an operator edit ✗')
