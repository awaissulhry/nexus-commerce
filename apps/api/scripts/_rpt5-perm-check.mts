const { permissionForRoute } = await import('../src/lib/auth/permissions-manifest.js')
const cases: Array<[string,string]> = [
  ['GET','/api/advertising/reporting/saved'],
  ['POST','/api/advertising/reporting/saved'],
  ['PATCH','/api/advertising/reporting/saved/abc'],
  ['DELETE','/api/advertising/reporting/saved/abc'],
  ['GET','/api/advertising/reporting/run'],
  ['GET','/api/advertising/reporting/export'],
  ['POST','/api/advertising/campaigns'],
  ['POST','/api/advertising/rank-schedule-groups'],
]
for (const [m,p] of cases) console.log(`${m.padEnd(7)} ${p.padEnd(48)} -> ${permissionForRoute(m,p)}`)
console.log('---')
for (const [m,p] of [['POST','/api/advertising/reporting/imports/preview'],['GET','/api/advertising/reporting/imports'],['POST','/api/advertising/campaigns']] as Array<[string,string]>)
  console.log(`${m.padEnd(7)} ${p.padEnd(48)} -> ${permissionForRoute(m,p)}`)
