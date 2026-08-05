/** PHASE 3 DRY-RUN (READ-ONLY): every eBay DB hygiene issue + the exact heal each
 * family would receive. Writes NOTHING — this is the preview to approve. */
const { default: prisma } = await import('../src/db.js')

const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const aspectKeys = (o: unknown) => (isObj(o) ? Object.keys(o) : []).filter((k) => k.startsWith('aspect_'))
// Canonical column id = first letter after "aspect_" uppercased, rest unchanged
// (incident #34/#36b: aspect_body_type → aspect_Body_type, aspect_colore → aspect_Colore).
const canonKey = (k: string) => k.replace(/^(aspect_)(.*)$/, (_m, p: string, rest: string) => p + (rest.charAt(0).toUpperCase() + rest.slice(1)))
const AXIS_LIKE = /^(colore|color|taglia|size|sesso|tipo di prodotto)$/i

const memb = await prisma.sharedListingMembership.findMany({
  select: { itemId: true, sku: true, parentSku: true, marketplace: true, status: true, variationSpecifics: true, flatFileSnapshot: true },
})
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', externalListingId: { not: null } },
  select: { id: true, externalListingId: true, marketplace: true, flatFileSnapshot: true },
})

// ---------- group memberships by family ----------
interface Fam { key: string; statuses: Set<string>; items: Set<string>; membCount: number; snapKeys: Set<string>; vsKeys: Set<string> }
const fams = new Map<string, Fam>()
for (const m of memb) {
  const key = `${m.marketplace}|${m.parentSku}`
  let f = fams.get(key)
  if (!f) { f = { key, statuses: new Set(), items: new Set(), membCount: 0, snapKeys: new Set(), vsKeys: new Set() }; fams.set(key, f) }
  f.statuses.add(m.status); f.items.add(m.itemId); f.membCount++
  for (const k of aspectKeys(m.flatFileSnapshot)) f.snapKeys.add(k)
  for (const k of (isObj(m.variationSpecifics) ? Object.keys(m.variationSpecifics) : [])) f.vsKeys.add(k)
}

// ---------- [A] case-twin fold (membership snapshots) ----------
let twinFamilies = 0, twinKeysFolded = 0
const twinExamples: string[] = []
for (const f of fams.values()) {
  const byCanon = new Map<string, Set<string>>()
  for (const k of f.snapKeys) { const c = canonKey(k); (byCanon.get(c) ?? byCanon.set(c, new Set()).get(c)!).add(k) }
  const twins = [...byCanon.entries()].filter(([, s]) => s.size > 1)
  if (twins.length) {
    twinFamilies++
    twinKeysFolded += twins.reduce((n, [, s]) => n + (s.size - 1), 0)
    if (twinExamples.length < 6) twinExamples.push(`${f.key}: ${twins.map(([c, s]) => `{${[...s].join(' + ')}} → ${c}`).join(', ')}`)
  }
}
// CL snapshots too
let clTwinRows = 0
for (const c of cls) {
  const keys = aspectKeys(c.flatFileSnapshot)
  const byCanon = new Map<string, number>()
  for (const k of keys) byCanon.set(canonKey(k), (byCanon.get(canonKey(k)) ?? 0) + 1)
  if ([...byCanon.values()].some((n) => n > 1)) clTwinRows++
}

// ---------- [B] polluted variationSpecifics (axis store) ----------
const polluted: string[] = []
for (const f of fams.values()) {
  const nonAxis = [...f.vsKeys].filter((k) => !AXIS_LIKE.test(k))
  const junk = [...f.vsKeys].filter((k) => /variantattribut/i.test(k))
  if (f.vsKeys.size > 3 || junk.length) polluted.push(`${f.key}: ${f.vsKeys.size} keys (${nonAxis.length} non-axis${junk.length ? ', +junk ' + junk.join(',') : ''}) → reconcile to live axes`)
}

// ---------- [C] corpse families (no ACTIVE membership) ----------
const corpses = [...fams.values()].filter((f) => !f.statuses.has('ACTIVE'))
const corpseMemb = corpses.reduce((n, f) => n + f.membCount, 0)

// ---------- [D] dead-link ChannelListings ----------
const activeItemIds = new Set(memb.filter((m) => m.status === 'ACTIVE').map((m) => m.itemId))
const membItemIds = new Set(memb.map((m) => m.itemId))
const deadCls = cls.filter((c) => membItemIds.has(c.externalListingId!) && !activeItemIds.has(c.externalListingId!))
const deadItemIds = new Set(deadCls.map((c) => c.externalListingId!))

console.log('=== PHASE 3 HEAL DRY-RUN (READ-ONLY — nothing written) ===')
console.log(`families: ${fams.size} · memberships: ${memb.length} · eBay ChannelListings: ${cls.length}\n`)
console.log(`[A] CASE-TWIN COLUMN FOLD — ${twinFamilies} families, ${twinKeysFolded} duplicate keys to fold (+ ${clTwinRows} CL snapshot rows)`)
twinExamples.forEach((x) => console.log('     ', x))
console.log(`\n[B] POLLUTED axis store (variationSpecifics) — ${polluted.length} families → reconcile to LIVE axes`)
polluted.slice(0, 10).forEach((x) => console.log('     ', x))
console.log(`\n[C] STALE CORPSE families (no active listing) — ${corpses.length} families, ${corpseMemb} memberships to sweep`)
corpses.forEach((f) => console.log(`      ${f.key} · statuses=${JSON.stringify([...f.statuses])} · ${f.membCount} memberships · items=${[...f.items].join(',')}`))
console.log(`\n[D] DEAD-LINK ChannelListings — ${deadCls.length} rows point at ${deadItemIds.size} dead itemIds ${JSON.stringify([...deadItemIds])}`)

console.log('\n=== proposed heal (on approval): [A] fold twins in snapshots · [B] reconcile polluted stores to live · [C] sweep corpse memberships · [D] clear dead externalListingId — all snapshot-backed + reversible ===')
await prisma.$disconnect()
