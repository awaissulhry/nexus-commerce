/** ACR.2.3 — run the account-wide contest board against prod. READ-ONLY. */
import '../src/env.js'
await import('../src/db.js')
const { getAccountKeywordContests } = await import('../src/services/advertising/ads-keyword-contests.service.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const b = await getAccountKeywordContests({ marketplace: 'IT', limit: 400 })

console.log(`\n═══ IT · ${b.windowDays}d window · AD_TARGET grain covers ${b.daysWithData} days ═══`)
console.log(`contested ${b.totals.contested} · cross-portfolio ${b.totals.crossPortfolio} · ${b.totals.campaigns} campaigns in ${b.totals.portfolios} portfolios`)
console.log(`spend on contested terms ${eur(b.totals.spend30dCents)} · of which NOT the champion ${eur(b.totals.challengerSpend30dCents)}`)
for (const n of b.notes) console.log(`  · ${n}`)

console.log(`\n── top 12 by contested spend ──`)
for (const c of b.contests.slice(0, 12)) {
  const champ = c.contenders.find((x) => x.campaignId === c.championId)
  console.log(`\n  "${c.term}" [${c.matchType}] · ${c.contenders.length} campaigns · ${c.portfolios} portfolios${c.crossPortfolio ? ' ⚑CROSS' : ''}${c.bothTop ? ' ⚑BOTH-TOP' : ''}`)
  console.log(`    30d ${eur(c.spend30dCents)} → ${eur(c.sales30dCents)} · ${c.impressions30d.toLocaleString()} impr`)
  console.log(`    champion: ${champ?.campaignName} [${champ?.portfolioName}] — ${c.championReason}`)
  for (const x of c.contenders) {
    const mark = x.campaignId === c.championId ? '★' : ' '
    console.log(`    ${mark} ${x.campaignName.slice(0, 30).padEnd(32)} ${String(x.portfolioName).slice(0, 20).padEnd(22)} bid=${(x.bidCents / 100).toFixed(2)} impr=${String(x.impressions).padStart(6)} spend=${eur(x.spendCents).padStart(9)} acos=${x.acos != null ? (x.acos * 100).toFixed(0) + '%' : '—'} tos=${x.tosBias}%`)
  }
}

const cross = b.contests.filter((c) => c.crossPortfolio)
console.log(`\n── portfolio pairs that actually collide (${cross.length} cross-portfolio contests) ──`)
const pairCount = new Map<string, { n: number; spend: number }>()
for (const c of cross) {
  const names = [...new Set(c.contenders.map((x) => x.portfolioName))].sort()
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const k = `${names[i]} ↔ ${names[j]}`
    const p = pairCount.get(k) ?? { n: 0, spend: 0 }
    p.n += 1; p.spend += c.spend30dCents
    pairCount.set(k, p)
  }
}
for (const [k, v] of [...pairCount.entries()].sort((a, b2) => b2[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(52)} ${String(v.n).padStart(3)} terms · ${eur(v.spend)}`)
}

const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
