// READ-ONLY: how much IT output would move if the Italian fold were removed,
// i.e. the exact blast radius the market gate must protect. No writes.
const { default: prisma } = await import('../src/db.js')

const AXIS_SYNONYM_GROUPS: string[][] = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]
const ASPECT_SYNONYM_GROUPS: string[][] = [
  ...AXIS_SYNONYM_GROUPS,
  ['marca', 'brand', 'marke', 'marque'],
  ['stagione', 'season'],
  ['paese di fabbricazione', 'country/region of manufacture', 'country of manufacture', 'made in'],
  ['tipo di giacca', 'jacket type'],
  ['tipo di prodotto', 'product type'],
  ['adatto a', 'suitable for'],
  ['livello di protezione', 'protection level'],
  ['reparto', 'department'],
  ['vestibilità', 'vestibilita', 'fit'],
  ['condizione', 'condition'],
]
const canon = (n: string) => {
  const lk = n.toLowerCase().trim()
  for (const g of ASPECT_SYNONYM_GROUPS) if (g.includes(lk)) return g[0]
  return lk
}

const out: Record<string, unknown> = {}

// A. variationTheme spellings in the catalog — would a pass-through theme差 on IT?
const prods = await prisma.product.findMany({
  where: { deletedAt: null, NOT: { variationTheme: null } },
  select: { sku: true, variationTheme: true },
})
const themeCounts = new Map<string, number>()
for (const p of prods) themeCounts.set(p.variationTheme!, (themeCounts.get(p.variationTheme!) ?? 0) + 1)
out.variationThemes = [...themeCounts.entries()].sort((a, b) => b[1] - a[1])
// themes whose tokens are NOT already the canonical spelling (these are the only
// ones where the declared-theme fold changes the transmitted name)
out.themesThatGetRewritten = [...themeCounts.keys()].filter((t) =>
  t.split(/[,/|]/).map((x) => x.trim()).filter(Boolean)
    .some((tok) => tok.toLowerCase() !== canon(tok)),
)

// B. memberships whose stored axis names are NOT the Italian canonical
const ms = await prisma.sharedListingMembership.findMany({
  select: { marketplace: true, parentSku: true, itemId: true, variationSpecifics: true },
})
const nonCanon = new Map<string, { itemIds: Set<string>; names: Set<string> }>()
for (const m of ms) {
  const vs = (m.variationSpecifics ?? {}) as Record<string, unknown>
  for (const n of Object.keys(vs)) {
    if (n.toLowerCase() === canon(n)) continue
    const k = `${m.marketplace}:${m.parentSku}`
    if (!nonCanon.has(k)) nonCanon.set(k, { itemIds: new Set(), names: new Set() })
    nonCanon.get(k)!.itemIds.add(m.itemId)
    nonCanon.get(k)!.names.add(n)
  }
}
out.membershipsWithNonItalianAxisNames = [...nonCanon.entries()].map(([k, v]) => ({
  key: k, itemIds: [...v.itemIds], names: [...v.names],
}))

// C. Shared-flagged IT families: do any variant rows carry a NON-canonical
// aspect spelling for a known dimension? (Those are the rows where the fold
// currently rewrites the transmitted axis name on IT.)
const snaps = await prisma.sharedListingMembership.findMany({
  where: { marketplace: 'IT' },
  select: { parentSku: true, sku: true, flatFileSnapshot: true },
})
const rewritten = new Map<string, Set<string>>()
for (const s of snaps) {
  const snap = (s.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const k of Object.keys(snap)) {
    if (!k.startsWith('aspect_')) continue
    const raw = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
    if (!raw) continue
    const c = canon(raw)
    if (raw.toLowerCase() === c) continue
    if (!ASPECT_SYNONYM_GROUPS.some((g) => g.includes(c))) continue
    if (!rewritten.has(s.parentSku)) rewritten.set(s.parentSku, new Set())
    rewritten.get(s.parentSku)!.add(`${raw} -> ${c}`)
  }
}
out.itSnapshotAspectsThatTheFoldRewrites = [...rewritten.entries()].map(([p, s]) => ({ parentSku: p, folds: [...s] }))

console.log(JSON.stringify(out, null, 2))
await prisma.$disconnect()
