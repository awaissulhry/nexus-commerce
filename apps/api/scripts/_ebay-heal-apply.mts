/** PHASE 3 HEAL APPLY (reversible). Backs up ALL memberships + eBay ChannelListings
 * to a timestamped file FIRST, then: [C] sweep corpses · [D] clear dead links ·
 * [A] fold case-twin columns · [B] reconcile polluted stores to live.
 * Pass "apply" to write; otherwise it only backs up + reports. */
import { writeFileSync } from 'node:fs'
process.env.NEXUS_EBAY_REAL_API = 'true' // [B] reconcile does live GetItem reads
const { default: prisma } = await import('../src/db.js')

const APPLY = process.argv[2] === 'apply'
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const canonKey = (k: string) => k.replace(/^(aspect_)(.*)$/, (_m, p: string, rest: string) => p + (rest.charAt(0).toUpperCase() + rest.slice(1)))

const CORPSE_ITEMIDS = ['256552369326', '257628002510', '256550346578']
const DEAD_LINK_ITEMIDS = ['256550346578', '256552369326']
const POLLUTED_ACTIVE_PARENTS = ['AIREON', 'GALE-JACKET', 'xavia-knee-slider'] // 257628002510 is a corpse → swept, not reconciled

// ── BACKUP (everything we might touch) ──────────────────────────────────────
const allMemb = await prisma.sharedListingMembership.findMany()
const allEbayCls = await prisma.channelListing.findMany({ where: { channel: 'EBAY' } })
const stamp = Date.now()
const backupPath = `/Users/awais/nexus-commerce/apps/api/scripts/_ebay-heal-backup-${stamp}.json`
writeFileSync(backupPath, JSON.stringify({ stamp, memberships: allMemb, channelListings: allEbayCls }, null, 0))
console.log(`✔ backup written: ${backupPath} (${allMemb.length} memberships, ${allEbayCls.length} eBay CLs)`)

if (!APPLY) { console.log('\nDRY-RUN — pass "apply" to write. Nothing changed.'); await prisma.$disconnect() }
else {
  // ── [C] corpse sweep ──────────────────────────────────────────────────────
  const cDel = await prisma.sharedListingMembership.deleteMany({ where: { itemId: { in: CORPSE_ITEMIDS }, status: { not: 'ACTIVE' } } })
  console.log(`[C] corpse sweep: deleted ${cDel.count} ended memberships`)

  // ── [D] dead-link clear ───────────────────────────────────────────────────
  const dUpd = await prisma.channelListing.updateMany({
    where: { channel: 'EBAY', externalListingId: { in: DEAD_LINK_ITEMIDS } },
    data: { externalListingId: null },
  })
  console.log(`[D] dead-link clear: nulled externalListingId on ${dUpd.count} ChannelListings`)

  // ── [A] case-twin fold (membership + CL snapshots) ────────────────────────
  // Canonicalise EVERY aspect_ key to its sentence-cased form (not just
  // within-row twins). Different rows using aspect_Genere vs aspect_genere make
  // the family-level grid show duplicate columns even when no single row carries
  // both — so renaming lone lowercase keys is required, plus merging any real
  // twin (existing non-empty value wins).
  const foldTwins = (snap: unknown): { changed: boolean; obj: Record<string, unknown> } => {
    if (!isObj(snap)) return { changed: false, obj: {} }
    const out: Record<string, unknown> = {}
    let changed = false
    for (const [k, v] of Object.entries(snap)) {
      if (!k.startsWith('aspect_')) { out[k] = v; continue }
      const c = canonKey(k)
      if (c !== k) changed = true
      if (!(c in out)) { out[c] = v; continue }
      const cur = out[c]
      const curEmpty = !(typeof cur === 'string' && cur.trim() !== '')
      if (curEmpty && typeof v === 'string' && v.trim() !== '') out[c] = v
      changed = true
    }
    return { changed, obj: out }
  }
  let aMemb = 0
  for (const m of allMemb) {
    // skip the corpse rows we just deleted
    if (CORPSE_ITEMIDS.includes(m.itemId) && m.status !== 'ACTIVE') continue
    const f = foldTwins(m.flatFileSnapshot)
    if (f.changed) { await prisma.sharedListingMembership.update({ where: { id: m.id }, data: { flatFileSnapshot: f.obj } }); aMemb++ }
  }
  let aCl = 0
  for (const c of allEbayCls) {
    const f = foldTwins(c.flatFileSnapshot)
    if (f.changed) { await prisma.channelListing.update({ where: { id: c.id }, data: { flatFileSnapshot: f.obj } }); aCl++ }
  }
  console.log(`[A] case-twin fold: ${aMemb} memberships + ${aCl} ChannelListings rewritten`)

  // ── [B] reconcile polluted ACTIVE families to live axes ───────────────────
  const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
  const { reconcileMembershipsFromEbay } = await import('../src/services/ebay-membership-reconcile.service.js')
  const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
  const token = await ebayAuthService.getValidToken(conn!.id)
  const targets = await prisma.sharedListingMembership.findMany({
    where: { parentSku: { in: POLLUTED_ACTIVE_PARENTS }, status: 'ACTIVE' },
    select: { itemId: true, marketplace: true, parentSku: true }, distinct: ['itemId'],
  })
  console.log(`[B] reconcile: ${targets.length} active listing(s) across ${POLLUTED_ACTIVE_PARENTS.length} polluted families`)
  for (const t of targets) {
    try {
      const r = await reconcileMembershipsFromEbay(t.itemId, t.marketplace, { oauthToken: token }, t.parentSku)
      console.log(`     ${t.parentSku} (${t.itemId}): matched ${r.matched}/${r.liveVariations}, rewritten ${r.rewritten}, removedStale ${r.removedStale}`)
    } catch (e) {
      console.log(`     ${t.parentSku} (${t.itemId}): FAILED — ${(e as Error).message}`)
    }
  }

  console.log('\n✔ HEAL APPLIED. Re-run _ebay-heal-dryrun.mts to confirm; restore from the backup file if needed.')
  await prisma.$disconnect()
}
