// READ-ONLY: pure-function probe. NO DB, NO network.
import { canonicalizeRowAspects, aspectCanonicalName } from '../src/services/ebay-theme-axes.js'

console.log('=== aspectCanonicalName() for GERMAN / FRENCH names ===')
for (const n of ['Farbe','Größe','Marke','Couleur','Taille','Marque','Color','Size','Brand','Colore','Taglia']) {
  console.log(`  ${n.padEnd(10)} -> ${aspectCanonicalName(n)}`)
}

console.log('\n=== FOLD a hypothetical PROPER GERMAN DE row ===')
const deRow: Record<string, unknown> = {
  sku: 'WATERPROOF-OVERJACKET-BLACK-MEN-M',
  marketplace: 'DE',
  variation_theme: 'Farbe,Größe',
  aspect_Farbe: 'Schwarz | Herren',
  aspect_Größe: 'M',
  aspect_Marke: 'Xavia Racing',
}
console.log('BEFORE:', JSON.stringify(deRow))
const folded = canonicalizeRowAspects(deRow)
console.log('AFTER :', JSON.stringify(deRow), ` (folded=${folded})`)

console.log('\n=== FOLD the ACTUAL stored DE WATERPROOF row shape ===')
const actual: Record<string, unknown> = {
  aspect_Size: 'M', aspect_Color: 'Nero',
  aspect_Colore: 'Nero', aspect_Taglia: 'M', aspect_Marca: 'Xavia Racing',
  aspect_Stagione: 'Tutte le stagioni', aspect_Stile: '', aspect_Chiusura: '',
}
console.log('BEFORE:', JSON.stringify(actual))
console.log('AFTER :', JSON.stringify(actual), ` (folded=${canonicalizeRowAspects(actual)})`)

console.log('\n=== PIPE-ENCODED value survival through the fold ===')
const pipe: Record<string, unknown> = { aspect_Color: 'Red | Men', aspect_Colore: '' }
console.log('BEFORE:', JSON.stringify(pipe))
console.log('AFTER :', JSON.stringify(pipe), ` (folded=${canonicalizeRowAspects(pipe)})`)
const pipe2: Record<string, unknown> = { aspect_Color: 'Red | Men', aspect_Colore: 'Rosso | Uomo' }
console.log('BEFORE:', JSON.stringify(pipe2))
console.log('AFTER :', JSON.stringify(pipe2), ` (folded=${canonicalizeRowAspects(pipe2)})`)

console.log('\n=== German value into an EMPTY Italian cell (data survives but under IT key) ===')
const g2: Record<string, unknown> = { aspect_Farbe: 'Schwarz', aspect_Colore: 'Nero' }
console.log('BEFORE:', JSON.stringify(g2))
console.log('AFTER :', JSON.stringify(g2), ` (folded=${canonicalizeRowAspects(g2)})`)
