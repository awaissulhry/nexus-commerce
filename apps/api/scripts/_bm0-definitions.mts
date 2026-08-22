/** BM.0 — are the indices percentiles, and what composes each funnel stage? READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })

const rows = await prisma.amazonAdsBrandBuildingMetric.findMany({
  select: { marketplace: true, categoryNodeName: true, computationDate: true, metrics: true },
})
const M = rows.map(r => ({ mk: r.marketplace, node: r.categoryNodeName, d: r.computationDate.toISOString().slice(0,10),
  m: r.metrics as Record<string,string> }))
const n = (o: Record<string,string>, k: string) => { const v = o[k]; return v === undefined ? null : Number(v) }

// ── A. awareness vs consideration: how close are they, really? ─────────────
const pairs = M.map(r => [n(r.m,'awarenessIndex'), n(r.m,'considerationIndex')] as const)
  .filter((p): p is readonly [number,number] => p[0] !== null && p[1] !== null)
const diffs = pairs.map(([a,c]) => Math.abs(a-c))
console.log(`A. awareness vs consideration — ${pairs.length} rows`)
console.log(`   max |diff| ${Math.max(...diffs).toFixed(4)} · mean ${(diffs.reduce((x,y)=>x+y,0)/diffs.length).toFixed(5)}`)
console.log(`   identical: ${diffs.filter(d=>d===0).length} · consideration > awareness: ${pairs.filter(([a,c])=>c>a).length}`)

// ── B. the median-crossing test ────────────────────────────────────────────
// If an index is a PERCENTILE RANK, a row sitting exactly ON the category median
// must score ~0.50. Take rows within ±10% of the median for each candidate metric
// and report the mean index. The pairing that lands nearest 0.50 is the composition.
const CANDIDATES: Array<[string,string,string]> = [
  ['viewedDetailPageOnly','viewedDetailPageCategoryMedian','detail page views'],
  ['brandedSearchesOnly','brandedSearchesCategoryMedian','branded searches'],
  ['brandedSearchesAndDetailPageViews','brandedSearchesAndDetailPageViewsCategoryMedian','branded search + DPV'],
  ['addToCarts','addToCartsCategoryMedian','add to carts'],
  ['brandCustomers','brandCustomersCategoryMedian','brand customers'],
  ['highValueCustomers','highValueCustomersCategoryMedian','high-value customers'],
]
const INDICES = ['awarenessIndex','considerationIndex','salesIndex']
console.log(`\nB. median-crossing — mean index for rows within +/-10% of the category median`)
console.log(`   ${'metric'.padEnd(22)} ${'n'.padStart(4)}  ` + INDICES.map(i=>i.replace('Index','').padStart(14)).join(''))
for (const [own, med, label] of CANDIDATES) {
  const near = M.filter(r => {
    const o = n(r.m,own), md = n(r.m,med)
    return o !== null && md !== null && md > 0 && Math.abs(o-md)/md <= 0.10
  })
  const cells = INDICES.map(i => {
    const vs = near.map(r=>n(r.m,i)).filter((v): v is number => v!==null)
    return vs.length ? (vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(3).padStart(14) : '—'.padStart(14)
  })
  console.log(`   ${label.padEnd(22)} ${String(near.length).padStart(4)}  ` + cells.join(''))
}

// ── C. does the index move with our standing? ──────────────────────────────
// Spearman rank correlation between each index and log(own / median).
function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => { const s = x.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]); const r = Array(x.length)
    s.forEach(([,i],k)=>{ r[i as number]=k+1 }); return r as number[] }
  const ra = rank(a), rb = rank(b), N = a.length
  const d2 = ra.reduce((s,v,i)=>s+(v-rb[i])**2,0)
  return 1 - (6*d2)/(N*(N*N-1))
}
console.log(`\nC. Spearman(index, log(own / category median)) — 1.0 = index tracks our standing exactly`)
console.log(`   ${'metric'.padEnd(22)} ${'n'.padStart(4)}  ` + INDICES.map(i=>i.replace('Index','').padStart(14)).join(''))
for (const [own, med, label] of CANDIDATES) {
  const cells = INDICES.map(idx => {
    const xs: number[] = [], ys: number[] = []
    for (const r of M) {
      const o = n(r.m,own), md = n(r.m,med), iv = n(r.m,idx)
      if (o===null||md===null||iv===null||o<=0||md<=0) continue
      xs.push(Math.log(o/md)); ys.push(iv)
    }
    return xs.length > 8 ? spearman(xs,ys).toFixed(3).padStart(14) : `n=${xs.length}`.padStart(14)
  })
  const cnt = M.filter(r=>n(r.m,own)!==null&&n(r.m,med)!==null).length
  console.log(`   ${label.padEnd(22)} ${String(cnt).padStart(4)}  ` + cells.join(''))
}

// ── D. what IS return on engagement? ───────────────────────────────────────
// If ROE were "value per engagement" over a common numerator, ROE_x * count_x
// would be the same number for every x on a row. Test it.
console.log(`\nD. ROE x count — equal across engagement types would mean one shared numerator`)
const ROE: Array<[string,string,string]> = [
  ['addToCarts','addToCartsReturnOnEngagement','add to carts'],
  ['brandCustomers','brandCustomersReturnOnEngagement','brand customers'],
  ['viewedDetailPageOnly','viewedDetailPageOnlyReturnOnEngagement','detail page views'],
  ['highValueCustomers','highValueCustomersReturnOnEngagement','high-value customers'],
]
for (const r of M.filter(x=>x.mk==='IT'&&x.node==='/Categorie/Moto, accessori e componenti').slice(-3)) {
  const parts = ROE.map(([c,roe,l])=>{ const cv=n(r.m,c), rv=n(r.m,roe)
    return `${l}: ${cv===null||rv===null?'—':(cv*rv).toFixed(1)}` })
  console.log(`   ${r.d}  ` + parts.join(' · '))
}
await prisma.$disconnect()
