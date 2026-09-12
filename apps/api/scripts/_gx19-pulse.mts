import '../src/env.js'
const { hourlyPulse, DAY_LABELS } = await import('../src/services/advertising/ads-hourly-pulse.service.js')
for (const m of ['IT','ES']) {
  const p = await hourlyPulse({ marketplace: m })
  console.log(`\n═══ ${m} · today ${p.today} (UTC) · through hour ${p.throughHour ?? '—'} · vs ${p.comparisonDay}`)
  console.log(`  today      €${p.totals.today.cost.toFixed(2).padStart(8)}  ${String(p.totals.today.clicks).padStart(4)} clicks  €${p.totals.today.sales.toFixed(2)} sales`)
  console.log(`  last week  €${p.totals.comparison.cost.toFixed(2).padStart(8)}  ${String(p.totals.comparison.clicks).padStart(4)} clicks  €${p.totals.comparison.sales.toFixed(2)} sales`)
  const withData = p.heat.filter(c => c.days > 0)
  console.log(`  heat: ${withData.length}/168 cells with data · ${p.heat.filter(c=>c.days===0).length} hatched · window ${p.heatWindowDays}d`)
  const best = [...withData].filter(c=>c.cvr!=null).sort((a,b)=>(b.cvr??0)-(a.cvr??0)).slice(0,3)
  for (const c of best) console.log(`    best CVR  ${DAY_LABELS[c.weekday]} ${String(c.hour).padStart(2,'0')}:00 UTC  cvr ${((c.cvr??0)*100).toFixed(1)}%  €${(c.cost??0).toFixed(2)} over ${c.days}d`)
  console.log(`  top campaigns today: ${p.topCampaigns.slice(0,3).map(c=>`${c.label.slice(0,20)} €${c.cost.toFixed(2)}`).join(' · ') || 'none'}`)
  for (const c of p.caveats.slice(2)) console.log(`  · ${c.slice(0,120)}`)
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
