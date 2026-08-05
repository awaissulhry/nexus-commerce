import { canonicalizeRowAspects } from '../src/services/ebay-theme-axes.js'
function show(label: string, row: Record<string, unknown>) {
  const before = JSON.stringify(row)
  const n = canonicalizeRowAspects(row)
  console.log(`${label}\n  BEFORE: ${before}\n  AFTER : ${JSON.stringify(row)}  (folded=${n})\n`)
}
show('[A] ACTUAL stored DE WATERPROOF row shape', {
  aspect_Size: 'M', aspect_Color: 'Nero',
  aspect_Colore: 'Nero', aspect_Taglia: 'M', aspect_Marca: 'Xavia Racing',
  aspect_Stagione: 'Tutte le stagioni', aspect_Stile: '', aspect_Chiusura: '',
})
show('[B] PROPER GERMAN row on the DE market', {
  variation_theme: 'Farbe,Größe',
  aspect_Farbe: 'Schwarz | Herren', aspect_Größe: 'M', aspect_Marke: 'Xavia Racing',
})
show('[C] German value BESIDE an Italian value (DE market)', {
  aspect_Farbe: 'Schwarz', aspect_Colore: 'Nero',
})
show('[D] German value with EMPTY Italian twin', {
  aspect_Farbe: 'Schwarz', aspect_Colore: '',
})
show('[E] pipe-encoded EN twin + filled IT canonical', {
  aspect_Color: 'Red | Men', aspect_Colore: 'Rosso | Uomo',
})
show('[F] pipe-encoded EN twin + EMPTY IT canonical', {
  aspect_Color: 'Red | Men', aspect_Colore: '',
})
show('[G] TEST-S-Black actual shape (no IT twin at all)', {
  aspect_Size: 'S', aspect_Color: 'Black',
})
show('[H] French row on a hypothetical FR market', {
  aspect_Couleur: 'Noir', aspect_Taille: 'M', aspect_Marque: 'Xavia',
})
