// READ-ONLY. Simulates the HEAD (deployed) canonicalizeRowAspects on the REAL DE row.
import { canonicalizeRowAspects as headFold } from './_head_axes_snapshot.mts'
import { canonicalizeRowAspects as wtFold } from '../src/services/ebay-theme-axes.js'

// REAL stored DE itemSpecifics (ChannelListing.platformAttributes.itemSpecifics)
// for WATERPROOF-OVERJACKET-BLACK-MEN-XL, verbatim from the DB.
const real = { Size: 'XL', Color: 'Nero', Marca: 'Xavia Racing', Colore: 'Nero', Taglia: 'XL', Stagione: 'Tutte le stagioni' }
const asRow = () => {
  const r: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(real)) r[`aspect_${k.replace(/ /g, '_')}`] = v
  return r
}

function run(label: string, mk: () => Record<string, unknown>) {
  const a = mk(); const before = JSON.stringify(a); const na = headFold(a)
  const b = mk(); const nb = wtFold(b)
  console.log(`\n${label}`)
  console.log('  BEFORE     :', before)
  console.log('  HEAD (prod):', JSON.stringify(a), `folded=${na}`)
  console.log('  WORKTREE   :', JSON.stringify(b), `folded=${nb}`)
}

run('[1] DE row as stored, untouched', asRow)
run('[2] DE row + operator types German Farbe=Schwarz (Colore already "Nero")', () => ({ ...asRow(), aspect_Farbe: 'Schwarz' }))
run('[3] DE row + operator types German Größe=XL (Taglia already "XL")', () => ({ ...asRow(), 'aspect_Größe': 'XL' }))
run('[4] DE row + Marke=Xavia Racing DE (Marca filled)', () => ({ ...asRow(), aspect_Marke: 'Xavia Racing DE' }))
run('[5] Pipe-encoded IT canonical + German typed', () => ({ aspect_Colore: 'Nero | Uomo', aspect_Farbe: 'Schwarz | Herren' }))
run('[6] German typed on an EMPTY Italian cell', () => ({ aspect_Colore: '', aspect_Farbe: 'Schwarz' }))
run('[7] German typed with NO Italian key at all', () => ({ aspect_Farbe: 'Schwarz', aspect_Marke: 'Xavia' }))
