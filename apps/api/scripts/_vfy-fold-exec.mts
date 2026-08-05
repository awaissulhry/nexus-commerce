const { canonicalizeRowAspects, aspectCanonicalName } = await import('../src/services/ebay-theme-axes.js')
const de: Record<string, unknown> = { sku: 'X-DE-1', aspect_Farbe: 'Schwarz', aspect_Größe: 'M', aspect_Marke: 'Xavia', aspect_Material: 'Polyester' }
console.log('DE folded:', canonicalizeRowAspects(de), JSON.stringify(de))
const fr: Record<string, unknown> = { aspect_Couleur: 'Noir', aspect_Taille: 'M', aspect_Marque: 'Xavia' }
console.log('FR folded:', canonicalizeRowAspects(fr), JSON.stringify(fr))
const uk: Record<string, unknown> = { aspect_Colour: 'Black', aspect_Size: 'M' }
console.log('UK folded:', canonicalizeRowAspects(uk), JSON.stringify(uk))
const es: Record<string, unknown> = { aspect_Color: 'Negro', aspect_Talla: 'M' }
console.log('ES folded:', canonicalizeRowAspects(es), JSON.stringify(es))
// pipe encoding preserved?
const pipe: Record<string, unknown> = { aspect_Farbe: 'Schwarz | Herren' }
console.log('PIPE:', canonicalizeRowAspects(pipe), JSON.stringify(pipe))
console.log('aspectCanonicalName(Farbe)=', aspectCanonicalName('Farbe'), ' (Größe)=', aspectCanonicalName('Größe'))
