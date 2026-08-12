/** _kt6-unbid.mts — KT.6 §3.1: a GENUINELY unbid watched term, and what the control says. READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
import { computeBlastRadius, blastRadiusSentence } from '../src/services/advertising/kt6-bid-action.js'
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const wrap = (s: string, w = 96) => { const o: string[] = []; let c = ''
  for (const x of s.split(' ')) { if ((c + ' ' + x).trim().length > w) { o.push(c); c = x } else c = (c + ' ' + x).trim() }
  if (c) o.push(c); return o.map((l) => '   ' + l).join('\n') }

async function main() {
  const camps = await prisma.campaign.findMany({ select: { id: true, marketplace: true } })
  const byId = new Map(camps.map((c) => [c.id, c]))
  const targets = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: { expressionValue: true, adGroup: { select: { campaignId: true } } },
  })
  const bidIT = new Set(targets.filter((t) => byId.get(t.adGroup!.campaignId)?.marketplace === 'IT').map((t) => norm(t.expressionValue)))
  const wl = await prisma.keywordWatchlist.findFirst({ where: { marketplace: 'IT', isDefault: true }, select: { terms: { select: { term: true, isBranded: true } } } })
  const watched = (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
  const unbid = watched.filter((t) => !bidIT.has(t))
  console.log(`IT watched non-branded terms: ${watched.length} · genuinely unbid (0 targets): ${unbid.length}`)
  console.log(`first five unbid: ${unbid.slice(0, 5).map((t) => `"${t}"`).join(', ')}`)
  console.log()
  const term = unbid[0]
  const r = computeBlastRadius([], 55)
  console.log(`§3.1 artefact — "${term}" (IT), verified to have ZERO keyword targets:`)
  console.log(wrap(blastRadiusSentence(r, { term, marketplace: 'IT', shareAgeDays: 18, undoWindowHours: 24, proposeOnly: true })))
  console.log()
  console.log('⇒ the control offers no bid change here at all. What it CAN offer is measured next:')
  const itWritable = await prisma.campaign.count({ where: { marketplace: 'IT', liveBidWritesEnabled: true } })
  const groups = await prisma.adGroup.count({ where: { campaign: { marketplace: 'IT', liveBidWritesEnabled: true } } })
  console.log(`   ${itWritable} writable IT campaigns hold ${groups} ad groups — so a keyword could go in ${groups} places.`)
  console.log('   No single destination is derivable, so KT.6 must NOT invent one. The honest action is a')
  console.log('   hand-off to Keyword Harvest (which already owns destination choice — HV.3 measured a')
  console.log('   median of 5 candidates and unique for 13%), not a "create keyword here" button.')
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 300)); await prisma.$disconnect(); process.exit(1) })
