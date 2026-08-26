import '../src/env.js'
const { getBidGrid, BID_MARKET_ALL } = await import('../src/services/advertising/bid-grid.service.js')
const { default: prisma } = await import('../src/db.js')
for (const status of ['enabled','all'] as const) {
  const t0 = Date.now()
  const g = await getBidGrid({ market: BID_MARKET_ALL, line:null, portfolio:null, campaign:null, view:'targets',
    status, kind:[], match:[], band:null, measured:'all', q:null, windowDays:30, sort:null, dir:'desc', limit:5000 })
  const ms = Date.now()-t0
  const bytes = JSON.stringify(g).length
  const pts = Object.values(g.series).reduce((s:number,a:any)=>s+a.length,0)
  console.log(`status=${status.padEnd(8)} ${String(g.rows.length).padStart(5)} rows · series ${String(Object.keys(g.series).length).padStart(4)} entities / ${String(pts).padStart(5)} points · ${(bytes/1024/1024).toFixed(2)} MB · ${ms} ms`)
}
await prisma.$disconnect()
